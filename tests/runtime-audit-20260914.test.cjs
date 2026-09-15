const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function runtime(saved = { enabled: true, auto_idle: true }, options = {}) {
    const handlers = {};
    const calls = [];
    const timers = new Map();
    let timerId = 0;
    const configPath = path.join('profile', 'bot-config.json');
    const files = new Map([[configPath, JSON.stringify(saved)]]);
    const app = Object.assign(new EventEmitter(), {
        getPath: () => 'profile', requestSingleInstanceLock: () => true,
        commandLine: { appendSwitch() {} }, whenReady: () => ({ then: fn => fn() }),
        quit: () => calls.push('quit'),
    });
    const powerMonitor = new EventEmitter();
    const session = {
        webRequest: { onBeforeRequest() {} },
        clearStorageData: async () => calls.push('clear-storage'),
        clearAuthCache: async () => calls.push('clear-auth'),
        closeAllConnections: async () => calls.push('close-connections'),
    };
    const host = Object.assign(new EventEmitter(), {
        mainFrame: {}, setWindowOpenHandler() {}, isDestroyed: () => false,
        send(channel, data) { calls.push(['host', channel, structuredClone(data)]); },
    });
    const window = Object.assign(new EventEmitter(), {
        webContents: host, isDestroyed: () => false, loadFile() {},
        show() {}, focus() {}, setAlwaysOnTop() {},
        hide: () => calls.push('hide'), minimize: () => calls.push('minimize'),
    });
    const guest = Object.assign(new EventEmitter(), {
        session, destroyed: false,
        isDestroyed() { return this.destroyed; },
        setWindowOpenHandler() {}, getType: () => 'webview',
        reload: () => calls.push('reload'),
        send(channel, data) { calls.push(['guest', channel, structuredClone(data)]); },
        close() { this.destroyed = true; calls.push('guest-close'); this.emit('destroyed'); },
    });
    const storage = {
        existsSync: file => files.has(file), readFileSync: file => files.get(file),
        mkdirSync() {}, writeFileSync: (file, data) => files.set(file, data),
        renameSync(from, to) {
            if (options.failSave) throw new Error('Disk unavailable');
            files.set(to, files.get(from)); files.delete(from);
        },
    };
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8'), {
        module, URL, __dirname: path.join(__dirname, '../electron'),
        process: { argv: [], env: options.diagnostics ? { IDLEDEX_DEBUG: '1' } : {}, platform: 'win32' },
        console: { log: text => calls.push(['log', text]), warn() {}, error() {} },
        setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
        clearTimeout: id => timers.delete(id),
        require(name) {
            if (name === 'electron') return {
                app, powerMonitor,
                BrowserWindow: class { constructor() { app.emit('web-contents-created', {}, host); return window; } },
                session: { defaultSession: session, fromPartition: () => session },
                webContents: { getAllWebContents: () => [host, guest] },
                ipcMain: { handle: (name, fn) => handlers[name] = fn, on: (name, fn) => handlers[name] = fn },
            };
            if (name === 'fs') return storage;
            if (name === 'path') return path;
            if (name === 'node:url') return require('node:url');
            if (name === './config-schema') return require('../electron/config-schema');
            if (name === './account-session') return require('../electron/account-session');
            throw new Error(name);
        },
    });
    host.emit('did-attach-webview', {}, guest);
    return {
        app, powerMonitor, host, guest, window, handlers, calls, timers,
        main: module.exports,
        event: { sender: host, senderFrame: host.mainFrame },
        persisted: () => JSON.parse(files.get(configPath)),
        runRecovery() {
            for (const [id, timer] of timers) if (timer.delay === 2000) {
                timers.delete(id); timer.fn();
            }
        },
    };
}

test('renderer recovery pauses bot and native AUTO in disk and dashboard before reloading', () => {
    const app = runtime();
    app.guest.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    assert.equal(app.persisted().enabled, false);
    assert.equal(app.persisted().auto_idle, false);
    const notification = app.calls.find(call => call[0] === 'host' && call[2]?.cmd === 'toggle-bot');
    assert.ok(notification, 'Dashboard must receive the pause before it resends config on dom-ready');
    assert.equal(notification[2].payload.enabled, false);
    assert.equal(notification[2].payload.auto_idle, false);
    assert.equal(app.calls.includes('reload'), false);
    app.runRecovery();
    assert.equal(app.calls.filter(call => call === 'reload').length, 1);
});

