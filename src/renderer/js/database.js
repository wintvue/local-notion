// Databases: table and board views over child pages, plus row property editors.
import { el, uid, between, popup, closeMenu, debounce, emojiPicker, toast } from './util.js';

export const PROP_TYPES = [
  { type: 'text', label: 'Text', icon: '≡' },
  { type: 'number', label: 'Number', icon: '#' },
  { type: 'select', label: 'Select', icon: '◉' },
  { type: 'multi_select', label: 'Multi-select', icon: '☰' },
  { type: 'checkbox', label: 'Checkbox', icon: '☑' },
  { type: 'date', label: 'Date', icon: '📅' },
  { type: 'url', label: 'URL', icon: '🔗' },
];
const TYPE_ICON = { title: 'Aa', ...Object.fromEntries(PROP_TYPES.map((t) => [t.type, t.icon])) };
const OPTION_COLORS = ['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'];

function optionChip(opt, onRemove) {
  return el('span', { class: `chip opt-${opt?.color || 'gray'}` }, opt ? opt.name : '?', onRemove ? el('button', { class: 'chip-x', onclick: (e) => { e.stopPropagation(); onRemove(); } }, '×') : null);
}

/** Convert a value when a property changes type. */
function convertValue(v, from, to, col) {
  if (v == null || v === '') return undefined;
  const asText = Array.isArray(v) ? v.map((id) => col.options?.find((o) => o.id === id)?.name || '').join(', ')
    : (from === 'select' ? col.options?.find((o) => o.id === v)?.name : String(v));
  switch (to) {
    case 'number': { const n = parseFloat(asText); return Number.isFinite(n) ? n : undefined; }
    case 'checkbox': return v === true || /^(true|yes|1|x)$/i.test(asText);
    case 'select': return from === 'multi_select' ? v[0] : (from === 'select' ? v : undefined);
    case 'multi_select': return from === 'select' ? [v] : (from === 'multi_select' ? v : undefined);
    case 'date': return /^\d{4}-\d{2}-\d{2}/.test(asText) ? asText.slice(0, 10) : undefined;
    default: return asText;
  }
}

/** Inline editor for one property value. Calls onChange(newValue). */
export function cellEditor(col, value, onChange, { onSchemaChange, compact = false } = {}) {
  switch (col.type) {
    case 'checkbox': {
      const cb = el('input', { type: 'checkbox', class: 'cell-check' });
      cb.checked = !!value;
      cb.addEventListener('change', () => onChange(cb.checked));
      return el('div', { class: 'cell-inner center' }, cb);
    }
    case 'number': case 'text': case 'url': {
      const input = el('input', { class: 'cell-input', type: col.type === 'number' ? 'number' : 'text', value: value ?? '', placeholder: compact ? '' : 'Empty', step: 'any' });
      const commit = debounce(() => {
        const v = col.type === 'number' ? (input.value === '' ? undefined : parseFloat(input.value)) : (input.value || undefined);
        onChange(v);
      }, 300);
      input.addEventListener('input', commit);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { commit.flush(); input.blur(); } });
      input.addEventListener('blur', () => commit.flush());
      if (col.type === 'url' && value) {
        return el('div', { class: 'cell-inner url' }, input, el('button', { class: 'cell-open', title: 'Open link', onclick: () => window.open(/^https?:/.test(value) ? value : `https://${value}`) }, '↗'));
      }
      return el('div', { class: 'cell-inner' }, input);
    }
    case 'date': {
      const input = el('input', { class: 'cell-input', type: 'date', value: value || '' });
      input.addEventListener('change', () => onChange(input.value || undefined));
      return el('div', { class: 'cell-inner' }, input);
    }
    case 'select': case 'multi_select': {
      const multi = col.type === 'multi_select';
      const box = el('div', { class: 'cell-inner chips', tabindex: '0' });
      const selected = () => (multi ? (Array.isArray(value) ? value : []) : (value ? [value] : []));
      const draw = () => {
        box.textContent = '';
        for (const id of selected()) box.append(optionChip(col.options?.find((o) => o.id === id)));
        if (!selected().length && !compact) box.append(el('span', { class: 'muted' }, 'Empty'));
      };
      draw();
      box.addEventListener('click', () => openSelectEditor(box, col, selected(), multi, (ids) => {
        value = multi ? ids : ids[0];
        draw();
        onChange(multi ? (ids.length ? ids : undefined) : (ids[0] || undefined));
      }, onSchemaChange));
      return box;
    }
    default: {
      const input = el('input', { class: 'cell-input', value: value ?? '' });
      input.addEventListener('change', () => onChange(input.value));
      return el('div', { class: 'cell-inner' }, input);
    }
  }
}

