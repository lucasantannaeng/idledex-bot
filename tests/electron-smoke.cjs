// Actual application main with a disposable profile and offline network.
// No replacement IPC handlers, BrowserWindow or security preferences.
const { app, session, webContents, powerMonitor } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
function option(name) {
    const index = args.indexOf(name);
    assert.ok(index >= 0 && args[index + 1], `Required option: ${name}`);
    return args[index + 1];
}
const candidate = path.resolve(option('--app-dir'));
const profile = path.resolve(option('--profile'));
const relativeProfile = path.relative(os.tmpdir(), profile);
assert.ok(!relativeProfile.startsWith('..') && !path.isAbsolute(relativeProfile) &&
    path.basename(profile).startsWith('idledex-smoke-'), 'Only a disposable smoke profile is allowed');
app.setPath('userData', profile);
app.setPath('sessionData', profile);
app.disableHardwareAcceleration();
const reportPath = path.resolve(option('--report'));
const configPath = path.join(profile, 'bot-config.json');
const secondary = args.includes('--secondary');
const errors = [];
let timer;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
    for (let attempt = 0; attempt < 150; attempt++) {
        const result = await check();
        if (result) return result;
        await delay(50);
    }
    throw new Error(`Timed out: ${label}`);
}
function fail(error) {
    console.error(error.stack || error);
    if (!secondary) fs.writeFileSync(reportPath, JSON.stringify({ passed: false, error: error.message }, null, 2));
    clearTimeout(timer);
    app.exit(1);
}
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);

