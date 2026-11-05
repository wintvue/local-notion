// App shell: sidebar, navigation, search, trash, settings.
import { el, uid, popup, closeMenu, modal, toast, debounce, timeAgo, emojiPicker } from './util.js';
import { PageEditor, newDatabaseProps } from './editor.js';
import { pageToMarkdown, markdownToBlocks } from './markdown.js';

const api = window.api;

class App {
  constructor() {
    this.tree = [];
    this.byId = new Map();
    this.expanded = new Set();
    this.history = [];
    this.hIndex = -1;
    this.editor = null;
    this.currentId = null;
    document.body.classList.add(`platform-${api.platform}`);
  }

  async start() {
    this.expanded = new Set((await api.getMeta('expanded')) || []);
    const width = await api.getMeta('sidebarWidth');
    if (width) document.documentElement.style.setProperty('--sidebar-w', `${width}px`);
    if (await api.getMeta('sidebarCollapsed')) document.body.classList.add('sidebar-collapsed');
    this.theme = (await api.getMeta('theme')) || 'system';

    this.buildShell();
    await this.refreshSidebar();
    api.onMenu((cmd) => this.command(cmd));
    api.onChanged(debounce(() => this.refreshSidebar(), 150));
    window.addEventListener('hashchange', () => {
      const id = location.hash.slice(1);
      if (id && id !== this.currentId) this.navigate(id);
    });
    document.addEventListener('keydown', (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === 'p' || (e.key === 'k' && !e.target.closest('[data-block]')))) { e.preventDefault(); this.openSearch(); }
    });
    window.addEventListener('beforeunload', () => this.editor && this.editor.flush());

    const initial = location.hash.slice(1) || (await api.getMeta('lastPage'));
    const target = initial && this.byId.has(initial) ? initial : this.tree.find((t) => !t.parentId)?.id;
    if (target) this.navigate(target);
    else this.renderEmpty();
  }

  // ------------------------------------------------------------ shell

  buildShell() {
    const app = document.getElementById('app');
    this.sidebarTree = el('div', { class: 'sb-tree' });
    this.favorites = el('div', { class: 'sb-section' });
    const resizer = el('div', { class: 'sb-resizer' });
    resizer.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const move = (ev) => document.documentElement.style.setProperty('--sidebar-w', `${Math.max(200, Math.min(480, ev.clientX))}px`);
      const up = (ev) => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); api.setMeta('sidebarWidth', Math.max(200, Math.min(480, ev.clientX))); };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
    const navItem = (icon, label, onclick, hint) => el('div', { class: 'sb-item nav', onclick }, el('span', { class: 'sb-icon' }, icon), el('span', { class: 'sb-label' }, label), hint ? el('span', { class: 'sb-hint' }, hint) : null);
    this.sidebar = el('aside', { class: 'sidebar' },
      el('div', { class: 'sb-top drag-region' },
        el('div', { class: 'sb-workspace' }, el('img', { class: 'ws-logo', src: 'logo.png', alt: '' }), el('span', {}, 'Local Notion')),
        el('button', { class: 'icon-btn no-drag', title: 'Close sidebar (⌘\\)', onclick: () => this.toggleSidebar() }, '«')),
      navItem('🔍', 'Search', () => this.openSearch(), '⌘P'),
      navItem('⚙️', 'Settings', (e) => this.openSettings(e.currentTarget)),
      navItem('＋', 'New page', () => this.createPage(null)),
      el('div', { class: 'sb-scroll' },
        this.favorites,
        el('div', { class: 'sb-section' },
          el('div', { class: 'sb-heading' }, el('span', {}, 'Pages'),
            el('button', { class: 'icon-btn small', title: 'Add a page', onclick: () => this.createPage(null) }, '+')),
          this.sidebarTree)),
      el('div', { class: 'sb-bottom' },
        navItem('▦', 'New database', () => this.createDatabase(null)),
        navItem('⤓', 'Import', () => this.importMarkdown()),
        navItem('🗑', 'Trash', () => this.openTrash())),
      resizer);

    this.backBtn = el('button', { class: 'icon-btn', title: 'Back (⌘[)', onclick: () => this.back() }, '←');
    this.fwdBtn = el('button', { class: 'icon-btn', title: 'Forward (⌘])', onclick: () => this.forward() }, '→');
    this.crumbs = el('div', { class: 'crumbs' });
    this.edited = el('span', { class: 'edited muted' });
    this.favBtn = el('button', { class: 'icon-btn', title: 'Favorite', onclick: () => this.toggleFavorite(this.currentId) }, '☆');
    this.topbar = el('header', { class: 'topbar drag-region' },
      el('button', { class: 'icon-btn open-sidebar no-drag', title: 'Open sidebar (⌘\\)', onclick: () => this.toggleSidebar() }, '☰'),
      el('div', { class: 'no-drag nav-btns' }, this.backBtn, this.fwdBtn),
      this.crumbs,
      el('div', { class: 'topbar-right no-drag' }, this.edited, this.favBtn,
        el('button', { class: 'icon-btn', title: 'More', onclick: (e) => this.pageMenu(e.currentTarget) }, '⋯')));
    this.content = el('main', { class: 'content' });
    this.scroller = el('div', { class: 'scroller' }, this.content);
    app.append(this.sidebar, el('div', { class: 'main' }, this.topbar, this.scroller));
  }

  toggleSidebar() {
    const c = document.body.classList.toggle('sidebar-collapsed');
    api.setMeta('sidebarCollapsed', c);
  }

  // ------------------------------------------------------------ sidebar

  async refreshSidebar() {
    this.tree = await api.tree();
    this.byId = new Map(this.tree.map((t) => [t.id, t]));
    this.renderSidebar();
    this.updateTopbar();
  }

  treeItem(id) { return this.byId.get(id); }

  childrenOf(id) {
    return this.tree.filter((t) => t.parentId === id && this.byId.get(t.parentId)?.type !== 'database').sort((a, b) => a.position - b.position);
  }

  renderSidebar() {
    this.sidebarTree.textContent = '';
    const roots = this.tree.filter((t) => !t.parentId).sort((a, b) => a.position - b.position);
    for (const t of roots) this.sidebarTree.append(this.renderTreeItem(t, 0));
    if (!roots.length) this.sidebarTree.append(el('div', { class: 'sb-empty muted' }, 'No pages yet'));
    this.favorites.textContent = '';
    const favs = this.tree.filter((t) => t.favorite);
    if (favs.length) {
      this.favorites.append(el('div', { class: 'sb-heading' }, el('span', {}, 'Favorites')));
      for (const t of favs) this.favorites.append(this.renderTreeItem(t, 0, 'fav'));
    }
  }

  renderTreeItem(t, depth, prefix = '') {
    const key = prefix + t.id;
    const kids = t.type === 'database' ? [] : this.childrenOf(t.id);
    const open = this.expanded.has(key);
    const wrap = el('div', { class: 'sb-node' });
    const row = el('div', {
      class: `sb-item sb-page${t.id === this.currentId ? ' active' : ''}`,
      style: { paddingLeft: `${8 + depth * 14}px` },
      draggable: 'true',
      dataset: { id: t.id },
      onclick: () => this.navigate(t.id),
      oncontextmenu: (e) => { e.preventDefault(); this.itemMenu(t, e.currentTarget); },
    },
    el('button', {
      class: `sb-arrow${open ? ' open' : ''}${kids.length ? '' : ' leaf'}`,
      onclick: (e) => { e.stopPropagation(); if (open) this.expanded.delete(key); else this.expanded.add(key); api.setMeta('expanded', [...this.expanded]); this.renderSidebar(); },
    }, '▶'),
    el('span', { class: 'sb-icon' }, t.icon || (t.type === 'database' ? '▦' : '📄')),
    el('span', { class: 'sb-label' }, t.title || 'Untitled'),
    el('span', { class: 'sb-actions' },
      el('button', { class: 'icon-btn small', title: 'Delete, duplicate, and more', onclick: (e) => { e.stopPropagation(); this.itemMenu(t, e.currentTarget); } }, '⋯'),
      t.type === 'page' ? el('button', { class: 'icon-btn small', title: 'Add a page inside', onclick: (e) => { e.stopPropagation(); this.createPage(t.id); } }, '+') : null));
    this.sidebarDnD(row, t);
    wrap.append(row);
    if (open) {
      const box = el('div', { class: 'sb-children' });
      for (const k of kids) box.append(this.renderTreeItem(k, depth + 1, prefix));
      if (!kids.length && t.type === 'page') box.append(el('div', { class: 'sb-empty muted', style: { paddingLeft: `${30 + depth * 14}px` } }, 'No pages inside'));
      wrap.append(box);
    }
    return wrap;
  }

  sidebarDnD(row, t) {
    row.addEventListener('dragstart', (e) => { e.dataTransfer.setData('application/x-page', t.id); e.dataTransfer.effectAllowed = 'move'; });
    row.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('application/x-page')) return;
      e.preventDefault();
      const r = row.getBoundingClientRect();
      const y = e.clientY - r.top;
      row.classList.remove('drop-before', 'drop-after', 'drop-inside');
      row.classList.add(y < r.height * 0.25 ? 'drop-before' : y > r.height * 0.75 ? 'drop-after' : (t.type === 'page' ? 'drop-inside' : 'drop-after'));
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after', 'drop-inside'));
    row.addEventListener('drop', async (e) => {
      e.preventDefault();
      const mode = row.classList.contains('drop-before') ? 'before' : row.classList.contains('drop-inside') ? 'inside' : 'after';
      row.classList.remove('drop-before', 'drop-after', 'drop-inside');
      const id = e.dataTransfer.getData('application/x-page');
      if (!id || id === t.id || this.isAncestor(id, t.id)) return;
      const moving = await api.loadPage(id);
      if (!moving) return;
      const b = moving.page;
      if (mode === 'inside') {
        b.parentId = t.id;
        const sibs = this.childrenOf(t.id);
        b.position = sibs.length ? sibs[sibs.length - 1].position + 1 : 1;
        this.expanded.add(t.id);
      } else {
        b.parentId = t.parentId;
        const sibs = this.tree.filter((x) => x.parentId === t.parentId && x.id !== id).sort((a, c) => a.position - c.position);
        const i = sibs.findIndex((x) => x.id === t.id);
        const other = mode === 'before' ? sibs[i - 1] : sibs[i + 1];
        b.position = other ? (t.position + other.position) / 2 : t.position + (mode === 'before' ? -1 : 1);
      }
      await api.apply([{ op: 'upsert', block: b }]);
      await this.refreshSidebar();
      if (this.currentId) this.reload();
    });
  }

  isAncestor(ancestorId, id) {
    let cur = this.byId.get(id);
    while (cur) { if (cur.id === ancestorId) return true; cur = this.byId.get(cur.parentId); }
    return false;
  }

  itemMenu(t, anchor) {
    popup(anchor, {
      items: [
        { label: t.favorite ? 'Remove from Favorites' : 'Add to Favorites', icon: t.favorite ? '★' : '☆', onClick: () => this.toggleFavorite(t.id) },
        { label: 'Duplicate', icon: '⧉', onClick: async () => { const id = await api.duplicate(t.id); await this.refreshSidebar(); this.navigate(id); } },
        { label: 'Change icon', icon: '☺', onClick: () => setTimeout(() => emojiPicker(anchor, (em) => this.setPageProps(t.id, { icon: em })), 0) },
        { label: 'Open in new window', icon: '⧉', onClick: () => api.newWindow(t.id) },
        'separator',
        { label: 'Move to Trash', icon: '🗑', danger: true, onClick: () => this.trashPage(t.id) },
      ],
    });
  }

  async setPageProps(id, patch) {
    const d = await api.loadPage(id);
    if (!d) return;
    Object.assign(d.page.props, patch);
    await api.apply([{ op: 'upsert', block: d.page }]);
    await this.refreshSidebar();
    if (id === this.currentId) this.reload();
  }

  async toggleFavorite(id) {
    const t = this.byId.get(id);
    if (!t) return;
    await api.apply([{ op: 'favorite', id, value: !t.favorite }]);
    await this.refreshSidebar();
  }

  async trashPage(id) {
    if (this.editor && this.editor.blocks.has(id)) this.editor.blocks.delete(id);
    await api.apply([{ op: 'delete', id }]);
    toast('Moved to Trash');
    await this.refreshSidebar();
    if (id === this.currentId || this.isAncestor(id, this.currentId) || !this.byId.has(this.currentId)) {
      const fallback = this.byId.get(this.byId.get(id)?.parentId)?.id || this.tree.find((x) => !x.parentId)?.id;
      if (fallback) this.navigate(fallback, { replace: true }); else this.renderEmpty();
    } else if (this.currentId) this.reload();
  }

  // ------------------------------------------------------------ pages

  async createPage(parentId, { navigate = true, title = '', icon = '' } = {}) {
    if (this.editor) await this.editor.flush();
    const sibs = this.tree.filter((t) => t.parentId === parentId);
    const position = sibs.length ? Math.max(...sibs.map((s) => s.position)) + 1 : 1;
    const id = uid();
    await api.apply([{ op: 'upsert', block: { id, type: 'page', parentId, position, props: { title, icon } } }]);
    if (parentId) { this.expanded.add(parentId); api.setMeta('expanded', [...this.expanded]); }
    await this.refreshSidebar();
    if (navigate) this.navigate(id);
    return id;
  }

  async createDatabase(parentId) {
    if (this.editor) await this.editor.flush();
    const id = uid();
    const sibs = this.tree.filter((t) => t.parentId === parentId);
    const position = sibs.length ? Math.max(...sibs.map((s) => s.position)) + 1 : 1;
    await api.apply([{ op: 'upsert', block: { id, type: 'database', parentId, position, props: newDatabaseProps('') } }]);
    await this.refreshSidebar();
    this.navigate(id);
  }

  async navigate(id, { replace = false, fromHistory = false } = {}) {
    if (this.editor) { await this.editor.flush(); this.editor.destroy(); this.editor = null; }
    const data = await api.loadPage(id);
    if (!data || !data.page.alive) { toast('That page no longer exists'); return; }
    if (!fromHistory) {
      if (replace && this.hIndex >= 0) this.history[this.hIndex] = id;
      else if (this.history[this.hIndex] !== id) { this.history = this.history.slice(0, this.hIndex + 1); this.history.push(id); this.hIndex++; }
    }
    this.currentId = id;
    if (location.hash.slice(1) !== id) history.replaceState(null, '', `#${id}`);
    api.setMeta('lastPage', id);
    // Expand ancestors so the active page is visible in the sidebar.
    let cur = this.byId.get(data.page.parentId);
    while (cur) { this.expanded.add(cur.id); cur = this.byId.get(cur.parentId); }
    this.content.textContent = '';
    const host = el('div');
    this.content.append(host);
    this.editor = new PageEditor(host, data, this);
    this.scroller.scrollTop = 0;
    this.renderSidebar();
    this.updateTopbar();
    if (!(data.page.props.title || '').trim()) this.editor.titleEl.focus();
  }

  reload() {
    if (!this.currentId) return;
    const top = this.scroller.scrollTop;
    this.navigate(this.currentId, { fromHistory: true }).then(() => { this.scroller.scrollTop = top; });
  }

  back() { if (this.hIndex > 0) { this.hIndex--; this.navigate(this.history[this.hIndex], { fromHistory: true }); } }
  forward() { if (this.hIndex < this.history.length - 1) { this.hIndex++; this.navigate(this.history[this.hIndex], { fromHistory: true }); } }

  onPageSaved(editor) {
    if (editor === this.editor) this.edited.textContent = editor.lastEditedLabel();
  }

  onTitleChange(page) {
    const t = this.byId.get(page.id);
    if (t) { t.title = page.props.title || ''; t.icon = page.props.icon || ''; }
    const node = this.sidebar.querySelectorAll(`.sb-item[data-id="${page.id}"]`);
    node.forEach((n) => {
      n.querySelector('.sb-label').textContent = page.props.title || 'Untitled';
      n.querySelector('.sb-icon').textContent = page.props.icon || (page.type === 'database' ? '▦' : '📄');
    });
    this.updateTopbar();
    document.title = `${page.props.title || 'Untitled'} — Local Notion`;
  }

  updateTopbar() {
    this.backBtn.disabled = this.hIndex <= 0;
    this.fwdBtn.disabled = this.hIndex >= this.history.length - 1;
    this.crumbs.textContent = '';
    if (!this.editor) return;
    const chain = [...this.editor.breadcrumbs.map((b) => this.byId.get(b.id) || b), this.byId.get(this.currentId) || { id: this.currentId, ...this.editor.page.props }];
    chain.forEach((c, i) => {
      if (i) this.crumbs.append(el('span', { class: 'crumb-sep' }, '/'));
      this.crumbs.append(el('button', { class: 'crumb no-drag', onclick: () => this.navigate(c.id) }, c.icon ? `${c.icon} ` : '', c.title || 'Untitled'));
    });
    const t = this.byId.get(this.currentId);
    this.favBtn.textContent = t && t.favorite ? '★' : '☆';
    this.favBtn.classList.toggle('on', !!(t && t.favorite));
    this.edited.textContent = this.editor.lastEditedLabel();
    document.title = `${this.editor.page.props.title || 'Untitled'} — Local Notion`;
  }

  renderEmpty() {
    this.currentId = null;
    this.content.textContent = '';
    this.content.append(el('div', { class: 'empty-state' },
      el('div', { class: 'empty-icon' }, '📝'),
      el('h2', {}, 'No pages yet'),
      el('p', { class: 'muted' }, 'Create a page to start writing.'),
      el('button', { class: 'primary-btn', onclick: () => this.createPage(null) }, 'New page')));
    this.updateTopbar();
  }

  pageMenu(anchor) {
    if (!this.editor) return;
    const p = this.editor.page.props;
    const set = (patch) => { this.editor.checkpoint(); Object.assign(this.editor.page.props, patch); this.editor.touchPage(); this.editor.render(); };
    const fontItem = (f, label) => ({ label, icon: f === 'serif' ? 'Ag' : f === 'mono' ? '{}' : 'Aa', active: (p.font || 'default') === f, onClick: () => set({ font: f }) });
    popup(anchor, {
      align: 'right',
      items: [
        { header: 'Style' },
        fontItem('default', 'Default'), fontItem('serif', 'Serif'), fontItem('mono', 'Mono'),
        'separator',
        { label: 'Small text', icon: p.smallText ? '✓' : ' ', onClick: () => set({ smallText: !p.smallText }) },
        { label: 'Full width', icon: p.fullWidth ? '✓' : ' ', onClick: () => set({ fullWidth: !p.fullWidth }) },
        'separator',
        { label: 'Duplicate', icon: '⧉', onClick: async () => { await this.editor.flush(); const id = await api.duplicate(this.currentId); await this.refreshSidebar(); this.navigate(id); } },
        { label: 'Export as Markdown', icon: '⤒', hint: '⌘⇧E', onClick: () => this.exportMarkdown() },
        { label: 'Export as PDF', icon: '⎙', onClick: () => this.exportPdf() },
        { label: 'Open in new window', icon: '⧉', onClick: () => api.newWindow(this.currentId) },
        'separator',
        { label: 'Move to Trash', icon: '🗑', danger: true, onClick: () => this.trashPage(this.currentId) },
      ],
    });
  }

  // ------------------------------------------------------------ search

  openSearch() {
    const input = el('input', { class: 'search-input', placeholder: 'Search pages and content…' });
    const list = el('div', { class: 'search-results' });
    let results = [];
    let index = 0;
    const m = modal(el('div', { class: 'search' }, input, list,
      el('div', { class: 'search-foot muted' }, '↑↓ to navigate · ↵ to open · ⌘↵ new window · esc to close')), { className: 'search-modal' });
    const draw = () => {
      list.textContent = '';
      if (!results.length) list.append(el('div', { class: 'muted pad' }, input.value ? 'No results' : 'No pages'));
      if (!input.value && results.length) list.append(el('div', { class: 'popup-header' }, 'Recent'));
      results.forEach((r, i) => {
        const crumbs = [];
        let cur = this.byId.get(r.parentId);
        while (cur) { crumbs.unshift(cur.title || 'Untitled'); cur = this.byId.get(cur.parentId); }
        list.append(el('div', { class: `search-item${i === index ? ' active' : ''}`, onclick: () => { m.close(); this.navigate(r.id); }, onmousemove: () => { if (index !== i) { index = i; draw(); } } },
          el('span', { class: 'sb-icon' }, r.icon || (r.type === 'database' ? '▦' : '📄')),
          el('div', { class: 'search-main' },
            el('div', { class: 'search-title' }, r.title || 'Untitled', crumbs.length ? el('span', { class: 'muted small' }, ` — ${crumbs.join(' / ')}`) : null),
            r.snippet ? el('div', { class: 'search-snippet muted' }, r.snippet) : null),
          el('span', { class: 'muted small' }, timeAgo(r.updatedAt))));
      });
      list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
    };
    const run = debounce(async () => { results = await api.search(input.value); index = 0; draw(); }, 80);
    input.addEventListener('input', run);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); index = Math.min(results.length - 1, index + 1); draw(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); index = Math.max(0, index - 1); draw(); }
      if (e.key === 'Enter' && results[index]) {
        e.preventDefault();
        m.close();
        if (e.metaKey || e.ctrlKey) api.newWindow(results[index].id); else this.navigate(results[index].id);
      }
    });
    run();
    input.focus();
  }

  // ------------------------------------------------------------ trash

  async openTrash() {
    const list = el('div', { class: 'trash-list' });
    const filter = el('input', { class: 'input', placeholder: 'Filter by page title…' });
    const m = modal(el('div', { class: 'trash' }, el('h3', {}, 'Trash'), filter, list), { className: 'trash-modal' });
    const draw = async () => {
      const items = (await api.trash()).filter((t) => (t.title || 'Untitled').toLowerCase().includes(filter.value.toLowerCase()));
      list.textContent = '';
      if (!items.length) list.append(el('div', { class: 'muted pad' }, 'Trash is empty'));
      for (const t of items) {
        list.append(el('div', { class: 'trash-item' },
          el('span', { class: 'sb-icon' }, t.icon || (t.type === 'database' ? '▦' : '📄')),
          el('span', { class: 'sb-label' }, t.title || 'Untitled'),
          el('span', { class: 'muted small' }, timeAgo(t.updatedAt)),
          el('button', { class: 'icon-btn', title: 'Restore', onclick: async () => { await api.apply([{ op: 'restore', id: t.id }]); await this.refreshSidebar(); if (this.currentId) this.reload(); draw(); toast('Restored'); } }, '↺'),
          el('button', { class: 'icon-btn danger', title: 'Delete permanently', onclick: async () => {
            if (!confirm(`Permanently delete "${t.title || 'Untitled'}"? This cannot be undone.`)) return;
            await api.apply([{ op: 'purge', id: t.id }]);
            draw();
          } }, '✕')));
      }
    };
    filter.addEventListener('input', draw);
    draw();
    filter.focus();
    return m;
  }

  // ------------------------------------------------------------ settings & io

  openSettings(anchor) {
    const set = async (mode) => { this.theme = mode; await api.setMeta('theme', mode); await api.setTheme(mode); };
    popup(anchor, {
      items: [
        { header: 'Appearance' },
        { label: 'Use system setting', icon: '◐', active: this.theme === 'system', onClick: () => set('system') },
        { label: 'Light', icon: '☀', active: this.theme === 'light', onClick: () => set('light') },
        { label: 'Dark', icon: '☾', active: this.theme === 'dark', onClick: () => set('dark') },
        'separator',
        { label: 'Back up workspace (JSON)…', icon: '⤓', onClick: () => api.backup() },
      ],
    });
  }

  async toggleTheme() {
    const dark = await api.isDark();
    const mode = dark ? 'light' : 'dark';
    this.theme = mode;
    await api.setMeta('theme', mode);
    await api.setTheme(mode);
  }

  async exportMarkdown() {
    if (!this.editor || this.editor.page.type !== 'page') { toast('Open a page to export'); return; }
    await this.editor.flush();
    const md = pageToMarkdown(this.editor.page, (id) => this.editor.children(id));
    const name = `${(this.editor.page.props.title || 'Untitled').replace(/[/\\?%*:|"<>]/g, '-')}.md`;
    const saved = await api.saveText(name, md, 'md');
    if (saved) toast('Exported');
  }

  async exportPdf() {
    if (!this.editor) return;
    await this.editor.flush();
    const name = `${(this.editor.page.props.title || 'Untitled').replace(/[/\\?%*:|"<>]/g, '-')}.pdf`;
    const saved = await api.exportPdf(name);
    if (saved) toast('Exported PDF');
  }

  async importMarkdown() {
    const files = await api.openText(['md', 'markdown', 'txt']);
    let lastId = null;
    for (const f of files) {
      const { title, blocks } = markdownToBlocks(f.text, { takeTitle: true });
      const sibs = this.tree.filter((t) => !t.parentId);
      const pageId = uid();
      const ops = [{ op: 'upsert', block: { id: pageId, type: 'page', parentId: null, position: (sibs.length ? Math.max(...sibs.map((s) => s.position)) : 0) + 1, props: { title: title || f.name.replace(/\.(md|markdown|txt)$/i, ''), icon: '' } } }];
      const add = (nodes, parentId) => nodes.forEach((n, i) => {
        const id = uid();
        ops.push({ op: 'upsert', block: { id, type: n.type, parentId, position: i + 1, props: n.props } });
        add(n.children, id);
      });
      add(blocks, pageId);
      await api.apply(ops);
      lastId = pageId;
    }
    if (lastId) { await this.refreshSidebar(); this.navigate(lastId); toast(`Imported ${files.length} file${files.length > 1 ? 's' : ''}`); }
  }

  command(cmd) {
    closeMenu();
    switch (cmd) {
      case 'new-page': this.createPage(null); break;
      case 'find': this.editor?.openFind(); break;
      case 'replace': this.editor?.openFind(true); break;
      case 'find-next': this.editor?.findReplace?.move(1); break;
      case 'find-previous': this.editor?.findReplace?.move(-1); break;
      case 'search': this.openSearch(); break;
      case 'toggle-sidebar': this.toggleSidebar(); break;
      case 'toggle-theme': this.toggleTheme(); break;
      case 'back': this.back(); break;
      case 'forward': this.forward(); break;
      case 'export-markdown': this.exportMarkdown(); break;
      case 'export-pdf': this.exportPdf(); break;
      case 'import-markdown': this.importMarkdown(); break;
      default:
    }
  }
}

window.app = new App();
window.app.start();
