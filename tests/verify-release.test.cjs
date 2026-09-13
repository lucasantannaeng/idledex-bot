const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { parseArgs, computeFileHash, computeDirHash, verifyRelease } = require('../research/verify-release.cjs');

test('T19: parseArgs extracts --app-dir correctly', () => {
    assert.deepEqual(parseArgs(['--other', 'val']), { appDir: null });
    assert.deepEqual(parseArgs(['--app-dir', 'dist-custom/app']), { appDir: 'dist-custom/app' });
    assert.deepEqual(parseArgs(['--verbose', '--app-dir', 'my-dir', '--flag']), { appDir: 'my-dir' });
});

test('T19: computeFileHash computes correct sha256', () => {
    const buf = Buffer.from('hello world');
    const hash = computeFileHash(buf);
    assert.equal(hash, 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
});

test('T19: verifyRelease fails when candidate directory does not exist', () => {
    assert.throws(() => {
        verifyRelease({ appDir: 'non-existent-directory-xyz-123', writeReport: false });
    }, /Target app directory does not exist/);
});

test('T19: verifyRelease detects unexpected extra files outside allowlist', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idledex-verify-test-'));
    try {
        // Copy electron, app, and package.json from root to tmpDir
        const root = path.resolve(__dirname, '..');
        fs.cpSync(path.join(root, 'electron'), path.join(tmpDir, 'electron'), { recursive: true });
        fs.cpSync(path.join(root, 'app'), path.join(tmpDir, 'app'), { recursive: true });
        fs.copyFileSync(path.join(root, 'package.json'), path.join(tmpDir, 'package.json'));

        // Add an unauthorized extra file
        fs.writeFileSync(path.join(tmpDir, 'unexpected-secrets.env'), 'SECRET_KEY=123');

        assert.throws(() => {
            verifyRelease({ appDir: tmpDir, writeReport: false });
        }, /Unexpected extra files found in distribution: unexpected-secrets.env/);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('T19: verifyRelease detects modified distribution files', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idledex-verify-test-mod-'));
    try {
        const root = path.resolve(__dirname, '..');
        fs.cpSync(path.join(root, 'electron'), path.join(tmpDir, 'electron'), { recursive: true });
        fs.cpSync(path.join(root, 'app'), path.join(tmpDir, 'app'), { recursive: true });
        fs.copyFileSync(path.join(root, 'package.json'), path.join(tmpDir, 'package.json'));

        // Tamper with a file
        fs.writeFileSync(path.join(tmpDir, 'app/app.js'), '// Tampered content');

        assert.throws(() => {
            verifyRelease({ appDir: tmpDir, writeReport: false });
        }, /Distribution differs from source: app\/app.js/);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('T19: verifyRelease succeeds with identical valid distribution directory', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idledex-verify-test-valid-'));
    try {
        const root = path.resolve(__dirname, '..');
        fs.cpSync(path.join(root, 'electron'), path.join(tmpDir, 'electron'), { recursive: true });
        fs.cpSync(path.join(root, 'app'), path.join(tmpDir, 'app'), { recursive: true });
        fs.copyFileSync(path.join(root, 'package.json'), path.join(tmpDir, 'package.json'));

        const report = verifyRelease({ appDir: tmpDir, writeReport: false, smokePath: 'non-existent-smoke.json' });
        assert.equal(report.sourceMatchesDistribution, true);
        assert.ok(report.candidateHash);
        assert.ok(report.shippedFileCount > 5);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});
