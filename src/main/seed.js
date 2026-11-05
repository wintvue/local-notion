'use strict';
const crypto = require('node:crypto');

// First-run content so a new workspace isn't empty.
function seed(store) {
  const id = () => crypto.randomUUID();
  const ops = [];
  let pos = 0;
  const add = (type, parentId, props) => {
    const b = { id: id(), type, parentId, position: ++pos, props };
    ops.push({ op: 'upsert', block: b });
    return b.id;
  };

  const welcome = add('page', null, { title: 'Getting Started', icon: '👋' });
  add('paragraph', welcome, { text: 'Welcome to <b>Local Notion</b>, a workspace that keeps everything on this computer.' });
  add('heading2', welcome, { text: 'The basics' });
  add('todo', welcome, { text: 'Type <code>/</code> on an empty line to insert any block', checked: false });
  add('todo', welcome, { text: 'Use Markdown shortcuts: <code>#</code>, <code>-</code>, <code>1.</code>, <code>[]</code>, <code>&gt;</code>, <code>```</code>', checked: false });
  add('todo', welcome, { text: 'Select text and press ⌘B, ⌘I, ⌘U, ⌘E or ⌘K for formatting and links', checked: false });
  add('todo', welcome, { text: 'Press Tab / Shift-Tab to nest and un-nest blocks', checked: false });
  add('todo', welcome, { text: 'Drag the ⋮⋮ handle to reorder blocks', checked: true });
  const toggle = add('toggle', welcome, { text: 'Click the arrow to open this toggle', collapsed: true });
  add('paragraph', toggle, { text: 'Toggles can hold any blocks, including other toggles.' });
  add('callout', welcome, { text: 'Press ⌘P to search every page. ⌘N creates a new page.', icon: '💡' });
  add('heading2', welcome, { text: 'Pages inside pages' });
  const sub = add('page', welcome, { title: 'A sub-page', icon: '📄' });
  add('paragraph', sub, { text: 'Pages can be nested as deep as you like. Use the breadcrumbs above to go back.' });
  add('code', welcome, { text: 'function hello() {\n  return "world";\n}', language: 'javascript' });
  add('quote', welcome, { text: 'Everything is stored in a local SQLite database. File ▸ Show Data Folder reveals it.' });

  const status = [
    { id: 'todo', name: 'Not started', color: 'gray' },
    { id: 'doing', name: 'In progress', color: 'blue' },
    { id: 'done', name: 'Done', color: 'green' },
  ];
  const db = add('database', null, {
    title: 'Tasks',
    icon: '✅',
    schema: [
      { id: 'title', name: 'Name', type: 'title' },
      { id: 'status', name: 'Status', type: 'select', options: status },
      { id: 'due', name: 'Due', type: 'date' },
      { id: 'done', name: 'Done', type: 'checkbox' },
      { id: 'est', name: 'Estimate (h)', type: 'number' },
    ],
    views: [
      { id: 'table', type: 'table', name: 'Table' },
      { id: 'board', type: 'board', name: 'Board', groupBy: 'status' },
    ],
  });
  const today = new Date().toISOString().slice(0, 10);
  add('page', db, { title: 'Try the board view', icon: '', values: { status: 'doing', due: today, est: 1 } });
  add('page', db, { title: 'Add a new property', icon: '', values: { status: 'todo', est: 2 } });
  add('page', db, { title: 'Open a row as a page', icon: '', values: { status: 'done', done: true, est: 0.5 } });

  store.apply(ops);
}

module.exports = { seed };
