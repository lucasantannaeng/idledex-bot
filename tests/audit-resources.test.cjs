const test = require('node:test');
const assert = require('node:assert/strict');
const { createEngine } = require('./engine-harness.cjs');

// Synthetic fixtures only. team/battle/Professor shapes are documented in
// research/2026-09-08-audit.md; Collector/DexQuest match the existing engine tests.
function setup(config = {}) {
    const engine = createEngine();
    const socket = engine.socket();
    socket.open();
    engine.configure({ enabled: true, auto_idle: false, auto_roam: false,
        auto_claim_dailies: false, auto_travel_deliveries: false,
        auto_npc_quests: true, discard_iv_pct: 0, protect_last_copy: true, ...config });
    socket.message({ t: 'welcome', d: { playerId: 'trainer', map: 'route_001' } });
    return { engine, socket };
}

function creature(id = 'box-1') {
    return { id, speciesId: 25, name: 'Pikachu', teamSlot: null, boxSlot: 0,
        ivs: { hp: 1, atk: 1, def: 1, spa: 1, spd: 1, spe: 1 } };
}

function dexQuest(socket) {
    socket.message({ t: 'dexquest:state', d: {
        questId: 'quest-1', target: { speciesId: 25, name: 'Pikachu', have: 1 },
    } });
}

function collector(socket, ids) {
    socket.message({ t: 'collector:state', d: {
        mapId: 'route_001', window: 1, deliverable: true, delivered: false,
    } });
    socket.message({ t: 'collector:preview', d: {
        mapId: 'route_001', window: 1, creatureIds: ids,
    } });
}

for (const npc of ['dexquest', 'collector']) {
    test(`${npc} preserves the last species copy when protect_last_copy is enabled`, () => {
        const { socket } = setup();
        socket.message({ t: 'team', d: { creatures: [creature()] } });
        if (npc === 'dexquest') dexQuest(socket);
        else collector(socket, ['box-1']);
        assert.equal(socket.sent.filter(p => p.t === `${npc}:deliver`).length, 0,
            'shared resource protection must apply to donations as well as release');
    });
}

test('a pending Collector donation prevents DexQuest from reserving the same creature', () => {
    const { socket } = setup({ protect_last_copy: false });
    socket.message({ t: 'team', d: { creatures: [creature()] } });
    collector(socket, ['box-1']);
    assert.equal(socket.sent.filter(p => p.t === 'collector:deliver').length, 1);
    dexQuest(socket);
    assert.equal(socket.sent.filter(p => p.t === 'dexquest:deliver').length, 0,
        'NPC-specific deduplication must not allow overlapping destructive requests');
});

test('Collector cannot consume an entire species batch while last-copy protection is enabled', () => {
    const { socket } = setup();
    socket.message({ t: 'team', d: { creatures: [creature('a'), creature('b')] } });
    collector(socket, ['a', 'b']);
    assert.equal(socket.sent.filter(p => p.t === 'collector:deliver').length, 0);
});

test('donation reservation survives reconnect and clears after collection confirms removal', () => {
    const { engine, socket } = setup({ protect_last_copy: false });
    socket.message({ t: 'team', d: { creatures: [creature('a'), creature('b')] } });
    dexQuest(socket);
    assert.equal(socket.sent.filter(p => p.t === 'dexquest:deliver').length, 1);
    socket.close();
    const next = engine.socket(); next.open();
    next.message({ t: 'welcome', d: { playerId: 'trainer', map: 'route_001' } });
    dexQuest(next);
    assert.equal(next.sent.filter(p => p.t === 'dexquest:deliver').length, 0);
    next.message({ t: 'team', d: { creatures: [creature('b')] } });
    next.message({ t: 'dexquest:state', d: { questId: 'quest-2', target: { speciesId: 25, have: 1 } } });
    assert.equal(next.sent.filter(p => p.t === 'dexquest:deliver').length, 1);
});

