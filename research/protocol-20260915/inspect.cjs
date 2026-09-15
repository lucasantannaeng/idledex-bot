const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const bundlePath = path.join(__dirname, 'index-Ykq_gMSa.js');
const source = fs.readFileSync(bundlePath, 'utf8');
const keys = process.argv.slice(2);
if (keys[0] === '--slice') {
  const offset = Number(keys[1]);
  console.log(source.slice(offset, offset + Number(keys[2] || 5000)));
  process.exit(0);
}
for (const key of keys) {
  const matches = [];
  let offset = -1;
  while ((offset = source.indexOf(key, offset + 1)) >= 0) {
    matches.push({ offset, context: source.slice(Math.max(0, offset - 120), offset + 1250) });
  }
  console.log(JSON.stringify({ key, total: matches.length, matches: matches.slice(0, 5) }, null, 2));
}
if (!keys.length) {
  const artifacts = ['play.html', 'index-Ykq_gMSa.js'].map(file => {
    const bytes = fs.readFileSync(path.join(__dirname, file));
    return { file, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  });
  console.log(JSON.stringify({ artifacts, assets: [...new Set([...source.matchAll(/\.\/[^"'\s]+\.js/g)].map(match => match[0]))] }, null, 2));
}
