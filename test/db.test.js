'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Store } = require('../src/main/db');
const { seed } = require('../src/main/seed');

const mk = () => new Store(':memory:');
const up = (id, type, parentId, position, props = {}) => ({ op: 'upsert', block: { id, type, parentId, position, props } });

test('upsert, load page subtree, stop at nested pages', () => {
  const s = mk();
  s.apply([up('p', 'page', null, 1, { title: 'Root' }), up('a', 'paragraph', 'p', 1, { text: 'hi' }),
    up('b', 'toggle', 'p', 2, { text: 't' }), up('c', 'paragraph', 'b', 1, { text: 'inner' }),
    up('sub', 'page', 'p', 3, { title: 'Sub' }), up('subtext', 'paragraph', 'sub', 1, { text: 'hidden' })]);
  const r = s.loadPage('p');
  assert.deepStrictEqual(r.blocks.map((b) => b.id), ['a', 'b', 'c', 'sub']);
  assert.deepStrictEqual(s.loadPage('sub').breadcrumbs.map((b) => b.id), ['p']);
});

test('delete is soft and deep; restore brings it back; purge removes', () => {
  const s = mk();
  s.apply([up('p', 'page', null, 1, { title: 'Root' }), up('sub', 'page', 'p', 1, { title: 'Sub' }), up('x', 'paragraph', 'sub', 1, { text: 'x' })]);
  s.apply([{ op: 'delete', id: 'p' }]);
  assert.strictEqual(s.tree().length, 0);
  assert.deepStrictEqual(s.trash().map((t) => t.id).sort(), ['p', 'sub']);
  s.apply([{ op: 'restore', id: 'sub' }]);
  assert.strictEqual(s.get('sub').parentId, null, 'orphan restored to top level');
  assert.strictEqual(s.loadPage('sub').blocks.length, 1);
  s.apply([{ op: 'purge', id: 'p' }]);
  assert.strictEqual(s.get('p'), null);
});

test('search finds titles and block text', () => {
  const s = mk();
  s.apply([up('p', 'page', null, 1, { title: 'Recipes' }), up('a', 'paragraph', 'p', 1, { text: 'Bake the <b>sourdough</b> bread' })]);
  assert.strictEqual(s.search('recip')[0].id, 'p');
  const hit = s.search('sourdough')[0];
  assert.strictEqual(hit.id, 'p');
  assert.match(hit.snippet, /sourdough bread/);
});

test('duplicate copies the subtree with new ids', () => {
  const s = mk();
  s.apply([up('p', 'page', null, 1, { title: 'A' }), up('a', 'paragraph', 'p', 1, { text: 'x' })]);
  const id = s.duplicate('p');
  assert.notStrictEqual(id, 'p');
  assert.strictEqual(s.get(id).props.title, 'A (copy)');
  assert.strictEqual(s.loadPage(id).blocks[0].props.text, 'x');
});

test('seed creates a usable workspace with a database', () => {
  const s = mk();
  seed(s);
  const tree = s.tree();
  const db = tree.find((t) => t.type === 'database');
  assert.ok(db);
  const loaded = s.loadPage(db.id);
  assert.strictEqual(loaded.blocks.filter((b) => b.type === 'page').length, 3);
  const row = loaded.blocks[0];
  assert.strictEqual(s.loadPage(row.id).database.id, db.id);
});

test('failed batch rolls back every write and leaves the store usable', t => {
  const s = mk(); t.after(() => s.close());
  assert.throws(() => s.apply([up('p', 'page', null, 1, { title: 'Rollback' }), { op: 'invalid' }]), /unknown op/);
  assert.strictEqual(s.get('p'), null);
  s.apply([up('p', 'page', null, 1, { title: 'Committed' })]);
  assert.strictEqual(s.get('p').props.title, 'Committed');
});

