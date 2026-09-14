const test = require('node:test');
const assert = require('node:assert/strict');
const { createEngine } = require('./engine-harness.cjs');

const flush = () => new Promise(setImmediate);

function startMap(engine) {
    const socket = engine.socket();
    socket.open();
    engine.configure({ enabled: false });
    socket.message({ t: 'welcome', d: { playerId: 'player', map: 'route_001' } });
    return socket;
}

test('collision deadline covers a response body that stalls after successful headers', async () => {
    let signal;
    let readingBody = false;
    const engine = createEngine(async (_url, options) => {
        signal = options.signal;
        return {
            ok: true,
            json() {
                readingBody = true;
                return new Promise((_resolve, reject) => {
                    signal.addEventListener('abort', () => {
                        const error = new Error('Response body aborted');
                        error.name = 'AbortError';
                        reject(error);
                    }, { once: true });
                });
            },
        };
    });
    startMap(engine);
    await flush();
    assert.equal(readingBody, true);
    engine.advance(9999);
    assert.equal(signal.aborted, false);
    engine.advance(1);
    await flush();
    assert.equal(signal.aborted, true, '10 second deadline must abort a stalled JSON body');
    assert.equal(engine.state().mapAvailable, false);
    assert.equal(engine.state().mapStatus, 'unavailable');
});

for (const invalidCell of [NaN, 256, -1, 0.5, '0', null]) {
    test(`collision grid rejects invalid cell ${String(invalidCell)} (${typeof invalidCell})`, async () => {
        const engine = createEngine(async () => ({
            ok: true,
            json: async () => ({ cols: 2, rows: 2, grid: [0, 0, 0, invalidCell] }),
        }));
        startMap(engine);
        await flush();
        assert.equal(engine.state().mapAvailable, false, 'malformed cells must not become traversable through typed-array coercion');
        assert.equal(engine.state().mapStatus, 'unavailable');
    });
}

test('disconnect aborts the active collision request immediately', async () => {
    let signal;
    const engine = createEngine((_url, options) => {
        signal = options.signal;
        return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => {
                const error = new Error('Request aborted');
                error.name = 'AbortError';
                reject(error);
            }, { once: true });
        });
    });
    const socket = startMap(engine);
    assert.equal(signal.aborted, false);
    socket.close();
    await flush();
    assert.equal(signal.aborted, true, 'a closed game session must release its pending map request');
    assert.equal(engine.state().mapAvailable, false);
    assert.notEqual(engine.state().mapStatus, 'loading');
});

test('disconnect removes the availability of a previously loaded collision map', async () => {
    const engine = createEngine(async () => ({
        ok: true,
        json: async () => ({ cols: 2, rows: 2, grid: [0, 0, 0, 0] }),
    }));
    const socket = startMap(engine);
    await flush();
    assert.equal(engine.state().mapAvailable, true);
    socket.close();
    assert.equal(engine.state().connected, false);
    assert.equal(engine.state().mapAvailable, false);
    assert.notEqual(engine.state().mapStatus, 'available');
    assert.notEqual(engine.state().mapStatus, 'empty');
});
