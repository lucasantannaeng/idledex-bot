const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

// 1. Test Preload IPC Bridge Hardening
test('T04: preload IPC bridge only forwards allowlisted channels and commands', () => {
    const preloadModule = require('../electron/preload-game.js');
    const { ALLOWED_PRELOAD_CHANNELS, ALLOWED_HOST_COMMANDS } = preloadModule;

    assert.ok(ALLOWED_PRELOAD_CHANNELS.has('game-telemetry'));
    assert.ok(ALLOWED_PRELOAD_CHANNELS.has('game-log'));
    assert.equal(ALLOWED_PRELOAD_CHANNELS.has('save-config'), false);
    assert.equal(ALLOWED_PRELOAD_CHANNELS.has('admin-eval'), false);

    assert.ok(ALLOWED_HOST_COMMANDS.has('update-config'));
    assert.ok(ALLOWED_HOST_COMMANDS.has('toggle-bot'));
    assert.ok(ALLOWED_HOST_COMMANDS.has('manual-action'));
    assert.equal(ALLOWED_HOST_COMMANDS.has('exec'), false);
});

// Helper to create a DOM Node mock that fails if innerHTML is ever set
class MockElement {
    constructor(tagName, id = '') {
        this.tagName = String(tagName).toUpperCase();
        this.id = id;
        this.children = [];
        this.attributes = new Map();
        this.listeners = new Map();
        this.style = {};
        this._textContent = '';
        this.value = '';
        this.checked = false;
    }

    get innerHTML() {
        return this._textContent;
    }

    set innerHTML(val) {
        throw new Error(`CRITICAL SECURITY FAILURE: innerHTML was set on <${this.tagName} id="${this.id}"> with payload: ${val}`);
    }

    get textContent() {
        if (this.children.length > 0) {
            return this._textContent + this.children.map(c => c.textContent || '').join('');
        }
        return this._textContent;
    }

    set textContent(val) {
        this._textContent = String(val);
        this.children = [];
    }

    appendChild(child) {
        this.children.push(child);
        return child;
    }

    removeChild(child) {
        const idx = this.children.indexOf(child);
        if (idx !== -1) this.children.splice(idx, 1);
        return child;
    }

    replaceChildren(...newChildren) {
        const flattened = [];
        for (const item of newChildren) {
            if (item instanceof MockDocumentFragment) {
                flattened.push(...item.children);
            } else if (Array.isArray(item)) {
                flattened.push(...item);
            } else if (item !== undefined && item !== null) {
                flattened.push(item);
            }
        }
        this.children = flattened;
        if (this.children.length === 1 && typeof this.children[0] === 'string') {
            this._textContent = this.children[0];
            this.children = [];
        }
    }

    addEventListener(type, fn) {
        const list = this.listeners.get(type) || [];
        list.push(fn);
        this.listeners.set(type, list);
    }

    dispatchEvent(type, eventObj = {}) {
        const list = this.listeners.get(type) || [];
        for (const fn of list) fn(eventObj);
    }

    setAttribute(key, val) {
        this.attributes.set(key, val);
    }

    getAttribute(key) {
        return this.attributes.get(key) || null;
    }
}

class MockTextNode {
    constructor(text) {
        this.nodeType = 3;
        this.textContent = String(text);
    }
}

class MockDocumentFragment {
    constructor() {
        this.children = [];
    }
    appendChild(child) {
        this.children.push(child);
        return child;
    }
}

