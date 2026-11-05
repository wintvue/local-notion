import { el } from './util.js';

// Ranges highlight text without inserting markup into the saved document.
export class FindReplace {
  constructor(editor) {
    this.editor = editor;
    this.matches = [];
    this.index = 0;
    this.query = el('input', { placeholder: 'Find in page', 'aria-label': 'Find in page' });
    this.replacement = el('input', { placeholder: 'Replace with', 'aria-label': 'Replace with' });
    this.status = el('span', { class: 'find-status', role: 'status', 'aria-live': 'polite' });
    this.previous = el('button', { title: 'Previous match (Shift+Enter)', onclick: () => this.move(-1) }, '↑');
    this.next = el('button', { title: 'Next match (Enter)', onclick: () => this.move(1) }, '↓');
    this.replace = el('button', { onclick: () => this.replaceMatches(false) }, 'Replace');
    this.replaceAll = el('button', { onclick: () => this.replaceMatches(true) }, 'Replace All');
    this.caseSensitive = el('input', { type: 'checkbox', onchange: () => this.refresh(true) });
    this.replaceRow = el('div', { class: 'find-row' }, this.replacement, this.replace, this.replaceAll);
    this.panel = el('div', { class: 'find-panel', role: 'search', 'aria-label': 'Find and replace in page' },
      el('div', { class: 'find-row' }, this.query, this.status, this.previous, this.next,
        el('button', { title: 'Show or hide replace', onclick: () => { this.replaceRow.hidden = !this.replaceRow.hidden; } }, '⇄'),
        el('button', { title: 'Close (Escape)', onclick: () => this.close(true) }, '×')),
      this.replaceRow,
      el('label', { class: 'find-case' }, this.caseSensitive, ' Match case'));
    this.query.addEventListener('input', () => this.refresh(true));
    this.panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); this.close(true); }
      if (e.key === 'Enter') { e.preventDefault(); if (e.target === this.replacement) this.replaceMatches(false); else this.move(e.shiftKey ? -1 : 1); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && e.target.tagName !== 'INPUT') {
        e.preventDefault(); e.shiftKey ? editor.redo() : editor.undo();
      }
    });
    document.body.append(this.panel);
    this.observer = new MutationObserver(() => this.refresh());
    this.observer.observe(editor.root, { subtree: true, childList: true, characterData: true });
  }

  open(replace) {
    const selection = window.getSelection();
    if (selection && this.editor.root.contains(selection.anchorNode) && selection.toString() && !selection.toString().includes('\n')) this.query.value = selection.toString();
    this.replaceRow.hidden = !replace;
    this.refresh(true);
    this.paint(true);
    this.query.focus();
    this.query.select();
  }

  refresh(reset = false) {
    if (reset) this.index = 0;
    this.matches = [];
    const query = this.query.value;
    if (query) {
      const targets = [{ node: this.editor.titleEl, block: null }];
      // Walk the DOM in reading order; collapsed toggle children are excluded.
      for (const node of this.editor.root.querySelectorAll('.text[data-block]')) {
        if (node.closest('[hidden]') || !node.getClientRects().length) continue;
        targets.push({ node, block: this.editor.blocks.get(node.dataset.block) });
      }
      const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), this.caseSensitive.checked ? 'g' : 'gi');
      for (const { node, block } of targets) {
        if (!node || (block === undefined)) continue;
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        const nodes = [];
        let textNode, offset = 0;
        while ((textNode = walker.nextNode())) { nodes.push({ node: textNode, start: offset }); offset += textNode.length; }
        for (const hit of node.textContent.matchAll(pattern)) {
          const start = hit.index, end = start + hit[0].length;
          const first = nodes.find(n => n.start + n.node.length > start);
          const last = nodes.find(n => n.start + n.node.length >= end);
          if (!first || !last) continue;
          const range = document.createRange();
          range.setStart(first.node, start - first.start);
          range.setEnd(last.node, end - last.start);
          this.matches.push({ range, node, block });
        }
      }
    }
    this.index = Math.min(this.index, Math.max(0, this.matches.length - 1));
    this.paint();
  }

  paint(scroll = false) {
    const current = this.matches[this.index];
    CSS.highlights.set('find-matches', new Highlight(...this.matches.map(m => m.range)));
    CSS.highlights.set('find-current', new Highlight(...(current ? [current.range] : [])));
    this.status.textContent = this.query.value ? (current ? `${this.index + 1} of ${this.matches.length}` : 'No matches') : 'Type to find';
    for (const button of [this.previous, this.next, this.replace, this.replaceAll]) button.disabled = !current;
    if (scroll && current) current.node.scrollIntoView({ block: 'center', behavior: 'instant' });
  }

  move(delta) {
    this.refresh();
    if (this.matches.length) this.index = (this.index + delta + this.matches.length) % this.matches.length;
    this.paint(true);
  }

  replaceMatches(all) {
    this.refresh();
    if (!this.matches.length) return;
    this.editor.checkpoint();
    const matches = all ? [...this.matches].reverse() : [this.matches[this.index]];
    const changed = new Set();
    for (const match of matches) {
      match.range.deleteContents();
      match.range.insertNode(document.createTextNode(this.replacement.value));
      changed.add(match.block);
    }
    for (const block of changed) {
      if (block) this.editor.syncText(block);
      else {
        this.editor.page.props.title = this.editor.titleEl.textContent;
        this.editor.touchPage();
        this.editor.app.onTitleChange(this.editor.page);
      }
    }
    this.editor.renderTocs();
    this.refresh();
    this.paint(true);
  }

  close(restoreFocus = false) {
    this.observer.disconnect();
    this.panel.remove();
    CSS.highlights.delete('find-matches');
    CSS.highlights.delete('find-current');
    this.editor.findReplace = null;
    if (restoreFocus) this.editor.titleEl.focus();
  }
}
