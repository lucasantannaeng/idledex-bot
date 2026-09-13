const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');

function parseArgs(args = process.argv.slice(2)) {
    let appDir = null;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--app-dir' && i + 1 < args.length) {
            appDir = args[i + 1];
            i++;
        }
    }
    return { appDir };
}

function computeFileHash(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function computeDirHash(dir) {
    const hash = crypto.createHash('sha256');
    function walk(sub) {
        if (!fs.existsSync(sub)) return;
        const entries = fs.readdirSync(sub, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
            const p = path.join(sub, entry.name);
            if (entry.isDirectory()) walk(p);
            else if (entry.isFile()) {
                hash.update(entry.name);
                hash.update(fs.readFileSync(p));
            }
        }
    }
    walk(dir);
    return hash.digest('hex');
}

function collectFiles(baseDir, relativePrefix = '') {
    const results = [];
    const fullPath = path.join(baseDir, relativePrefix);
    if (!fs.existsSync(fullPath)) return results;
    const entries = fs.readdirSync(fullPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
        const rel = relativePrefix ? path.join(relativePrefix, entry.name) : entry.name;
        if (entry.isDirectory()) {
            results.push(...collectFiles(baseDir, rel));
        } else if (entry.isFile()) {
            results.push(rel.replace(/\\/g, '/'));
        }
    }
    return results;
}

function verifyRelease(options = {}) {
    const cliArgs = parseArgs(options.argv || process.argv.slice(2));
    const targetAppDir = options.appDir || cliArgs.appDir || (
        fs.existsSync(path.join(root, 'dist-release/win-unpacked/resources/app'))
            ? path.join(root, 'dist-release/win-unpacked/resources/app')
            : path.join(root, 'dist-desktop/win-unpacked/resources/app')
    );

    const shipped = path.resolve(root, targetAppDir);
    assert.ok(fs.existsSync(shipped), `Target app directory does not exist: ${shipped}`);

    // Expected source directories/files
    const expectedSourceFiles = [
        ...collectFiles(root, 'electron'),
        ...collectFiles(root, 'app')
    ];

    const hashes = {};
    for (const rel of expectedSourceFiles) {
        const sourcePath = path.join(root, rel);
        const shippedPath = path.join(shipped, rel);
        assert.ok(fs.existsSync(shippedPath), `Missing distributed file: ${rel}`);
        const sourceBuf = fs.readFileSync(sourcePath);
        const shippedBuf = fs.readFileSync(shippedPath);
        assert.ok(sourceBuf.equals(shippedBuf), `Distribution differs from source: ${rel}`);
        hashes[rel] = computeFileHash(sourceBuf);
    }

    // Manifest checks
    const shippedManifestPath = path.join(shipped, 'package.json');
    assert.ok(fs.existsSync(shippedManifestPath), 'Missing shipped package.json');
    const sourcePkg = require('../package.json');
    const shippedPkg = JSON.parse(fs.readFileSync(shippedManifestPath, 'utf8'));
    for (const key of ['name', 'version', 'main', 'dependencies']) {
        assert.deepEqual(shippedPkg[key], sourcePkg[key], `Manifest differs: ${key}`);
    }

    // Allowlist check for extra files in shipped directory
    const shippedFiles = collectFiles(shipped);
    const allowedFilesSet = new Set([...expectedSourceFiles, 'package.json']);
    const disallowedFiles = shippedFiles.filter(f => !allowedFilesSet.has(f));
    assert.deepEqual(disallowedFiles, [], `Unexpected extra files found in distribution: ${disallowedFiles.join(', ')}`);

    const candidateHash = computeDirHash(shipped);

    // Smoke result verification if available
    let smokeReport = null;
    const smokePath = options.smokePath || path.join(__dirname, 'smoke-result.json');
    if (fs.existsSync(smokePath)) {
        smokeReport = JSON.parse(fs.readFileSync(smokePath, 'utf8'));
        assert.equal(smokeReport.passed, true, 'Smoke test did not pass');
        if (smokeReport.candidateHash) {
            assert.equal(smokeReport.candidateHash, candidateHash, 'Smoke test was run against a different build hash');
        }
    }

    const report = {
        checkedAt: new Date().toISOString(),
        version: sourcePkg.version,
        sourceMatchesDistribution: true,
        candidatePath: path.relative(root, shipped).replace(/\\/g, '/'),
        candidateHash,
        shippedFileCount: Object.keys(hashes).length + 1,
        hashes,
        smoke: smokeReport
    };

    if (options.writeReport !== false) {
        fs.writeFileSync(path.join(__dirname, 'release-verification.json'), JSON.stringify(report, null, 2));
    }
    return report;
}

if (require.main === module) {
    const report = verifyRelease();
    console.log(`Verified ${report.shippedFileCount} distributed files in ${report.candidatePath}; version ${report.version}; hash: ${report.candidateHash.slice(0, 12)}`);
}

module.exports = {
    parseArgs,
    computeFileHash,
    computeDirHash,
    collectFiles,
    verifyRelease
};