test('suspension directly stops game automation even with a nonresponsive dashboard', () => {
    const app = runtime({ enabled: false, auto_idle: true });
    app.powerMonitor.emit('suspend');
    assert.equal(app.persisted().auto_idle, false);
    const command = app.calls.find(call => call[0] === 'guest' && call[2]?.cmd === 'update-config');
    assert.ok(command, 'Suspension must reach the guest without waiting for dashboard JavaScript');
    assert.equal(command[2].payload.enabled, false);
    assert.equal(command[2].payload.auto_idle, false);
    const transmissions = () => app.calls.filter(call => call[0] === 'host' || call[0] === 'guest').length;
    const sentBeforeResume = transmissions();
    app.powerMonitor.emit('resume');
    assert.equal(transmissions(), sentBeforeResume, 'Resume must not reactivate automation');
});

test('failed safety pause persistence still prevents automation from returning on dashboard reload', () => {
    const app = runtime(undefined, { failSave: true });
    app.powerMonitor.emit('suspend');
    assert.equal(app.persisted().enabled, true, 'Failed atomic write preserves existing disk contents');
    assert.equal(app.main.loadConfig().enabled, false, 'Effective session configuration must stay paused');
    assert.equal(app.main.loadConfig().auto_idle, false);
    assert.ok(app.calls.some(call => call[0] === 'guest'), 'Disk errors must not prevent pausing the live guest');
});

test('switching accounts disables both automation modes before closing the old session', async () => {
    const app = runtime();
    assert.equal((await app.handlers['switch-account'](app.event)).ok, true);
    assert.equal(app.persisted().enabled, false);
    assert.equal(app.persisted().auto_idle, false);
    assert.ok(app.calls.indexOf('guest-close') < app.calls.indexOf('clear-storage'));
});

test('account switch rejects activation saves until the old session has finished clearing', async () => {
    const app = runtime();
    const switching = app.handlers['switch-account'](app.event);
    assert.equal(app.handlers['save-config'](app.event, { enabled: true }), false);
    assert.equal(app.handlers['save-config'](app.event, { enabled: false, auto_idle: true }), false);
    assert.equal((await switching).ok, true);
    assert.equal(app.persisted().enabled, false);
    assert.equal(app.persisted().auto_idle, false);
    assert.equal(app.handlers['save-config'](app.event, { enabled: true }), true,
        'An explicit activation after switching finishes remains available');
});

test('renderer crash recovery has a three-reload limit', () => {
    const app = runtime();
    for (let i = 0; i < 5; i++) {
        app.guest.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
        app.runRecovery();
    }
    assert.equal(app.calls.filter(call => call === 'reload').length, 3);
});

test('close-to-tray and minimize retain access through the taskbar when tray creation fails', () => {
    const app = runtime({ close_to_tray: true });
    app.window.emit('close', { preventDefault() {} });
    app.handlers['minimize-to-tray'](app.event);
    assert.equal(app.calls.includes('hide'), false, 'Without a tray icon the hidden window is inaccessible');
    assert.equal(app.calls.filter(call => call === 'minimize').length, 2);
});

test('renderer console forwarding requires explicit diagnostics and redacts the host as well as guest', () => {
    const app = runtime();
    app.host.emit('console-message', {}, 1, 'session_token=host-secret');
    app.guest.emit('console-message', {}, 1, 'session_token=guest-secret');
    assert.equal(app.calls.some(call => call[0] === 'log'), false);

    const diagnostic = runtime(undefined, { diagnostics: true });
    diagnostic.host.emit('console-message', {}, 1, 'session_token=host-secret');
    diagnostic.guest.emit('console-message', {}, 1, 'session_token=guest-secret');
    const output = diagnostic.calls.filter(call => call[0] === 'log').map(call => call[1]).join('\n');
    assert.match(output, /REDACTED/);
    assert.doesNotMatch(output, /host-secret|guest-secret/);
});

test('diagnostic redaction covers encoded tokens and structured credentials', () => {
    const app = runtime();
    const output = app.main.sanitizeLogMessage('token=encoded%2Fsecret&state=ok Cookie: sid=cookie-secret; other=hidden');
    assert.doesNotMatch(output, /encoded|secret|hidden/);
    assert.doesNotMatch(app.main.sanitizeLogMessage('{"session_token":"json-secret"}'), /json-secret/);
});
