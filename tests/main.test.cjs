const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function mainProcess(saved) {
    const handlers = {};
    const files = new Map();
    const configPath = path.join('profile', 'bot-config.json');
    if (saved !== undefined) files.set(configPath, saved);
    const switches = [];
    let failRename = false;
    const fakeWebContents = { mainFrame: {} };
    const fakeMainWindow = { isDestroyed: () => false, webContents: fakeWebContents };
    const app = { getPath: () => 'profile', on() {}, whenReady: () => ({ then() {} }),
        commandLine: { appendSwitch: (...args) => switches.push(args) }, requestSingleInstanceLock: () => true };
    const storage = { existsSync: p => files.has(p), readFileSync: p => files.get(p),
        writeFileSync: (p, value) => files.set(p, value), mkdirSync() {},
        renameSync(from, to) { if (failRename) throw new Error('disk failure'); files.set(to, files.get(from)); files.delete(from); } };
    const moduleExports = {};
    const moduleObj = { exports: moduleExports };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8'), {
        module: moduleObj, exports: moduleExports,
        require(name) { if (name === './account-session') return require('../electron/account-session'); if (name === './config-schema') return require('../electron/config-schema'); if (name === 'electron') return { app, ipcMain: { handle: (name, fn) => handlers[name] = fn, on: (name, fn) => handlers[name] = fn } }; if (name === 'fs') return storage; if (name === 'path') return path; throw new Error(name); },
        console, process: { env: {}, argv: [], platform: 'win32' }, __dirname: path.join(__dirname, '../electron'),
    });
    if (moduleObj.exports.setMainWindowForTesting) {
        moduleObj.exports.setMainWindowForTesting(fakeMainWindow);
    }
    const authorizedEvent = { sender: fakeWebContents, senderFrame: fakeWebContents.mainFrame };
    return {
        config: (evt = authorizedEvent) => handlers['get-config'](evt),
        save: (value, evt = authorizedEvent) => handlers['save-config'](evt, value),
        handlers,
        fakeWebContents,
        fakeMainWindow,
        switches,
        failRename: () => { failRename = true; },
        persisted: () => files.get(configPath),
        exports: moduleObj.exports
    };
}
test('existing partial configuration merges defaults and preserves zero values', () => {
    const main = mainProcess('{"catch_hp_pct":0,"enabled":false}');
    assert.equal(main.config().catch_hp_pct, 0);
    assert.equal(main.config().enabled, false);
    assert.equal(main.config().auto_roam, true);
});
test('failed atomic save preserves the previous configuration', () => {
    const main = mainProcess('{"enabled":false}');
    main.failRename();
    assert.equal(main.save({ enabled: true }), false);
    assert.equal(main.persisted(), '{"enabled":false}');
});
test('remote debugging is disabled by default', () => {
    assert.equal(mainProcess().switches.length, 0);
});
test('close_to_tray is false by default and can be persisted', () => {
    const main = mainProcess();
    assert.equal(main.config().close_to_tray, false);
    assert.equal(main.save({ ...main.config(), close_to_tray: true }), true);
    assert.equal(main.config().close_to_tray, true);
});

test('T05: corrupted configuration returns safe defaults without throwing', () => {
    const main = mainProcess('CORRUPT_NOT_JSON{[');
    const cfg = main.config();
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.strategy_mode, 'balanced');
    assert.equal(cfg.flee_hp_pct, 0.30);
});

test('T05: future schema version is not silently overwritten', () => {
    const futureJson = JSON.stringify({ schemaVersion: 99, enabled: true, customFutureKey: 'secure' });
    const main = mainProcess(futureJson);
    assert.equal(main.save({ enabled: false }), false);
    assert.equal(main.persisted(), futureJson);
});

test('T05: normalization strips ghost keys and clamps domain boundaries', () => {
    const main = mainProcess();
    const result = main.save({
        enabled: true,
        iv_collection_threshold: 150,
        iv_sell_threshold: 120,
        flee_hp_pct: 35, // 35% converted to 0.35
        min_iv_alert: 999, // clamped to 186
        discard_iv_pct: -10, // clamped to 0
        roam_step_delay_ms: 10, // clamped to 205
        strategy_mode: 'invalid_mode', // fallback to 'balanced'
        target_species: ['pikachu', '  pikachu ', 'eevee', ''],
        malicious_key: 'should_be_stripped'
    });
    assert.equal(result, true);
    const saved = JSON.parse(main.persisted());
    assert.equal(saved.enabled, true);
    assert.equal(saved.iv_collection_threshold, undefined, 'Ghost key iv_collection_threshold must be stripped');
    assert.equal(saved.iv_sell_threshold, undefined, 'Ghost key iv_sell_threshold must be stripped');
    assert.equal(saved.malicious_key, undefined, 'Unknown keys must be stripped');
    assert.equal(saved.flee_hp_pct, 0.35);
    assert.equal(saved.min_iv_alert, 186);
    assert.equal(saved.discard_iv_pct, 0);
    assert.equal(saved.roam_step_delay_ms, 205);
    assert.equal(saved.strategy_mode, 'balanced');
    assert.deepEqual(saved.target_species, ['pikachu', 'eevee']);
    assert.equal(saved.target_mode, 'selected');
});

test('T18: sanitizeLogMessage redacts sensitive tokens, keys, cookies and auth headers', () => {
    const main = mainProcess();
    const sanitize = main.exports.sanitizeLogMessage;
    assert.ok(typeof sanitize === 'function');

    const msgWithToken = 'Connecting to wss://idledex.com/ws?session_token=secret12345&other=ok';
    assert.equal(sanitize(msgWithToken), 'Connecting to wss://idledex.com/ws?session_token=[REDACTED]&other=ok');

    const msgWithWsToken = 'Received error for ws_token=abc-999_xyz';
    assert.equal(sanitize(msgWithWsToken), 'Received error for ws_token=[REDACTED]');

    const msgWithBearer = 'Request header: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';
    assert.equal(sanitize(msgWithBearer), 'Request header: Bearer [REDACTED]');

    const msgWithCookie = 'Failed with cookie=auth_cookie_val_123';
    assert.equal(sanitize(msgWithCookie), 'Failed with cookie=[REDACTED]');
});

