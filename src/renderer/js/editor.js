// Block editor for a single page.
import {
  el, uid, sanitize, between, debounce, caretOffset, setCaret, splitAtCaret, caretAtStart, caretAtEnd,
  caretOnFirstLine, caretOnLastLine, setCaretAtX, popup, closeMenu, emojiPicker, htmlToText, COLORS, timeAgo, toast,
} from './util.js';
import { markdownToBlocks } from './markdown.js';
import { DatabaseView, PropertyList } from './database.js';

export const BLOCK_TYPES = [
  { type: 'paragraph', label: 'Text', icon: 'Aa', desc: 'Plain text', keys: 'text paragraph plain' },
  { type: 'heading1', label: 'Heading 1', icon: 'H1', desc: 'Big section heading', keys: 'h1 heading title' },
  { type: 'heading2', label: 'Heading 2', icon: 'H2', desc: 'Medium section heading', keys: 'h2 heading subtitle' },
  { type: 'heading3', label: 'Heading 3', icon: 'H3', desc: 'Small section heading', keys: 'h3 heading' },
  { type: 'bulleted', label: 'Bulleted list', icon: '•', desc: 'Simple bulleted list', keys: 'bullet list ul unordered' },
  { type: 'numbered', label: 'Numbered list', icon: '1.', desc: 'List with numbering', keys: 'number list ol ordered' },
  { type: 'todo', label: 'To-do list', icon: '☑', desc: 'Track tasks with a checkbox', keys: 'todo task check checkbox' },
  { type: 'toggle', label: 'Toggle list', icon: '▸', desc: 'Toggles can hide content', keys: 'toggle collapse details' },
  { type: 'quote', label: 'Quote', icon: '❝', desc: 'Capture a quote', keys: 'quote blockquote citation' },
  { type: 'callout', label: 'Callout', icon: '💡', desc: 'Make writing stand out', keys: 'callout note info tip' },
  { type: 'code', label: 'Code', icon: '</>', desc: 'Capture a code snippet', keys: 'code snippet pre' },
  { type: 'divider', label: 'Divider', icon: '—', desc: 'Visually divide blocks', keys: 'divider hr line separator' },
  { type: 'page', label: 'Page', icon: '📄', desc: 'Embed a sub-page', keys: 'page subpage link' },
  { type: 'database', label: 'Database', icon: '▦', desc: 'Inline table and board', keys: 'database table board kanban' },
  { type: 'image', label: 'Image', icon: '🖼', desc: 'Upload an image', keys: 'image picture photo upload' },
  { type: 'toc', label: 'Table of contents', icon: '☰', desc: 'Links to headings on the page', keys: 'toc contents outline' },
];
const TYPE_INFO = Object.fromEntries(BLOCK_TYPES.map((t) => [t.type, t]));
const TEXT_TYPES = new Set(['paragraph', 'heading1', 'heading2', 'heading3', 'bulleted', 'numbered', 'todo', 'toggle', 'quote', 'callout', 'code']);
const CONTINUING = new Set(['bulleted', 'numbered', 'todo', 'toggle']);
const NO_CHILDREN = new Set(['code', 'divider', 'image', 'page', 'database', 'toc']);
const LANGUAGES = ['plain', 'javascript', 'typescript', 'python', 'json', 'html', 'css', 'bash', 'sql', 'go', 'rust', 'java', 'c', 'cpp', 'swift', 'ruby', 'php', 'markdown', 'yaml'];
const COVERS = [
  'linear-gradient(120deg,#f6d365,#fda085)', 'linear-gradient(120deg,#a1c4fd,#c2e9fb)', 'linear-gradient(120deg,#84fab0,#8fd3f4)',
  'linear-gradient(120deg,#fbc2eb,#a6c1ee)', 'linear-gradient(120deg,#434343,#000000)', 'linear-gradient(120deg,#e0c3fc,#8ec5fc)',
  'linear-gradient(120deg,#ffecd2,#fcb69f)', 'linear-gradient(120deg,#30cfd0,#330867)',
];

export class PageEditor {
  constructor(root, data, app) {
    this.root = root;
    this.app = app;
    this.page = data.page;
    this.database = data.database;
    this.breadcrumbs = data.breadcrumbs;
    this.blocks = new Map(data.blocks.map((b) => [b.id, b]));
    this.nodes = new Map();
    this.dirty = new Set();
    this.pendingOps = [];
    this.undoStack = [];
    this.redoStack = [];
    this.lastEditAt = 0;
    this.slash = null;
    this.save = debounce(() => this.flush(), 350);
    this.onSelectionChange = () => this.updateFormatBar();
    document.addEventListener('selectionchange', this.onSelectionChange);
    this.render();
  }

  destroy() {
    this.flush();
    document.removeEventListener('selectionchange', this.onSelectionChange);
    this.hideFormatBar();
    closeMenu();
    if (this.dbView) this.dbView.destroy();
  }

  // ---------------------------------------------------------------- model

  children(pid) {
    const out = [];
    for (const b of this.blocks.values()) if (b.parentId === pid) out.push(b);
    return out.sort((a, b) => a.position - b.position);
  }

  isRootChild(b) { return b.parentId === this.page.id; }

  markDirty(b) {
    this.dirty.add(b.id);
    this.save();
  }

  touchPage() { this.dirty.add(this.page.id); this.save(); }

  async flush() {
    const ops = [...this.pendingOps];
    this.pendingOps = [];
    for (const id of this.dirty) {
      const b = id === this.page.id ? this.page : this.blocks.get(id);
      if (b) ops.push({ op: 'upsert', block: { id: b.id, type: b.type, parentId: b.parentId, position: b.position, props: b.props } });
    }
    this.dirty.clear();
    if (!ops.length) return;
    try {
      await window.api.apply(ops);
      this.page.updatedAt = Date.now();
      this.app.onPageSaved(this);
    } catch (e) {
      console.error(e);
      toast('Could not save changes');
    }
  }

  addBlock(type, parentId, position, props = {}) {
    const b = { id: uid(), type, parentId, position, props: { ...defaultProps(type), ...props } };
    this.blocks.set(b.id, b);
    this.markDirty(b);
    return b;
  }

  removeBlock(b) {
    const drop = (x) => { for (const c of this.children(x.id)) drop(c); this.blocks.delete(x.id); this.dirty.delete(x.id); };
    drop(b);
    this.pendingOps.push({ op: 'delete', id: b.id });
    this.save();
  }

  /** Position for a new child of parentId right after `after` (or first if null). */
  positionAfter(parentId, after) {
    const sibs = this.children(parentId);
    if (!after) return between(undefined, sibs[0]?.position);
    const i = sibs.findIndex((s) => s.id === after.id);
    return between(after.position, sibs[i + 1]?.position);
  }

  positionBefore(parentId, before) {
    const sibs = this.children(parentId);
    const i = sibs.findIndex((s) => s.id === before.id);
    return between(sibs[i - 1]?.position, before.position);
  }

  lastChildPosition(parentId) {
    const sibs = this.children(parentId);
    return sibs.length ? sibs[sibs.length - 1].position + 1 : 1;
  }

  /** Blocks in reading order, skipping collapsed toggle contents. */
  visibleOrder() {
    const out = [];
    const walk = (pid) => {
      for (const b of this.children(pid)) {
        out.push(b);
        if (!(b.type === 'toggle' && b.props.collapsed) && !NO_CHILDREN.has(b.type)) walk(b.id);
      }
    };
    walk(this.page.id);
    return out;
  }

