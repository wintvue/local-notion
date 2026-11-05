'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { validateTag, checksums } = require('../scripts/release');

test('release requires an exact package version, including prerelease suffix', () => {
  validateTag('v1.0.0', '1.0.0');
  validateTag('v1.1.0-beta.1', '1.1.0-beta.1');
  for (const tag of ['1.0.0', 'v2.0.0', 'v1.0.0\n', 'v1.0.0; echo bad']) {
    assert.throws(() => validateTag(tag, '1.0.0'));
  }
});

test('release checksums cover sorted installers only and detect changed bytes', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-notion-release-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => checksums(dir), /No release installers/);
  fs.writeFileSync(path.join(dir, 'b.zip'), 'zip');
  fs.writeFileSync(path.join(dir, 'a.dmg'), 'dmg');
  fs.writeFileSync(path.join(dir, 'builder-debug.yml'), 'not an installer');
  const expected = ['a.dmg', 'b.zip'].map(name => `${crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex')}  ${name}\n`).join('');
  assert.equal(checksums(dir), expected);
  fs.writeFileSync(path.join(dir, 'b.zip'), 'changed');
  assert.notEqual(checksums(dir), expected);
});
