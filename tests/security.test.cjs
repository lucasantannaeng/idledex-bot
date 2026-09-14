const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const fs = require('node:fs');

function loadMainModule() {
    const handlers = {};
    const appEvents = {};
    const webContentsEvents = {};
    const sessionPartitions = new Map();
    const fakeWebContents = {
        mainFrame: {},
        on(event, fn) { (webContentsEvents[event] ??= []).push(fn); },
        setWindowOpenHandler(fn) { fakeWebContents._windowOpenHandler = fn; },
    };
    const fakeMainWindow = {
        isDestroyed: () => false,
        webContents: fakeWebContents,
        loadFile() {},
        once() {},
        on() {},
        show() {},
        focus() {},
        setAlwaysOnTop() {},
    };
    const fakeSession = {
        webRequest: { onBeforeRequest() {} },
        setPermissionRequestHandler(fn) { fakeSession._permReq = fn; },
        setPermissionCheckHandler(fn) { fakeSession._permCheck = fn; },
    };
    const app = {
        getPath: () => 'profile',
        on(event, fn) { (appEvents[event] ??= []).push(fn); },
        whenReady: () => ({ then(cb) { cb(); } }),
        commandLine: { appendSwitch() {} },
        requestSingleInstanceLock: () => true,
    };
    const storage = {
        existsSync: () => true,
        readFileSync: () => '{}',
        writeFileSync() {},
        mkdirSync() {},
        renameSync() {},
    };
    const moduleExports = {};
    const moduleObj = { exports: moduleExports };

    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8'), {
        module: moduleObj,
        exports: moduleExports,
        require(name) {
            if (name === './account-session') return require('../electron/account-session');
            if (name === 'electron') {
                return {
                    app,
                    BrowserWindow: class { constructor() { return fakeMainWindow; } static getAllWindows() { return [fakeMainWindow]; } },
                    Tray: class { setToolTip() {} setContextMenu() {} on() {} },
                    Menu: { buildFromTemplate: () => ({}) },
                    nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
                    session: {
                        defaultSession: fakeSession,
                        fromPartition(part) {
                            if (!sessionPartitions.has(part)) sessionPartitions.set(part, fakeSession);
                            return sessionPartitions.get(part);
                        },
                    },
                    webContents: { getAllWebContents: () => [] },
                    ipcMain: {
                        handle: (name, fn) => { handlers[name] = fn; },
                        on: (name, fn) => { handlers[name] = fn; },
                    },
                };
            }
            if (name === './config-schema') return require('../electron/config-schema');
            if (name === 'fs') return storage;
            if (name === 'path') return path;
            if (name === 'node:url') return require('node:url');
            throw new Error(name);
        },
        console,
        setTimeout,
        clearTimeout,
        URL,
        process: { env: {}, argv: [], platform: 'win32' },
        __dirname: path.join(__dirname, '../electron'),
    });

    if (moduleObj.exports.setMainWindowForTesting) {
        moduleObj.exports.setMainWindowForTesting(fakeMainWindow);
    }

    return {
        main: moduleObj.exports,
        handlers,
        fakeMainWindow,
        fakeWebContents,
        fakeSession,
        appEvents,
        webContentsEvents,
    };
}

test('T02: IPC handlers reject calls without valid sender or from subframes', async () => {
    const { handlers, fakeWebContents, fakeMainWindow, main } = loadMainModule();
    const validEvent = { sender: fakeWebContents, senderFrame: fakeWebContents.mainFrame };
    const foreignSender = { mainFrame: {} };
    const subFrameEvent = { sender: fakeWebContents, senderFrame: {} };

    // get-config
    assert.equal(await handlers['get-config'](null), null);
    assert.equal(await handlers['get-config']({}), null);
    assert.equal(await handlers['get-config']({ sender: foreignSender, senderFrame: foreignSender.mainFrame }), null);
    assert.equal(await handlers['get-config'](subFrameEvent), null);
    assert.ok(await handlers['get-config'](validEvent) !== null);

    // save-config
    assert.equal(await handlers['save-config'](null, {}), false);
    assert.equal(await handlers['save-config']({ sender: foreignSender, senderFrame: foreignSender.mainFrame }, {}), false);
    assert.equal(await handlers['save-config'](subFrameEvent, {}), false);
    assert.equal(await handlers['save-config'](validEvent, { enabled: true }), true);

    // switch-account
    assert.equal((await handlers['switch-account'](null))?.ok, false);
    assert.equal((await handlers['switch-account'](subFrameEvent))?.ok, false);

    // Destroyed window rejection
    fakeMainWindow.isDestroyed = () => true;
    assert.equal(await handlers['get-config'](validEvent), null);
    assert.equal(await handlers['save-config'](validEvent, {}), false);
});

