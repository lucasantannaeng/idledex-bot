const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Executes the retained userscript offline. Packet assertions characterize its
// legacy envelopes; they are not evidence that the current game accepts them.
function createUserscript({ restoreConstantsForReproduction = false } = {}) {
    const listeners = new Map();
    const timers = new Map();
    let nextTimer = 0;
    let now = 0;
    function element() {
        const events = new Map();
        return {
            style: {}, textContent: '',
            addEventListener(type, callback) { events.set(type, callback); },
            click() { events.get('click')?.(); },
        };
    }
    const elements = { 'idledex-bot-toggle': element(), 'idledex-bot-status': element() };
    class NativeSocket {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;
        constructor(url) { this.url = String(url); this.readyState = 0; this.events = new Map(); this.sent = []; }
        addEventListener(type, callback) {
            const callbacks = this.events.get(type) || [];
            callbacks.push(callback);
            this.events.set(type, callbacks);
        }
        emit(type, event = {}) { for (const callback of this.events.get(type) || []) callback(event); }
        open() { this.readyState = 1; this.emit('open'); }
        close() { this.readyState = 3; this.emit('close'); }
        message(packet) { this.emit('message', { data: JSON.stringify(packet) }); }
        send(data) { this.sent.push(JSON.parse(data)); }
    }
    const context = {
        WebSocket: NativeSocket, URL,
        location: { href: 'https://idledex.com/play' },
        console: { log() {} },
        document: {
            createElement: element,
            getElementById(id) { return elements[id] || null; },
            body: { appendChild() {} },
        },
        addEventListener(type, callback) { listeners.set(type, callback); },
        setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, due: now + delay }); return id; },
        clearTimeout(id) { timers.delete(id); },
    };
    context.window = context;
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../idledex-bot.user.js'), 'utf8'), vm.createContext(context));
    listeners.get('DOMContentLoaded')();
    // Isolate the timer/session regressions from the independently broken OPEN
    // constant in the original userscript, which otherwise masks every send.
    if (restoreConstantsForReproduction && context.WebSocket.OPEN === undefined) {
        context.WebSocket.OPEN = NativeSocket.OPEN;
    }
    return {
        context, NativeSocket, timers,
        socket(url = 'wss://idledex.com/ws') { const ws = new context.WebSocket(url); ws.open(); return ws; },
        welcome(ws) { ws.message({ t: 'welcome', d: { playerId: 'synthetic-trainer', map: 'route_001' } }); },
        toggle() { elements['idledex-bot-toggle'].click(); },
        status() { return elements['idledex-bot-status'].textContent; },
        advance(ms) {
            const end = now + ms;
            for (let guard = 0; guard < 100; guard++) {
                const next = [...timers.entries()].filter(([, value]) => value.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
                if (!next) { now = end; return; }
                now = next[1].due;
                timers.delete(next[0]);
                next[1].callback();
            }
            throw new Error('Userscript timers did not settle');
        },
    };
}

test('T27: WebSocket wrapper preserves constants, prototype, native send and subclassing', () => {
    const script = createUserscript();
    for (const name of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) {
        assert.equal(script.context.WebSocket[name], script.NativeSocket[name]);
    }
    const ws = script.socket();
    assert.equal(script.context.WebSocket.prototype, script.NativeSocket.prototype);
    assert.ok(ws instanceof script.context.WebSocket);
    assert.equal(ws.send, script.NativeSocket.prototype.send);
    class CustomSocket extends script.context.WebSocket {}
    assert.ok(new CustomSocket('wss://idledex.com/ws') instanceof CustomSocket);
    assert.throws(() => script.context.WebSocket('wss://idledex.com/ws'), /class constructor|without 'new'/i);
});

test('T27: game packets require a welcome; a foreign or unconfirmed socket cannot take the session', () => {
    const script = createUserscript({ restoreConstantsForReproduction: true });
    const ws = script.socket();
    ws.message({ t: 'daily:list', d: { quests: [] } });
    assert.equal(ws.sent.length, 0);
    script.welcome(ws);
    const foreign = script.socket('wss://analytics.example.com/events');
    script.welcome(foreign);
    const candidate = script.socket();
    ws.message({ t: 'daily:list', d: { quests: [] } });
    assert.ok(ws.sent.length > 0);
    assert.equal(foreign.sent.length, 0);
    assert.equal(candidate.sent.length, 0);
});

test('T27: pausing cancels delayed idle and resuming cannot replay it', () => {
    const script = createUserscript({ restoreConstantsForReproduction: true });
    const ws = script.socket(); script.welcome(ws);
    ws.message({ t: 'battle:end', d: { victory: true } });
    const obsoleteCallback = [...script.timers.values()][0].callback;
    script.toggle();
    script.advance(2000);
    assert.equal(ws.sent.length, 0);
    script.toggle();
    obsoleteCallback();
    assert.equal(ws.sent.length, 0);
    assert.equal(script.timers.size, 0);
});

test('T27: reconnect cancels combat callbacks and ignores retired socket messages and close', () => {
    const script = createUserscript({ restoreConstantsForReproduction: true });
    const first = script.socket(); script.welcome(first);
    first.message({ t: 'battle:turn', d: { opponent: { hpPercent: 0.2 } } });
    const obsoleteCallback = [...script.timers.values()][0].callback;
    const second = script.socket('wss://idledex.com/ws/2'); script.welcome(second);
    script.advance(500);
    obsoleteCallback();
    first.message({ t: 'daily:list', d: { quests: [] } });
    script.welcome(first);
    first.close();
    assert.equal(first.sent.length, 0);
    assert.equal(second.sent.length, 0);
    assert.equal(script.status(), 'Conectado');
});

test('T27: closing the active socket removes all scheduled actions', () => {
    const script = createUserscript({ restoreConstantsForReproduction: true });
    const ws = script.socket(); script.welcome(ws);
    ws.message({ t: 'battle:end', d: {} });
    ws.close();
    assert.equal(script.timers.size, 0);
    assert.equal(script.status(), 'Desconectado');
});

test('T27: an ended battle cannot attack a later battle or queue duplicate turn actions', () => {
    const script = createUserscript({ restoreConstantsForReproduction: true });
    const ws = script.socket(); script.welcome(ws);
    const turn = { t: 'battle:turn', d: { opponent: { hpPercent: 0.8 } } };
    ws.message(turn);
    const obsoleteCallback = [...script.timers.values()][0].callback;
    ws.message({ t: 'battle:end', d: {} });
    ws.message(turn);
    ws.message({ ...turn, t: 'battle:control' });
    obsoleteCallback();
    script.advance(1500);
    assert.equal(ws.sent.length, 1);
});

test('T27 characterization: legacy combat envelopes remain unverified against the current game', () => {
    const script = createUserscript({ restoreConstantsForReproduction: true });
    const ws = script.socket(); script.welcome(ws);
    ws.message({ t: 'battle:turn', d: { opponent: { hpPercent: 0.2 } } });
    script.advance(300);
    ws.message({ t: 'battle:turn', d: { opponent: { hpPercent: 0.8 } } });
    script.advance(300);
    assert.deepEqual(ws.sent, [
        { t: 'capture:throw', d: { ballId: 'poke-ball' } },
        { t: 'battle:move', d: { moveIndex: 0 } },
    ]);
});
