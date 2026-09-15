const test = require('node:test');
const assert = require('node:assert/strict');
const { createEngine } = require('./engine-harness.cjs');

function creature(id, extra = {}) {
    return { id, speciesId: 19, name: 'Rattata', teamSlot: null, boxSlot: 0,
        ivs: { hp: 1, atk: 1, def: 1, spa: 1, spd: 1, spe: 1 }, ...extra };
}

function setup() {
    const engine = createEngine();
    const socket = engine.socket();
    socket.open();
    engine.configure({ enabled: false, auto_idle: false, discard_iv_pct: 80, protect_last_copy: false });
    socket.message({ t: 'welcome', d: { playerId: 'box-contract' } });
    return { engine, socket };
}

function cleanup(engine) { engine.command('manual-action', { action: 'cleanup-box' }); }
function releases(socket) { return socket.sent.filter(p => p.t === 'creature:release').flatMap(p => p.d.creatureIds); }
function confirmations(engine) {
    return engine.logs.filter(log => /Liberação confirmada/.test(log.message));
}

for (const flag of ['isMega', 'isListed']) {
    test(`Box cleanup protects the current protocol field ${flag}`, () => {
        const { engine, socket } = setup();
        socket.message({ t: 'team', d: { creatures: [
            creature('protected', { [flag]: true }), creature('eligible'),
        ] } });
        cleanup(engine);
        assert.deepEqual(releases(socket), ['eligible']);
    });
}

test('a partial welcome cannot confirm a release missing from the initial party', () => {
    const { engine, socket } = setup();
    const leader = creature('leader', { teamSlot: 0, boxSlot: null });
    socket.message({ t: 'team', d: { creatures: [leader, creature('pending')] } });
    cleanup(engine);
    assert.deepEqual(releases(socket), ['pending']);
    socket.message({ t: 'welcome', d: { playerId: 'box-contract', snapshot: { player: { team: [leader] } } } });
    assert.equal(confirmations(engine).length, 0, 'welcome contains only the initial roster');
    socket.message({ t: 'team', d: { creatures: [leader, creature('pending')] } });
    cleanup(engine);
    assert.deepEqual(releases(socket), ['pending'], 'unconfirmed request stays reserved');
    socket.message({ t: 'team', d: { creatures: [leader] } });
    assert.ok(confirmations(engine).length > 0, 'only the complete roster proves removal');
});

test('cleanup requires a complete team snapshot after welcome, including reconnects', () => {
    const { engine, socket } = setup();
    socket.message({ t: 'team', d: { creatures: [creature('stale')] } });
    socket.message({ t: 'welcome', d: { playerId: 'box-contract' } });
    cleanup(engine);
    assert.deepEqual(releases(socket), [], 'stale collection cannot authorize cleanup');
    socket.message({ t: 'team', d: { creatures: [creature('fresh')] } });
    assert.deepEqual(releases(socket), [], 'loading must not silently execute the earlier click');
    cleanup(engine);
    assert.deepEqual(releases(socket), ['fresh']);
});

test('missing Box location remains ineligible even after a complete roster', () => {
    const { engine, socket } = setup();
    socket.message({ t: 'team', d: { creatures: [
        creature('unknown-location', { boxSlot: null }), creature('eligible'),
    ] } });
    cleanup(engine);
    assert.deepEqual(releases(socket), ['eligible']);
});

test('a newly opened socket cannot clean the old session before its welcome', () => {
    const { engine, socket } = setup();
    socket.message({ t: 'team', d: { creatures: [creature('stale')] } });
    socket.close();
    const next = engine.socket();
    next.open();
    cleanup(engine);
    assert.deepEqual(releases(next), []);
    next.message({ t: 'team', d: {} });
    cleanup(engine);
    assert.deepEqual(releases(next), [], 'malformed team data is not a complete roster');
});

test('partial roster cannot authorize donation and complete roster releases the gate', () => {
    const { engine, socket } = setup();
    engine.configure({ enabled: true, auto_npc_quests: true, discard_iv_pct: 0 });
    const candidate = creature('donation');
    socket.message({ t: 'welcome', d: { playerId: 'box-contract', snapshot: { player: { team: [candidate] } } } });
    const quest = { t: 'dexquest:state', d: { questId: 'quest', target: { speciesId: 19, have: 1 } } };
    socket.message(quest);
    assert.equal(socket.sent.filter(p => p.t === 'dexquest:deliver').length, 0);
    socket.message({ t: 'team', d: { creatures: [candidate] } });
    socket.message(quest);
    assert.equal(socket.sent.filter(p => p.t === 'dexquest:deliver').length, 1);
});

test('capture waits for complete roster and still evaluates the current team patch', () => {
    const { engine, socket } = setup();
    engine.configure({ enabled: true, auto_lock_valuable: false });
    socket.message({ t: 'battle:start', d: { ownerId: 'box-contract', battleId: 'caught', foe: { speciesId: 19 } } });
    socket.message({ t: 'battle:end', d: { battleId: 'caught', result: 'capture', caught: { id: 'caught', speciesId: 19 } } });
    socket.message({ t: 'team:patch', d: { creatures: [creature('caught')] } });
    assert.deepEqual(releases(socket), []);
    socket.message({ t: 'team', d: { creatures: [creature('caught', { ivs: null })] } });
    assert.deepEqual(releases(socket), []);
    socket.message({ t: 'team:patch', d: { creatures: [creature('caught')] } });
    assert.deepEqual(releases(socket), ['caught']);
});
