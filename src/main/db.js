'use strict';
// Local block store backed by SQLite (node:sqlite, bundled with Electron's Node).
//
// Everything is a block. Pages and databases are blocks too; a block's
// children are the rows whose parent_id points at it, ordered by `position`.
//   page      props: { title, icon, cover?, fullWidth? }
//   database  props: { title, icon, schema: [{ id, name, type, options? }] }
//             children are pages (rows) whose props.values = { [colId]: value }
//   text-ish  props: { text (sanitised inline HTML), checked?, language?, color?, collapsed? }

const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');

const CONTAINER_TYPES = new Set(['page', 'database']);

class Store {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = OFF;
      CREATE TABLE IF NOT EXISTS blocks (
        id         TEXT PRIMARY KEY,
        type       TEXT NOT NULL,
        parent_id  TEXT,
        position   REAL NOT NULL DEFAULT 0,
        props      TEXT NOT NULL DEFAULT '{}',
        alive      INTEGER NOT NULL DEFAULT 1,
        favorite   INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS blocks_parent ON blocks(parent_id, position);
      CREATE INDEX IF NOT EXISTS blocks_type ON blocks(type);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    `);
    this.q = {
      get: this.db.prepare('SELECT * FROM blocks WHERE id = ?'),
      children: this.db.prepare('SELECT * FROM blocks WHERE parent_id = ? AND alive = 1 ORDER BY position'),
      containers: this.db.prepare(
        "SELECT id, type, parent_id, position, props, favorite, updated_at FROM blocks WHERE alive = 1 AND type IN ('page','database') ORDER BY position"
      ),
      upsert: this.db.prepare(`
        INSERT INTO blocks (id, type, parent_id, position, props, alive, created_at, updated_at)
        VALUES (@id, @type, @parent_id, @position, @props, 1, @now, @now)
        ON CONFLICT(id) DO UPDATE SET type = @type, parent_id = @parent_id, position = @position,
          props = @props, alive = 1, updated_at = @now`),
      setAlive: this.db.prepare('UPDATE blocks SET alive = ?, updated_at = ? WHERE id = ?'),
      hardDelete: this.db.prepare('DELETE FROM blocks WHERE id = ?'),
      setFavorite: this.db.prepare('UPDATE blocks SET favorite = ? WHERE id = ?'),
      trash: this.db.prepare(
        "SELECT id, type, parent_id, props, updated_at FROM blocks WHERE alive = 0 AND type IN ('page','database') ORDER BY updated_at DESC"
      ),
      allAliveText: this.db.prepare('SELECT id, type, parent_id, props FROM blocks WHERE alive = 1'),
      getMeta: this.db.prepare('SELECT value FROM meta WHERE key = ?'),
      setMeta: this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    };
  }

  close() { this.db.close(); }

  tx(fn) {
    this.db.exec('BEGIN');
    try { const r = fn(); this.db.exec('COMMIT'); return r; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  static row(r) {
    if (!r) return null;
    return {
      id: r.id, type: r.type, parentId: r.parent_id, position: r.position,
      props: JSON.parse(r.props), favorite: !!r.favorite, alive: r.alive === undefined ? true : !!r.alive,
      createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  getMeta(key) { const r = this.q.getMeta.get(key); return r ? JSON.parse(r.value) : undefined; }
  setMeta(key, value) { this.q.setMeta.run(key, JSON.stringify(value)); }

  get(id) { return Store.row(this.q.get.get(id)); }
  children(id) { return this.q.children.all(id).map(Store.row); }

  /** Sidebar tree: every live page/database, flat; the renderer nests them. */
  tree() {
    return this.q.containers.all().map((r) => {
      const p = JSON.parse(r.props);
      return { id: r.id, type: r.type, parentId: r.parent_id, position: r.position, title: p.title || '', icon: p.icon || '', favorite: !!r.favorite, updatedAt: r.updated_at };
    });
  }

  /** A page or database plus its content subtree (stops at nested pages/databases). */
  loadPage(id) {
    const root = this.get(id);
    if (!root) return null;
    const blocks = [];
    const walk = (pid) => {
      for (const b of this.children(pid)) {
        blocks.push(b);
        if (!CONTAINER_TYPES.has(b.type)) walk(b.id);
      }
    };
    walk(id);
    const breadcrumbs = [];
    let cur = root;
    while (cur && cur.parentId) {
      cur = this.get(cur.parentId);
      if (cur && CONTAINER_TYPES.has(cur.type)) breadcrumbs.unshift({ id: cur.id, title: cur.props.title || '', icon: cur.props.icon || '' });
    }
    const parent = root.parentId ? this.get(root.parentId) : null;
    // Database rows need their parent's schema to render properties.
    const database = parent && parent.type === 'database' ? parent : null;
    return { page: root, blocks, breadcrumbs, database };
  }

  /** Apply a batch of ops atomically: {op:'upsert', block} | {op:'delete', id} | {op:'restore', id} | {op:'purge', id}. */
  apply(ops) {
    const now = Date.now();
    return this.tx(() => {
      for (const o of ops) {
        if (o.op === 'upsert') {
          const b = o.block;
          this.q.upsert.run({ id: b.id, type: b.type, parent_id: b.parentId ?? null, position: b.position ?? 0, props: JSON.stringify(b.props || {}), now });
        } else if (o.op === 'delete') {
          this.setAliveDeep(o.id, 0, now);
        } else if (o.op === 'restore') {
          this.setAliveDeep(o.id, 1, now);
          // If the parent is gone, restore to the top level.
          const b = this.get(o.id);
          const parent = b && b.parentId ? this.get(b.parentId) : null;
          if (b && b.parentId && (!parent || !parent.alive)) {
            this.q.upsert.run({ id: b.id, type: b.type, parent_id: null, position: now, props: JSON.stringify(b.props), now });
          }
        } else if (o.op === 'purge') {
          this.purgeDeep(o.id);
        } else if (o.op === 'favorite') {
          this.q.setFavorite.run(o.value ? 1 : 0, o.id);
        } else {
          throw new Error(`unknown op ${o.op}`);
        }
      }
      return { ok: true, at: now };
    });
  }

  allChildIds(id) {
    return this.db.prepare('SELECT id FROM blocks WHERE parent_id = ?').all(id).map((r) => r.id);
  }

  setAliveDeep(id, alive, now) {
    this.q.setAlive.run(alive, now, id);
    for (const c of this.allChildIds(id)) this.setAliveDeep(c, alive, now);
  }

  purgeDeep(id) {
    for (const c of this.allChildIds(id)) this.purgeDeep(c);
    this.q.hardDelete.run(id);
  }

  trash() {
    return this.q.trash.all().map((r) => {
      const p = JSON.parse(r.props);
      return { id: r.id, type: r.type, parentId: r.parent_id, title: p.title || '', icon: p.icon || '', updatedAt: r.updated_at };
    });
  }

  /** Full-text-ish search over titles and block text. Returns containing pages. */
  search(query, limit = 30) {
    const q = String(query || '').trim().toLowerCase();
    const containers = new Map(this.tree().map((t) => [t.id, t]));
    if (!q) return [...containers.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit).map((t) => ({ ...t, snippet: '' }));
    const parentOf = new Map();
    const rows = this.q.allAliveText.all();
    for (const r of rows) parentOf.set(r.id, r.parent_id);
    const pageFor = (id) => { let cur = id; while (cur && !containers.has(cur)) cur = parentOf.get(cur); return cur; };
    const hits = new Map();
    for (const r of rows) {
      const p = JSON.parse(r.props);
      const isContainer = r.type === 'page' || r.type === 'database';
      const text = isContainer ? (p.title || '') : stripTags(p.text || '');
      const i = text.toLowerCase().indexOf(q);
      if (i < 0) continue;
      const pid = isContainer ? r.id : pageFor(r.parent_id);
      if (!pid || !containers.has(pid)) continue;
      const score = isContainer ? 2 : 1;
      const prev = hits.get(pid);
      if (!prev || prev.score < score) {
        hits.set(pid, { ...containers.get(pid), score, snippet: isContainer ? '' : text.slice(Math.max(0, i - 40), i + 80) });
      }
    }
    return [...hits.values()].sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt).slice(0, limit);
  }

  /** Deep-copy a page/database and its subtree (including nested pages). */
  duplicate(id) {
    const src = this.get(id);
    if (!src) return null;
    const now = Date.now();
    const newId = crypto.randomUUID();
    this.tx(() => {
      const copy = (b, newParent, nid) => {
        const props = { ...b.props };
        if (b.id === id) props.title = (props.title || 'Untitled') + ' (copy)';
        this.q.upsert.run({ id: nid, type: b.type, parent_id: newParent, position: b.id === id ? b.position + 0.0001 : b.position, props: JSON.stringify(props), now });
        for (const c of this.children(b.id)) copy(c, nid, crypto.randomUUID());
      };
      copy(src, src.parentId, newId);
    });
    return newId;
  }

  /** Every live block, for full backups. */
  dumpAll() {
    return this.db.prepare('SELECT * FROM blocks').all().map(Store.row);
  }
}

function stripTags(html) {
  return String(html).replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

module.exports = { Store, stripTags };