function openSelectEditor(anchor, col, selected, multi, onPick, onSchemaChange) {
  let current = [...selected];
  const input = el('input', { class: 'input', placeholder: multi ? 'Search or create options' : 'Search or create an option' });
  const chips = el('div', { class: 'select-chips' });
  const list = el('div', { class: 'select-list' });
  const draw = () => {
    chips.textContent = '';
    for (const id of current) chips.append(optionChip(col.options.find((o) => o.id === id), () => { current = current.filter((x) => x !== id); onPick(current); draw(); }));
    list.textContent = '';
    const q = input.value.trim().toLowerCase();
    const opts = (col.options || []).filter((o) => o.name.toLowerCase().includes(q));
    list.append(el('div', { class: 'popup-header' }, 'Select an option or create one'));
    for (const o of opts) {
      list.append(el('div', {
        class: 'popup-item', onclick: () => {
          if (multi) current = current.includes(o.id) ? current.filter((x) => x !== o.id) : [...current, o.id];
          else current = current[0] === o.id ? [] : [o.id];
          onPick(current);
          if (!multi) closeMenu(); else { input.value = ''; draw(); }
        },
      }, optionChip(o), current.includes(o.id) ? el('span', { class: 'popup-hint' }, '✓') : null,
      el('button', { class: 'opt-more', title: 'Edit option', onclick: (e) => { e.stopPropagation(); editOption(e.currentTarget, col, o, onSchemaChange, () => { current = current.filter((x) => col.options.some((y) => y.id === x)); onPick(current); }); } }, '⋯')));
    }
    if (q && !(col.options || []).some((o) => o.name.toLowerCase() === q)) {
      list.append(el('div', {
        class: 'popup-item', onclick: () => {
          const o = { id: uid().slice(0, 8), name: input.value.trim(), color: OPTION_COLORS[(col.options || []).length % OPTION_COLORS.length] };
          col.options = [...(col.options || []), o];
          onSchemaChange();
          current = multi ? [...current, o.id] : [o.id];
          onPick(current);
          if (!multi) closeMenu(); else { input.value = ''; draw(); }
        },
      }, 'Create ', optionChip({ name: input.value.trim(), color: 'gray' })));
    }
  };
  input.addEventListener('input', draw);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); list.querySelector('.popup-item')?.click(); } });
  draw();
  popup(anchor, { content: el('div', { class: 'select-editor' }, chips, input, list) });
  input.focus();
}

function editOption(anchor, col, opt, onSchemaChange, onDeleted) {
  const name = el('input', { class: 'input', value: opt.name });
  name.addEventListener('change', () => { opt.name = name.value.trim() || opt.name; onSchemaChange(); });
  const colors = el('div', { class: 'opt-colors' });
  for (const c of OPTION_COLORS) {
    colors.append(el('div', { class: `popup-item${opt.color === c ? ' active' : ''}`, onclick: () => { opt.color = c; onSchemaChange(); closeMenu(); } }, el('span', { class: `chip opt-${c}` }, c)));
  }
  popup(anchor, {
    content: el('div', { class: 'opt-editor' }, name,
      el('div', { class: 'popup-item danger', onclick: () => { col.options = col.options.filter((o) => o !== opt); onSchemaChange(); closeMenu(); onDeleted(); } }, '🗑 Delete'),
      el('div', { class: 'popup-header' }, 'Colors'), colors),
  });
  name.focus();
}

