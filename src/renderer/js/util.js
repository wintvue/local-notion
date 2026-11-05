// Small shared helpers for the renderer.

export const uid = () => crypto.randomUUID();

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function htmlToText(html) {
  const d = document.createElement('div');
  d.innerHTML = html || '';
  return d.textContent || '';
}

export function debounce(fn, ms) {
  let t;
  const wrapped = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  wrapped.flush = () => { clearTimeout(t); fn(); };
  return wrapped;
}

// Inline HTML allowlist for rich text stored in blocks.
const ALLOWED = { B: [], STRONG: [], I: [], EM: [], U: [], S: [], STRIKE: [], CODE: [], A: ['href'], BR: [], SPAN: ['class'], MARK: ['class'] };
const RENAME = { STRONG: 'b', EM: 'i', STRIKE: 's', DEL: 's' };

export function sanitize(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html || '';
  const out = document.createElement('div');
  const walk = (src, dst) => {
    for (const n of src.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) { dst.append(n.textContent); continue; }
      if (n.nodeType !== Node.ELEMENT_NODE) continue;
      const tag = RENAME[n.tagName] ? RENAME[n.tagName].toUpperCase() : n.tagName;
      if (n.tagName === 'DIV' || n.tagName === 'P') {
        if (dst.childNodes.length) dst.append(document.createElement('br'));
        walk(n, dst);
        continue;
      }
      if (!(tag in ALLOWED) && !(n.tagName in ALLOWED)) { walk(n, dst); continue; }
      const e = document.createElement(tag);
      for (const a of ALLOWED[tag] || ALLOWED[n.tagName] || []) {
        const v = n.getAttribute(a);
        if (v == null) continue;
        if (a === 'href' && !/^(https?:|mailto:|page:)/i.test(v.trim())) continue;
        if (a === 'class') {
          const cls = v.split(/\s+/).filter((c) => /^(color|bg)-[a-z]+$/.test(c)).join(' ');
          if (cls) e.setAttribute('class', cls);
          continue;
        }
        e.setAttribute(a, v);
      }
      walk(n, e);
      if (tag === 'SPAN' && !e.getAttribute('class')) { dst.append(...e.childNodes); continue; }
      dst.append(e);
    }
  };
  walk(tpl.content, out);
  // A lone trailing <br> is a contenteditable artifact.
  return out.innerHTML.replace(/<br>$/, '');
}

/** Position strictly between a and b (either may be undefined). */
export function between(a, b) {
  if (a == null && b == null) return 1;
  if (a == null) return b - 1;
  if (b == null) return a + 1;
  return (a + b) / 2;
}

export function timeAgo(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ms).toLocaleDateString();
}

// ---- caret helpers for contenteditable ----

export function caretOffset(root) {
  const sel = window.getSelection();
  if (!sel.rangeCount) return 0;
  const r = sel.getRangeAt(0);
  if (!root.contains(r.startContainer)) return 0;
  const pre = document.createRange();
  pre.selectNodeContents(root);
  pre.setEnd(r.startContainer, r.startOffset);
  return pre.toString().length;
}

export function setCaret(root, offset) {
  root.focus();
  const sel = window.getSelection();
  const range = document.createRange();
  let remaining = offset;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (remaining <= node.length) { range.setStart(node, remaining); range.collapse(true); sel.removeAllRanges(); sel.addRange(range); return; }
    remaining -= node.length;
  }
  range.selectNodeContents(root);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

export function selectionIsCollapsed() {
  const s = window.getSelection();
  return !s.rangeCount || s.isCollapsed;
}

/** Split an editable's HTML at the caret into [before, after]. */
export function splitAtCaret(root) {
  const sel = window.getSelection();
  if (!sel.rangeCount) return [root.innerHTML, ''];
  const r = sel.getRangeAt(0);
  const before = document.createRange();
  before.selectNodeContents(root);
  before.setEnd(r.startContainer, r.startOffset);
  const after = document.createRange();
  after.selectNodeContents(root);
  after.setStart(r.endContainer, r.endOffset);
  const h = (range) => { const d = document.createElement('div'); d.append(range.cloneContents()); return d.innerHTML; };
  return [sanitize(h(before)), sanitize(h(after))];
}

export function caretAtStart(root) {
  return selectionIsCollapsed() && caretOffset(root) === 0;
}

export function caretAtEnd(root) {
  return selectionIsCollapsed() && caretOffset(root) >= (root.textContent || '').length;
}

function caretRect() {
  const sel = window.getSelection();
  if (!sel.rangeCount) return null;
  const r = sel.getRangeAt(0).cloneRange();
  r.collapse(true);
  let rect = r.getClientRects()[0];
  if (!rect) {
    const span = document.createElement('span');
    span.textContent = '​';
    r.insertNode(span);
    rect = span.getBoundingClientRect();
    span.remove();
  }
  return rect;
}

export function caretOnFirstLine(root) {
  const c = caretRect();
  if (!c) return true;
  const lh = parseFloat(getComputedStyle(root).lineHeight) || 24;
  return c.top - root.getBoundingClientRect().top < lh * 0.8;
}

export function caretOnLastLine(root) {
  const c = caretRect();
  if (!c) return true;
  const lh = parseFloat(getComputedStyle(root).lineHeight) || 24;
  return root.getBoundingClientRect().bottom - c.bottom < lh * 0.8;
}

