const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const shipped = path.join(root, 'dist-desktop/win-unpacked/resources/app');
function files(directory) {
    return fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap(entry => {
        const relative = path.join(directory, entry.name);
        return entry.isDirectory() ? files(relative) : [relative];
    });
}
const hashes = {};
for (const relative of [...files('electron'), ...files('app')]) {
    const source = fs.readFileSync(path.join(root, relative));
    assert.ok(source.equals(fs.readFileSync(path.join(shipped, relative))), `Distribution differs: ${relative}`);
    hashes[relative] = crypto.createHash('sha256').update(source).digest('hex');
}
// electron-builder removes development scripts and build metadata from the manifest.
const manifest = JSON.parse(fs.readFileSync(path.join(shipped, 'package.json')));
for (const key of ['name', 'version', 'main', 'dependencies']) {
    assert.deepEqual(manifest[key], require('../package.json')[key], `Manifest differs: ${key}`);
}
const smoke = JSON.parse(fs.readFileSync(path.join(__dirname, 'smoke-result.json')));
assert.equal(smoke.passed, true);
assert.equal(path.resolve(smoke.source), shipped, 'Smoke must exercise the distributed app');
assert.equal(smoke.help.missing.length, 0);
assert.equal(smoke.help.inView, true);
assert.equal(smoke.accountReset, true);
assert.equal(fs.existsSync(path.join(root, 'dist-candidate/win-unpacked')), false, 'Duplicate package still exists');
const report = { checkedAt: new Date().toISOString(), version: require('../package.json').version, sourceMatchesDistribution: true, smoke, hashes };
fs.writeFileSync(path.join(__dirname, 'release-verification.json'), JSON.stringify(report, null, 2));
console.log(`Verified ${Object.keys(hashes).length} distributed files; version ${report.version}`);