/** Column header menu: rename, change type, sort, delete. */
function columnMenu(anchor, col, { onRename, onType, onSort, onDelete, onHide }) {
  const name = el('input', { class: 'input', value: col.name });
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { onRename(name.value.trim() || col.name); closeMenu(); } });
  name.addEventListener('change', () => onRename(name.value.trim() || col.name));
  const box = el('div', { class: 'col-menu' }, name);
  const item = (label, icon, fn, cls = '') => el('div', { class: `popup-item ${cls}`, onclick: () => { closeMenu(); fn(); } }, el('span', { class: 'popup-icon' }, icon), label);
  if (col.type !== 'title') {
    box.append(el('div', { class: 'popup-header' }, 'Type'));
    for (const t of PROP_TYPES) box.append(el('div', { class: `popup-item${col.type === t.type ? ' active' : ''}`, onclick: () => { closeMenu(); onType(t.type); } }, el('span', { class: 'popup-icon' }, t.icon), t.label));
    box.append(el('div', { class: 'popup-sep' }));
  }
  box.append(item('Sort ascending', '↑', () => onSort('asc')), item('Sort descending', '↓', () => onSort('desc')));
  if (onHide && col.type !== 'title') box.append(item('Hide in view', '◌', onHide));
  if (col.type !== 'title') box.append(item('Delete property', '🗑', onDelete, 'danger'));
  popup(anchor, { content: box });
  name.focus();
  name.select();
}

export class DatabaseView {
  constructor(host, app, db, { inline = false, data = null, onDbChange } = {}) {
    this.host = host;
    this.app = app;
    this.db = db;
    this.inline = inline;
    this.onDbChange = onDbChange;
    this.search = '';
    this.viewId = null;
    this.saveDb = debounce(() => this.persistDb(), 250);
    this.rowSaves = new Map();
    this.pendingRows = new Set();
    if (data) { this.setData(data); this.render(); } else this.load();
  }

  destroy() {
    this.saveDb.flush();
    this.flushRows();
  }

  async load() {
    const data = await window.api.loadPage(this.db.id);
    if (!data) return;
    this.db = data.page;
    this.setData(data);
    this.render();
  }

  setData(data) {
    this.rows = data.blocks.filter((b) => b.parentId === this.db.id && b.type === 'page').sort((a, b) => a.position - b.position);
    const p = this.db.props;
    if (!p.schema) p.schema = [{ id: 'title', name: 'Name', type: 'title' }];
    if (!p.views || !p.views.length) p.views = [{ id: 'table', type: 'table', name: 'Table' }];
  }

  get schema() { return this.db.props.schema; }
  get view() { return this.db.props.views.find((v) => v.id === this.viewId) || this.db.props.views[0]; }

  async persistDb() {
    await window.api.apply([{ op: 'upsert', block: this.db }]);
    this.onDbChange && this.onDbChange();
    if (this.inline) this.app.refreshSidebar();
  }

  schemaChanged() { this.saveDb(); this.render(); }

  setRowValue(row, colId, value) {
    if (colId === 'title') row.props.title = value || '';
    else {
      row.props.values = row.props.values || {};
      if (value === undefined) delete row.props.values[colId]; else row.props.values[colId] = value;
    }
    this.saveRow(row);
  }

  saveRow(row) {
    this.pendingRows.add(row);
    clearTimeout(this.rowTimer);
    this.rowTimer = setTimeout(() => this.flushRows(), 250);
  }

  async flushRows() {
    clearTimeout(this.rowTimer);
    if (!this.pendingRows.size) return;
    const ops = [...this.pendingRows].map((r) => ({ op: 'upsert', block: r }));
    this.pendingRows.clear();
    await window.api.apply(ops);
  }

  value(row, col) { return col.type === 'title' ? row.props.title : row.props.values?.[col.id]; }

  visibleRows() {
    let rows = [...this.rows];
    const q = this.search.trim().toLowerCase();
    if (q) {
      rows = rows.filter((r) => this.schema.some((c) => {
        const v = this.value(r, c);
        if (v == null) return false;
        if (c.type === 'select') return (c.options?.find((o) => o.id === v)?.name || '').toLowerCase().includes(q);
        if (c.type === 'multi_select') return (v || []).some((id) => (c.options?.find((o) => o.id === id)?.name || '').toLowerCase().includes(q));
        return String(v).toLowerCase().includes(q);
      }));
    }
    const sort = this.view.sort;
    const col = sort && this.schema.find((c) => c.id === sort.col);
    if (col) {
      const key = (r) => {
        const v = this.value(r, col);
        if (col.type === 'select') return col.options?.findIndex((o) => o.id === v) ?? -1;
        if (col.type === 'checkbox') return v ? 1 : 0;
        return v ?? '';
      };
      rows.sort((a, b) => {
        const x = key(a), y = key(b);
        const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
        return sort.dir === 'desc' ? -c : c;
      });
    }
    return rows;
  }

