const test = require('node:test');
const assert = require('node:assert/strict');
const { createEngine } = require('./engine-harness.cjs');

test('T16: route switch triggers map:travel to next route when all target species are caught', () => {
    const engine = createEngine();
    const socket = engine.socket();
    socket.open();
    engine.configure({
        enabled: true,
        auto_idle: false,
        auto_roam: true,
        auto_route_switch: true,
        target_mode: 'all',
        pinned_species: null
    });

    socket.message({ t: 'welcome', d: { playerId: 'player-1', map: 'route_001' } });
    socket.message({
        t: 'map:preview',
        d: {
            mapId: 'route_001',
            species: [
                { speciesId: 'pidgey', name: 'Pidgey', caught: true },
                { speciesId: 'rattata', name: 'Rattata', caught: true }
            ]
        }
    });

    engine.advance(4000);
    const travels = socket.sent.filter(p => p.t === 'map:travel');
    assert.equal(travels.length, 1);
    assert.equal(travels[0].d.mapId, 'route_002');

    engine.publish();
    const state = engine.state();
    assert.equal(state.routeSwitch.active, true);
    assert.equal(state.routeSwitch.targetRoute, 'route_002');
});

test('T16: pinned species prevents route switch even if all target species are caught', () => {
    const engine = createEngine();
    const socket = engine.socket();
    socket.open();
    engine.configure({
        enabled: true,
        auto_idle: false,
        auto_roam: true,
        auto_route_switch: true,
        target_mode: 'all',
        pinned_species: 'pikachu'
    });

    socket.message({ t: 'welcome', d: { playerId: 'player-1', map: 'route_001' } });
    socket.message({
        t: 'map:preview',
        d: {
            mapId: 'route_001',
            species: [
                { speciesId: 'pidgey', name: 'Pidgey', caught: true },
                { speciesId: 'pikachu', name: 'Pikachu', caught: true }
            ]
        }
    });

    engine.advance(4000);
    const travels = socket.sent.filter(p => p.t === 'map:travel');
    assert.equal(travels.length, 0);

    engine.publish();
    assert.equal(engine.state().routeSwitch.active, false);
});

test('T16: server travel error aborts routeSwitchState and resumes roam on original map', () => {
    const engine = createEngine();
    const socket = engine.socket();
    socket.open();
    engine.configure({
        enabled: true,
        auto_idle: false,
        auto_roam: true,
        auto_route_switch: true,
        target_mode: 'all'
    });

    socket.message({ t: 'welcome', d: { playerId: 'player-1', map: 'route_001' } });
    socket.message({
        t: 'map:preview',
        d: {
            mapId: 'route_001',
            species: [{ speciesId: 'pidgey', name: 'Pidgey', caught: true }]
        }
    });

    engine.advance(4000);
    engine.publish();
    assert.equal(engine.state().routeSwitch.active, true);

    socket.message({ t: 'error', d: { code: 'travel_forbidden' } });
    engine.publish();
    assert.equal(engine.state().routeSwitch.active, false);
    assert.equal(engine.state().routeSwitch.targetRoute, null);
    assert.equal(engine.state().currentMap, 'route_001');
});

test('T16: arrival at target route confirms destination and clears switch state', () => {
    const engine = createEngine();
    const socket = engine.socket();
    socket.open();
    engine.configure({
        enabled: true,
        auto_idle: false,
        auto_roam: true,
        auto_route_switch: true,
        target_mode: 'all'
    });

    socket.message({ t: 'welcome', d: { playerId: 'player-1', map: 'route_001' } });
    socket.message({
        t: 'map:preview',
        d: {
            mapId: 'route_001',
            species: [{ speciesId: 'pidgey', name: 'Pidgey', caught: true }]
        }
    });

    engine.advance(4000);
    engine.publish();
    assert.equal(engine.state().routeSwitch.active, true);

    socket.message({ t: 'map:change', d: { map: 'route_002', x: 10, y: 10 } });
    engine.publish();
    assert.equal(engine.state().routeSwitch.active, false);
    assert.equal(engine.state().currentMap, 'route_002');
});

