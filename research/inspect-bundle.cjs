const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, 'index-DwmEwqo-.js'), 'utf8');
console.log('SHA256:', crypto.createHash('sha256').update(source).digest('hex'));
if (process.argv[2] === '--commands') {
    console.log([...new Set([...source.matchAll(/"([a-z][a-z-]*:[a-z:-]+)"/g)].map(match => match[1]))].filter(key => key.startsWith(process.argv[3] || '')).join('\n'));
    process.exit(0);
}
if (process.argv[2] === '--function') {
    const index = source.indexOf(process.argv[3]);
    if (index < 0) throw new Error('Pattern not found');
    const start = source.lastIndexOf('function ', index);
    const end = source.indexOf('function ', index + 1);
    console.log(source.slice(start, end < 0 ? index + 5000 : end));
    process.exit(0);
}
for (let key of (process.argv.length > 2 ? process.argv.slice(2) : ['battle:move', 'battle:item', 'map:travel', 'professor:deliver', 'collection:state', 'battle:control'])) {
    if (key.startsWith('@')) key = 'case' + JSON.stringify(key.slice(1)) + ':';
    let index = -1;
    for (let count = 0; count < 3; count++) {
        index = source.indexOf(key, index + 1);
        if (index < 0) break;
        console.log(key, source.slice(Math.max(0, index - 100), index + 650));
    }
}