  async addRow(values = {}, title = '') {
    const last = this.rows[this.rows.length - 1];
    const row = { id: uid(), type: 'page', parentId: this.db.id, position: last ? last.position + 1 : 1, props: { title, icon: '', values } };
    this.rows.push(row);
    await window.api.apply([{ op: 'upsert', block: row }]);
    this.render();
    return row;
  }

  async deleteRow(row) {
    this.rows = this.rows.filter((r) => r !== row);
    await window.api.apply([{ op: 'delete', id: row.id }]);
    this.render();
    toast('Moved to trash');
  }

  addProperty(type = 'text') {
    const col = { id: uid().slice(0, 8), name: PROP_TYPES.find((t) => t.type === type).label, type };
    if (type === 'select' || type === 'multi_select') col.options = [];
    this.schema.push(col);
    this.schemaChanged();
    return col;
  }

  // ---------------------------------------------------------------- render

  render() {
    this.host.textContent = '';
    const p = this.db.props;
    if (this.inline) {
      const title = el('div', { class: 'db-inline-title' },
        el('span', { class: 'db-inline-icon', onclick: (e) => emojiPicker(e.currentTarget, (em) => { p.icon = em; this.saveDb(); this.render(); }) }, p.icon || '▦'),
        el('span', { class: 'db-inline-name', contenteditable: 'plaintext-only', 'data-placeholder': 'Untitled database', oninput: (e) => { p.title = e.currentTarget.textContent; this.saveDb(); } }, p.title || ''),
        el('button', { class: 'ghost-btn small', title: 'Open as full page', onclick: () => this.app.navigate(this.db.id) }, '↗ Open'));
      this.host.append(title);
    }
    const tabs = el('div', { class: 'db-tabs' });
    for (const v of p.views) {
      tabs.append(el('button', {
        class: `db-tab${v === this.view ? ' active' : ''}`,
        onclick: () => { this.viewId = v.id; this.render(); },
        oncontextmenu: (e) => { e.preventDefault(); this.viewMenu(e.currentTarget, v); },
      }, v.type === 'board' ? '▥ ' : '▦ ', v.name));
    }
    tabs.append(el('button', { class: 'db-tab add', title: 'Add a view', onclick: (e) => this.addViewMenu(e.currentTarget) }, '+'));
    const searchInput = el('input', { class: 'db-search', placeholder: 'Search…', value: this.search });
    searchInput.addEventListener('input', () => { this.search = searchInput.value; this.renderBody(); });
    const toolbar = el('div', { class: 'db-toolbar' }, tabs, el('div', { class: 'db-actions' },
      this.view.sort ? el('button', { class: 'ghost-btn small', title: 'Clear sort', onclick: () => { delete this.view.sort; this.saveDb(); this.render(); } }, `${this.view.sort.dir === 'asc' ? '↑' : '↓'} ${this.schema.find((c) => c.id === this.view.sort.col)?.name || ''} ×`) : null,
      searchInput,
      el('button', { class: 'ghost-btn small', title: 'View options', onclick: (e) => this.viewMenu(e.currentTarget, this.view) }, '⋯'),
      el('button', { class: 'primary-btn small', onclick: async () => { const r = await this.addRow(this.newRowDefaults()); this.focusRowTitle(r); } }, 'New')));
    this.host.append(toolbar);
    this.body = el('div', { class: 'db-body' });
    this.host.append(this.body);
    this.renderBody();
  }

  newRowDefaults() {
    return {};
  }

  renderBody() {
    this.body.textContent = '';
    if (this.view.type === 'board') this.renderBoard();
    else this.renderTable();
  }

  focusRowTitle(row) {
    const input = this.host.querySelector(`[data-row="${row.id}"] .title-input`);
    if (input) input.focus();
  }