/** Place the caret in `root` on the line nearest x, at its first or last line. */
export function setCaretAtX(root, x, fromBottom) {
  const rect = root.getBoundingClientRect();
  const y = fromBottom ? rect.bottom - 4 : rect.top + 4;
  const pos = document.caretPositionFromPoint ? document.caretPositionFromPoint(x, y) : null;
  if (pos && root.contains(pos.offsetNode)) {
    root.focus();
    const range = document.createRange();
    range.setStart(pos.offsetNode, pos.offset);
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  } else {
    setCaret(root, fromBottom ? (root.textContent || '').length : 0);
  }
}

// ---- floating menus ----

let openMenu = null;

export function closeMenu() {
  if (openMenu) { openMenu.cleanup(); openMenu = null; }
}

/**
 * Show a popup positioned near `anchor` (an element or a DOMRect).
 * items: [{label, icon?, hint?, onClick, danger?} | 'separator' | {header}]
 * or pass a ready-made element as `content`.
 */
export function popup(anchor, { items, content, className = '', align = 'left', onClose } = {}) {
  closeMenu();
  const box = el('div', { class: `popup ${className}` });
  if (content) box.append(content);
  if (items) {
    for (const it of items) {
      if (it === 'separator') { box.append(el('div', { class: 'popup-sep' })); continue; }
      if (it.header) { box.append(el('div', { class: 'popup-header' }, it.header)); continue; }
      box.append(el('div', {
        class: `popup-item${it.danger ? ' danger' : ''}${it.active ? ' active' : ''}`,
        onmousedown: (e) => e.preventDefault(),
        onclick: () => { closeMenu(); it.onClick && it.onClick(); },
      }, it.icon ? el('span', { class: 'popup-icon' }, it.icon) : null, el('span', { class: 'popup-label' }, it.label), it.hint ? el('span', { class: 'popup-hint' }, it.hint) : null));
    }
  }
  document.body.append(box);
  const r = anchor instanceof Element ? anchor.getBoundingClientRect() : anchor;
  const bw = box.offsetWidth, bh = box.offsetHeight;
  let left = align === 'right' ? r.right - bw : r.left;
  let top = r.bottom + 4;
  if (top + bh > window.innerHeight - 8) top = Math.max(8, r.top - bh - 4);
  left = Math.max(8, Math.min(left, window.innerWidth - bw - 8));
  box.style.left = `${left}px`;
  box.style.top = `${top}px`;
  const onDown = (e) => { if (!box.contains(e.target)) closeMenu(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); } };
  setTimeout(() => document.addEventListener('mousedown', onDown), 0);
  document.addEventListener('keydown', onKey, true);
  openMenu = {
    box,
    cleanup: () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
      box.remove();
      onClose && onClose();
    },
  };
  return box;
}

export function isMenuOpen() { return !!openMenu; }

export function modal(content, { className = '', onClose } = {}) {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const box = el('div', { class: `modal ${className}` }, content);
  backdrop.append(box);
  const close = () => { backdrop.remove(); document.removeEventListener('keydown', onKey, true); onClose && onClose(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(backdrop);
  return { close, box };
}

export function toast(msg) {
  const t = el('div', { class: 'toast' }, msg);
  document.body.append(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2200);
}

export const EMOJI = '📄 📝 📌 📎 📚 📖 📒 📓 📔 📕 📗 📘 📙 🗂️ 🗃️ 🗒️ 🗓️ 📅 📆 📊 📈 📉 ✅ ☑️ ✔️ ❌ ⭐ 🌟 ✨ 💡 🔥 🚀 🎯 🏁 🏆 🎉 🎨 🎵 🎬 📷 💻 🖥️ ⌨️ 🧠 🧪 🔬 🔭 🧰 🔧 🔨 ⚙️ 🔒 🔑 🏠 🏢 🌍 🗺️ ✈️ 🚗 🍎 🍕 ☕ 🍰 🌱 🌳 🌸 🌞 🌙 ⛅ ❄️ 🌊 🐶 🐱 🦊 🐻 🐼 🦄 🐝 🦋 ❤️ 💙 💚 💛 💜 🖤 🤍 👋 👍 👏 🙌 🤝 💪 👀 🧑‍💻 👩‍🎨 💬 📣 🔔 💰 💳 🛒 🎁 📦 ⏰ ⌛ 🧭 🔗 🧩 ♟️ 🎲'.split(' ');

export function emojiPicker(anchor, onPick, { allowRemove = true } = {}) {
  const grid = el('div', { class: 'emoji-grid' });
  for (const e of EMOJI) grid.append(el('button', { class: 'emoji', onclick: () => { closeMenu(); onPick(e); } }, e));
  const content = el('div', { class: 'emoji-picker' },
    el('div', { class: 'emoji-bar' },
      el('span', {}, 'Pick an icon'),
      allowRemove ? el('button', { class: 'link-btn', onclick: () => { closeMenu(); onPick(''); } }, 'Remove') : null,
      el('button', { class: 'link-btn', onclick: () => { closeMenu(); onPick(EMOJI[Math.floor(Math.random() * EMOJI.length)]); } }, 'Random')),
    grid);
  popup(anchor, { content });
}

export const COLORS = ['default', 'gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'];
