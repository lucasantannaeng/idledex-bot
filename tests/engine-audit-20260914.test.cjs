const test = require('node:test');
const assert = require('node:assert/strict');
const { createEngine } = require('./engine-harness.cjs');

function setup(config = {}) {
    const engine = createEngine();
    const socket = engine.socket();
    socket.open();
    engine.configure({ enabled: true, auto_roam: false, auto_idle: false,
        auto_claim_dailies: false, auto_npc_quests: false,
        auto_travel_deliveries: false, auto_lock_valuable: false,
        protect_last_copy: true, discard_iv_pct: 0, ...config });
    socket.message({ t: 'welcome', d: { playerId: 'audit-trainer', map: 'route_001' } });
    socket.message({ t: 'team', d: { creatures: [] } }); // Initial box:open response before gameplay.
    return { engine, socket };
}

function mon(id, extra = {}) {
    return { id, speciesId: 11, name: 'Metapod', teamSlot: null, boxSlot: 0,
        nature: 'hardy', ivs: { hp: 5, atk: 5, def: 5, spa: 5, spd: 5, spe: 5 }, ...extra };
}

function releases(socket) {
    return socket.sent.filter(packet => packet.t === 'creature:release').flatMap(packet => packet.d.creatureIds);
}

for (const protectLastCopy of [true, false]) {
    test(`batch cleanup ${protectLastCopy ? 'preserves' : 'can release'} the last copy across repeated requests`, () => {
        const { engine, socket } = setup({ discard_iv_pct: 80, protect_last_copy: protectLastCopy });
        socket.message({ t: 'team', d: { creatures: [mon('a'), mon('b'), mon('c')] } });
        engine.command('manual-action', { action: 'cleanup-box' });
        engine.command('manual-action', { action: 'cleanup-box' });
        assert.equal(new Set(releases(socket)).size, protectLastCopy ? 2 : 3);
        assert.equal(releases(socket).length, protectLastCopy ? 2 : 3, 'pending releases are never repeated');
        if (protectLastCopy) {
            const remaining = ['a', 'b', 'c'].filter(id => !releases(socket).includes(id));
            socket.message({ t: 'team', d: { creatures: remaining.map(id => mon(id)) } });
            engine.command('manual-action', { action: 'cleanup-box' });
            assert.equal(releases(socket).length, 2, 'confirmed deletion must still leave one copy');
        }
    });
}

test('competitive nature criteria use species names when the protocol has numeric species IDs', () => {
    const { engine, socket } = setup({ desired_nature: 'competitive', protect_last_copy: false });
    socket.message({ t: 'team', d: { creatures: [
        mon('recommended', { nature: 'relaxed' }),
        mon('generic-only', { nature: 'modest' }),
    ] } });
    engine.command('manual-action', { action: 'cleanup-box' });
    assert.deepEqual(releases(socket), ['generic-only'], 'Metapod supports relaxed, not the generic modest fallback');
});

test('IV percentage filtering compares the real percentage before display rounding', () => {
    const { engine, socket } = setup({ discard_iv_pct: 80, protect_last_copy: false });
    socket.message({ t: 'team', d: { creatures: [
        mon('below-80', { ivs: { hp: 25, atk: 25, def: 25, spa: 25, spd: 24, spe: 24 } }),
        mon('above-80', { ivs: { hp: 25, atk: 25, def: 25, spa: 25, spd: 25, spe: 24 } }),
    ] } });
    engine.command('manual-action', { action: 'cleanup-box' });
    assert.deepEqual(releases(socket), ['below-80'], '148/186 is below 80%; 149/186 is above it');
});

test('a collection patch resolves a captured valuable creature and locks it before discard', () => {
    const { engine, socket } = setup({ discard_iv_pct: 95, protect_last_copy: false, auto_lock_valuable: true });
    socket.message({ t: 'battle:start', d: { ownerId: 'audit-trainer', battleId: 'capture-patch', foe: { speciesId: 11, name: 'Metapod' } } });
    socket.message({ t: 'battle:end', d: { battleId: 'capture-patch', result: 'capture', caught: { speciesId: 11, id: 'caught' } } });
    socket.message({ t: 'collection:patch', d: { mons: [mon('caught', {
        nature: 'relaxed', ivs: { hp: 25, atk: 25, def: 25, spa: 25, spd: 25, spe: 25 },
    })] } });
    assert.equal(releases(socket).length, 0, 'capture auto-lock must take precedence over release');
    assert.equal(socket.sent.filter(packet => packet.t === 'creature:lock' && packet.d.creatureId === 'caught').length, 1);
    assert.equal(engine.state().lastCapturedMon?.isBestNature, true);
});

