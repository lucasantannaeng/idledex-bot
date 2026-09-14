const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Execute the complete shipped preload, including both IPC bridges and injection.
function createEngine(fetch = async () => ({ ok: false })) {
    const listeners = new Map();
    const telemetry = [];
    const timers = new Map();
    let timerId = 0;
    let now = Date.now();
    class Clock extends Date { static now() { return now; } }
    function schedule(fn, delay = 0, repeating = false) {
        const id = ++timerId;
        const callback = () => {
            if (!repeating) timers.delete(id);
            else callback.due = now + Math.max(1, delay);
            fn();
        };
        callback.due = now + delay;
        timers.set(id, callback);
        return id;
    }
    class Socket {
        static OPEN = 1;
        static CLOSED = 3;
        static CONNECTING = 0;
        static CLOSING = 2;
        constructor(url) { this.url = url; this.readyState = 0; this.listeners = {}; this.sent = []; }
        addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
        emit(type, data = {}) { for (const fn of this.listeners[type] || []) fn(data); }
        open() { this.readyState = 1; this.emit('open'); }
        close() { this.readyState = 3; this.emit('close', { code: 1000 }); }
        message(data) {
            if (typeof data === 'string' || data instanceof ArrayBuffer || ArrayBuffer.isView(data) || (typeof Blob !== 'undefined' && data instanceof Blob)) {
                this.emit('message', { data });
            } else {
                this.emit('message', { data: JSON.stringify(data) });
            }
        }
        binary(buffer) {
            const data = buffer instanceof ArrayBuffer ? buffer : (buffer && buffer.buffer ? buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) : buffer);
            this.emit('message', { data });
        }
        send(data) {
            try {
                this.sent.push(typeof data === 'string' ? JSON.parse(data) : data);
            } catch {
                this.sent.push(data);
            }
        }
    }
    const window = {
        WebSocket: Socket,
        addEventListener(type, fn) { const list = listeners.get(type) || []; list.push(fn); listeners.set(type, list); },
        dispatchEvent(event) { for (const fn of listeners.get(event.type) || []) fn(event); },
    };
    let context;
    const sandbox = {
        window, console: { log() {}, warn() {}, error() {} }, fetch,
        sessionStorage: { getItem() { return null; }, setItem() {} },
        document: { querySelector() { return null; }, querySelectorAll() { return []; } },
        CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
        KeyboardEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
        structuredClone, Uint8Array, ArrayBuffer, DataView, TextDecoder, atob, Date: Clock, URL, Blob, AbortController,
        performance: { now() { return now; } },
        setTimeout(fn, delay) { return schedule(fn, delay); },
        setInterval(fn, delay) { return schedule(fn, delay, true); },
        clearTimeout(id) { timers.delete(id); }, clearInterval(id) { timers.delete(id); },
        require(name) {
            if (name === './config-schema') return require('../electron/config-schema');
            if (name === './bridge-contract') return require('../electron/bridge-contract');
            if (name !== 'electron') throw new Error(`Unexpected dependency: ${name}`);
            return {
                webFrame: { executeJavaScript(source) { vm.runInContext(source, context); } },
                ipcRenderer: { on() {}, sendToHost(channel, data) {
                    if (channel === 'game-telemetry') telemetry.push(structuredClone(data));
                } },
            };
        },
    };
    Object.defineProperty(sandbox, 'WebSocket', { get: () => window.WebSocket });
    context = vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../electron/preload-game.js'), 'utf8'), context);
    return {
        socket(url = 'wss://gateway.idledex.com') { return new window.WebSocket(url); },
        state() {
            return telemetry.at(-1);
        },
        publish(payload = {}) {
            window.dispatchEvent(new sandbox.CustomEvent('idledex-from-preload', { detail: { cmd: 'update-config', payload } }));
            return telemetry.at(-1);
        },
        telemetry, timers,
        now() { return now; },
        onKeyDown(callback) { window.addEventListener('keydown', callback); },
        onKeyUp(callback) { window.addEventListener('keyup', callback); },
        advance(ms) {
            const end = now + ms;
            for (let steps = 0; steps < 10000; steps++) {
                const next = [...timers.values()].filter(fn => fn.due <= end).sort((a, b) => a.due - b.due)[0];
                if (!next) { now = end; return; }
                now = next.due;
                next();
            }
            throw new Error('Timer loop did not settle');
        },
        configure(payload) {
            window.dispatchEvent(new sandbox.CustomEvent('idledex-from-preload', { detail: { cmd: 'update-config', payload } }));
        },
        command(cmd, payload) {
            window.dispatchEvent(new sandbox.CustomEvent('idledex-from-preload', { detail: { cmd, payload } }));
        },
    };
}
module.exports = { createEngine };