test('T02: isAllowedGuestUrl allows official idledex and google oauth while rejecting unauthorized urls', () => {
    const { main } = loadMainModule();
    assert.equal(main.isAllowedGuestUrl('https://idledex.com/play'), true);
    assert.equal(main.isAllowedGuestUrl('https://idledex.com/api/auth/callback'), true);
    assert.equal(main.isAllowedGuestUrl('https://accounts.google.com/o/oauth2/v2/auth'), true);
    assert.equal(main.isAllowedGuestUrl('https://accounts.google.com/signin/v3'), true);
    assert.equal(main.isAllowedGuestUrl(''), true);
    assert.equal(main.isAllowedGuestUrl('about:blank'), true);

    // Google 2FA & regional auth domains
    assert.equal(main.isAllowedGuestUrl('https://myaccount.google.com/signinoptions/two-step-verification'), true);
    assert.equal(main.isAllowedGuestUrl('https://oauth2.googleapis.com/token'), true);
    assert.equal(main.isAllowedGuestUrl('https://accounts.google.com.br/o/oauth2/v2/auth'), true);
    assert.equal(main.isAllowedGuestUrl('https://accounts.youtube.com/accounts/SetSID'), true);

    // Adversarial URLs
    assert.equal(main.isAllowedGuestUrl('http://idledex.com'), false, 'Plain HTTP must be rejected');
    assert.equal(main.isAllowedGuestUrl('https://idledex.com.evil.com/play'), false, 'Subdomain attack must be rejected');
    assert.equal(main.isAllowedGuestUrl('https://evil-google.com/oauth'), false, 'Lookalike domain must be rejected');
    assert.equal(main.isAllowedGuestUrl('https://myaccount.google.com.evil.com'), false);
    assert.equal(main.isAllowedGuestUrl('https://oauth2.googleapis.com.evil.com'), false);
    assert.equal(main.isAllowedGuestUrl('https://evil-google.com.br'), false);
    assert.equal(main.isAllowedGuestUrl('javascript:alert(1)'), false, 'Javascript scheme must be rejected');
    assert.equal(main.isAllowedGuestUrl('file:///etc/passwd'), false, 'File scheme must be rejected');
});

test('T02: will-attach-webview strictly validates partition, sender webContents and source URL', () => {
    const { appEvents, fakeWebContents } = loadMainModule();
    const createdCbs = appEvents['web-contents-created'] || [];
    assert.ok(createdCbs.length > 0, 'web-contents-created listener must be registered');

    let attachCb = null;
    const contentsMock = {
        on(event, fn) {
            if (event === 'will-attach-webview') attachCb = fn;
        }
    };
    for (const cb of createdCbs) {
        cb({}, contentsMock);
    }
    assert.ok(attachCb, 'will-attach-webview listener must be bound');

    // 1. Foreign caller window
    let prevented = false;
    attachCb({ preventDefault: () => { prevented = true; } }, {}, { partition: 'persist:idledex', src: 'https://idledex.com/play' });
    assert.equal(prevented, true, 'Attaching from foreign contents must be prevented');

    // 2. Main window with wrong partition
    prevented = false;
    const mainWindowContentsMock = fakeWebContents;
    let mainAttachCb = null;
    mainWindowContentsMock.on = (event, fn) => { if (event === 'will-attach-webview') mainAttachCb = fn; };
    for (const cb of createdCbs) cb({}, mainWindowContentsMock);

    mainAttachCb({ preventDefault: () => { prevented = true; } }, {}, { partition: 'temp:test', src: 'https://idledex.com/play' });
    assert.equal(prevented, true, 'Non-persist:idledex partition must be prevented');

    // 3. Main window with adversarial src
    prevented = false;
    mainAttachCb({ preventDefault: () => { prevented = true; } }, {}, { partition: 'persist:idledex', src: 'https://malicious.com' });
    assert.equal(prevented, true, 'Adversarial src must be prevented');

    // 4. Authorized attachment
    prevented = false;
    const webPreferences = {};
    mainAttachCb({ preventDefault: () => { prevented = true; } }, webPreferences, { partition: 'persist:idledex', src: 'https://idledex.com/play' });
    assert.equal(prevented, false, 'Authorized attachment must be allowed');
    assert.ok(webPreferences.preload.endsWith('preload-game.js'), 'Preload must be forced to preload-game.js');
    assert.equal(webPreferences.contextIsolation, true);
    assert.equal(webPreferences.sandbox, true);
    assert.equal(webPreferences.nodeIntegration, false);
});

for (const url of [
    'https://idledex.com:444/play',
    'https://accounts.google.com:444/o/oauth2/v2/auth',
    'https://user:password@idledex.com/play',
    'https://user:password@accounts.google.com/o/oauth2/v2/auth',
]) {
    test(`T02: guest origin restrictions reject nonstandard ports and userinfo: ${url}`, () => {
        const { main } = loadMainModule();
        assert.equal(main.isAllowedGuestUrl(url), false);
    });
}

test('T02: dashboard navigation rejects arbitrary local files', () => {
    const { webContentsEvents } = loadMainModule();
    const navigationHandlers = webContentsEvents['will-navigate'];
    assert.ok(navigationHandlers?.length > 0, 'Dashboard navigation guard must be registered');
    let prevented = false;
    for (const handler of navigationHandlers) {
        handler({ preventDefault() { prevented = true; } }, 'file:///C:/untrusted.html');
    }
    assert.equal(prevented, true,
        'An arbitrary local page must not receive the privileged dashboard preload');
});

test('T02: session permissions are denied by default', () => {
    const { fakeSession, main } = loadMainModule();
    let callbackResult = null;
    fakeSession._permReq({}, 'media', result => { callbackResult = result; });
    assert.equal(callbackResult, false, 'Permission request must be denied');
    assert.equal(fakeSession._permCheck({}, 'notifications'), false, 'Permission check must return false');
});