function createDOMEnvironment() {
    const elementsById = new Map();

    const getOrCreate = (id, tag = 'div') => {
        if (!elementsById.has(id)) {
            elementsById.set(id, new MockElement(tag, id));
        }
        return elementsById.get(id);
    };

    // Pre-create UI elements referenced by app.js
    const gameView = getOrCreate('game-view', 'webview');
    getOrCreate('bot-sidebar', 'aside');
    getOrCreate('bot-status-pill', 'div');
    getOrCreate('pill-dot', 'span');
    getOrCreate('pill-text', 'span');
    getOrCreate('btn-toggle-bot', 'button');
    getOrCreate('btn-switch-account', 'button');
    getOrCreate('btn-toggle-sidebar', 'button');
    getOrCreate('btn-minimize-tray', 'button');
    getOrCreate('shard-indicator', 'span');
    const logFeed = getOrCreate('log-feed', 'div');
    const radarCanvas = getOrCreate('radar-canvas', 'canvas');
    radarCanvas.getContext = () => ({
        fillRect() {}, strokeRect() {}, beginPath() {}, moveTo() {}, lineTo() {},
        stroke() {}, arc() {}, fill() {}, fillStyle: '', strokeStyle: '', lineWidth: 1,
        shadowColor: '', shadowBlur: 0
    });
    getOrCreate('radar-coords', 'span');
    const entitiesList = getOrCreate('entities-list', 'div');
    const areaList = getOrCreate('area-species-list', 'div');
    getOrCreate('current-map-badge', 'span');
    getOrCreate('cfg-unselected-action-radar', 'select');
    getOrCreate('cfg-unselected-action', 'select');
    getOrCreate('btn-select-all-species', 'button');
    getOrCreate('btn-deselect-all-species', 'button');
    getOrCreate('cfg-strategy', 'select');
    getOrCreate('cfg-discard-iv-pct', 'input');
    getOrCreate('lbl-discard-iv-pct', 'span');
    getOrCreate('btn-save-settings', 'button');
    getOrCreate('btn-clear-logs', 'button');
    getOrCreate('combat-status', 'span');
    getOrCreate('combat-enemy-name', 'span');
    getOrCreate('combat-enemy-hp-text', 'span');
    getOrCreate('combat-enemy-hp-bar', 'div');
    getOrCreate('combat-player-name', 'span');
    getOrCreate('combat-player-hp-text', 'span');
    getOrCreate('combat-player-hp-bar', 'div');
    getOrCreate('last-cap-grade', 'span');
    const lastCapBody = getOrCreate('last-cap-body', 'div');

    const documentMock = {
        getElementById(id) {
            return elementsById.get(id) || getOrCreate(id, 'div');
        },
        createElement(tagName) {
            return new MockElement(tagName);
        },
        createTextNode(text) {
            return new MockTextNode(text);
        },
        createDocumentFragment() {
            return new MockDocumentFragment();
        },
        querySelectorAll(selector) {
            if (selector.includes('s-tab')) {
                return [
                    new MockElement('button', 'tab-radar'),
                    new MockElement('button', 'tab-combat')
                ];
            }
            if (selector.includes('#area-species-list input')) {
                return areaList.children
                    .map(label => label.children ? label.children[0]?.children?.[0] : null)
                    .filter(Boolean);
            }
            return [];
        },
        querySelector(selector) {
            return this.getElementById(selector.replace(/^#/, ''));
        }
    };

    const windowMock = {
        addEventListener(type, fn) {
            this[`on_${type}`] = fn;
        },
        dispatchEvent(event) {},
        electronAPI: {
            getConfig: async () => ({ enabled: false, target_species: [] }),
            saveConfig: async (cfg) => true,
        }
    };

    const context = vm.createContext({
        window: windowMock,
        document: documentMock,
        console,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        Date,
        Math,
        Number,
        String,
        Array,
        Object,
    });

    const appCode = fs.readFileSync(path.join(__dirname, '../app/app.js'), 'utf8');
    vm.runInContext(appCode, context);

    return { window: windowMock, document: documentMock, elementsById, entitiesList, areaList, lastCapBody, logFeed };
}

test('T04: adversarial HTML payloads in telemetry are rendered strictly as text without innerHTML', async () => {
    const env = createDOMEnvironment();
    // Simulate DOMContentLoaded
    await env.window.on_DOMContentLoaded?.();

    // 1. Test adversarial species list
    const maliciousSpecies = [
        {
            speciesId: 'pika" onchange="alert(\'xss\')',
            name: '<script>alert("species-xss")</script>',
            minLevel: '<svg onload=alert(1)>', // invalid level, should be sanitized
            maxLevel: 25,
            frequency: '<b onmouseover="alert(1)">Rare</b>',
            caught: true
        }
    ];

    // Trigger updateAreaSpawnsUI via telemetry
    env.window.handleTelemetry({
        currentMap: 'route-test',
        currentMapName: '<img src=x onerror=alert("map")>',
        availableSpecies: maliciousSpecies
    });

    // Check area species list
    assert.equal(env.areaList.children.length, 1);
    const label = env.areaList.children[0];
    const leftDiv = label.children[0];
    const input = leftDiv.children[0];
    const nameSpan = leftDiv.children[1];

    // Value should be literal string, NOT executed or broken out
    assert.equal(input.value, 'pika" onchange="alert(\'xss\')');
    // Name should be textContent, NOT HTML
    assert.equal(nameSpan.textContent, '<script>alert("species-xss")</script>');

    // 2. Test adversarial entities radar list
    const maliciousEntities = [
        {
            is_enemy: true,
            x: 10,
            y: 12,
            name: 'Wild: <img src=x onerror=alert("entity-xss")>'
        }
    ];

    env.window.handleTelemetry({
        entities: maliciousEntities,
        playerPos: { x: 0, y: 0 }
    });

    assert.equal(env.entitiesList.children.length, 1);
    const foeRow = env.entitiesList.children[0];
    const foeNameSpan = foeRow.children[0];
    assert.equal(foeNameSpan.textContent, '<img src=x onerror=alert("entity-xss")>');

    // 3. Test adversarial captured mon evaluation with non-finite values
    const maliciousMon = {
        name: '<script>alert("mon-eval")</script>',
        isShiny: true,
        level: NaN, // Non-finite level
        nature: '"><script>alert(2)</script>',
        isBestNature: true,
        grade: 'S',
        ivTotal: Infinity, // Non-finite IV
        ivPct: NaN,
        ivs: { hp: 31, atk: '31', def: NaN, spa: 31, spd: 31, spe: 31 }
    };

    env.window.handleTelemetry({
        lastCapturedMon: maliciousMon
    });

    assert.ok(env.lastCapBody.children.length >= 3);
    const row1 = env.lastCapBody.children[0];
    assert.ok(row1.children[1].textContent.includes('Lv?'), 'NaN level safely converted to Lv?');

    const row2 = env.lastCapBody.children[1];
    assert.ok(row2.children[0].textContent.includes('⭐ TOP NATURE!'));
    // The nature text must be textContent
    assert.ok(row2.children[0].children[0].textContent.includes('"><script>alert(2)</script>'));

    // 4. Test adversarial log message
    env.window.appendLog('<script>alert("log-xss")</script>', 'info');
    const logEntry = env.logFeed.children.at(-1);
    assert.equal(logEntry.children[1].textContent, ' <script>alert("log-xss")</script>');
});

test('T04: handleIdledexToPreload rejects unauthorized channels and malformed payloads', () => {
    const { handleIdledexToPreload } = require('../electron/preload-game.js');
    const sent = [];
    const fakeIpcRenderer = {
        sendToHost(channel, data) {
            sent.push({ channel, data });
        }
    };

    // Evaluate in context where ipcRenderer is available
    const sandbox = {
        ipcRenderer: fakeIpcRenderer,
        handleIdledexToPreload
    };
    const vmCtx = vm.createContext(sandbox);

    // 1. Authorized channel and valid payload
    handleIdledexToPreload({ detail: { channel: 'game-telemetry', data: { connected: true } } }, fakeIpcRenderer);
    handleIdledexToPreload({ detail: { channel: 'game-log', data: { message: 'hello' } } }, fakeIpcRenderer);
    assert.equal(sent.length, 2);
    assert.equal(sent[0].channel, 'game-telemetry');
    assert.equal(sent[1].channel, 'game-log');

    // 2. Unauthorized channel
    handleIdledexToPreload({ detail: { channel: 'admin-eval', data: { code: 'bad()' } } }, fakeIpcRenderer);
    handleIdledexToPreload({ detail: { channel: 'save-config', data: {} } }, fakeIpcRenderer);
    handleIdledexToPreload({ detail: { channel: 'switch-account', data: {} } }, fakeIpcRenderer);
    assert.equal(sent.length, 2, 'Unauthorized channels must be rejected');

    // 3. Null or primitive data payloads
    handleIdledexToPreload({ detail: { channel: 'game-telemetry', data: null } }, fakeIpcRenderer);
    handleIdledexToPreload({ detail: { channel: 'game-telemetry', data: 'malicious string' } }, fakeIpcRenderer);
    handleIdledexToPreload({ detail: { channel: 'game-telemetry', data: 42 } }, fakeIpcRenderer);
    handleIdledexToPreload({ detail: null }, fakeIpcRenderer);
    assert.equal(sent.length, 2, 'Non-object payloads must be rejected');
});

test('T04: handleHostCommand rejects unauthorized commands', () => {
    const { handleHostCommand } = require('../electron/preload-game.js');
    const dispatched = [];
    const fakeWindow = {
        dispatchEvent(evt) {
            dispatched.push(evt.detail);
        }
    };
    global.CustomEvent = class {
        constructor(type, opts) {
            this.type = type;
            this.detail = opts?.detail;
        }
    };

    // 1. Authorized commands
    handleHostCommand({}, { cmd: 'update-config', payload: { enabled: true } }, fakeWindow);
    handleHostCommand({}, { cmd: 'toggle-bot', payload: { enabled: false } }, fakeWindow);
    handleHostCommand({}, { cmd: 'manual-action', payload: { action: 'claim-all' } }, fakeWindow);
    assert.equal(dispatched.length, 3);
    assert.equal(dispatched[0].cmd, 'update-config');
    assert.equal(dispatched[1].cmd, 'toggle-bot');
    assert.equal(dispatched[2].cmd, 'manual-action');

    // 2. Unauthorized commands
    handleHostCommand({}, { cmd: 'eval', payload: 'process.exit(1)' }, fakeWindow);
    handleHostCommand({}, { cmd: 'shell-exec', payload: 'calc.exe' }, fakeWindow);
    handleHostCommand({}, null, fakeWindow);
    handleHostCommand({}, 'plain string', fakeWindow);
    assert.equal(dispatched.length, 3, 'Unauthorized commands must be rejected');
});

test('T04: index.html has strict CSP without unsafe-inline scripts and zero inline event handlers', () => {
    const html = fs.readFileSync(path.join(__dirname, '../app/index.html'), 'utf8');

    // Verify CSP meta tag presence
    const cspMatch = html.match(/<meta\s+http-equiv=["']Content-Security-Policy["']\s+content="([^"]+)"/i);
    assert.ok(cspMatch, 'Content-Security-Policy meta tag must be present in index.html');
    const cspContent = cspMatch[1];

    // Verify script-src does not allow unsafe-inline or unsafe-eval
    const scriptSrcMatch = cspContent.match(/script-src\s+([^;]+)/);
    assert.ok(scriptSrcMatch, 'CSP must declare script-src');
    assert.ok(!scriptSrcMatch[1].includes("'unsafe-inline'"), "script-src must NOT include 'unsafe-inline'");
    assert.ok(!scriptSrcMatch[1].includes("'unsafe-eval'"), "script-src must NOT include 'unsafe-eval'");

    // Verify zero inline on* attributes across entire index.html
    const inlineHandlers = [...html.matchAll(/\b(on[a-z]+)=/gi)].map(m => m[1]);
    assert.deepEqual(inlineHandlers, [], `Found inline event handlers in index.html: ${inlineHandlers.join(', ')}`);
});

test('T17: initial index.html does not claim BOT ATIVO before receiving configuration', () => {
    const html = fs.readFileSync(path.join(__dirname, '../app/index.html'), 'utf8');
    assert.ok(html.includes('class="status-pill paused"'), 'Status pill must initialize in paused state');
    assert.ok(html.includes('<span id="pill-text">BOT PAUSADO</span>'), 'Initial status text must be BOT PAUSADO');
    assert.ok(!html.includes('<span id="pill-text">BOT ATIVO</span>'), 'Initial HTML must never falsely claim BOT ATIVO');
});