test('pending release survives elapsed time and reconnection until authoritative reconciliation', () => {
    const { engine, socket } = setup({ protect_last_copy: false, discard_iv_pct: 50 });
    socket.message({ t: 'battle:start', d: { ownerId: 'trainer', battleId: 'capture',
        foe: { speciesId: 25, name: 'Pikachu' } } });
    socket.message({ t: 'battle:end', d: { battleId: 'capture', result: 'capture',
        caught: { speciesId: 25, name: 'Pikachu' } } });
    socket.message({ t: 'team', d: { creatures: [creature()] } });
    assert.equal(socket.sent.filter(p => p.t === 'creature:release').length, 1);
    socket.close();
    engine.advance(31000);
    const replacement = engine.socket();
    replacement.open();
    replacement.message({ t: 'welcome', d: { playerId: 'trainer', map: 'route_001' } });
    // There has been no team snapshot, deletion patch or rejection since release.
    dexQuest(replacement);
    assert.equal(replacement.sent.filter(p => p.t === 'dexquest:deliver').length, 0,
        'elapsed time must not turn an unresolved release into a donation candidate');
});

test('an uncorrelated server error cannot free a pending release for another destructive action', () => {
    const { engine, socket } = setup({ protect_last_copy: false, discard_iv_pct: 50 });
    socket.message({ t: 'collection', d: { mons: [creature()] } });
    assert.equal(socket.sent.filter(p => p.t === 'creature:release').length, 1);
    socket.message({ t: 'error', d: { code: 'creature_locked' } });
    engine.configure({ discard_iv_pct: 0 });
    dexQuest(socket);
    assert.equal(socket.sent.filter(p => p.t === 'dexquest:deliver').length, 0);
});

test('a requested lock protects the creature before its confirmation arrives', () => {
    const { socket } = setup({ protect_last_copy: false, discard_iv_pct: 50 });
    socket.message({ t: 'battle:start', d: { ownerId: 'trainer', battleId: 'lock', foe: { speciesId: 25 } } });
    socket.message({ t: 'battle:end', d: { battleId: 'lock', result: 'capture', caught: { speciesId: 25 } } });
    socket.message({ t: 'team', d: { creatures: [{ ...creature(), ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 } }] } });
    assert.equal(socket.sent.filter(p => p.t === 'creature:lock').length, 1);
    // A later patch can be stale; no successful lock or correlated rejection exists.
    socket.message({ t: 'collection:patch', d: { mons: [creature()] } });
    assert.equal(socket.sent.filter(p => p.t === 'creature:release').length, 0);
    dexQuest(socket);
    assert.equal(socket.sent.filter(p => p.t === 'dexquest:deliver').length, 0);
});

test('capture target is not weakened by a damaging move without a proven nonlethal bound', () => {
    const { engine, socket } = setup({ catch_hp_pct: 0.5 });
    socket.message({ t: 'inventory', d: { items: [{ itemId: 'super-ball', quantity: 10 }] } });
    socket.message({ t: 'battle:start', d: { ownerId: 'trainer', battleId: 'high-target',
        leader: { creatureId: 'leader', level: 50, hp: 100, maxHp: 100,
            moves: [{ id: 'hyper-beam', power: 150, type: 'normal' }] },
        foe: { creatureId: 'wild-1', speciesId: 25, name: 'Pikachu',
            level: 50, hp: 100, maxHp: 100, types: ['electric'] },
    } });
    socket.message({ t: 'battle:control', d: {
        battleId: 'high-target', open: true, canThrow: true, windowMs: 1000,
    } });
    engine.advance(100);
    assert.equal(socket.sent.filter(p => p.t === 'battle:move').length, 0,
        'same level, HP percentage and weakest available power do not prove survival');
    assert.equal(socket.sent.filter(p => p.t === 'battle:item').length, 1,
        'the available permitted ball preserves the capture attempt while damage is unproven');
});
