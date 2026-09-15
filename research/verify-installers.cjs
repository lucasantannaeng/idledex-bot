// author: codex — inspect embedded application files without running an installer.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { verifyRelease, computeFileHash } = require('./verify-release.cjs');
const root = path.resolve(__dirname, '..');
const version = require('../package.json').version;
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'idledex-artifact-check-'));
const reports = [];
try {
    for (const kind of ['Portable', 'Setup']) {
        const file = path.join(root, 'dist-release', `IdleDex_Desktop_${kind}_${version}.exe`);
        const destination = path.join(temporary, kind);
        const result = spawnSync(path.join(root, 'node_modules/7zip-bin/win/x64/7za.exe'),
            ['x', file, 'resources\\app\\*', '-r', '-y', '-o' + destination],
            { windowsHide: true, encoding: 'utf8', timeout: 60000 });
        assert.equal(result.status, 0, `Extraction failed: ${kind}\n${result.stdout}\n${result.stderr}`);
        const report = verifyRelease({ appDir: path.join(destination, 'resources/app'), writeReport: false });
        reports.push({ file: path.relative(root, file), sha256: computeFileHash(fs.readFileSync(file)),
            version, candidateHash: report.candidateHash, verifiedFiles: report.shippedFileCount });
    }
    fs.writeFileSync(path.join(__dirname, 'installer-verification.json'),
        JSON.stringify({ checkedAt: new Date().toISOString(), passed: true, reports }, null, 2));
    console.log(JSON.stringify(reports, null, 2));
} finally {
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temporary).startsWith('idledex-artifact-check-'));
    fs.rmSync(temporary, { recursive: true, force: true });
}