const targetCases = [
    { name: 'selected numeric ID', config: { target_mode: 'selected', target_species: [11] }, action: 'battle:item' },
    { name: 'unselected numeric ID', config: { target_mode: 'selected', target_species: [12] }, action: 'battle:flee' },
    { name: 'empty selected list', config: { target_mode: 'selected', target_species: [] }, action: 'battle:flee' },
    { name: 'no targets', config: { target_mode: 'none' }, action: 'battle:flee' },
    { name: 'pinned numeric ID overrides none', config: { target_mode: 'none', pinned_species: [11] }, action: 'battle:item' },
    { name: 'pinned name overrides none', config: { target_mode: 'none', pinned_species: ' Metapod ' }, action: 'battle:item' },
    { name: 'second pinned species overrides area selection', config: { target_mode: 'selected', target_species: [25], pinned_species: ['pikachu', 'metapod'] }, action: 'battle:item' },
    { name: 'shiny protection overrides none', config: { target_mode: 'none' }, shiny: true, action: 'battle:item' },
];

for (const target of targetCases) {
    test(`capture focus: ${target.name}`, () => {
        const { engine, socket } = setup({ unselected_action: 'flee', ...target.config });
        socket.message({ t: 'inventory', d: { items: [{ itemId: 'poke-ball', quantity: 10 }] } });
        socket.message({ t: 'battle:start', d: {
            ownerId: 'audit-trainer', battleId: 'focus',
            leader: { creatureId: 'leader', hp: 100, maxHp: 100, level: 50 },
            foe: { speciesId: 11, name: 'Metapod', hp: 100, maxHp: 100, level: 10, isShiny: target.shiny },
        } });
        socket.message({ t: 'battle:control', d: { battleId: 'focus', open: true, canThrow: true, windowMs: 1000 } });
        engine.advance(100);
        const actions = socket.sent.filter(packet => /^battle:(item|move|flee)$/.test(packet.t));
        assert.equal(actions.length, 1);
        assert.equal(actions[0].t, target.action);
        if (target.action === 'battle:item') assert.equal(actions[0].d.itemId, 'poke-ball');
    });
}

test('pausing both automation modes through configuration explicitly stops native idle', () => {
    const { engine, socket } = setup({ enabled: false, auto_idle: true });
    socket.sent.length = 0;
    engine.configure({ enabled: false, auto_idle: false });
    assert.equal(socket.sent.filter(packet => packet.t === 'idle:stop').length, 1);
    assert.equal(socket.sent.filter(packet => packet.t === 'idle:start').length, 0);
});

test('host pause applies auto_idle false and stops native idle before publishing paused state', () => {
    const { engine, socket } = setup({ enabled: false, auto_idle: true });
    socket.sent.length = 0;
    engine.command('toggle-bot', { enabled: false, auto_idle: false, reason: 'suspend' });
    assert.equal(socket.sent.filter(packet => packet.t === 'idle:stop').length, 1);
    assert.equal(socket.sent.filter(packet => packet.t === 'idle:start').length, 0);
    assert.equal(engine.state().config.auto_idle, false);
    assert.equal(engine.state().config.enabled, false);
});

test('normal pause preserves an explicitly enabled native idle preference', () => {
    const { engine, socket } = setup({ enabled: true, auto_idle: true });
    socket.sent.length = 0;
    engine.command('toggle-bot', { enabled: false });
    assert.equal(socket.sent.filter(packet => packet.t === 'idle:start').length, 1);
    assert.equal(engine.state().config.auto_idle, true);
});

