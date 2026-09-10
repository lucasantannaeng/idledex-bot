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
    const app = { getPath: () => 'profile', on() {}, whenReady: () => ({ then() {} }),
        commandLine: { appendSwitch: (...args) => switches.push(args) }, requestSingleInstanceLock: () => true };
    const storage = { existsSync: p => files.has(p), readFileSync: p => files.get(p),
        writeFileSync: (p, value) => files.set(p, value), mkdirSync() {},
        renameSync(from, to) { if (failRename) throw new Error('disk failure'); files.set(to, files.get(from)); files.delete(from); } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8'), {
        require(name) { if (name === './account-session') return require('../electron/account-session'); if (name === 'electron') return { app, ipcMain: { handle: (name, fn) => handlers[name] = fn, on() {} } }; if (name === 'fs') return storage; if (name === 'path') return path; throw new Error(name); },
        console, process: { env: {}, argv: [], platform: 'win32' }, __dirname: path.join(__dirname, '../electron'),
    });
    return { config: () => handlers['get-config'](), save: value => handlers['save-config']({}, value), switches,
        failRename: () => { failRename = true; }, persisted: () => files.get(configPath) };
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
