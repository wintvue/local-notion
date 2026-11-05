'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
// electron-builder's bundled ASAR library is available after npm ci.
const asar = require('@electron/asar');
const apps = fs.readdirSync('dist', { withFileTypes: true }).filter(e => e.isDirectory())
  .map(e => path.join('dist', e.name, 'Local Notion.app')).filter(p => fs.existsSync(p));
assert.ok(apps.length, 'No packaged app found');
for (const app of apps) {
  const archive = path.join(app, 'Contents/Resources/app.asar');
  const packaged = JSON.parse(asar.extractFile(archive, 'package.json'));
  assert.equal(packaged.version, require('../package.json').version);
  for (const file of ['src/main/main.js', 'src/main/preload.js', 'src/renderer/js/editor.js', 'src/renderer/js/find-replace.js', 'src/renderer/index.html']) {
    assert.deepEqual(asar.extractFile(archive, file), fs.readFileSync(file), `Packaged file differs: ${file}`);
  }
  assert.ok(fs.existsSync(path.join(app, 'Contents/MacOS/Local Notion')));
  console.log('Verified packaged application:', app);
}
