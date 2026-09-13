const test = require('node:test');
const assert = require('node:assert/strict');
const { createEngine } = require('./engine-harness.cjs');

function buildBinaryFrame({ tick = 100, ack = null, entities = [] } = {}) {
    let flags = 0;
    if (ack !== null) flags |= 0x01;
    let size = 1 + 4 + 1; // 0x01 + tick + flags
    if (ack !== null) size += 4;
    size += 2; // entityCount

    const encodedEntities = entities.map(e => {
        const nameBytes = Buffer.from(e.name || '', 'utf8');
        let f = 0;
        let entitySize = 1 + 1 + nameBytes.length;
        if (e.x !== undefined && e.x !== null) { f |= 0x01; entitySize += 2; }
        if (e.y !== undefined && e.y !== null) { f |= 0x02; entitySize += 2; }
        if (e.dir !== undefined && e.dir !== null) { f |= 0x04; entitySize += 1; }
        return { f, nameBytes, x: e.x, y: e.y, dir: e.dir, entitySize };
    });

    for (const ee of encodedEntities) size += ee.entitySize;

    const buf = new Uint8Array(size);
    const view = new DataView(buf.buffer);
    buf[0] = 0x01;
    let offset = 1;
    view.setUint32(offset, tick, true); offset += 4;
    buf[offset++] = flags;
    if (ack !== null) {
        view.setUint32(offset, ack, true); offset += 4;
    }
    view.setUint16(offset, entities.length, true); offset += 2;

    const dirMap = { N: 0, E: 1, S: 2, W: 3 };
    for (const ee of encodedEntities) {
        buf[offset++] = ee.f;
        buf[offset++] = ee.nameBytes.length;
        buf.set(ee.nameBytes, offset);
        offset += ee.nameBytes.length;
        if (ee.f & 0x01) { view.setUint16(offset, ee.x, true); offset += 2; }
        if (ee.f & 0x02) { view.setUint16(offset, ee.y, true); offset += 2; }
        if (ee.f & 0x04) { buf[offset++] = dirMap[ee.dir] ?? 0; }
    }
    return buf.buffer;
}

test('T09: valid binary frame parses tick, ack, player position, and entities', () => {
    const engine = createEngine();
    const socket = engine.socket(); socket.open();
    socket.message({ t: 'welcome', d: { playerId: 'my-player', map: 'route_001' } });

    const frame = buildBinaryFrame({
        tick: 1001,
        ack: 42,
        entities: [
            { name: 'my-player', x: 15, y: 25, dir: 'N' },
            { name: 'wild:pidgey', x: 16, y: 25, dir: 'S' }
        ]
    });

    socket.binary(frame);

    const state = engine.state();
    assert.deepEqual(state.playerPos, { x: 15, y: 25 });
    assert.strictEqual(state.entities.length, 2);
    assert.strictEqual(state.entities[0].is_player, true);
    assert.strictEqual(state.entities[0].is_enemy, false);
    assert.strictEqual(state.entities[1].is_player, false);
    assert.strictEqual(state.entities[1].is_enemy, true);
});

test('T09: truncated binary frame does not mutate playerPos or entities (transactional)', () => {
    const engine = createEngine();
    const socket = engine.socket(); socket.open();
    socket.message({ t: 'welcome', d: { playerId: 'my-player', map: 'route_001' } });

    // Establish initial baseline state
    const validFrame = buildBinaryFrame({
        tick: 1,
        ack: 10,
        entities: [{ name: 'my-player', x: 7, y: 7, dir: 'E' }]
    });
    socket.binary(validFrame);
    assert.deepEqual(engine.state().playerPos, { x: 7, y: 7 });

    // 1. Truncated prefix (< 6 bytes)
    socket.binary(new Uint8Array([0x01, 0x00, 0x00]));
    assert.deepEqual(engine.state().playerPos, { x: 7, y: 7 });

    // 2. Truncated ack (flag set but buffer ends)
    const truncatedAck = new Uint8Array([0x01, 0x01, 0x00, 0x00, 0x00, 0x01, 0x05, 0x00]); // flag 1 but only 2 bytes for ack
    socket.binary(truncatedAck);
    assert.deepEqual(engine.state().playerPos, { x: 7, y: 7 });

    // 3. Truncated entity list (valid full frame truncated by half)
    const fullFrame = new Uint8Array(buildBinaryFrame({
        tick: 2,
        ack: 20,
        entities: [
            { name: 'my-player', x: 99, y: 99, dir: 'W' },
            { name: 'wild:rat', x: 100, y: 100, dir: 'N' }
        ]
    }));
    // Cut off mid-way through the first entity's coords
    const truncatedEntities = fullFrame.slice(0, 16);
    socket.binary(truncatedEntities);

    // Player position and entities MUST NOT be corrupted by truncated frame
    assert.deepEqual(engine.state().playerPos, { x: 7, y: 7 });
    assert.strictEqual(engine.state().entities.length, 1);
});

