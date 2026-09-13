// Hidden, isolated Electron smoke test of the packaged dashboard and preload bridge.
const { app, BrowserWindow, ipcMain, session, webContents } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const root = path.resolve(__dirname, '..');
const assert = require('node:assert/strict');
function parseArgs() {
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--app-dir' && i + 1 < args.length) return args[i + 1];
    }
    return null;
}
const cliAppDir = parseArgs();
const packaged = process.env.IDLEDEX_SMOKE_SOURCE === '1'
    ? root
    : (cliAppDir
        ? path.resolve(root, cliAppDir)
        : (process.env.IDLEDEX_APP_DIR
            ? path.resolve(root, process.env.IDLEDEX_APP_DIR)
            : (fs.existsSync(path.join(root, 'dist-release/win-unpacked/resources/app'))
                ? path.join(root, 'dist-release/win-unpacked/resources/app')
                : path.join(root, 'dist-desktop/win-unpacked/resources/app'))));
app.setPath('userData', path.join(root, '.smoke-profile'));
const config = { enabled: false, auto_idle: false, catch_hp_pct: 0, strategy_mode: 'collection', ball_priority: 'force_highest' };
const { resetGameSession } = require(path.join(packaged, 'electron/account-session'));
ipcMain.handle('get-config', () => config);
ipcMain.handle('save-config', (_event, value) => Object.assign(config, value) && true);
ipcMain.handle('switch-account', async () => {
    config.enabled = false;
    await resetGameSession(session.fromPartition('persist:idledex'), webContents.getAllWebContents());
    return { ok: true };
});
let window;
let timeout;
async function run() {
    await app.whenReady();
    // Serve an offline fixture at the game's origin. No login or game server is contacted.
    session.fromPartition('persist:idledex').protocol.handle('https', () => new Response(
        '<!doctype html><html><meta charset="utf-8"><body style="background:#111;color:#eee;font:20px sans-serif"><h1>IdleDex — teste local</h1><p>Validação de configuração e preload, sem conexão ao jogo.</p></body></html>',
        { headers: { 'content-type': 'text/html; charset=utf-8' } },
    ));
    app.on('web-contents-created', (_event, contents) => {
        contents.on('will-attach-webview', (_ev, preferences) => {
            preferences.preload = path.join(packaged, 'electron/preload-game.js');
            preferences.contextIsolation = false;
            preferences.sandbox = false;
        });
    });
    window = new BrowserWindow({ show: false, width: 1480, height: 920, webPreferences: {
        preload: path.join(packaged, 'electron/preload-dashboard.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: false, webviewTag: true, backgroundThrottling: false, offscreen: true,
    } });
    const errors = [];
    window.webContents.on('console-message', (_event, level, message) => { if (level === 3) errors.push(message); });
    timeout = setTimeout(() => { console.error('Electron smoke timed out'); app.exit(1); }, 25000);
    await window.loadFile(path.join(packaged, 'app/index.html'));
    const result = await window.webContents.executeJavaScript(`new Promise((resolve,reject)=>{
        let attempts=0; const timer=setInterval(()=>{
            if(lastTelemetry?.config?.ball_priority==='force_highest') {
                clearInterval(timer); resolve({enabled:lastTelemetry.config.enabled,catchHp:lastTelemetry.config.catch_hp_pct,
                    label:document.getElementById('pill-text').textContent, input:document.getElementById('cfg-catch').value});
            } else if(++attempts>150) {clearInterval(timer);reject(new Error('No guest config telemetry'));}
        },100);
    })`);
    assert.equal(result.enabled, false);
    assert.equal(result.catchHp, 0);
    assert.equal(result.input, '0');
    assert.match(result.label, /PAUSADO/);
    const help = await window.webContents.executeJavaScript(`(() => {
        const dialog = document.getElementById('help-dialog');
        document.getElementById('btn-tutorial').click();
        const tutorialOpen = dialog.open;
        const sections = document.querySelectorAll('#help-body section').length;
        document.getElementById('help-close').click();
        const closed = !dialog.open;
        switchPanel('config');
        const rows = [...document.querySelectorAll('.form-item')];
        const missing = rows.filter(row => !row.querySelector('.help-trigger')).map(row => row.textContent);
        document.querySelector('[data-help-topic="cfg-catch"]').click();
        const quick = dialog.open && document.getElementById('help-title').textContent;
        document.querySelector('#help-body button').click();
        const linked = document.getElementById('tutorial-cfg-catch').getBoundingClientRect();
        const body = document.getElementById('help-body').getBoundingClientRect();
        const inView = linked.top >= body.top && linked.top < body.bottom;
        return { tutorialOpen, sections, closed, missing, quick, inView };
    })()`);
    assert.equal(help.tutorialOpen, true);
    assert.ok(help.sections >= 30);
    assert.equal(help.closed, true);
    assert.deepEqual(help.missing, []);
    assert.equal(help.quick, 'HP inimigo para captura');
    assert.equal(help.inView, true);
    await window.webContents.executeJavaScript("document.getElementById('help-close').click(); document.getElementById('btn-tutorial').click()");
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await window.webContents.executeJavaScript("document.getElementById('help-dialog').open"), false);
    await window.webContents.executeJavaScript("document.getElementById('btn-tutorial').click()");
    assert.deepEqual(errors, []);
    await new Promise(resolve => setTimeout(resolve, 500));
    const screenshot = await window.webContents.capturePage();
    fs.writeFileSync(path.join(root, 'research/smoke-dashboard.png'), screenshot.toPNG());
    // Synthetic session only: prove old logins disappear and another partition survives.
    const gameSession = session.fromPartition('persist:idledex');
    const otherSession = session.fromPartition('test-unrelated');
    await gameSession.cookies.set({ url: 'https://idledex.com', name: 'test-session', value: 'synthetic' });
    await gameSession.cookies.set({ url: 'https://accounts.google.com', name: 'test-google', value: 'synthetic' });
    await otherSession.cookies.set({ url: 'https://idledex.com', name: 'unrelated', value: 'synthetic' });
    const reloaded = new Promise(resolve => window.webContents.once('did-finish-load', resolve));
    await window.webContents.executeJavaScript("document.getElementById('help-close').click(); document.getElementById('btn-switch-account').click()");
    await reloaded;
    assert.equal((await gameSession.cookies.get({})).length, 0);
    assert.equal((await otherSession.cookies.get({})).length, 1);
    assert.equal(config.ball_priority, 'force_highest');
    const { computeDirHash } = require('../research/verify-release.cjs');
    const candidateHash = computeDirHash(packaged);
    fs.writeFileSync(path.join(root, 'research/smoke-result.json'), JSON.stringify({ passed: true, checkedAt: new Date().toISOString(), source: packaged, candidateHash, help, accountReset: true, ...result }, null, 2));
    console.log(JSON.stringify({ passed: true, candidateHash, ...result }));
    clearTimeout(timeout);
    app.exit(0);
}
run().catch(error => { console.error(error.stack); clearTimeout(timeout); app.exit(1); });
