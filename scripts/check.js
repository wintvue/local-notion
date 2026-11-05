'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(file) : file.endsWith('.js') ? [file] : [];
  });
}
for (const file of ['src', 'test', 'scripts'].flatMap(walk)) {
  const code = fs.readFileSync(file, 'utf8');
  if (file.startsWith(path.join('src', 'renderer') + path.sep)) new vm.SourceTextModule(code, { identifier: file });
  else new vm.Script(code, { filename: file });
}
console.log('All JavaScript files parse successfully.');
