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
    const smokeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idledex-verify-test-smoke-'));
    try {
        const root = path.resolve(__dirname, '..');
        fs.cpSync(path.join(root, 'electron'), path.join(tmpDir, 'electron'), { recursive: true });
        fs.cpSync(path.join(root, 'app'), path.join(tmpDir, 'app'), { recursive: true });
        fs.copyFileSync(path.join(root, 'package.json'), path.join(tmpDir, 'package.json'));

        const smokePath = path.join(smokeDir, 'smoke-result.json');
        const smoke = { passed: true, candidateHash: computeDirHash(tmpDir) };
        fs.writeFileSync(smokePath, JSON.stringify(smoke));
        const report = verifyRelease({ appDir: tmpDir, writeReport: false, smokePath });
        assert.equal(report.sourceMatchesDistribution, true);
        assert.equal(report.candidateHash, smoke.candidateHash);
        assert.deepEqual(report.smoke, smoke);
        assert.ok(report.shippedFileCount > 5);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        fs.rmSync(smokeDir, { recursive: true, force: true });
    }
});

test('T19: verifyRelease rejects a candidate without a smoke report', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idledex-verify-no-smoke-'));
    try {
        const root = path.resolve(__dirname, '..');
        const appDir = path.join(tmpDir, 'app');
        fs.mkdirSync(appDir);
        fs.cpSync(path.join(root, 'electron'), path.join(appDir, 'electron'), { recursive: true });
        fs.cpSync(path.join(root, 'app'), path.join(appDir, 'app'), { recursive: true });
        fs.copyFileSync(path.join(root, 'package.json'), path.join(appDir, 'package.json'));
        const smokePath = path.join(tmpDir, 'missing-smoke.json');

        assert.throws(() => verifyRelease({ appDir, smokePath, writeReport: false }), /smoke/i);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('T19: verifyRelease rejects passed smoke without a candidate hash', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idledex-verify-unbound-smoke-'));
    try {
        const root = path.resolve(__dirname, '..');
        const appDir = path.join(tmpDir, 'app');
        fs.mkdirSync(appDir);
        fs.cpSync(path.join(root, 'electron'), path.join(appDir, 'electron'), { recursive: true });
        fs.cpSync(path.join(root, 'app'), path.join(appDir, 'app'), { recursive: true });
        fs.copyFileSync(path.join(root, 'package.json'), path.join(appDir, 'package.json'));
        const smokePath = path.join(tmpDir, 'smoke-result.json');
        fs.writeFileSync(smokePath, JSON.stringify({ passed: true }));

        assert.throws(() => verifyRelease({ appDir, smokePath, writeReport: false }), /hash/i);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('T19: computeDirHash identifies relative file paths, independent of candidate root', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idledex-verify-hash-paths-'));
    try {
        const first = path.join(tmpDir, 'candidate-a');
        const second = path.join(tmpDir, 'candidate-b');
        fs.mkdirSync(path.join(first, 'electron'), { recursive: true });
        fs.writeFileSync(path.join(first, 'electron', 'main.js'), 'console.log("fixture");');
        fs.cpSync(first, second, { recursive: true });

        assert.equal(computeDirHash(first), computeDirHash(second), 'Identical copies must share a hash');
        fs.renameSync(path.join(second, 'electron'), path.join(second, 'misplaced-electron'));
        assert.notEqual(computeDirHash(first), computeDirHash(second), 'Moving code must change candidate identity');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});
