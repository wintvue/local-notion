'use strict';
// End-to-end driver: boots the real app against a throwaway data dir, drives the
// window with real input events, and writes screenshots to $E2E_OUT.
// Usage: npx electron test/e2e.js
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localnotes-e2e-'));
process.env.LOCALNOTES_DATA_DIR = dataDir;
const OUT = process.env.E2E_OUT || path.join(dataDir, 'shots');
fs.mkdirSync(OUT, { recursive: true });

require('../src/main/main.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];

app.on('browser-window-created', async (_e, win) => {
  if (global.__driven) return;
  global.__driven = true;
  const wc = win.webContents;
  wc.on('console-message', (e) => { if (e.level === 'error' || e.level === 3) console.log('[renderer error]', e.message); });
  await new Promise((r) => wc.once('did-finish-load', r));
  await sleep(800);

  const js = (code) => wc.executeJavaScript(code);
  const shot = async (name) => { const img = await wc.capturePage(); fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG()); };
  const type = async (text) => { for (const ch of text) { wc.sendInputEvent({ type: 'char', keyCode: ch }); await sleep(12); } await sleep(60); };
  const key = async (keyCode, modifiers = []) => {
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await sleep(120);
  };
  const expect = async (desc, code) => {
    const ok = await js(code).catch((e) => `threw ${e.message}`);
    console.log(ok === true ? '  ✔' : '  ✖', desc, ok === true ? '' : `→ ${JSON.stringify(ok)}`);
    if (ok !== true) failures.push(desc);
  };

  try {
    console.log('E2E: data dir', dataDir);
    await expect('sidebar shows seeded pages', `document.querySelectorAll('.sb-item.sb-page').length >= 2`);
    await expect('Getting Started page renders blocks', `document.querySelectorAll('.blocks .block').length > 8`);
    await shot('01-welcome');
    if (process.env.E2E_DEBUG) console.log(await js(process.env.E2E_DEBUG));

    // New page via app API, then type a title and content.
    await js('window.app.createPage(null)');
    await sleep(400);
    await expect('new page focuses title', `document.activeElement.classList.contains('page-title')`);
    await type('Meeting notes');
    await key('Enter');
    await type('# Agenda');
    await expect('"# " shortcut makes heading1', `!!document.querySelector('.blocks .type-heading1')`);
    await key('Enter');
    await type('- first item');
    await key('Enter');
    await type('second item');
    await key('Tab');
    await expect('Tab nests the bullet', `document.querySelectorAll('.blocks .type-bulleted .block-children .type-bulleted').length === 1`);
    await key('Enter');
    await key('Enter'); // empty nested bullet -> outdent
    await key('Enter'); // empty top-level bullet -> paragraph
    await expect('empty list item converts to paragraph', `document.activeElement.closest('.block').classList.contains('type-paragraph')`);
    await type('[] buy milk');
    await expect('[] makes a todo', `!!document.querySelector('.blocks .type-todo')`);
    await key('Enter');
    await key('Enter');
    await type('/');
    await sleep(150);
    const box = await js(`(() => { const r = document.querySelector('.slash-popup').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    wc.sendInputEvent({ type: 'mouseMove', x: box.x, y: box.y });
    await sleep(50);
    for (let i = 0; i < 4; i++) { wc.sendInputEvent({ type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: -120 }); await sleep(80); }
    await sleep(300);
    await expect('slash menu scrolls with the mouse wheel', `document.querySelector('.slash-popup').scrollTop > 100`);
    await key('ArrowDown');
    await expect('arrow keys keep the menu open and scrolled', `!!document.querySelector('.slash-popup') && document.querySelector('.slash-popup').scrollTop > 0`);
    await type('code');
    await sleep(150);
    await expect('slash menu opens and filters', `document.querySelector('.slash-item.active')?.textContent.includes('Code') === true`);
    await key('Enter');
    await expect('slash turns block into code', `document.activeElement.closest('.block').classList.contains('type-code')`);
    await type('const x = 1;');
    await shot('02-new-page');

    // Undo should remove the code text, redo restores it.
    await key('z', ['meta']);
    await sleep(100);
    await expect('undo reverts typing', `!document.querySelector('.type-code pre').textContent.includes('const x')`);
    await key('z', ['meta', 'shift']);
    await sleep(100);
    await expect('redo restores typing', `document.querySelector('.type-code pre').textContent.includes('const x')`);

    // Persistence: reload the page from disk.
    await js('window.app.editor.flush()');
    await sleep(300);
    await js('window.app.reload()');
    await sleep(500);
    await expect('content persisted after reload', `[...document.querySelectorAll('.blocks .text')].map(t => t.textContent).join('|').includes('buy milk')`);
    await expect('nested bullet persisted', `document.querySelectorAll('.blocks .type-bulleted .block-children .type-bulleted').length === 1`);
    await expect('sidebar shows new title', `[...document.querySelectorAll('.sb-label')].some(l => l.textContent === 'Meeting notes')`);

    // Backspace merge: put caret at start of the 2nd paragraph-ish block.
    await js(`(() => { const t = [...document.querySelectorAll('.blocks .type-todo .text')][0]; t.focus(); const r = document.createRange(); r.setStart(t.firstChild, 0); r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r); })()`);
    await key('Backspace');
    await expect('backspace at start turns todo into paragraph', `!document.querySelector('.blocks .type-todo')`);

    // Search
    await key('p', ['meta']);
    await sleep(200);
    await type('milk');
    await sleep(300);
    await expect('search finds page by content', `document.querySelector('.search-item.active')?.textContent.includes('Meeting notes') === true`);
    await shot('03-search');
    await key('Escape');

    // Database
    const dbId = await js(`window.app.tree.find(t => t.type === 'database').id`);
    await js(`window.app.navigate(${JSON.stringify(dbId)})`);
    await sleep(500);
    await expect('database table renders rows', `document.querySelectorAll('.db-row:not(.head)').length === 3`);
    await shot('04-db-table');
    await js(`document.querySelector('.db-actions .primary-btn').click()`);
    await sleep(300);
    await type('Write tests');
    await sleep(400);
    await expect('new row added', `document.querySelectorAll('.db-row:not(.head)').length === 4`);
    await js(`[...document.querySelectorAll('.db-tab')].find(t => t.textContent.includes('Board')).click()`);
    await sleep(300);
    await expect('board view renders columns', `document.querySelectorAll('.board-col').length >= 3`);
    await shot('05-db-board');

    // Open a row as a page and check properties.
    await js(`document.querySelector('.board-card').click()`);
    await sleep(500);
    await expect('row page shows properties', `document.querySelectorAll('.prop-row').length >= 3`);
    await shot('06-row-page');

    // Trash & restore
    const curId = await js('window.app.currentId');
    await js(`window.app.trashPage(${JSON.stringify(curId)})`);
    await sleep(400);
    const trash = await js('window.api.trash()');
    await expect('trashed row appears in trash', `${JSON.stringify(trash.map((t) => t.id))}.includes(${JSON.stringify(curId)})`);

    // Markdown round trip
    const sampleMd = '# Title\n\n- a\n    - b\n- [x] done\n\n```js\nx()\n```\n**bold** text';
    await expect('markdown import parses nested lists, todos and code', `import('./js/markdown.js').then(m => {
      const r = m.markdownToBlocks(${JSON.stringify(sampleMd)}, { takeTitle: true });
      return r.title === 'Title' && r.blocks[0].type === 'bulleted' && r.blocks[0].children[0].props.text === 'b'
        && r.blocks[1].props.checked === true && r.blocks[2].type === 'code' && r.blocks[3].props.text === '<b>bold</b> text';
    })`);

    // Find/replace across inline formatting, with literal input and structural undo.
    await js(`(() => {
      const e = window.app.editor;
      const b = e.addBlock('paragraph', e.page.id, e.lastChildPosition(e.page.id), { text: '<b>Need</b><i>le</i> Needle needle' });
      e.renderBlocks(); window.__findBlock = b.id;
      window.app.command('replace');
      e.findReplace.query.value = 'Needle'; e.findReplace.refresh(true);
    })()`);
    await expect('find counts matches across formatting', `window.app.editor.findReplace.matches.length === 3`);
    await expect('find panel focuses search', `document.activeElement === window.app.editor.findReplace.query`);
    await js(`window.app.editor.findReplace.move(-1)`);
    await expect('previous match wraps', `window.app.editor.findReplace.index === 2`);
    await js(`(() => { const f = window.app.editor.findReplace; f.caseSensitive.checked = true; f.refresh(true); })()`);
    await expect('match case filters results', `window.app.editor.findReplace.matches.length === 2`);
    await js(`(() => { const f = window.app.editor.findReplace; f.replacement.value = '<$&>'; f.replaceMatches(true); })()`);
    await expect('replace all inserts literal text and preserves unaffected formatting', `(() => {
      const e = window.app.editor, n = e.nodes.get(window.__findBlock).text;
      return n.textContent === '<$&> <$&> needle' && !n.querySelector('script');
    })()`);
    await js(`window.app.editor.undo()`);
    await expect('replace all undoes in one step', `window.app.editor.nodes.get(window.__findBlock).text.innerHTML === '<b>Need</b><i>le</i> Needle needle'`);
    await js(`window.app.editor.redo()`);
    await expect('replace all redoes', `window.app.editor.nodes.get(window.__findBlock).text.textContent === '<$&> <$&> needle'`);
    await js(`(() => { const f = window.app.editor.findReplace; f.query.value = '<$&>'; f.refresh(true); })()`);
    await expect('find treats regex characters literally', `window.app.editor.findReplace.matches.length === 2`);
    await shot('find-replace');
    await key('Escape');
    await expect('Escape closes panel and clears highlights', `!document.querySelector('.find-panel') && !CSS.highlights.has('find-matches')`);

    // Dark mode
    await js(`window.api.setTheme('dark')`);
    await js(`window.app.navigate(window.app.tree.find(t => t.title === 'Getting Started').id)`);
    await sleep(500);
    await shot('07-dark');
    await expect('page exports to markdown', `import('./js/markdown.js').then(m => {
      const md = m.pageToMarkdown(window.app.editor.page, id => window.app.editor.children(id));
      return md.startsWith('# 👋 Getting Started') && md.includes('- [x] Drag') && md.includes('**Local Notion**');
    })`);
    await js(`window.api.setTheme('system')`);
  } catch (e) {
    console.error('E2E crashed', e);
    failures.push('crash');
  }
  console.log(failures.length ? `\nE2E FAILED (${failures.length})` : '\nE2E PASSED', '— screenshots in', OUT);
  app.exit(failures.length ? 1 : 0);
});
