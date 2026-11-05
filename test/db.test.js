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