  viewMenu(anchor, v) {
    const items = [
      { label: 'Rename view', icon: '✎', onClick: () => setTimeout(() => {
        const input = el('input', { class: 'input', value: v.name });
        const done = () => { if (input.value.trim()) { v.name = input.value.trim(); this.saveDb(); } closeMenu(); this.render(); };
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(); });
        popup(anchor, { content: el('div', { class: 'col-menu' }, input), align: 'right' });
        input.focus(); input.select();
      }, 0) },
    ];
    if (v.type === 'board') {
      items.push({ header: 'Group by' });
      for (const c of this.schema.filter((c) => c.type === 'select')) items.push({ label: c.name, icon: '◉', active: v.groupBy === c.id, onClick: () => { v.groupBy = c.id; this.saveDb(); this.render(); } });
    }
    const hidden = new Set(v.hidden || []);
    const hideable = this.schema.filter((c) => c.type !== 'title');
    if (hideable.length) {
      items.push({ header: 'Properties' });
      for (const c of hideable) {
        items.push({ label: c.name, icon: hidden.has(c.id) ? '◌' : '●', hint: hidden.has(c.id) ? 'hidden' : '', onClick: () => {
          v.hidden = hidden.has(c.id) ? [...hidden].filter((x) => x !== c.id) : [...hidden, c.id];
          this.saveDb(); this.render();
        } });
      }
    }
    if (this.db.props.views.length > 1) {
      items.push('separator', { label: 'Delete view', icon: '🗑', danger: true, onClick: () => { this.db.props.views = this.db.props.views.filter((x) => x !== v); this.viewId = null; this.saveDb(); this.render(); } });
    }
    popup(anchor, { items, align: 'right', className: 'scroll' });
  }

  addViewMenu(anchor) {
    const add = (type) => {
      const v = { id: uid().slice(0, 8), type, name: type === 'board' ? 'Board' : 'Table' };
      this.db.props.views.push(v);
      this.viewId = v.id;
      this.saveDb();
      this.render();
    };
    popup(anchor, { items: [{ label: 'Table', icon: '▦', onClick: () => add('table') }, { label: 'Board', icon: '▥', onClick: () => add('board') }] });
  }

  colCallbacks(col) {
    return {
      onRename: (name) => { col.name = name; this.schemaChanged(); },
      onType: (type) => {
        if (type === col.type) return;
        const from = col.type;
        if ((type === 'select' || type === 'multi_select') && !col.options) col.options = [];
        if ((type === 'select' || type === 'multi_select') && from !== 'select' && from !== 'multi_select') {
          // Build options from existing text values.
          for (const r of this.rows) {
            const v = r.props.values?.[col.id];
            if (v == null || v === '') continue;
            for (const name of String(v).split(',').map((s) => s.trim()).filter(Boolean)) {
              if (!col.options.some((o) => o.name === name)) col.options.push({ id: uid().slice(0, 8), name, color: OPTION_COLORS[col.options.length % OPTION_COLORS.length] });
            }
          }
          for (const r of this.rows) {
            const v = r.props.values?.[col.id];
            if (v == null || v === '') continue;
            const ids = String(v).split(',').map((s) => col.options.find((o) => o.name === s.trim())?.id).filter(Boolean);
            r.props.values[col.id] = type === 'select' ? ids[0] : ids;
            this.saveRow(r);
          }
        } else {
          for (const r of this.rows) {
            if (!r.props.values || !(col.id in r.props.values)) continue;
            const nv = convertValue(r.props.values[col.id], from, type, col);
            if (nv === undefined) delete r.props.values[col.id]; else r.props.values[col.id] = nv;
            this.saveRow(r);
          }
        }
        col.type = type;
        this.schemaChanged();
      },
      onSort: (dir) => { this.view.sort = { col: col.id, dir }; this.saveDb(); this.render(); },
      onHide: () => { this.view.hidden = [...(this.view.hidden || []), col.id]; this.saveDb(); this.render(); },
      onDelete: () => {
        if (!confirm(`Delete the property "${col.name}"?`)) return;
        this.db.props.schema = this.schema.filter((c) => c !== col);
        this.schemaChanged();
      },
    };
  }

  renderTable() {
    const hidden = new Set(this.view.hidden || []);
    const cols = this.schema.filter((c) => !hidden.has(c.id));
    const widths = this.view.widths || {};
    const table = el('div', { class: 'db-table' });
    const head = el('div', { class: 'db-row head' });
    for (const col of cols) {
      const cell = el('div', { class: `db-cell head${col.type === 'title' ? ' title' : ''}`, style: { width: `${widths[col.id] || (col.type === 'title' ? 260 : 180)}px` } },
        el('span', { class: 'col-icon' }, TYPE_ICON[col.type] || '≡'), el('span', { class: 'col-name' }, col.name));
      cell.addEventListener('click', () => columnMenu(cell, col, this.colCallbacks(col)));
      const grip = el('div', { class: 'col-resize', onclick: (e) => e.stopPropagation() });
      grip.addEventListener('mousedown', (e) => {
        e.preventDefault(); e.stopPropagation();
        const start = e.clientX; const w0 = cell.getBoundingClientRect().width;
        const cells = () => table.querySelectorAll(`[data-col="${col.id}"]`);
        const move = (ev) => { const w = Math.max(80, w0 + ev.clientX - start); cell.style.width = `${w}px`; cells().forEach((c) => { c.style.width = `${w}px`; }); };
        const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); this.view.widths = { ...(this.view.widths || {}), [col.id]: Math.round(cell.getBoundingClientRect().width) }; this.saveDb(); };
        document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
      });
      cell.append(grip);
      head.append(cell);
    }
    head.append(el('div', { class: 'db-cell head add', title: 'Add a property', onclick: (e) => {
      popup(e.currentTarget, { items: [{ header: 'Property type' }, ...PROP_TYPES.map((t) => ({ label: t.label, icon: t.icon, onClick: () => { const c = this.addProperty(t.type); setTimeout(() => { const h = [...this.body.querySelectorAll('.db-cell.head')].find((x) => x.textContent.includes(c.name)); if (h) h.click(); }, 0); } }))] });
    } }, '+'));
    table.append(head);

    for (const row of this.visibleRows()) {
      const r = el('div', { class: 'db-row', dataset: { row: row.id } });
      for (const col of cols) {
        const cell = el('div', { class: `db-cell${col.type === 'title' ? ' title' : ''}`, dataset: { col: col.id }, style: { width: `${widths[col.id] || (col.type === 'title' ? 260 : 180)}px` } });
        if (col.type === 'title') {
          const input = el('input', { class: 'cell-input title-input', value: row.props.title || '', placeholder: 'Untitled' });
          input.addEventListener('input', () => { row.props.title = input.value; this.saveRow(row); });
          input.addEventListener('keydown', async (e) => {
            if (e.key === 'Enter') { e.preventDefault(); const nr = await this.addRow(this.newRowDefaults()); this.focusRowTitle(nr); }
          });
          cell.append(...[
            row.props.icon ? el('span', { class: 'row-icon' }, row.props.icon) : null,
            input,
            el('button', { class: 'row-open', title: 'Open as page', onclick: async () => { await this.flushRows(); this.app.navigate(row.id); } }, '↗ Open'),
            el('button', { class: 'row-del', title: 'Delete row', onclick: () => this.deleteRow(row) }, '🗑')].filter(Boolean));
        } else {
          cell.append(cellEditor(col, this.value(row, col), (v) => this.setRowValue(row, col.id, v), { onSchemaChange: () => this.saveDb(), compact: true }));
        }
        r.append(cell);
      }
      table.append(r);
    }
    table.append(el('div', { class: 'db-new-row', onclick: async () => { const nr = await this.addRow(this.newRowDefaults()); this.focusRowTitle(nr); } }, '+ New'));
    const count = this.visibleRows().length;
    table.append(el('div', { class: 'db-count' }, `${count} ${count === 1 ? 'row' : 'rows'}`));
    this.body.append(el('div', { class: 'db-scroll' }, table));
  }

  renderBoard() {
    let group = this.schema.find((c) => c.id === this.view.groupBy && c.type === 'select') || this.schema.find((c) => c.type === 'select');
    if (!group) {
      this.body.append(el('div', { class: 'db-empty' }, 'Board views group cards by a Select property. ',
        el('button', { class: 'primary-btn small', onclick: () => { const c = this.addProperty('select'); c.name = 'Status'; c.options = [{ id: 'todo', name: 'Not started', color: 'gray' }, { id: 'doing', name: 'In progress', color: 'blue' }, { id: 'done', name: 'Done', color: 'green' }]; this.view.groupBy = c.id; this.schemaChanged(); } }, 'Add a Status property')));
      return;
    }
    this.view.groupBy = group.id;
    const hidden = new Set(this.view.hidden || []);
    const shown = this.schema.filter((c) => c.type !== 'title' && c.id !== group.id && !hidden.has(c.id));
    const board = el('div', { class: 'board' });
    const rows = this.visibleRows();
    const groups = [{ id: undefined, name: `No ${group.name}`, color: 'gray' }, ...(group.options || [])];
    let dragRow = null;
    for (const g of groups) {
      const items = rows.filter((r) => (r.props.values?.[group.id] || undefined) === g.id);
      if (g.id === undefined && !items.length) continue;
      const col = el('div', { class: 'board-col' });
      col.append(el('div', { class: 'board-head' }, optionChip(g), el('span', { class: 'muted' }, String(items.length))));
      const list = el('div', { class: 'board-list' });
      for (const r of items) {
        const card = el('div', { class: 'board-card', draggable: 'true', onclick: async () => { await this.flushRows(); this.app.navigate(r.id); } },
          el('div', { class: 'card-title' }, r.props.icon ? `${r.props.icon} ` : '', r.props.title || 'Untitled'));
        for (const c of shown) {
          const v = this.value(r, c);
          if (v == null || v === '' || (Array.isArray(v) && !v.length) || v === false) continue;
          let disp;
          if (c.type === 'select') disp = optionChip(c.options?.find((o) => o.id === v));
          else if (c.type === 'multi_select') disp = el('span', {}, v.map((id) => optionChip(c.options?.find((o) => o.id === id))));
          else if (c.type === 'checkbox') disp = `☑ ${c.name}`;
          else disp = `${c.type === 'number' ? c.name + ': ' : ''}${v}`;
          card.append(el('div', { class: 'card-prop' }, disp));
        }
        card.addEventListener('dragstart', (e) => { dragRow = r; e.dataTransfer.effectAllowed = 'move'; card.classList.add('dragging'); });
        card.addEventListener('dragend', () => { card.classList.remove('dragging'); dragRow = null; });
        list.append(card);
      }
      list.append(el('div', { class: 'board-add', onclick: async () => { const nr = await this.addRow(g.id ? { [group.id]: g.id } : {}); this.app.navigate(nr.id); } }, '+ New'));
      col.addEventListener('dragover', (e) => { if (dragRow) { e.preventDefault(); col.classList.add('over'); } });
      col.addEventListener('dragleave', (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove('over'); });
      col.addEventListener('drop', (e) => {
        e.preventDefault();
        col.classList.remove('over');
        if (!dragRow) return;
        // Place relative to the card under the cursor.
        const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('.board-card');
        const overRow = over && items[[...list.querySelectorAll('.board-card')].indexOf(over)];
        if (overRow && overRow !== dragRow) {
          const idx = this.rows.indexOf(overRow);
          dragRow.position = between(this.rows[idx - 1]?.position, overRow.position);
          this.rows.sort((a, b) => a.position - b.position);
        }
        this.setRowValue(dragRow, group.id, g.id);
        this.renderBody();
      });
      col.append(list);
      board.append(col);
    }
    this.body.append(board);
  }
}

/** Property rows shown at the top of a database row page. */
export class PropertyList {
  constructor(db, row, { onChange, onSchemaChange }) {
    this.el = el('div', { class: 'prop-list' });
    row.props.values = row.props.values || {};
    for (const col of db.props.schema || []) {
      if (col.type === 'title') continue;
      this.el.append(el('div', { class: 'prop-row' },
        el('div', { class: 'prop-name' }, el('span', { class: 'col-icon' }, TYPE_ICON[col.type] || '≡'), col.name),
        el('div', { class: 'prop-value' }, cellEditor(col, row.props.values[col.id], (v) => {
          if (v === undefined) delete row.props.values[col.id]; else row.props.values[col.id] = v;
          onChange();
        }, { onSchemaChange: () => onSchemaChange(db.props.schema) }))));
    }
    this.el.append(el('div', { class: 'prop-sep' }));
  }
}