test('updates preserve creation time and favorites while ordering children', t => {
  const s = mk(); t.after(() => s.close());
  s.apply([up('p', 'page', null, 1, { title: 'Original' }), up('b', 'paragraph', 'p', 2, { text: 'b' }), up('a', 'paragraph', 'p', 1, { text: 'a' }), { op: 'favorite', id: 'p', value: true }]);
  const createdAt = s.get('p').createdAt;
  s.apply([up('p', 'page', null, 1, { title: 'Renamed' })]);
  assert.strictEqual(s.get('p').createdAt, createdAt);
  assert.strictEqual(s.tree()[0].favorite, true);
  assert.deepStrictEqual(s.children('p').map(b => b.id), ['a', 'b']);
  s.apply([{ op: 'favorite', id: 'p', value: false }]);
  assert.strictEqual(s.tree()[0].favorite, false);
});

test('search excludes trash, attributes nested text to its nearest page and limits hits', t => {
  const s = mk(); t.after(() => s.close());
  s.apply([up('p', 'page', null, 1, { title: 'Outer' }), up('sub', 'page', 'p', 1, { title: 'Inner' }), up('toggle', 'toggle', 'sub', 1, { text: 'summary' }), up('text', 'paragraph', 'toggle', 1, { text: 'Unique needle' })]);
  assert.deepStrictEqual(s.search('NEEDLE').map(b => b.id), ['sub']);
  assert.strictEqual(s.search('', 1).length, 1);
  s.apply([{ op: 'delete', id: 'sub' }]);
  assert.deepStrictEqual(s.search('needle'), []);
  s.apply([{ op: 'restore', id: 'sub' }]);
  assert.strictEqual(s.search('needle')[0].id, 'sub');
});

test('duplicating databases preserves schema and remaps nested parents independently', t => {
  const s = mk(); t.after(() => s.close());
  const schema = [{ id: 'status', type: 'select', options: ['Todo', 'Done'] }];
  s.apply([up('db', 'database', null, 1, { title: 'Tasks', schema }), up('row', 'page', 'db', 1, { title: 'Task', values: { status: 'Todo' } }), up('text', 'paragraph', 'row', 1, { text: 'Details' })]);
  const id = s.duplicate('db');
  const copy = s.loadPage(id), row = copy.blocks[0];
  assert.deepStrictEqual(copy.page.props.schema, schema);
  assert.notStrictEqual(row.id, 'row');
  assert.strictEqual(row.parentId, id);
  assert.deepStrictEqual(row.props.values, { status: 'Todo' });
  const text = s.loadPage(row.id).blocks[0];
  assert.notStrictEqual(text.id, 'text');
  assert.strictEqual(text.parentId, row.id);
  s.apply([up(text.id, 'paragraph', row.id, 1, { text: 'Changed' })]);
  assert.strictEqual(s.get('text').props.text, 'Details');
});

test('file-backed storage persists blocks, metadata, favorites and trash across reopening', t => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-notion-db-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'test.db');
  let s = new Store(file);
  try {
    s.apply([up('p', 'page', null, 1, { title: 'Persisted' }), { op: 'favorite', id: 'p', value: true }, { op: 'delete', id: 'p' }]);
    s.setMeta('preferences', { theme: 'dark', expanded: ['p'] });
  } finally { s.close(); }
  s = new Store(file);
  try {
    assert.deepStrictEqual(s.getMeta('preferences'), { theme: 'dark', expanded: ['p'] });
    assert.strictEqual(s.getMeta('missing'), undefined);
    assert.strictEqual(s.trash()[0].id, 'p');
    s.apply([{ op: 'restore', id: 'p' }]);
    assert.strictEqual(s.tree()[0].favorite, true);
    assert.strictEqual(s.loadPage('p').page.props.title, 'Persisted');
  } finally { s.close(); }
});

test('purge removes descendants that were already trashed', t => {
  const s = mk(); t.after(() => s.close());
  s.apply([up('p', 'page', null, 1, {}), up('sub', 'page', 'p', 1, {}), up('text', 'paragraph', 'sub', 1, { text: 'gone' })]);
  s.apply([{ op: 'delete', id: 'sub' }, { op: 'delete', id: 'p' }, { op: 'purge', id: 'p' }]);
  assert.deepStrictEqual(s.dumpAll(), []);
  assert.strictEqual(s.loadPage('missing'), null);
  assert.strictEqual(s.duplicate('missing'), null);
});