for (const incomplete of [
    { name: 'quality', config: { min_quality: 'great' }, missing: { quality: undefined }, known: { quality: 100 } },
    { name: 'nature', config: { desired_nature: 'adamant' }, missing: { nature: undefined }, known: { nature: 'modest' } },
]) {
    test(`cleanup waits for configured ${incomplete.name} data before discarding`, () => {
        const { engine, socket } = setup({ protect_last_copy: false, ...incomplete.config });
        socket.message({ t: 'team', d: { creatures: [mon('incomplete', incomplete.missing)] } });
        engine.command('manual-action', { action: 'cleanup-box' });
        assert.deepEqual(releases(socket), [], 'missing criteria do not prove the creature fails them');
        socket.message({ t: 'collection:patch', d: { mons: [{ id: 'incomplete', ...incomplete.known }] } });
        assert.deepEqual(releases(socket), ['incomplete'], 'known failing criteria permit a release');
    });

    test(`NPC donation waits for configured ${incomplete.name} data`, () => {
        const { socket } = setup({ protect_last_copy: false, auto_npc_quests: true, ...incomplete.config });
        socket.message({ t: 'team', d: { creatures: [mon('incomplete', incomplete.missing)] } });
        socket.message({ t: 'dexquest:state', d: { questId: 'incomplete-donation', target: { speciesId: 11, have: 1 } } });
        assert.equal(socket.sent.filter(packet => packet.t === 'dexquest:deliver').length, 0);
    });
}

test('a collection patch preceding battle end waits for capture evaluation before release or donation', () => {
    const { engine, socket } = setup({ discard_iv_pct: 95, protect_last_copy: false, auto_lock_valuable: true, auto_npc_quests: true });
    socket.message({ t: 'battle:start', d: { ownerId: 'audit-trainer', battleId: 'capture-order', foe: { speciesId: 11, name: 'Metapod' } } });
    socket.message({ t: 'collection:patch', d: { mons: [mon('caught-early', {
        nature: 'relaxed', ivs: { hp: 25, atk: 25, def: 25, spa: 25, spd: 25, spe: 25 },
    })] } });
    engine.command('manual-action', { action: 'cleanup-box' });
    socket.message({ t: 'dexquest:state', d: { questId: 'early-donation', target: { speciesId: 11, have: 1 } } });
    assert.deepEqual(releases(socket), [], 'the collection update alone must not bypass capture protection');
    assert.equal(socket.sent.filter(packet => packet.t === 'dexquest:deliver').length, 0);
    socket.message({ t: 'battle:end', d: { battleId: 'capture-order', result: 'capture', caught: { speciesId: 11, id: 'caught-early' } } });
    assert.deepEqual(releases(socket), []);
    assert.equal(socket.sent.filter(packet => packet.t === 'creature:lock' && packet.d.creatureId === 'caught-early').length, 1);
});

test('capture waits for a delayed quality patch and then auto-locks a qualifying creature', () => {
    const { engine, socket } = setup({ discard_iv_pct: 80, min_quality: 'great', protect_last_copy: false, auto_lock_valuable: true });
    socket.message({ t: 'battle:start', d: { ownerId: 'audit-trainer', battleId: 'capture-quality', foe: { speciesId: 11, name: 'Metapod' } } });
    socket.message({ t: 'battle:end', d: { battleId: 'capture-quality', result: 'capture', caught: { speciesId: 11, id: 'late-quality' } } });
    socket.message({ t: 'team', d: { creatures: [mon('late-quality', { ivs: { hp: 30, atk: 30, def: 30, spa: 30, spd: 30, spe: 30 } })] } });
    engine.command('manual-action', { action: 'cleanup-box' });
    assert.deepEqual(releases(socket), []);
    socket.message({ t: 'collection:patch', d: { mons: [{ id: 'late-quality', quality: 995 }] } });
    assert.deepEqual(releases(socket), []);
    assert.equal(socket.sent.filter(packet => packet.t === 'creature:lock' && packet.d.creatureId === 'late-quality').length, 1);
});

test('cleanup with no filters remains a no-op even with missing optional criteria', () => {
    const { engine, socket } = setup({ protect_last_copy: false });
    socket.message({ t: 'team', d: { creatures: [mon('unfiltered', { nature: undefined })] } });
    engine.command('manual-action', { action: 'cleanup-box' });
    assert.deepEqual(releases(socket), []);
});