async function run() {
    timer = setTimeout(() => fail(new Error('Real-main smoke exceeded 35 seconds')), 35000);
    if (secondary) {
        require(path.join(candidate, 'electron/main.js'));
        return;
    }
    fs.writeFileSync(reportPath, JSON.stringify({ passed: false, status: 'running' }));
    fs.writeFileSync(configPath, JSON.stringify({ enabled: false, auto_idle: false,
        catch_hp_pct: 0, strategy_mode: 'collection', ball_priority: 'force_highest' }));
    app.on('browser-window-created', (_event, created) => {
        created.setOpacity(0);
        created.setPosition(-20000, -20000);
    });
    app.on('web-contents-created', (_event, contents) => {
        contents.on('preload-error', (_event, _file, error) => errors.push(error.message));
        contents.on('console-message', (_event, level, message) => {
            if (level === 3) errors.push(message);
        });
    });
    await app.whenReady();
    const gameSession = session.fromPartition('persist:idledex');
    for (const ses of [session.defaultSession, gameSession]) {
        ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
        await ses.protocol.handle('https', request => {
            const url = new URL(request.url);
            if (url.origin !== 'https://idledex.com' || url.pathname !== '/play') return new Response('', { status: 404 });
            return new Response(`<!doctype html><meta charset="utf-8"><script>
                window.startupProbe = {
                    hooked: !WebSocket.toString().includes('[native code]'),
                    requireType: typeof require, processType: typeof process,
                    ipcType: typeof ipcRenderer, apiType: typeof electronAPI
                };
            </script><body>Offline fixture: actual application and preloads.</body>`,
            { headers: { 'content-type': 'text/html; charset=utf-8' } });
        });
    }
    const application = require(path.join(candidate, 'electron/main.js'));
    const window = await until(() => application.getMainWindow(), 'real main window');
    const host = window.webContents;
    await until(async () => !host.isLoading() && await host.executeJavaScript(
        "typeof lastTelemetry !== 'undefined' && lastTelemetry?.config?.ball_priority === 'force_highest'"), 'guest configuration round trip');
    const guest = webContents.getAllWebContents().find(contents => contents.getType() === 'webview');
    assert.ok(guest, 'Real guest must exist');
    const startup = await guest.executeJavaScript('window.startupProbe');
    assert.equal(startup.hooked, true, 'WebSocket hook must precede the first page script');
    assert.deepEqual([startup.requireType, startup.processType, startup.ipcType, startup.apiType], Array(4).fill('undefined'));
    for (const contents of [host, guest]) {
        const prefs = contents.getLastWebPreferences();
        assert.equal(prefs.contextIsolation, true, `${contents.getType()}: context isolation`);
        assert.equal(prefs.sandbox, true, `${contents.getType()}: sandbox`);
        assert.equal(prefs.nodeIntegration, false, `${contents.getType()}: Node disabled`);
    }
    const state = await host.executeJavaScript(`({enabled:lastTelemetry.config.enabled,
        catchHp:lastTelemetry.config.catch_hp_pct,label:document.getElementById('pill-text').textContent,
        input:document.getElementById('cfg-catch').value})`);
    assert.deepEqual([state.enabled, state.catchHp, state.input], [false, 0, '0']);
    assert.match(state.label, /PAUSADO/);
    assert.equal(await host.executeJavaScript("electronAPI.saveConfig({...currentConfig, pinned_species:'pikachu', close_to_tray:true})"), true);
    assert.equal(JSON.parse(fs.readFileSync(configPath)).pinned_species, 'pikachu');
    const reloaded = once(host, 'did-finish-load');
    host.reload();
    await reloaded;
    await until(() => host.executeJavaScript("lastTelemetry?.config?.pinned_species === 'pikachu'"), 'saved configuration after reload');
    const reloadedGuest = webContents.getAllWebContents().find(contents => contents.getType() === 'webview');
    await reloadedGuest.executeJavaScript(`(() => {
        const message = '<img src=x onerror="window.xssExecuted=true">';
        window.dispatchEvent(new CustomEvent('idledex-to-preload', {detail:{channel:'game-log',data:{message,level:'warning'}}}));
        window.dispatchEvent(new CustomEvent('idledex-to-preload', {detail:{channel:'game-telemetry',data:{
            currentMap:'route_test', availableSpecies:[{speciesId:'x" onclick="window.xssExecuted=true', name:message, frequency:message, minLevel:1, maxLevel:2}]
        }}}));
        window.dispatchEvent(new CustomEvent('idledex-to-preload', {detail:{channel:'save-config',data:{enabled:true}}}));
    })()`);
    await until(() => host.executeJavaScript("document.getElementById('log-feed').textContent.includes('window.xssExecuted')"), 'untrusted text reaches actual DOM');
    assert.equal(await host.executeJavaScript("Boolean(window.xssExecuted) || Boolean(document.querySelector('#area-species-list img, #area-species-list [onclick], #log-feed img'))"), false);
    assert.equal(JSON.parse(fs.readFileSync(configPath)).enabled, false, 'Guest cannot invoke host save-config');
    await host.executeJavaScript('toggleBotState()');
    await until(() => host.executeJavaScript('lastTelemetry?.config?.enabled === true'), 'activation before suspend');
    powerMonitor.emit('suspend'); // Exercise the registered production handler.
    await until(() => host.executeJavaScript('currentConfig.enabled === false && lastTelemetry?.config?.enabled === false'), 'suspend pauses UI and engine');
    const help = await host.executeJavaScript(`(() => {
        document.getElementById('btn-tutorial').click();
        const open = document.getElementById('help-dialog').open;
        const sections = document.querySelectorAll('#help-body section').length;
        document.getElementById('help-close').click();
        switchPanel('config');
        const missing = [...document.querySelectorAll('.form-item')].filter(row => !row.querySelector('.help-trigger')).length;
        document.querySelector('[data-help-topic="cfg-catch"]').click();
        return {open, sections, missing, title:document.getElementById('help-title').textContent};
    })()`);
    assert.equal(help.open, true);
    assert.ok(help.sections >= 30);
    assert.equal(help.missing, 0);
    assert.equal(help.title, 'HP inimigo para captura');
    host.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    host.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await until(() => host.executeJavaScript("!document.getElementById('help-dialog').open"), 'Escape closes help');
    fs.writeFileSync(reportPath.replace(/\.json$/, '.png'),
        (await window.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
    window.close();
    assert.equal(window.isDestroyed(), false, 'close-to-tray must preserve the window');
    assert.equal(window.isVisible(), false);
    const secondInstance = once(app, 'second-instance');
    const child = spawn(process.execPath, [__filename, '--secondary', '--app-dir', candidate,
        '--profile', profile, '--report', reportPath], { windowsHide: true, stdio: 'ignore' });
    const childExit = once(child, 'exit');
    await secondInstance;
    assert.equal((await childExit)[0], 0, 'Second instance exits cleanly');
    const unrelated = session.fromPartition('smoke-unrelated');
    await gameSession.cookies.set({ url: 'https://idledex.com', name: 'synthetic-session', value: 'fixture' });
    await unrelated.cookies.set({ url: 'https://idledex.com', name: 'synthetic-other', value: 'fixture' });
    const accountReload = once(host, 'did-finish-load');
    await host.executeJavaScript("document.getElementById('btn-switch-account').click()");
    await accountReload;
    assert.equal((await gameSession.cookies.get({})).length, 0);
    assert.equal((await unrelated.cookies.get({})).length, 1);
    assert.equal(JSON.parse(fs.readFileSync(configPath)).enabled, false);
    await until(() => host.executeJavaScript("lastTelemetry?.config?.pinned_species === 'pikachu'"), 'guest after account reset');
    assert.deepEqual(errors, []);
    const sourceMode = candidate === root;
    const candidateHash = sourceMode ? null : require('../research/verify-release.cjs').computeDirHash(candidate);
    const report = { passed: true, scope: sourceMode ? 'source' : 'candidate', main: 'actual',
        checkedAt: new Date().toISOString(), candidateHash, runtime: process.versions.electron,
        startup, state, help, isolation: true, accountReset: 'synthetic', secondInstance: true,
        closeToTray: true, xssDom: true, suspend: 'simulated-signal', hardwareAcceleration: false };
    application.saveConfig({ ...application.loadConfig(), close_to_tray: false });
    app.once('will-quit', () => {
        clearTimeout(timer);
        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report));
    });
    window.close(); // Exercise the real quit handler, not app.exit(0).
}
run().catch(fail);