  prevVisible(b, textOnly = false) {
    const order = this.visibleOrder();
    for (let i = order.findIndex((x) => x.id === b.id) - 1; i >= 0; i--) if (!textOnly || TEXT_TYPES.has(order[i].type)) return order[i];
    return null;
  }

  nextVisible(b, textOnly = false) {
    const order = this.visibleOrder();
    const start = order.findIndex((x) => x.id === b.id);
    for (let i = start + 1; i < order.length; i++) if (!textOnly || TEXT_TYPES.has(order[i].type)) return order[i];
    return null;
  }

  isDescendant(id, ancestorId) {
    let cur = this.blocks.get(id);
    while (cur) { if (cur.parentId === ancestorId) return true; cur = this.blocks.get(cur.parentId); }
    return false;
  }

  // ---------------------------------------------------------------- undo

  snapshot() {
    return { page: JSON.stringify(this.page.props), blocks: new Map([...this.blocks].map(([id, b]) => [id, JSON.stringify(b)])) };
  }

  checkpoint() {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    // Typing after a structural change starts a new undo chunk.
    this.lastEditAt = Date.now() + 1;
    this.chunkStart = true;
  }

  /** Checkpoint on the first keystroke after a pause, so typing undoes in chunks. */
  checkpointTyping() {
    const now = Date.now();
    if (this.chunkStart || now - this.lastEditAt > 1000) { this.checkpoint(); this.chunkStart = false; }
    this.lastEditAt = now;
  }

