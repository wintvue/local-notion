'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function validateTag(tag, version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(version) || tag !== `v${version}`) {
    throw new Error('Release tag must equal v followed by the package.json version.');
  }
}

function checksums(dir) {
  const files = fs.readdirSync(dir).filter(name => /\.(dmg|zip)$/.test(name)).sort();
  if (!files.length) throw new Error('No release installers found.');
  return files.map(name => `${crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex')}  ${name}`).join('\n') + '\n';
}

if (require.main === module) {
  const [command, value] = process.argv.slice(2);
  if (command === 'validate') validateTag(value, require('../package.json').version);
  else if (command === 'checksums') fs.writeFileSync(path.join(value, 'SHA256SUMS.txt'), checksums(value));
  else throw new Error('Expected validate <tag> or checksums <directory>.');
}
module.exports = { validateTag, checksums };
