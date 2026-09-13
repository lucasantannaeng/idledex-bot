const test = require('node:test');
const assert = require('node:assert/strict');
const { createEngine } = require('./engine-harness.cjs');

function trip() {
    const engine = createEngine();
    const socket = engine.socket(); socket.open();
    engine.configure({ enabled: true, auto_idle: false, auto_heal_center: false });
    socket.message({ t: 'map:change', d: { map: 'route_006', x: 1, y: 1 } });
    socket.message({ t: 'team', d: { creatures: Array.from({ length: 6 }, (_, i) => ({
        id: `box-${i}`, speciesId: 'pidgey', teamSlot: null, boxSlot: i,
        ivs: { hp: 1, atk: 1, def: 1, spa: 1, spd: 1, spe: 1 },
    })) } });
    engine.command('manual-action', { action: 'trigger-auto-travel' });
    socket.message({ t: 'map:change', d: { map: 'npclab', x: 1, y: 1 } });
    return { engine, socket, travels: () => socket.sent.filter(p => p.t === 'map:travel') };
}

test('lab waits for professor response and confirmed delivery before returning', () => {
    const { engine, socket, travels } = trip();
    engine.advance(5000);
    assert.deepEqual(travels().map(p => p.d.mapId), ['npclab']);
    const state = { charges: 10, lotSize: 5, lots: [{ speciesId: 'pidgey', available: 6 }] };
    socket.message({ t: 'professor:state', d: state });
    socket.message({ t: 'professor:state', d: state });
    assert.equal(socket.sent.filter(p => p.t === 'professor:deliver').length, 1);
    assert.equal(travels().length, 1);
    socket.message({ t: 'professor:state', d: { charges: 5, lotSize: 5, lots: [{ speciesId: 'pidgey', available: 1 }] } });
    assert.equal(travels().at(-1).d.mapId, 'route_006');
});

test('no professor charges returns immediately without a fake delivery', () => {
    const { socket, travels } = trip();
    socket.message({ t: 'professor:state', d: { charges: 0, lotSize: 5, lots: [{ speciesId: 'pidgey', available: 6 }] } });
    assert.equal(socket.sent.filter(p => p.t === 'professor:deliver').length, 0);
    assert.equal(travels().at(-1).d.mapId, 'route_006');
});

test('lab timeout requests return instead of abandoning travel in the lab', () => {
    const { engine, travels } = trip();
    engine.advance(26000);
    assert.equal(travels().at(-1).d.mapId, 'route_006');
    engine.publish();
    assert.equal(engine.state().autoTravel.phase, 'returning');
});

test('resuming inside the lab restores delivery flow and never presses movement keys', () => {
    const { engine, socket, travels } = trip();
    let steps = 0;
    engine.onKeyDown(() => steps++);
    engine.command('toggle-bot', { enabled: false });
    engine.command('toggle-bot', { enabled: true });
    engine.advance(5000);
    engine.publish();
    assert.equal(engine.state().autoTravel.phase, 'delivering');
    assert.equal(steps, 0);
    socket.message({ t: 'professor:state', d: { charges: 0, lotSize: 5, lots: [] } });
    assert.equal(travels().at(-1).d.mapId, 'route_006');
    socket.message({ t: 'map:change', d: { map: 'route_006', x: 1, y: 1 } });
    assert.equal(engine.state().autoTravel.active, false);
});

test('unconfirmed return retries are bounded and pause without hunting in the lab', () => {
    const { engine } = trip();
    let steps = 0;
    engine.onKeyDown(() => steps++);
    engine.advance(60000);
    assert.equal(engine.state().config.enabled, false);
    assert.equal(steps, 0);
});

test('shard reconnect into lab restores delivery and returns to the welcome origin route', () => {
    const engine = createEngine();
    const routeSocket = engine.socket(); routeSocket.open();
    engine.configure({ enabled: true, auto_idle: false, auto_heal_center: false });
    routeSocket.message({ t: 'welcome', d: { playerId: 'player', map: 'route_014', x: 1, y: 1 } });
    routeSocket.close();
    const labSocket = engine.socket(); labSocket.open();
    labSocket.message({ t: 'welcome', d: { playerId: 'player', map: 'npclab', x: 1, y: 1 } });
    let steps = 0;
    engine.onKeyDown(() => steps++);
    engine.advance(4000);
    engine.publish();
    assert.equal(engine.state().autoTravel.phase, 'delivering');
    labSocket.message({ t: 'professor:state', d: { charges: 0, lotSize: 5, lots: [] } });
    assert.equal(labSocket.sent.find(p => p.t === 'map:travel').d.mapId, 'route_014');
    assert.equal(steps, 0);
    labSocket.close();
    const returned = engine.socket(); returned.open();
    returned.message({ t: 'welcome', d: { playerId: 'player', map: 'route_014', x: 1, y: 1 } });
    assert.equal(engine.state().autoTravel.active, false);
});

test('a walkable lab never triggers hunting, even without a pending trip', async () => {
    const engine = createEngine(async () => ({ ok: true, json: async () => ({ cols: 3, rows: 3, grid: Array(9).fill(1) }) }));
    const socket = engine.socket(); socket.open();
    engine.configure({ enabled: true, auto_roam: true, auto_npc_quests: false, auto_travel_deliveries: false });
    let steps = 0;
    engine.onKeyDown(() => steps++);
    socket.message({ t: 'welcome', d: { playerId: 'player', map: 'npclab', snapshot: { entities: [{ id: 'player', x: 1, y: 1 }] } } });
    await new Promise(setImmediate);
    engine.advance(10000);
    assert.equal(steps, 0);
});