  restore(snap) {
    const focus = this.currentFocus();
    for (const [id, b] of this.blocks) {
      if (!snap.blocks.has(id)) { this.pendingOps.push({ op: 'delete', id }); this.dirty.delete(id); }
      else if (snap.blocks.get(id) !== JSON.stringify(b)) this.dirty.add(id);
    }
    const next = new Map();
    for (const [id, json] of snap.blocks) {
      const b = JSON.parse(json);
      if (!this.blocks.has(id)) {
        if (b.type === 'page' || b.type === 'database') this.pendingOps.push({ op: 'restore', id });
        this.dirty.add(id);
      }
      next.set(id, b);
    }
    this.blocks = next;
    if (snap.page !== JSON.stringify(this.page.props)) { this.page.props = JSON.parse(snap.page); this.dirty.add(this.page.id); }
    this.save();
    this.render();
    if (focus && this.blocks.has(focus.id)) this.focus(focus.id, focus.offset);
    this.lastEditAt = 0;
  }

  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(this.snapshot());
    this.restore(this.undoStack.pop());
  }

  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(this.snapshot());
    this.restore(this.redoStack.pop());
  }

  // ---------------------------------------------------------------- render

  render() {
    if (this.dbView) { this.dbView.destroy(); this.dbView = null; }
    this.root.textContent = '';
    this.nodes.clear();
    const p = this.page.props;
    this.root.className = `page font-${p.font || 'default'}${p.fullWidth ? ' full-width' : ''}${p.smallText ? ' small-text' : ''}`;

    if (p.cover) this.root.append(this.renderCover());
    const header = el('div', { class: `page-header${p.cover ? ' has-cover' : ''}${p.icon ? ' has-icon' : ''}` });
    if (p.icon) header.append(el('div', { class: 'page-icon', title: 'Change icon', onclick: (e) => this.pickIcon(e.currentTarget) }, p.icon));
    const controls = el('div', { class: 'page-controls' },
      !p.icon ? el('button', { class: 'ghost-btn', onclick: (e) => this.pickIcon(e.currentTarget) }, '☺ Add icon') : null,
      !p.cover ? el('button', { class: 'ghost-btn', onclick: () => { this.checkpoint(); p.cover = COVERS[Math.floor(Math.random() * COVERS.length)]; this.touchPage(); this.render(); } }, '▭ Add cover') : null);
    header.append(controls);

    const title = el('h1', { class: 'page-title', contenteditable: 'plaintext-only', spellcheck: 'false', 'data-placeholder': 'Untitled' });
    title.textContent = p.title || '';
    title.addEventListener('input', () => {
      this.checkpointTyping();
      p.title = title.textContent.replace(/\n/g, ' ');
      this.touchPage();
      this.app.onTitleChange(this.page);
    });
    title.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || (e.key === 'ArrowDown' && caretOnLastLine(title))) {
        e.preventDefault();
        if (this.page.type === 'database') return;
        const first = this.children(this.page.id)[0];
        if (e.key === 'Enter' || !first || !TEXT_TYPES.has(first.type)) {
          this.checkpoint();
          const off = caretOffset(title);
          const rest = (p.title || '').slice(off);
          if (e.key === 'Enter' && rest) { p.title = p.title.slice(0, off); title.textContent = p.title; this.touchPage(); }
          const b = this.addBlock('paragraph', this.page.id, between(undefined, first?.position), { text: e.key === 'Enter' ? sanitize(rest.replace(/&/g, '&amp;').replace(/</g, '&lt;')) : '' });
          this.renderBlocks();
          this.focus(b.id, 0);
        } else this.focus(first.id, 0);
      }
    });
    this.titleEl = title;
    header.append(title);
    this.root.append(header);

    if (this.database) {
      this.props = new PropertyList(this.database, this.page, {
        onChange: () => this.touchPage(),
        onSchemaChange: (schema) => { this.database.props.schema = schema; window.api.apply([{ op: 'upsert', block: this.database }]); },
      });
      this.root.append(this.props.el);
    }

    if (this.page.type === 'database') {
      const host = el('div', { class: 'db-host full' });
      this.root.append(host);
      this.dbView = new DatabaseView(host, this.app, this.page, { inline: false, onDbChange: () => this.app.onTitleChange(this.page) });
      return;
    }

    this.blocksEl = el('div', { class: 'blocks' });
    this.blocksEl.addEventListener('keydown', (e) => this.onKeyDown(e));
    this.blocksEl.addEventListener('input', (e) => this.onInput(e));
    this.blocksEl.addEventListener('paste', (e) => this.onPaste(e));
    this.blocksEl.addEventListener('click', (e) => this.onClick(e));
    this.setupDrag();
    this.root.append(this.blocksEl);
    this.root.append(el('div', { class: 'page-tail', onclick: () => this.clickTail() }));
    this.root.onkeydown = (e) => this.onGlobalKey(e);
    this.renderBlocks();
  }

  renderCover() {
    const p = this.page.props;
    const isImg = p.cover.startsWith('app:') || p.cover.startsWith('http');
    const cover = el('div', { class: 'page-cover', style: isImg ? { backgroundImage: `url("${p.cover}")` } : { background: p.cover } });
    const choose = (e) => {
      const grid = el('div', { class: 'cover-grid' });
      for (const c of COVERS) grid.append(el('button', { class: 'cover-swatch', style: { background: c }, onclick: () => { closeMenu(); this.checkpoint(); p.cover = c; this.touchPage(); this.render(); } }));
      popup(e.currentTarget, {
        align: 'right',
        content: el('div', { class: 'cover-picker' }, grid,
          el('div', { class: 'popup-row' },
            el('button', { class: 'link-btn', onclick: async () => { closeMenu(); const src = await window.api.pickImage(); if (src) { this.checkpoint(); p.cover = src; this.touchPage(); this.render(); } } }, 'Upload image…'),
            el('button', { class: 'link-btn danger', onclick: () => { closeMenu(); this.checkpoint(); delete p.cover; this.touchPage(); this.render(); } }, 'Remove'))),
      });
    };
    cover.append(el('div', { class: 'cover-actions' }, el('button', { class: 'cover-btn', onclick: choose }, 'Change cover')));
    return cover;
  }

  pickIcon(anchor) {
    emojiPicker(anchor, (emoji) => {
      this.checkpoint();
      this.page.props.icon = emoji;
      this.touchPage();
      this.render();
      this.app.onTitleChange(this.page);
    });
  }

  renderBlocks() {
    const focus = this.currentFocus();
    this.blocksEl.textContent = '';
    this.nodes.clear();
    for (const b of this.children(this.page.id)) this.blocksEl.append(this.renderBlock(b));
    this.renumber();
    this.renderTocs();
    if (focus && this.nodes.has(focus.id)) this.focus(focus.id, focus.offset);
  }

  renderBlock(b) {
    const wrap = el('div', { class: `block type-${b.type}${b.props.color ? ` color-${b.props.color}` : ''}`, dataset: { id: b.id } });
    const row = el('div', { class: 'block-row' });
    const handle = el('div', { class: 'block-handle', contenteditable: 'false' },
      el('button', { class: 'handle-btn plus', title: 'Click to add below', onclick: () => this.insertBelow(b) }, '+'),
      el('button', { class: 'handle-btn drag', title: 'Drag to move\nClick to open menu', onclick: (e) => this.blockMenu(b, e.currentTarget), onmousedown: () => { wrap.draggable = true; } }, '⋮⋮'));
    row.append(handle);
    const content = el('div', { class: 'block-content' });
    let text = null;

    const mkText = (placeholder, tag = 'div') => {
      text = el(tag, { class: 'text', contenteditable: b.type === 'code' ? 'plaintext-only' : 'true', 'data-placeholder': placeholder, spellcheck: b.type === 'code' ? 'false' : 'true' });
      if (b.type === 'code') text.textContent = htmlToText(b.props.text);
      else text.innerHTML = b.props.text || '';
      return text;
    };

    switch (b.type) {
      case 'paragraph': content.append(mkText("Type '/' for commands")); break;
      case 'heading1': content.append(mkText('Heading 1')); break;
      case 'heading2': content.append(mkText('Heading 2')); break;
      case 'heading3': content.append(mkText('Heading 3')); break;
      case 'quote': content.append(mkText('Quote')); break;
      case 'bulleted':
        content.append(el('span', { class: 'marker bullet', contenteditable: 'false' }, '•'), mkText('List'));
        break;
      case 'numbered':
        content.append(el('span', { class: 'marker number', contenteditable: 'false' }, '1.'), mkText('List'));
        break;
      case 'todo': {
        const cb = el('input', { type: 'checkbox', class: 'todo-check' });
        cb.checked = !!b.props.checked;
        cb.addEventListener('change', () => { this.checkpoint(); b.props.checked = cb.checked; wrap.classList.toggle('checked', cb.checked); this.markDirty(b); });
        if (b.props.checked) wrap.classList.add('checked');
        content.append(el('span', { class: 'marker', contenteditable: 'false' }, cb), mkText('To-do'));
        break;
      }
      case 'toggle': {
        const arrow = el('button', { class: `toggle-arrow${b.props.collapsed ? '' : ' open'}`, contenteditable: 'false', onclick: () => this.toggleCollapse(b) }, '▶');
        content.append(el('span', { class: 'marker', contenteditable: 'false' }, arrow), mkText('Toggle'));
        break;
      }
      case 'callout':
        content.append(el('button', { class: 'callout-icon', contenteditable: 'false', onclick: (e) => emojiPicker(e.currentTarget, (em) => { this.checkpoint(); b.props.icon = em || '💡'; this.markDirty(b); this.rerender(b); }, { allowRemove: false }) }, b.props.icon || '💡'), mkText('Callout'));
        break;
      case 'code': {
        const lang = el('select', { class: 'code-lang', contenteditable: 'false' }, LANGUAGES.map((l) => el('option', { value: l, selected: l === (b.props.language || 'plain') }, l)));
        lang.addEventListener('change', () => { this.checkpoint(); b.props.language = lang.value; this.markDirty(b); });
        const copy = el('button', { class: 'code-copy', contenteditable: 'false', onclick: () => { navigator.clipboard.writeText(htmlToText(b.props.text)); toast('Copied'); } }, 'Copy');
        content.append(el('div', { class: 'code-bar', contenteditable: 'false' }, lang, copy), mkText('Code', 'pre'));
        break;
      }
      case 'divider': content.append(el('hr')); break;
      case 'image': {
        if (b.props.src) {
          const img = el('img', { src: b.props.src, draggable: 'false', style: b.props.width ? { width: `${b.props.width}px` } : null });
          const frame = el('div', { class: 'image-frame' }, img);
          const grip = el('div', { class: 'image-resize' });
          grip.addEventListener('mousedown', (e) => this.resizeImage(e, b, img));
          frame.append(grip);
          content.append(frame);
          const cap = el('div', { class: 'text caption', contenteditable: 'true', 'data-placeholder': 'Add a caption' });
          cap.innerHTML = b.props.caption || '';
          cap.addEventListener('input', () => { b.props.caption = sanitize(cap.innerHTML); this.markDirty(b); });
          content.append(cap);
        } else {
          content.append(el('button', { class: 'image-empty', onclick: async () => { const src = await window.api.pickImage(); if (src) { this.checkpoint(); b.props.src = src; this.markDirty(b); this.rerender(b); } } }, '🖼  Click to add an image'));
        }
        break;
      }
      case 'page': {
        const child = this.app.treeItem(b.id);
        const ptitle = child ? child.title : b.props.title;
        const icon = child ? child.icon : b.props.icon;
        content.append(el('a', { class: 'page-link', onclick: (e) => { e.preventDefault(); this.flush(); this.app.navigate(b.id); } },
          el('span', { class: 'page-link-icon' }, icon || '📄'), el('span', { class: 'page-link-title' }, ptitle || 'Untitled')));
        break;
      }
      case 'database': {
        const host = el('div', { class: 'db-host inline' });
        content.append(host);
        window.api.loadPage(b.id).then((d) => { if (d && host.isConnected) new DatabaseView(host, this.app, d.page, { inline: true, data: d }); });
        break;
      }
      case 'toc': content.append(el('div', { class: 'toc' })); break;
      default: content.append(mkText(''));
    }
    row.append(content);
    wrap.append(row);
    if (text) text.dataset.block = b.id;

    const kids = this.children(b.id);
    if (!NO_CHILDREN.has(b.type)) {
      const childEl = el('div', { class: 'block-children' });
      if (b.type === 'toggle' && b.props.collapsed) childEl.hidden = true;
      for (const c of kids) childEl.append(this.renderBlock(c));
      if (b.type === 'toggle' && !b.props.collapsed && !kids.length) {
        childEl.append(el('div', { class: 'toggle-empty', onclick: () => { this.checkpoint(); const c = this.addBlock('paragraph', b.id, 1); this.rerender(b); this.focus(c.id, 0); } }, 'Empty toggle. Click or drop blocks inside.'));
      }
      wrap.append(childEl);
    }
    this.nodes.set(b.id, { wrap, text });
    return wrap;
  }

  /** Re-render one block's subtree in place. */
  rerender(b) {
    const node = this.nodes.get(b.id);
    if (!node) return this.renderBlocks();
    const focus = this.currentFocus();
    const fresh = this.renderBlock(b);
    node.wrap.replaceWith(fresh);
    this.renumber();
    this.renderTocs();
    if (focus && this.nodes.has(focus.id)) this.focus(focus.id, focus.offset);
  }

  renumber() {
    const walk = (pid) => {
      let n = 0;
      for (const b of this.children(pid)) {
        n = b.type === 'numbered' ? n + 1 : 0;
        if (b.type === 'numbered') {
          const m = this.nodes.get(b.id)?.wrap.querySelector(':scope > .block-row .marker.number');
          if (m) m.textContent = `${n}.`;
        }
        walk(b.id);
      }
    };
    walk(this.page.id);
  }

  renderTocs() {
    const tocs = [...this.blocks.values()].filter((b) => b.type === 'toc');
    if (!tocs.length) return;
    const heads = this.visibleOrder().filter((b) => /^heading[123]$/.test(b.type));
    for (const t of tocs) {
      const box = this.nodes.get(t.id)?.wrap.querySelector('.toc');
      if (!box) continue;
      box.textContent = '';
      if (!heads.length) box.append(el('div', { class: 'muted' }, 'Add headings to create a table of contents.'));
      for (const h of heads) {
        box.append(el('a', { class: `toc-item level-${h.type.slice(-1)}`, onclick: () => this.nodes.get(h.id)?.wrap.scrollIntoView({ behavior: 'smooth', block: 'center' }) }, htmlToText(h.props.text) || 'Untitled'));
      }
    }
  }

  // ---------------------------------------------------------------- focus

  currentFocus() {
    const a = document.activeElement;
    if (!a || !a.dataset || !a.dataset.block || !this.root.contains(a)) return null;
    return { id: a.dataset.block, offset: caretOffset(a) };
  }

  focus(id, offset = 'end') {
    const node = this.nodes.get(id);
    if (!node) return;
    if (!node.text) { node.wrap.scrollIntoView({ block: 'nearest' }); return; }
    const len = (node.text.textContent || '').length;
    setCaret(node.text, offset === 'end' ? len : Math.min(offset, len));
    node.text.scrollIntoView({ block: 'nearest' });
  }

  focusFirst() {
    if (this.page.type === 'database') return;
    if (!(this.page.props.title || '').trim()) { this.titleEl.focus(); return; }
    const first = this.children(this.page.id).find((b) => TEXT_TYPES.has(b.type));
    if (first) this.focus(first.id, 'end');
    else this.clickTail();
  }

  clickTail() {
    const kids = this.children(this.page.id);
    const last = kids[kids.length - 1];
    if (last && last.type === 'paragraph' && !htmlToText(last.props.text)) { this.focus(last.id, 0); return; }
    this.checkpoint();
    const b = this.addBlock('paragraph', this.page.id, this.lastChildPosition(this.page.id));
    this.blocksEl.append(this.renderBlock(b));
    this.focus(b.id, 0);
  }

  blockFromEvent(e) {
    const t = e.target.closest && e.target.closest('[data-block]');
    return t ? this.blocks.get(t.dataset.block) : null;
  }

  // ---------------------------------------------------------------- editing

  syncText(b) {
    const node = this.nodes.get(b.id);
    if (!node || !node.text) return;
    if (b.type === 'code') b.props.text = node.text.textContent.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    else {
      if (node.text.innerHTML === '<br>') node.text.innerHTML = '';
      b.props.text = sanitize(node.text.innerHTML);
    }
    this.markDirty(b);
  }

  onInput(e) {
    const b = this.blockFromEvent(e);
    if (!b || e.target.classList.contains('caption')) return;
    this.checkpointTyping();
    this.syncText(b);
    if (b.type !== 'code' && this.markdownShortcut(b, e)) return;
    this.updateSlash(b, e);
    if (/^heading/.test(b.type)) this.renderTocs();
  }

  markdownShortcut(b, e) {
    const node = this.nodes.get(b.id).text;
    if (e.inputType !== 'insertText') return false;
    const off = caretOffset(node);
    const before = (node.textContent || '').slice(0, off);
    const rules = [
      [/^#\s$/, 'heading1'], [/^##\s$/, 'heading2'], [/^###\s$/, 'heading3'],
      [/^[-*+]\s$/, 'bulleted'], [/^1[.)]\s$/, 'numbered'], [/^\[\s?\]\s$/, 'todo'], [/^\[x\]\s$/i, 'todo', { checked: true }],
      [/^>\s$/, 'toggle'], [/^"\s$/, 'quote'], [/^```$/, 'code'], [/^---$/, 'divider'],
    ];
    for (const [re, type, extra] of rules) {
      if (!re.test(before) || b.type === type) continue;
      if (!['paragraph', 'bulleted', 'numbered', 'todo', 'toggle'].includes(b.type) && b.type !== 'paragraph') continue;
      this.deleteRange(node, 0, off);
      this.syncText(b);
      this.turnInto(b, type, extra);
      return true;
    }
    return false;
  }

  deleteRange(node, start, end) {
    setCaret(node, start);
    const sel = window.getSelection();
    const r = sel.getRangeAt(0);
    const endPos = document.createRange();
    setCaret(node, end);
    const er = sel.getRangeAt(0);
    endPos.setStart(er.startContainer, er.startOffset);
    r.setEnd(endPos.startContainer, endPos.startOffset);
    r.deleteContents();
    sel.removeAllRanges();
    sel.addRange(r);
  }

  turnInto(b, type, extra = {}) {
    this.checkpoint();
    const wasText = TEXT_TYPES.has(b.type);
    if (type === 'page' || type === 'database') {
      // These create a new child container rather than converting text.
      const ref = b;
      this.insertContainer(type, ref);
      if (!htmlToText(ref.props.text)) { this.removeBlock(ref); this.renderBlocks(); }
      return;
    }
    if (type === 'image') {
      window.api.pickImage().then((src) => {
        b.type = 'image';
        b.props = { src: src || '' };
        this.markDirty(b);
        this.rerender(b);
      });
      return;
    }
    b.type = type;
    b.props = { ...defaultProps(type), text: wasText && TEXT_TYPES.has(type) ? b.props.text : '', color: b.props.color, ...extra };
    if (!b.props.color) delete b.props.color;
    if (NO_CHILDREN.has(type)) {
      // Lift children out so they aren't lost under a block that can't show them.
      let pos = b.position;
      const next = this.children(b.parentId).find((s) => s.position > b.position);
      for (const c of this.children(b.id)) { pos = between(pos, next?.position); c.parentId = b.parentId; c.position = pos; this.markDirty(c); }
    }
    this.markDirty(b);
    this.rerender(b);
    if (type === 'divider' || type === 'toc') {
      const n = this.addBlock('paragraph', b.parentId, this.positionAfter(b.parentId, b));
      this.renderBlocks();
      this.focus(n.id, 0);
    } else this.focus(b.id, 0);
  }

  insertContainer(type, after) {
    const pos = after ? this.positionAfter(after.parentId, after) : this.lastChildPosition(this.page.id);
    const parentId = after ? after.parentId : this.page.id;
    // Containers must live directly under the page so the sidebar tree stays correct.
    const realParent = this.blocks.has(parentId) ? this.page.id : parentId;
    const realPos = realParent === parentId ? pos : this.positionAfter(this.page.id, this.topAncestor(after));
    const props = type === 'database' ? newDatabaseProps() : { title: '', icon: '' };
    const c = this.addBlock(type, realParent, realPos, props);
    this.flush().then(() => {
      this.app.refreshSidebar();
      if (type === 'page') this.app.navigate(c.id);
      else this.renderBlocks();
    });
    return c;
  }

  topAncestor(b) {
    let cur = b;
    while (cur && cur.parentId !== this.page.id) cur = this.blocks.get(cur.parentId);
    return cur || b;
  }

  insertBelow(b, type = 'paragraph') {
    this.checkpoint();
    const n = this.addBlock(type, b.parentId, this.positionAfter(b.parentId, b));
    this.renderBlocks();
    this.focus(n.id, 0);
    return n;
  }

  splitBlock(b) {
    const node = this.nodes.get(b.id).text;
    this.checkpoint();
    const empty = !htmlToText(b.props.text).trim() && !node.querySelector('img');
    if (empty && CONTINUING.has(b.type)) {
      if (!this.isRootChild(b) && this.blocks.get(b.parentId)?.type !== 'toggle') return this.outdent(b, false);
      return this.turnInto(b, 'paragraph');
    }
    const [before, after] = splitAtCaret(node);
    if (!htmlToText(before) && htmlToText(after) && caretAtStart(node)) {
      // Caret at start: push an empty block above and keep this one.
      this.addBlock(CONTINUING.has(b.type) ? b.type : 'paragraph', b.parentId, this.positionBefore(b.parentId, b));
      this.renderBlocks();
      this.focus(b.id, 0);
      return;
    }
    b.props.text = before;
    this.markDirty(b);
    const type = CONTINUING.has(b.type) ? b.type : 'paragraph';
    const kids = this.children(b.id);
    const intoChildren = kids.length && !(b.type === 'toggle' && b.props.collapsed);
    const parentId = intoChildren ? b.id : b.parentId;
    const pos = intoChildren ? between(undefined, kids[0].position) : this.positionAfter(b.parentId, b);
    const n = this.addBlock(type, parentId, pos, { text: after });
    this.renderBlocks();
    this.focus(n.id, 0);
  }

  mergeIntoPrevious(b) {
    const prev = this.prevVisible(b);
    if (!prev) {
      if (!htmlToText(b.props.text) && this.children(this.page.id).length > 1) { this.checkpoint(); this.removeBlock(b); this.renderBlocks(); }
      setCaret(this.titleEl, (this.page.props.title || '').length);
      return;
    }
    this.checkpoint();
    if (!TEXT_TYPES.has(prev.type)) {
      if (prev.type === 'divider' || prev.type === 'image' || prev.type === 'toc') { this.removeBlock(prev); this.renderBlocks(); this.focus(b.id, 0); return; }
      if (!htmlToText(b.props.text)) { this.removeBlock(b); this.renderBlocks(); }
      return;
    }
    const len = htmlToText(prev.props.text).length;
    prev.props.text = prev.type === 'code' ? prev.props.text + b.props.text : sanitize((prev.props.text || '') + (b.props.text || ''));
    for (const c of this.children(b.id)) { c.parentId = prev.id; c.position = this.lastChildPosition(prev.id); this.markDirty(c); }
    this.markDirty(prev);
    this.removeBlock(b);
    this.renderBlocks();
    this.focus(prev.id, len);
  }

  indent(b) {
    const sibs = this.children(b.parentId);
    const i = sibs.findIndex((s) => s.id === b.id);
    const prev = sibs[i - 1];
    if (!prev || NO_CHILDREN.has(prev.type)) return;
    this.checkpoint();
    const focus = this.currentFocus();
    if (prev.type === 'toggle' && prev.props.collapsed) { prev.props.collapsed = false; this.markDirty(prev); }
    b.parentId = prev.id;
    b.position = this.lastChildPosition(prev.id);
    this.markDirty(b);
    this.renderBlocks();
    if (focus) this.focus(focus.id, focus.offset);
  }

  outdent(b, checkpoint = true) {
    if (this.isRootChild(b)) return;
    if (checkpoint) this.checkpoint();
    const focus = this.currentFocus();
    const parent = this.blocks.get(b.parentId);
    // Following siblings become children of the outdented block, like Notion.
    const sibs = this.children(parent.id);
    const after = sibs.slice(sibs.findIndex((s) => s.id === b.id) + 1);
    let pos = this.lastChildPosition(b.id);
    for (const s of after) { s.parentId = b.id; s.position = pos++; this.markDirty(s); }
    b.position = this.positionAfter(parent.parentId, parent);
    b.parentId = parent.parentId;
    this.markDirty(b);
    this.renderBlocks();
    if (focus) this.focus(focus.id, focus.offset);
  }

  moveVertical(b, dir) {
    const sibs = this.children(b.parentId);
    const i = sibs.findIndex((s) => s.id === b.id);
    const j = i + dir;
    if (j < 0 || j >= sibs.length) return;
    this.checkpoint();
    const other = sibs[j];
    [b.position, other.position] = [other.position, b.position];
    this.markDirty(b);
    this.markDirty(other);
    this.renderBlocks();
  }

  duplicateBlock(b) {
    this.checkpoint();
    const copy = (src, parentId, position) => {
      const n = this.addBlock(src.type, parentId, position, JSON.parse(JSON.stringify(src.props)));
      for (const c of this.children(src.id)) copy(c, n.id, c.position);
      return n;
    };
    if (b.type === 'page' || b.type === 'database') {
      window.api.duplicate(b.id).then(() => this.app.reload());
      return;
    }
    const n = copy(b, b.parentId, this.positionAfter(b.parentId, b));
    this.renderBlocks();
    this.focus(n.id, 'end');
  }

  deleteBlock(b) {
    this.checkpoint();
    const prev = this.prevVisible(b, true);
    this.removeBlock(b);
    this.renderBlocks();
    if (b.type === 'page' || b.type === 'database') this.app.refreshSidebar();
    if (prev) this.focus(prev.id, 'end');
  }

  toggleCollapse(b) {
    b.props.collapsed = !b.props.collapsed;
    this.markDirty(b);
    this.rerender(b);
  }

  resizeImage(e, b, img) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = img.getBoundingClientRect().width;
    const max = this.blocksEl.getBoundingClientRect().width;
    const move = (ev) => { img.style.width = `${Math.max(80, Math.min(max, startW + (ev.clientX - startX) * 2))}px`; };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      this.checkpoint();
      b.props.width = Math.round(img.getBoundingClientRect().width);
      this.markDirty(b);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  // ---------------------------------------------------------------- keys

  onGlobalKey(e) {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z' && !e.target.closest('.db-host')) {
      e.preventDefault();
      this.syncFocused();
      if (e.shiftKey) this.redo(); else this.undo();
    } else if (mod && e.key.toLowerCase() === 'y' && !e.target.closest('.db-host')) {
      e.preventDefault();
      this.redo();
    }
  }

  syncFocused() {
    const f = this.currentFocus();
    if (f) { const b = this.blocks.get(f.id); if (b) this.syncText(b); }
  }

  onKeyDown(e) {
    const b = this.blockFromEvent(e);
    if (!b || e.target.classList.contains('caption')) return;
    const node = this.nodes.get(b.id).text;
    const mod = e.metaKey || e.ctrlKey;

    if (this.slash && this.slash.blockId === b.id && this.slashKey(e)) return;

    if (mod && !e.shiftKey && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === 'b' || k === 'i' || k === 'u') { e.preventDefault(); document.execCommand({ b: 'bold', i: 'italic', u: 'underline' }[k]); this.syncText(b); return; }
      if (k === 'e') { e.preventDefault(); this.wrapSelection('code'); this.syncText(b); return; }
      if (k === 'k') { e.preventDefault(); this.promptLink(b); return; }
      if (k === 'd') { e.preventDefault(); this.duplicateBlock(b); return; }
      if (k === 'enter') {
        e.preventDefault();
        if (b.type === 'todo') { this.checkpoint(); b.props.checked = !b.props.checked; this.markDirty(b); this.rerender(b); }
        if (b.type === 'toggle') this.toggleCollapse(b);
        return;
      }
    }
    if (mod && e.shiftKey) {
      if (e.key.toLowerCase() === 's') { e.preventDefault(); document.execCommand('strikeThrough'); this.syncText(b); return; }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); this.moveVertical(b, e.key === 'ArrowUp' ? -1 : 1); return; }
    }

    switch (e.key) {
      case 'Enter':
        if (e.shiftKey || b.type === 'code') return;
        e.preventDefault();
        this.splitBlock(b);
        return;
      case 'Backspace':
        if (!caretAtStart(node)) return;
        e.preventDefault();
        if (b.type !== 'paragraph') { this.turnInto(b, 'paragraph'); return; }
        if (!this.isRootChild(b)) { this.outdent(b); return; }
        this.mergeIntoPrevious(b);
        return;
      case 'Delete': {
        if (!caretAtEnd(node)) return;
        const next = this.nextVisible(b);
        if (!next) return;
        e.preventDefault();
        if (TEXT_TYPES.has(next.type)) this.mergeIntoPrevious(next);
        else if (['divider', 'image', 'toc'].includes(next.type)) { this.checkpoint(); this.removeBlock(next); this.renderBlocks(); this.focus(b.id, 'end'); }
        return;
      }
      case 'Tab':
        e.preventDefault();
        if (b.type === 'code') { document.execCommand('insertText', false, '  '); return; }
        if (e.shiftKey) this.outdent(b); else this.indent(b);
        return;
      case 'ArrowUp':
        if (e.shiftKey || !caretOnFirstLine(node)) return;
        { const p = this.prevVisible(b, true); e.preventDefault(); if (p) setCaretAtX(this.nodes.get(p.id).text, caretX(), true); else this.titleEl.focus(); }
        return;
      case 'ArrowDown':
        if (e.shiftKey || !caretOnLastLine(node)) return;
        { const n = this.nextVisible(b, true); if (n) { e.preventDefault(); setCaretAtX(this.nodes.get(n.id).text, caretX(), false); } }
        return;
      case 'ArrowLeft':
        if (e.shiftKey || !caretAtStart(node)) return;
        { const p = this.prevVisible(b, true); if (p) { e.preventDefault(); this.focus(p.id, 'end'); } }
        return;
      case 'ArrowRight':
        if (e.shiftKey || !caretAtEnd(node)) return;
        { const n = this.nextVisible(b, true); if (n) { e.preventDefault(); this.focus(n.id, 0); } }
        return;
      case 'Escape':
        node.blur();
        return;
      default:
    }
  }

  onClick(e) {
    const a = e.target.closest('a[href]');
    if (a && this.blocksEl.contains(a)) {
      e.preventDefault();
      const href = a.getAttribute('href');
      if (href.startsWith('page:')) this.app.navigate(href.slice(5));
      else window.open(href);
    }
  }

  async onPaste(e) {
    const b = this.blockFromEvent(e);
    if (!b) return;
    const files = [...(e.clipboardData.files || [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) {
      e.preventDefault();
      this.checkpoint();
      let after = b;
      for (const f of files) {
        const src = await window.api.saveImageData(new Uint8Array(await f.arrayBuffer()), '.' + (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg'));
        after = this.addBlock('image', after.parentId, this.positionAfter(after.parentId, after), { src });
      }
      this.renderBlocks();
      return;
    }
    const text = e.clipboardData.getData('text/plain');
    if (!text) return;
    e.preventDefault();
    if (b.type === 'code' || e.target.classList.contains('caption') || !text.includes('\n')) {
      document.execCommand('insertText', false, b.type === 'code' ? text : text.replace(/\n/g, ' '));
      return;
    }
    // Multi-line paste: parse as Markdown and insert blocks.
    this.checkpoint();
    const { blocks } = markdownToBlocks(text);
    const isEmpty = !htmlToText(b.props.text).trim() && b.type === 'paragraph';
    let after = b;
    let last = null;
    const insert = (nodes, parentId, prevSibling) => {
      let ref = prevSibling;
      for (const n of nodes) {
        const pos = ref ? this.positionAfter(parentId, ref) : this.lastChildPosition(parentId);
        const nb = this.addBlock(n.type, parentId, pos, n.props);
        if (n.children.length) insert(n.children, nb.id, null);
        ref = nb;
        last = nb;
      }
      return ref;
    };
    insert(blocks, after.parentId, after);
    if (isEmpty) this.removeBlock(b);
    this.renderBlocks();
    if (last) this.focus(last.id, 'end');
  }

  // ---------------------------------------------------------------- slash menu

  updateSlash(b, e) {
    const node = this.nodes.get(b.id).text;
    const off = caretOffset(node);
    const text = node.textContent || '';
    if (!this.slash && e.inputType === 'insertText' && e.data === '/') {
      const at = off - 1;
      if (at === 0 || /\s/.test(text[at - 1])) {
        this.slash = { blockId: b.id, at, index: 0 };
      }
    }
    if (!this.slash || this.slash.blockId !== b.id) return;
    if (off <= this.slash.at || text[this.slash.at] !== '/') return this.closeSlash();
    const q = text.slice(this.slash.at + 1, off).toLowerCase();
    const items = BLOCK_TYPES.filter((t) => !q || t.label.toLowerCase().includes(q) || t.keys.includes(q));
    if (!items.length && q.length > 2) return this.closeSlash();
    if (/\s{2}$/.test(q)) return this.closeSlash();
    this.slash.items = items;
    this.slash.index = Math.min(this.slash.index, Math.max(0, items.length - 1));
    this.renderSlash(node);
  }

  // The menu is created once per slash session and updated in place, so its
  // scroll position survives typing, hovering and arrow-key navigation.
  renderSlash(node) {
    const s = this.slash;
    if (!s.list || !s.list.isConnected) {
      s.list = el('div', { class: 'slash-menu' });
      const sel = window.getSelection();
      const rect = sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : node.getBoundingClientRect();
      const anchor = rect.height ? rect : node.getBoundingClientRect();
      s.box = popup(anchor, { content: s.list, className: 'slash-popup', onClose: () => { if (this.slash === s) this.slash = null; } });
      // Hover only counts when the pointer really moved; scrolling also fires mousemove.
      let last = null;
      s.list.addEventListener('mousemove', (e) => {
        const pos = `${e.screenX},${e.screenY}`;
        if (pos === last) return;
        last = pos;
        const item = e.target.closest('.slash-item');
        if (item) this.setSlashIndex(+item.dataset.index, false);
      });
    }
    s.list.textContent = '';
    if (!s.items.length) s.list.append(el('div', { class: 'muted pad' }, 'No results'));
    else s.list.append(el('div', { class: 'popup-header' }, 'Basic blocks'));
    s.items.forEach((t, i) => {
      s.list.append(el('div', {
        class: `slash-item${i === s.index ? ' active' : ''}`,
        dataset: { index: String(i) },
        onmousedown: (e) => { e.preventDefault(); s.index = i; this.chooseSlash(); },
      }, el('span', { class: 'slash-icon' }, t.icon), el('span', { class: 'slash-text' }, el('span', { class: 'slash-label' }, t.label), el('span', { class: 'slash-desc' }, t.desc))));
    });
    s.box.scrollTop = 0;
  }

  setSlashIndex(i, reveal) {
    const s = this.slash;
    if (!s || !s.list) return;
    s.index = i;
    s.list.querySelectorAll('.slash-item').forEach((it) => it.classList.toggle('active', +it.dataset.index === i));
    if (reveal) s.list.querySelector('.slash-item.active')?.scrollIntoView({ block: 'nearest' });
  }

  closeSlash() {
    const s = this.slash;
    this.slash = null;
    if (s) closeMenu();
  }

  slashKey(e) {
    const s = this.slash;
    if (!s.items) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = s.items.length;
      if (n) this.setSlashIndex((s.index + (e.key === 'ArrowDown' ? 1 : -1) + n) % n, true);
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      if (!s.items.length) { this.closeSlash(); return false; }
      e.preventDefault();
      this.chooseSlash();
      return true;
    }
    if (e.key === 'Escape') { e.preventDefault(); this.closeSlash(); return true; }
    return false;
  }

  chooseSlash() {
    const s = this.slash;
    const t = s.items[s.index];
    const b = this.blocks.get(s.blockId);
    const node = this.nodes.get(b.id).text;
    const off = caretOffset(node);
    this.closeSlash();
    if (!t) return;
    this.deleteRange(node, s.at, off);
    this.syncText(b);
    if (!htmlToText(b.props.text).trim() && b.type !== 'code') this.turnInto(b, t.type);
    else if (t.type === 'page' || t.type === 'database') { this.checkpoint(); this.insertContainer(t.type, b); }
    else {
      const n = this.insertBelow(b, 'paragraph');
      this.turnInto(n, t.type);
    }
  }

  // ---------------------------------------------------------------- formatting

  wrapSelection(tag, className) {
    const sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    const anc = range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
    const existing = anc.closest(className ? `span.${className.split(' ')[0]}` : tag);
    if (existing && existing.closest('[data-block]')) {
      // Toggle off: unwrap.
      existing.replaceWith(...existing.childNodes);
      return;
    }
    const w = document.createElement(tag);
    if (className) w.className = className;
    w.append(range.extractContents());
    // Remove nested color spans so the new color wins.
    if (className) w.querySelectorAll('span').forEach((s) => s.replaceWith(...s.childNodes));
    range.insertNode(w);
    sel.removeAllRanges();
    const r = document.createRange();
    r.selectNodeContents(w);
    sel.addRange(r);
  }

  promptLink(b) {
    const sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed) { toast('Select some text first'); return; }
    const range = sel.getRangeAt(0).cloneRange();
    const existing = (range.commonAncestorContainer.parentElement || range.commonAncestorContainer).closest?.('a');
    const input = el('input', { class: 'input', placeholder: 'Paste a link, or search pages…', value: existing ? existing.getAttribute('href') : '' });
    const results = el('div', { class: 'link-results' });
    const apply = (href) => {
      closeMenu();
      sel.removeAllRanges();
      sel.addRange(range);
      if (!href) document.execCommand('unlink');
      else document.execCommand('createLink', false, href);
      this.syncText(b);
    };
    const refresh = async () => {
      results.textContent = '';
      const q = input.value.trim();
      if (/^(https?:|mailto:)/.test(q) || /^[\w-]+\.[\w.]+/.test(q)) {
        results.append(el('div', { class: 'popup-item', onclick: () => apply(/^(https?:|mailto:)/.test(q) ? q : `https://${q}`) }, '🔗 Link to ', el('b', {}, q)));
      }
      for (const p of (await window.api.search(q)).slice(0, 6)) {
        results.append(el('div', { class: 'popup-item', onclick: () => apply(`page:${p.id}`) }, `${p.icon || '📄'} ${p.title || 'Untitled'}`));
      }
      if (existing) results.append(el('div', { class: 'popup-item danger', onclick: () => apply('') }, 'Remove link'));
    };
    input.addEventListener('input', refresh);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); results.querySelector('.popup-item')?.click(); } });
    popup(range.getBoundingClientRect(), { content: el('div', { class: 'link-popup' }, input, results) });
    refresh();
    input.focus();
  }

  updateFormatBar() {
    const sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return this.hideFormatBar();
    const node = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
    const text = node && node.closest('[data-block]');
    if (!text || !this.blocksEl || !this.blocksEl.contains(text)) return this.hideFormatBar();
    const b = this.blocks.get(text.dataset.block);
    if (!b || b.type === 'code') return this.hideFormatBar();
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (!this.formatBar) {
      const btn = (label, title, fn, cls = '') => el('button', { class: `fmt-btn ${cls}`, title, onmousedown: (e) => { e.preventDefault(); const cur = this.blocks.get(this.formatBlockId); if (cur) { this.checkpoint(); fn(cur, e.currentTarget); } } }, label);
      this.formatBar = el('div', { class: 'format-bar' },
        btn('Turn into ▾', 'Turn into', (cur, anchor) => this.turnIntoMenu(cur, anchor), 'wide'),
        el('span', { class: 'fmt-sep' }),
        btn('B', 'Bold ⌘B', (cur) => { document.execCommand('bold'); this.syncText(cur); }, 'b'),
        btn('i', 'Italic ⌘I', (cur) => { document.execCommand('italic'); this.syncText(cur); }, 'i'),
        btn('U', 'Underline ⌘U', (cur) => { document.execCommand('underline'); this.syncText(cur); }, 'u'),
        btn('S', 'Strikethrough ⌘⇧S', (cur) => { document.execCommand('strikeThrough'); this.syncText(cur); }, 's'),
        btn('<>', 'Code ⌘E', (cur) => { this.wrapSelection('code'); this.syncText(cur); }, 'code'),
        btn('🔗', 'Link ⌘K', (cur) => this.promptLink(cur)),
        btn('A ▾', 'Color', (cur, anchor) => this.colorMenu(cur, anchor, true)));
      document.body.append(this.formatBar);
    }
    this.formatBlockId = b.id;
    this.formatBar.style.display = 'flex';
    const w = this.formatBar.offsetWidth;
    this.formatBar.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, rect.left + rect.width / 2 - w / 2))}px`;
    this.formatBar.style.top = `${Math.max(8, rect.top - 44)}px`;
  }

  hideFormatBar() {
    if (this.formatBar) this.formatBar.style.display = 'none';
  }

  colorMenu(b, anchor, inline) {
    const sel = window.getSelection();
    const saved = inline && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    const items = [{ header: 'Color' }];
    for (const c of COLORS) {
      items.push({
        label: c[0].toUpperCase() + c.slice(1), icon: el('span', { class: `swatch color-${c}` }, 'A'),
        onClick: () => {
          if (inline) {
            sel.removeAllRanges(); sel.addRange(saved);
            if (c !== 'default') this.wrapSelection('span', `color-${c}`);
            else { document.execCommand('removeFormat'); }
            this.syncText(b);
          } else { b.props.color = c === 'default' ? undefined : c; if (!b.props.color) delete b.props.color; this.markDirty(b); this.rerender(b); }
        },
      });
    }
    items.push({ header: 'Background' });
    for (const c of COLORS.slice(1)) {
      items.push({
        label: `${c[0].toUpperCase() + c.slice(1)} background`, icon: el('span', { class: `swatch bg-${c}` }, 'A'),
        onClick: () => {
          if (inline) { sel.removeAllRanges(); sel.addRange(saved); this.wrapSelection('span', `bg-${c}`); this.syncText(b); }
          else { b.props.color = `bg${c}`; this.markDirty(b); this.rerender(b); }
        },
      });
    }
    popup(anchor, { items, className: 'scroll' });
  }

  turnIntoMenu(b, anchor) {
    const items = [{ header: 'Turn into' }];
    for (const t of BLOCK_TYPES.filter((x) => TEXT_TYPES.has(x.type))) {
      items.push({ label: t.label, icon: t.icon, active: t.type === b.type, onClick: () => this.turnInto(b, t.type) });
    }
    popup(anchor, { items, className: 'scroll' });
  }

  blockMenu(b, anchor) {
    wrapNotDraggable(this.nodes.get(b.id)?.wrap);
    const items = [
      { label: 'Delete', icon: '🗑', hint: 'Del', onClick: () => this.deleteBlock(b) },
      { label: 'Duplicate', icon: '⧉', hint: '⌘D', onClick: () => this.duplicateBlock(b) },
    ];
    if (TEXT_TYPES.has(b.type)) items.push({ label: 'Turn into', icon: '↻', onClick: () => setTimeout(() => this.turnIntoMenu(b, anchor), 0) });
    if (b.type === 'page' || b.type === 'database') items.push({ label: 'Open', icon: '↗', onClick: () => this.app.navigate(b.id) });
    items.push({ label: 'Color', icon: '🎨', onClick: () => setTimeout(() => this.colorMenu(b, anchor, false), 0) });
    items.push({ label: 'Move up', icon: '↑', hint: '⌘⇧↑', onClick: () => this.moveVertical(b, -1) });
    items.push({ label: 'Move down', icon: '↓', hint: '⌘⇧↓', onClick: () => this.moveVertical(b, 1) });
    popup(anchor, { items });
  }

  // ---------------------------------------------------------------- drag & drop

  setupDrag() {
    const ind = el('div', { class: 'drop-indicator' });
    let dragId = null;
    let target = null;
    const clear = () => { ind.remove(); target = null; };
    this.blocksEl.addEventListener('dragstart', (e) => {
      const w = e.target.closest && e.target.closest('.block');
      if (!w || !w.draggable) return;
      dragId = w.dataset.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('application/x-block', dragId);
      setTimeout(() => w.classList.add('dragging'), 0);
    });
    this.blocksEl.addEventListener('dragend', (e) => {
      const w = e.target.closest && e.target.closest('.block');
      if (w) { w.classList.remove('dragging'); w.draggable = false; }
      dragId = null;
      clear();
    });
    this.blocksEl.addEventListener('dragover', (e) => {
      const files = e.dataTransfer.types.includes('Files');
      if (!dragId && !files) return;
      e.preventDefault();
      const rowEl = document.elementFromPoint(e.clientX, e.clientY)?.closest('.block-row');
      const w = rowEl && rowEl.parentElement;
      if (!w || !this.blocksEl.contains(w) || w.dataset.id === dragId || (dragId && this.isDescendant(w.dataset.id, dragId))) return clear();
      const r = rowEl.getBoundingClientRect();
      const ref = this.blocks.get(w.dataset.id);
      const before = e.clientY < r.top + r.height / 2;
      const nest = !before && !NO_CHILDREN.has(ref.type) && e.clientX > r.left + 80;
      target = { id: ref.id, before, nest };
      const content = rowEl.querySelector('.block-content').getBoundingClientRect();
      const host = this.root.getBoundingClientRect();
      ind.style.top = `${(before ? r.top : r.bottom) - host.top + this.root.scrollTop - 1}px`;
      ind.style.left = `${content.left - host.left + (nest ? 28 : 0)}px`;
      ind.style.width = `${content.width - (nest ? 28 : 0)}px`;
      if (!ind.isConnected) this.root.append(ind);
    });
    this.blocksEl.addEventListener('dragleave', (e) => { if (!this.blocksEl.contains(e.relatedTarget)) clear(); });
    this.blocksEl.addEventListener('drop', async (e) => {
      e.preventDefault();
      const t = target;
      clear();
      const files = [...(e.dataTransfer.files || [])].filter((f) => f.type.startsWith('image/'));
      if (!t && !files.length) return;
      const ref = t ? this.blocks.get(t.id) : this.children(this.page.id).at(-1);
      const place = (b) => {
        if (!ref) { b.parentId = this.page.id; b.position = this.lastChildPosition(this.page.id); return; }
        if (t && t.nest) { b.parentId = ref.id; b.position = between(undefined, this.children(ref.id)[0]?.position); if (ref.type === 'toggle') ref.props.collapsed = false; this.markDirty(ref); }
        else if (t && t.before) { b.parentId = ref.parentId; b.position = this.positionBefore(ref.parentId, ref); }
        else { b.parentId = ref.parentId; b.position = this.positionAfter(ref.parentId, ref); }
      };
      this.checkpoint();
      if (files.length) {
        for (const f of files.reverse()) {
          const src = await window.api.saveImageData(new Uint8Array(await f.arrayBuffer()), '.' + (f.type.split('/')[1] || 'png'));
          const b = this.addBlock('image', this.page.id, 0, { src });
          place(b);
        }
      } else {
        const b = this.blocks.get(e.dataTransfer.getData('application/x-block'));
        if (!b) return;
        place(b);
        this.markDirty(b);
      }
      this.renderBlocks();
    });
  }

  lastEditedLabel() { return `Edited ${timeAgo(this.page.updatedAt || Date.now())}`; }
}

function wrapNotDraggable(w) { if (w) w.draggable = false; }

function caretX() {
  const sel = window.getSelection();
  if (!sel.rangeCount) return 0;
  const r = sel.getRangeAt(0).getClientRects()[0];
  return r ? r.left : sel.getRangeAt(0).getBoundingClientRect().left;
}

export function defaultProps(type) {
  switch (type) {
    case 'todo': return { text: '', checked: false };
    case 'toggle': return { text: '', collapsed: false };
    case 'callout': return { text: '', icon: '💡' };
    case 'code': return { text: '', language: 'plain' };
    case 'divider': case 'toc': return {};
    case 'image': return { src: '' };
    default: return { text: '' };
  }
}

export function newDatabaseProps(title = '') {
  return {
    title, icon: '',
    schema: [
      { id: 'title', name: 'Name', type: 'title' },
      { id: uid().slice(0, 8), name: 'Tags', type: 'multi_select', options: [] },
      { id: uid().slice(0, 8), name: 'Status', type: 'select', options: [
        { id: 'todo', name: 'Not started', color: 'gray' }, { id: 'doing', name: 'In progress', color: 'blue' }, { id: 'done', name: 'Done', color: 'green' }] },
    ],
    views: [{ id: 'table', type: 'table', name: 'Table' }, { id: 'board', type: 'board', name: 'Board' }],
  };
}
