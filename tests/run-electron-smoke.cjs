const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'idledex-smoke-'));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), [path.join(__dirname, 'electron-smoke.cjs'),
    ...process.argv.slice(2), '--profile', profile], { env, windowsHide: true, stdio: 'inherit' });
const watchdog = setTimeout(() => {
    console.error('Smoke process exceeded 45 seconds');
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
    else child.kill('SIGKILL');
}, 45000);
child.on('error', error => { console.error(error.message); clearTimeout(watchdog); process.exitCode = 1; });
child.on('exit', code => {
    clearTimeout(watchdog);
    // Delete only the exact temporary directory this process created.
    const relative = path.relative(os.tmpdir(), profile);
    if (!relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(profile).startsWith('idledex-smoke-')) {
        fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
    process.exitCode = code === 0 ? 0 : 1;
});