test('T16: watchdog timeout (15s) aborts route switch and resumes roam on original map', () => {
    const engine = createEngine();
    const socket = engine.socket();
    socket.open();
    engine.configure({
        enabled: true,
        auto_idle: false,
        auto_roam: true,
        auto_route_switch: true,
        target_mode: 'all'
    });

    socket.message({ t: 'welcome', d: { playerId: 'player-1', map: 'route_001' } });
    socket.message({
        t: 'map:preview',
        d: {
            mapId: 'route_001',
            species: [{ speciesId: 'pidgey', name: 'Pidgey', caught: true }]
        }
    });

    engine.advance(4000);
    engine.publish();
    assert.equal(engine.state().routeSwitch.active, true);

    // Advance past 15s timeout
    engine.advance(16000);
    engine.publish();
    assert.equal(engine.state().routeSwitch.active, false);
    assert.equal(engine.state().routeSwitch.targetRoute, null);
    assert.equal(engine.state().currentMap, 'route_001');
});

test('T16: mutual exclusion between auto-travel to lab and route switch', () => {
    const engine = createEngine();
    const socket = engine.socket();
    socket.open();
    engine.configure({
        enabled: true,
        auto_idle: false,
        auto_travel_deliveries: true,
        auto_npc_quests: true,
        auto_route_switch: true,
        target_mode: 'all'
    });

    socket.message({ t: 'welcome', d: { playerId: 'player-1', map: 'route_001' } });
    socket.message({
        t: 'team',
        d: {
            creatures: Array.from({ length: 7 }, (_, i) => ({
                id: 'box-' + i,
                speciesId: 'pidgey',
                teamSlot: null,
                boxSlot: i,
                ivs: { hp: 1, atk: 1, def: 1, spa: 1, spd: 1, spe: 1 }
            }))
        }
    });

    // Trigger auto-travel to lab
    engine.command('manual-action', { action: 'trigger-auto-travel' });
    engine.publish();
    assert.equal(engine.state().autoTravel.active, true);

    // Now send map:preview with all caught - route switch should NOT trigger during lab trip
    socket.message({
        t: 'map:preview',
        d: {
            mapId: 'route_001',
            species: [{ speciesId: 'pidgey', name: 'Pidgey', caught: true }]
        }
    });
    engine.advance(4000);
    engine.publish();
    assert.equal(engine.state().routeSwitch.active, false);
});

test('T15: map collision error sets mapAvailable false and suspends movement', async () => {
    const engine = createEngine(async () => ({ ok: false, status: 404 }));
    const socket = engine.socket();
    socket.open();
    engine.configure({ enabled: true, auto_idle: false, auto_roam: true });

    let steps = 0;
    engine.onKeyDown(() => steps++);

    socket.message({ t: 'welcome', d: { playerId: 'player-1', map: 'route_999' } });
    await new Promise(setImmediate);
    await new Promise(setImmediate);
    engine.advance(2000);
    engine.publish();

    const state = engine.state();
    assert.equal(state.mapAvailable, false);
    assert.equal(state.mapStatus, 'unavailable');
    assert.equal(steps, 0);
});

test('T15: corrupted map grid sets mapAvailable false and suspends movement', async () => {
    const engine = createEngine(async () => ({
        ok: true,
        json: async () => ({ cols: 5, rows: 5, grid: [1, 2, 3] })
    }));
    const socket = engine.socket();
    socket.open();
    engine.configure({ enabled: true, auto_idle: false, auto_roam: true });

    let steps = 0;
    engine.onKeyDown(() => steps++);

    socket.message({ t: 'welcome', d: { playerId: 'player-1', map: 'route_corrupt' } });
    await new Promise(setImmediate);
    await new Promise(setImmediate);
    engine.advance(2000);
    engine.publish();

    const state = engine.state();
    assert.equal(state.mapAvailable, false);
    assert.equal(state.mapStatus, 'unavailable');
    assert.equal(steps, 0);
});
