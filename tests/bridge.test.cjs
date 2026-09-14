const test = require('node:test');
const assert = require('node:assert/strict');
const { handleIdledexToPreload, handleHostCommand } = require('../electron/preload-game');

test('bridge rejects arrays, non-finite metrics, oversized strings and untrusted root fields', () => {
    const sent = [];
    const ipc = { sendToHost: (...args) => sent.push(args) };
    for (const data of [[], { connected: 'yes' }, { wallet: { silver: Infinity } },
        { connected: true, exec: 'arbitrary' }, { currentMapName: 'x'.repeat(5000) }]) {
        handleIdledexToPreload({ detail: { channel: 'game-telemetry', data } }, ipc);
    }
    assert.equal(sent.length, 0);
});

test('bridge does not execute accessors or forward cyclic data', () => {
    const sent = [];
    const ipc = { sendToHost: (...args) => sent.push(args) };
    let reads = 0;
    const accessor = { get connected() { reads++; return true; } };
    const cycle = {}; cycle.self = cycle;
    for (const data of [accessor, { collection: cycle }]) {
        handleIdledexToPreload({ detail: { channel: 'game-telemetry', data } }, ipc);
    }
    assert.equal(reads, 0);
    assert.equal(sent.length, 0);
});

test('bridge bounds log message shape and keeps valid adversarial text as data', () => {
    const sent = [];
    const ipc = { sendToHost: (...args) => sent.push(args) };
    for (const data of [{ message: {} }, { message: 'x'.repeat(5000) }, { message: 'a', level: 'exec' }]) {
        handleIdledexToPreload({ detail: { channel: 'game-log', data } }, ipc);
    }
    const text = '<img src=x onerror="window.injected=true">';
    handleIdledexToPreload({ detail: { channel: 'game-log', data: { message: text, level: 'warning' } } }, ipc);
    assert.equal(sent.length, 1);
    assert.equal(sent[0][1].message, text);
});

test('host bridge rejects malformed command payloads', () => {
    const events = [];
    global.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options.detail; } };
    const window = { dispatchEvent: event => events.push(event) };
    for (const data of [{ cmd: 'toggle-bot', payload: { enabled: 'false' } },
        { cmd: 'update-config', payload: [] }, { cmd: 'manual-action', payload: { action: 'eval' } }]) {
        handleHostCommand({}, data, window);
    }
    assert.equal(events.length, 0);
});