test('T09: remote player does not overwrite local player position (no remote player spoofing)', () => {
    const engine = createEngine();
    const socket = engine.socket(); socket.open();
    socket.message({ t: 'welcome', d: { playerId: 'trainer-self', map: 'route_001' } });

    // Establish local position
    socket.binary(buildBinaryFrame({
        tick: 1,
        entities: [{ name: 'trainer-self', x: 10, y: 10, dir: 'S' }]
    }));
    assert.deepEqual(engine.state().playerPos, { x: 10, y: 10 });

    // Binary update with another player ("player:other_user" or "player:bob")
    const remoteUserFrame = buildBinaryFrame({
        tick: 2,
        entities: [
            { name: 'player:other_user', x: 88, y: 99, dir: 'N' },
            { name: 'wild:caterpie', x: 11, y: 10, dir: 'W' }
        ]
    });
    socket.binary(remoteUserFrame);

    const state = engine.state();
    // Local playerPos must NOT be replaced by other_user
    assert.deepEqual(state.playerPos, { x: 10, y: 10 });
    const other = state.entities.find(e => e.id === 'player:other_user');
    assert.ok(other);
    assert.strictEqual(other.is_player, false);
    assert.strictEqual(other.is_enemy, false);
});

test('T09: multi-byte UTF-8 entity names decode properly without truncation or corruption', () => {
    const engine = createEngine();
    const socket = engine.socket(); socket.open();
    socket.message({ t: 'welcome', d: { playerId: 'self', map: 'route_001' } });

    const utf8Name = 'wild:nidoran♀-flabébé';
    const frame = buildBinaryFrame({
        tick: 5,
        entities: [{ name: utf8Name, x: 3, y: 4, dir: 'E' }]
    });
    socket.binary(frame);

    const state = engine.state();
    assert.strictEqual(state.entities.length, 1);
    assert.strictEqual(state.entities[0].name, utf8Name);
});

test('T09: delta frame without player position preserves existing player position', () => {
    const engine = createEngine();
    const socket = engine.socket(); socket.open();
    socket.message({ t: 'welcome', d: { playerId: 'my-player', map: 'route_001' } });

    socket.binary(buildBinaryFrame({
        tick: 1,
        entities: [{ name: 'my-player', x: 50, y: 60, dir: 'N' }]
    }));
    assert.deepEqual(engine.state().playerPos, { x: 50, y: 60 });

    // Delta update only containing wild entities
    socket.binary(buildBinaryFrame({
        tick: 2,
        entities: [{ name: 'wild:weedle', x: 51, y: 60, dir: 'S' }]
    }));

    // playerPos is preserved
    assert.deepEqual(engine.state().playerPos, { x: 50, y: 60 });
    assert.strictEqual(engine.state().entities.length, 1);
    assert.strictEqual(engine.state().entities[0].name, 'wild:weedle');
});

test('T09: valid Blob payload is parsed asynchronously and updates state', async () => {
    const engine = createEngine();
    const socket = engine.socket(); socket.open();
    socket.message({ t: 'welcome', d: { playerId: 'blob-player', map: 'route_001' } });

    const frame = buildBinaryFrame({
        tick: 10,
        entities: [{ name: 'blob-player', x: 33, y: 44, dir: 'E' }]
    });

    const blob = new Blob([frame]);
    socket.message(blob);

    // Wait for Blob promise microtask
    await new Promise(setImmediate);

    assert.deepEqual(engine.state().playerPos, { x: 33, y: 44 });
});

test('T09: delayed Blob payload from a replaced socket is dropped and does not mutate new session', async () => {
    const engine = createEngine();
    const oldSocket = engine.socket(); oldSocket.open();
    oldSocket.message({ t: 'welcome', d: { playerId: 'old-player', map: 'route_001' } });

    const staleFrame = buildBinaryFrame({
        tick: 1,
        entities: [{ name: 'old-player', x: 999, y: 999, dir: 'S' }]
    });
    const staleBlob = new Blob([staleFrame]);

    // Send Blob on old socket
    oldSocket.message(staleBlob);

    // Immediately replace session with new socket before Blob arrayBuffer resolves
    const newSocket = engine.socket(); newSocket.open();
    newSocket.message({ t: 'welcome', d: { playerId: 'new-player', map: 'route_002' } });

    const newFrame = buildBinaryFrame({
        tick: 2,
        entities: [{ name: 'new-player', x: 1, y: 1, dir: 'N' }]
    });
    newSocket.binary(newFrame);

    await new Promise(setImmediate);

    // State must belong to new session, NOT contaminated by stale Blob
    const state = engine.state();
    assert.strictEqual(state.playerId, 'new-player');
    assert.deepEqual(state.playerPos, { x: 1, y: 1 });
});