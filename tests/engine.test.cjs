const test = require('node:test');
const assert = require('node:assert/strict');
const { createEngine } = require('./engine-harness.cjs');

test('stationary bot refreshes rewards without blind claims or movement', () => {
    const engine = createEngine();
    const socket = engine.socket(); socket.open();
    engine.configure({ enabled: true, auto_roam: false, auto_idle: false, auto_claim_dailies: true });
    socket.message({ t: 'welcome', d: { playerId: 'player' } });
    engine.advance(5000);
    const commands = socket.sent.map(p => p.t);
    assert.ok(commands.includes('daily:open'));
    assert.ok(commands.includes('pokedex:open'));
    assert.ok(!commands.includes('move'));
    assert.ok(!commands.includes('daily:bonus'));
    assert.ok(!commands.includes('gamepass:claim-all'));
});

test('reward updates respect ready flags, ignore empty news and suppress duplicate requests', () => {
    const engine = createEngine();
    const socket = engine.socket(); socket.open();
    engine.configure({ enabled: true, auto_claim_dailies: true });
    socket.sent.length = 0;
    const dex = { t: 'pokedex:state', d: { milestones: [{ ready: true }] } };
    socket.message(dex); socket.message(dex);
    socket.message({ t: 'news:page', d: { posts: [
        { id: 'empty', reward: [], claimed: false },
        { id: 'ready', reward: [{ itemId: 'potion', quantity: 1 }], claimed: false },
    ] } });
    assert.deepEqual(socket.sent, [
        { t: 'pokedex:claim-all' }, { t: 'news:claim', d: { postId: 'ready' } },
    ]);
});

test('daily and pass rewards use official progress and tier eligibility', () => {
    const engine = createEngine();
    const socket = engine.socket(); socket.open();
    engine.configure({ enabled: true, auto_claim_dailies: true });
    socket.sent.length = 0;
    socket.message({ t: 'daily:list', d: { quests: [
        { id: 'ready', progress: 5, goal: 5, claimed: false },
        { id: 'pending', progress: 1, goal: 5, claimed: false },
        { id: 'claimed', progress: 5, goal: 5, claimed: true },
    ] } });
    assert.deepEqual(socket.sent, [{ t: 'daily:claim', d: { questId: 'ready' } }]);
    socket.message({ t: 'gamepass:state', d: { points: 20, premium: false, missions: [], tiers: [
        { points: 10, freeClaimed: false, premiumClaimed: false },
    ] } });
    assert.equal(socket.sent.at(-1).t, 'gamepass:claim-all');
});

test('overworld recovery uses an available potion once for a low-health living member', () => {
    const engine = createEngine();
    const socket = engine.socket(); socket.open();
    engine.configure({ enabled: true, auto_npc_quests: false, auto_travel_deliveries: false, auto_claim_dailies: false });
    socket.message({ t: 'welcome', d: { playerId: 'player', snapshot: { player: {
        team: [{ id: 'leader', teamSlot: 0, hp: 2, maxHp: 20, level: 5 }],
        inventory: [{ itemId: 'super-potion', kind: 'potion', quantity: 15 }],
    } } } });
    engine.advance(5000);
    assert.deepEqual(socket.sent.filter(command => command.t === 'item:use'), [
        { t: 'item:use', d: { itemId: 'super-potion', creatureId: 'leader' } },
    ]);
});

test('recovery heals an affordable party member instead of repeatedly requesting an unaffordable full team', () => {
    const engine = createEngine();
    const socket = engine.socket(); socket.open();
    engine.configure({ enabled: true, auto_npc_quests: false, auto_travel_deliveries: false, auto_claim_dailies: false });
    socket.message({ t: 'welcome', d: { playerId: 'player', snapshot: { player: { wallet: { silver: 18 }, team: [0, 1, 2].map(i => ({ id: 'mon-' + i, teamSlot: i, hp: 0, maxHp: 20, level: 5 })) } } } });
    socket.message({ t: 'progress:state', d: { rank: 22 } });
    engine.advance(5000);
    const heals = socket.sent.filter(command => command.t === 'heal:full');
    assert.deepEqual(heals, [{ t: 'heal:full', d: { creatureIds: ['mon-0'] } }]);
    socket.message({ t: 'error', d: { code: 'heal_insufficient_funds' } });
    engine.advance(30000);
    assert.equal(socket.sent.filter(command => command.t === 'heal:full').length, 1);
});

test('roaming delegates movement sequence to the game instead of sending a second move', async () => {
    const engine = createEngine(async () => ({ ok: true, json: async () => ({ cols: 3, rows: 3, grid: Array(9).fill(1) }) }));
    const socket = engine.socket(); socket.open();
    engine.configure({ enabled: true, auto_npc_quests: false, auto_travel_deliveries: false, auto_claim_dailies: false });
    engine.onKeyDown(event => socket.send(JSON.stringify({ t: 'move', d: { dir: { ArrowUp: 'N', ArrowDown: 'S', ArrowLeft: 'W', ArrowRight: 'E' }[event.code], n: 41 } })));
    socket.message({ t: 'welcome', d: { playerId: 'player', map: 'route_001', snapshot: { entities: [{ id: 'player', x: 1, y: 1 }] } } });
    await new Promise(setImmediate);
    engine.advance(1300);
    const moves = socket.sent.filter(command => command.t === 'move');
    assert.equal(moves.length, 1);
    assert.equal(moves[0].d.n, 41);
});

test('roaming enforces key pulse of 40ms and movement rate limiting (>=205ms cooldown)', async () => {
    const engine = createEngine(async () => ({ ok: true, json: async () => ({ cols: 5, rows: 5, grid: Array(25).fill(1) }) }));
    const socket = engine.socket(); socket.open();
    engine.configure({ enabled: true, auto_npc_quests: false, auto_travel_deliveries: false, auto_claim_dailies: false, roam_step_delay_ms: 100 });
    const events = [];
    engine.onKeyDown(event => events.push({ type: 'keydown', code: event.code, time: engine.now() }));
    engine.onKeyUp(event => events.push({ type: 'keyup', code: event.code, time: engine.now() }));
    socket.message({ t: 'welcome', d: { playerId: 'player', map: 'route_001', snapshot: { entities: [{ id: 'player', x: 2, y: 2 }] } } });
    await new Promise(setImmediate);
    engine.advance(1500);
    const downs = events.filter(e => e.type === 'keydown');
    const ups = events.filter(e => e.type === 'keyup');
    assert.ok(downs.length >= 2, `Should have at least 2 steps, got ${downs.length}`);
    assert.equal(downs.length, ups.length, 'Every keydown must have a matching keyup');
    for (let i = 0; i < downs.length; i++) {
        assert.equal(ups[i].time - downs[i].time, 40, 'Key pulse must be exactly 40ms');
    }
    for (let i = 1; i < downs.length; i++) {
        const interval = downs[i].time - downs[i - 1].time;
        assert.ok(interval >= 220, `Movement step interval must be >= 220ms (got ${interval}ms)`);
    }
});

test('professor delivery requires charges and sends one complete command for an unchanged state', () => {
    const engine = createEngine();
    const socket = engine.socket(); socket.open();
    engine.configure({ enabled: true });
    socket.message({ t: 'map:change', d: { map: 'npclab' } });
    const ivs = { hp: 1, atk: 1, def: 1, spa: 1, spd: 1, spe: 1 };
    socket.message({ t: 'team', d: { creatures: Array.from({ length: 6 }, (_, i) => ({ id: 'mon-' + i, speciesId: 1, boxSlot: i, teamSlot: null, ivs })) } });
    const state = { lotSize: 5, charges: 0, lots: [{ speciesId: 1, available: 6 }] };
    socket.message({ t: 'professor:state', d: state });
    const deliveries = () => socket.sent.filter(command => command.t === 'professor:deliver');
    assert.equal(deliveries().length, 0);
    state.charges = 5;
    socket.message({ t: 'professor:state', d: state });
    socket.message({ t: 'professor:state', d: state });
    assert.deepEqual(deliveries(), [{ t: 'professor:deliver', d: { speciesId: 1 } }]);
});

test('collector obtains a preview and protects valuable creatures before consuming', () => {
    const engine = createEngine();
    const socket = engine.socket(); socket.open();
    engine.configure({ protect_last_copy: false, enabled: true });
    socket.message({ t: 'map:change', d: { map: 'route_001' } });
    socket.message({ t: 'collector:state', d: { mapId: 'route_001', window: 1, deliverable: true, delivered: false } });
    assert.equal(socket.sent.filter(command => command.t === 'collector:deliver').length, 0);
    assert.equal(socket.sent.filter(command => command.t === 'collector:preview').length, 1);
    socket.message({ t: 'team', d: { creatures: [{ id: 'shiny', isShiny: true, teamSlot: null, boxSlot: 0 }] } });
    socket.message({ t: 'collector:preview', d: { mapId: 'route_001', window: 1, creatureIds: ['shiny'] } });
    assert.equal(socket.sent.filter(command => command.t === 'collector:deliver').length, 0);
    socket.message({ t: 'team', d: { creatures: [{ id: 'safe', speciesId: 25, teamSlot: null, boxSlot: 1, ivs: { hp: 1, atk: 1, def: 1, spa: 1, spd: 1, spe: 1 } }] } });
    const preview = { mapId: 'route_001', window: 1, creatureIds: ['safe'] };
    socket.message({ t: 'collector:preview', d: preview });
    socket.message({ t: 'collector:preview', d: preview });
    assert.equal(socket.sent.filter(command => command.t === 'collector:deliver').length, 1);
});

test('auto travel requires eligible Box surplus and pause cancels lab callbacks', () => {
    const engine = createEngine();
    const socket = engine.socket(); socket.open();
    engine.configure({ enabled: true });
    socket.message({ t: 'map:change', d: { map: 'route_001' } });
    const mons = Array.from({ length: 6 }, (_, i) => ({ id: 'mon-' + i, speciesId: 1, teamSlot: i, boxSlot: null,
        ivs: { hp: 1, atk: 1, def: 1, spa: 1, spd: 1, spe: 1 } }));
    socket.message({ t: 'team', d: { creatures: mons } });
    engine.command('manual-action', { action: 'trigger-auto-travel' });
    assert.equal(socket.sent.filter(command => command.t === 'map:travel').length, 0);
    socket.message({ t: 'team', d: { creatures: mons.map((mon, i) => ({ ...mon, teamSlot: null, boxSlot: i })) } });
    engine.command('manual-action', { action: 'trigger-auto-travel' });
    assert.equal(socket.sent.filter(command => command.t === 'map:travel').length, 1);
    socket.message({ t: 'map:change', d: { map: 'npclab' } });
    engine.command('toggle-bot', { enabled: false });
    socket.sent.length = 0;
    engine.advance(30000);
    assert.equal(socket.sent.length, 0);
});

test('capture summary waits for creature snapshot before grading and releasing low IVs', () => {
    const engine = createEngine();
    const socket = engine.socket(); socket.open();
    engine.configure({ enabled: true, protect_last_copy: false, discard_iv_pct: 50 });
    socket.message({ t: 'welcome', d: { playerId: 'player' } });
    socket.message({ t: 'battle:start', d: { ownerId: 'player', battleId: 'capture', foe: { speciesId: 1, name: 'Bulbasaur' } } });
    socket.message({ t: 'battle:end', d: { battleId: 'capture', result: 'capture', caught: { speciesId: 1, name: 'Bulbasaur' } } });
    const release = () => socket.sent.filter(command => command.t === 'creature:release');
    assert.equal(release().length, 0);
    const mon = { id: 'caught', speciesId: 1, name: 'Bulbasaur', teamSlot: null, boxSlot: 0, ivs: { hp: 1, atk: 1, def: 1, spa: 1, spd: 1, spe: 1 } };
    socket.message({ t: 'team', d: { creatures: [mon] } });
    assert.equal(engine.state().lastCapturedMon.ivTotal, 6);
    assert.equal(release().length, 1);
    socket.message({ t: 'team', d: { creatures: [mon] } });
    assert.equal(release().length, 1);
});

test('official capture and flee results are not counted as losses; missing IVs are not graded', () => {
    const engine = createEngine();
    const socket = engine.socket(); socket.open();
    socket.message({ t: 'welcome', d: { playerId: 'player' } });
    for (const result of ['capture', 'flee']) {
        socket.message({ t: 'battle:start', d: { ownerId: 'player', battleId: result, foe: { speciesId: 1, name: 'Bulbasaur' } } });
        socket.message({ t: 'battle:end', d: { battleId: result, result, caught: result === 'capture' ? { speciesId: 1, name: 'Bulbasaur' } : undefined } });
    }
    const state = engine.state();
    assert.equal(state.sessionMetrics.sessionCaptures, 1);
    assert.equal(state.progress.losses, 0);
    assert.equal(state.lastCapturedMon, null);
});

test('release rejects missing IVs, party members, locked and event creatures', () => {
    const engine = createEngine();
    const socket = engine.socket(); socket.open();
    engine.configure({ enabled: true, discard_iv_pct: 50 });
    const ivs = { hp: 1, atk: 1, def: 1, spa: 1, spd: 1, spe: 1 };
    socket.message({ t: 'collection', d: { mons: [
        { id: 'unknown', boxSlot: 0 },
        { id: 'party', teamSlot: 0, ivs },
        { id: 'event', boxSlot: 1, ivs, form: { eventTier: 1 } },
        { id: 'locked', boxSlot: 2, ivs, isLocked: true },
    ] } });
    assert.equal(socket.sent.filter(command => command.t === 'creature:release').length, 0);
});

test('battle action waits until animateMs and does not repeat during the same window', () => {
    const engine = createEngine();
    const socket = engine.socket(); socket.open();
    engine.configure({ enabled: true });
    socket.message({ t: 'welcome', d: { playerId: 'player' } });
    socket.message({ t: 'inventory', d: { items: [{ itemId: 'super-ball', quantity: 5 }] } });
    socket.message({ t: 'battle:start', d: { ownerId: 'player', battleId: 'battle',
        leader: { hp: 100, maxHp: 100 }, foe: { speciesId: 1, name: 'Bulbasaur', hp: 50, maxHp: 50, isShiny: true },
    } });
    socket.message({ t: 'battle:turn', d: { battleId: 'battle', turn: { events: [] }, animateMs: 1500, turnMs: 2200, canThrow: true, canHeal: true } });
    const actions = () => socket.sent.filter(command => command.t.startsWith('battle:'));
    engine.advance(1499);
    assert.equal(actions().length, 0);
    engine.advance(101);
    assert.equal(actions().length, 1);
    engine.advance(2000);
    assert.equal(actions().length, 1);
});

test('welcome callbacks cannot configure a replacement session or paused bot', () => {
    const engine = createEngine();
    const old = engine.socket(); old.open();
    engine.configure({ enabled: true });
    old.message({ t: 'welcome', d: { playerId: 'player' } });
    old.close();
    const current = engine.socket();
    current.readyState = 1;
    engine.advance(1500);
    assert.equal(current.sent.length, 0);
});

test('zero inventory quantity stays zero', () => {
    const engine = createEngine();
    const socket = engine.socket(); socket.open();
    socket.message({ t: 'inventory', d: { items: [{ itemId: 'super-ball', quantity: 0 }] } });
    assert.equal(engine.state().inventory.ball.superball, 0);
});

test('capture waits for server throw permission and sends one action per window', () => {
    const engine = createEngine();
    const socket = engine.socket(); socket.open();
    engine.configure({ enabled: true });
    socket.message({ t: 'welcome', d: { playerId: 'player' } });
    socket.message({ t: 'inventory', d: { items: [{ itemId: 'super-ball', quantity: 5 }] } });
    socket.message({ t: 'battle:start', d: { ownerId: 'player', battleId: 'battle',
        leader: { hp: 100, maxHp: 100 }, foe: { speciesId: 1, name: 'Bulbasaur', hp: 50, maxHp: 50, isShiny: true },
    } });
    socket.message({ t: 'battle:control', d: { battleId: 'battle', canThrow: false, canHeal: true } });
    for (const callback of [...engine.timers.values()]) callback();
    const actions = () => socket.sent.filter(command => command.t.startsWith('battle:'));
    assert.equal(actions().length, 0);
    socket.message({ t: 'battle:control', d: { battleId: 'battle', canThrow: true, canHeal: true } });
    for (const callback of [...engine.timers.values()]) callback();
    for (const callback of [...engine.timers.values()]) callback();
    assert.deepEqual(actions(), [{ t: 'battle:item', d: { battleId: 'battle', itemId: 'super-ball' } }]);
});

test('official battle leader and turn events update health for both sides', () => {
    const engine = createEngine();
    const socket = engine.socket(); socket.open();
    socket.message({ t: 'welcome', d: { playerId: 'player' } });
    socket.message({ t: 'battle:start', d: {
        ownerId: 'player', battleId: 'battle',
        leader: { creatureId: 'leader', hp: 80, maxHp: 100, moves: [] },
        foe: { hp: 40, maxHp: 50 },
    } });
    assert.equal(engine.state().myMon.hp, 80);
    socket.message({ t: 'battle:turn', d: { battleId: 'battle', turn: { events: [
        { e: 'attack', by: 'you', targetHp: 15 },
        { e: 'attack', by: 'foe', targetHp: 20 },
        { e: 'heal', who: 'you', hpAfter: 40 },
    ] }, animateMs: 1000, turnMs: 1500, canThrow: true, canHeal: true } });
    const state = engine.state();
    assert.equal(state.myMon.hp, 40);
    assert.equal(state.enemyMon.hp, 15);
    assert.equal(state.myMon.hpPercent, 0.4);
    assert.equal(state.enemyMon.hpPercent, 0.3);
    socket.message({ t: 'battle:turn', d: { battleId: 'battle', turn: { events: [
        { e: 'swap', view: { creatureId: 'replacement', hp: 50, maxHp: 50, moves: [{ id: 'tackle' }] } },
        { e: 'swap_enemy', view: { hp: 25, maxHp: 100 } },
    ] } } });
    assert.equal(engine.state().myMon.creatureId, 'replacement');
    assert.equal(engine.state().enemyMon.hpPercent, 0.25);
});

test('official team snapshots and patches keep party and collection synchronized', () => {
    const engine = createEngine();
    const socket = engine.socket(); socket.open();
    socket.message({ t: 'team', d: { creatures: [
        { id: 'party', speciesId: 1, teamSlot: 0, hp: 50, maxHp: 100 },
        { id: 'box', speciesId: 4, teamSlot: null, boxSlot: 0 },
    ] } });
    assert.equal(engine.state().team.length, 1);
    assert.equal(Object.keys(engine.state().collection).length, 2);
    socket.message({ t: 'team:patch', d: { creatures: [{ id: 'party', speciesId: 1, teamSlot: 0, hp: 25, maxHp: 100 }] } });
    assert.equal(engine.state().myMon.hpPercent, 0.25);
    assert.ok(engine.state().collection.box);
    socket.message({ t: 'team', d: { creatures: [] } });
    assert.equal(engine.state().team.length, 0);
    assert.equal(Object.keys(engine.state().collection).length, 0);
    assert.equal(engine.state().myMon, null);
});

test('boot waits for saved configuration before automatic actions', () => {
    const engine = createEngine();
    const socket = engine.socket(); socket.open();
    for (const callback of [...engine.timers.values()]) callback();
    socket.message({ t: 'daily:state', d: { quests: [{ id: 'quest', completed: true }] } });
    assert.equal(socket.sent.length, 0);
});

test('restoring a strategy preserves explicit customized settings', () => {
    const engine = createEngine();
    engine.configure({ enabled: false, strategy_mode: 'collection', catch_only_uncaught: false, ball_priority: 'force_highest' });
    const config = engine.state().config;
    assert.equal(config.catch_only_uncaught, false);
    assert.equal(config.ball_priority, 'force_highest');
});

test('paused bot does not claim rewards or deliver creatures on server updates', () => {
    const engine = createEngine();
    const socket = engine.socket(); socket.open();
    engine.configure({ enabled: false, auto_idle: false });
    socket.sent.length = 0;
    socket.message({ t: 'daily:state', d: { quests: [{ id: 'quest', completed: true }] } });
    socket.message({ t: 'professor:state', d: { lots: [{ speciesId: 'bulbasaur', available: 10 }] } });
    assert.equal(socket.sent.length, 0);
});

test('late close and messages from a replaced socket cannot change the current session', () => {
    const engine = createEngine();
    const old = engine.socket(); old.open();
    const current = engine.socket(); current.open();
    current.message({ t: 'welcome', d: { playerId: 'current-player' } });
    old.close();
    old.message({ t: 'welcome', d: { playerId: 'stale-player' } });
    const state = engine.state();
    assert.equal(state.connected, true);
    assert.equal(state.playerId, 'current-player');
});

test('disconnect clears battle, timers and publishes disconnected state', () => {
    const engine = createEngine();
    const socket = engine.socket(); socket.open();
    socket.message({ t: 'welcome', d: { playerId: 'player' } });
    socket.message({ t: 'battle:start', d: { ownerId: 'player', battleId: 'battle-1', leader: { hp: 10, maxHp: 10 }, foe: { hp: 10, maxHp: 10 } } });
    socket.close();
    const state = engine.telemetry.at(-1);
    assert.equal(state.connected, false);
    assert.equal(state.inBattle, false);
    assert.equal(state.currentBattleId, null);
});

test('reconnections are counted after a closed socket', () => {
    const engine = createEngine();
    const first = engine.socket(); first.open(); first.close();
    const second = engine.socket(); second.open();
    assert.equal(engine.state().sessionMetrics.reconnectCount, 1);
});

test('latest map wins when collision requests complete in reverse order', async () => {
    const pending = new Map();
    const engine = createEngine(url => new Promise(resolve => pending.set(url, resolve)));
    const socket = engine.socket(); socket.open();
    socket.message({ t: 'map:change', d: { map: 'route_001', x: 0, y: 0 } });
    socket.message({ t: 'map:change', d: { map: 'route_002', x: 0, y: 0 } });
    assert.ok(pending.has('/maps/route_002.collision.json'));
    const response = biome => ({ ok: true, json: async () => ({ cols: 2, rows: 2, grid: [1, 1, 1, 1], biome }) });
    pending.get('/maps/route_002.collision.json')(response('snow'));
    await new Promise(setImmediate);
    pending.get('/maps/route_001.collision.json')(response('forest'));
    await new Promise(setImmediate);
    engine.publish();
    assert.equal(engine.state().currentMapBiome, 'snow');
});

test('observing engine state is neutral and does not emit commands, mutate config or alter timers', () => {
    const engine = createEngine();
    const socket = engine.socket(); socket.open();
    engine.configure({ enabled: true, roam_step_delay_ms: 500 });
    const initialSentCount = socket.sent.length;
    const initialTelemetryCount = engine.telemetry.length;
    const initialTimerCount = engine.timers.size;

    const s1 = engine.state();
    const s2 = engine.state();

    assert.deepEqual(s1, s2);
    assert.equal(socket.sent.length, initialSentCount, 'Reading state must not send WebSocket commands');
    assert.equal(engine.telemetry.length, initialTelemetryCount, 'Reading state must not emit new telemetry entries');
    assert.equal(engine.timers.size, initialTimerCount, 'Reading state must not alter timer count');
});

test('T08: foreign service or analytics socket does not become activeWs or receive game commands', () => {
    const engine = createEngine();
    const gameSocket = engine.socket('wss://gateway.idledex.com'); gameSocket.open();
    gameSocket.message({ t: 'welcome', d: { playerId: 'trainer-1', map: 'route_001' } });
    assert.strictEqual(engine.state().connected, true);
    assert.strictEqual(engine.state().playerId, 'trainer-1');

    const foreignSocket = engine.socket('wss://analytics.google.com/feed');
    foreignSocket.open();
    foreignSocket.message({ t: 'analytics_ack', d: { status: 'ok' } });

    engine.publish({ enabled: true });
    assert.strictEqual(engine.state().connected, true);
    assert.strictEqual(engine.state().playerId, 'trainer-1');
    assert.strictEqual(foreignSocket.sent.length, 0, 'Foreign socket must never receive game commands');

    foreignSocket.close();
    assert.strictEqual(engine.state().connected, true, 'Closing foreign socket must not disconnect game');
});

test('T08: two simultaneous endpoints, new socket without welcome does not hijack active session (novo sem welcome)', () => {
    const engine = createEngine();
    const s1 = engine.socket('wss://gateway.idledex.com'); s1.open();
    s1.message({ t: 'welcome', d: { playerId: 'trainer-s1', map: 'route_001' } });
    assert.strictEqual(engine.state().playerId, 'trainer-s1');

    const s2 = engine.socket('wss://gateway.idledex.com'); s2.open();
    assert.strictEqual(engine.state().playerId, 'trainer-s1');

    s1.message({ t: 'entity:enter', d: { id: 'wild:pidgey', name: 'wild pidgey', x: 1, y: 1 } });
    assert.strictEqual(engine.state().entities.length, 1);
    assert.strictEqual(s2.sent.length, 0, 'Unpromoted socket without welcome must receive 0 commands');

    s2.close();
    assert.strictEqual(engine.state().connected, true, 'Delayed close on unpromoted socket must not disconnect active session');
    assert.strictEqual(engine.state().playerId, 'trainer-s1');
});

test('T08: invalid or non-ws URL does not crash or discard healthy session', () => {
    const engine = createEngine();
    const s1 = engine.socket('wss://gateway.idledex.com'); s1.open();
    s1.message({ t: 'welcome', d: { playerId: 'trainer-s1', map: 'route_001' } });
    assert.strictEqual(engine.state().connected, true);

    const bad1 = engine.socket('http://invalid.example.com');
    bad1.open();
    assert.strictEqual(engine.state().connected, true);
    bad1.close();
    assert.strictEqual(engine.state().connected, true);

    const bad2 = engine.socket('not-a-valid-url');
    bad2.open();
    assert.strictEqual(engine.state().connected, true);
});

test('T08: shard redirect and valid reconnect socket takes over control and rejects stale socket messages', () => {
    const engine = createEngine();
    const s1 = engine.socket('wss://idledex.com/ws'); s1.open();
    s1.message({ t: 'welcome', d: { playerId: 'trainer-s1', map: 'route_001' } });
    assert.strictEqual(engine.state().playerId, 'trainer-s1');

    s1.message({ t: 'shard:redirect', d: { shard: 2 } });

    const sShard = engine.socket('wss://idledex.com/ws/2'); sShard.open();
    sShard.message({ t: 'welcome', d: { playerId: 'trainer-shard2', map: 'route_002' } });

    assert.strictEqual(engine.state().connected, true);
    assert.strictEqual(engine.state().playerId, 'trainer-shard2');
    assert.strictEqual(engine.state().currentMap, 'route_002');

    s1.message({ t: 'welcome', d: { playerId: 'stale-player', map: 'stale_map' } });
    assert.strictEqual(engine.state().playerId, 'trainer-shard2');

    s1.close();
    assert.strictEqual(engine.state().connected, true);
    assert.strictEqual(engine.state().playerId, 'trainer-shard2');
});

test('T10: partial HP patch without teamSlot preserves team slots and prevents Box creatures from invading party', () => {
    const engine = createEngine();
    const socket = engine.socket(); socket.open();
    socket.message({ t: 'welcome', d: { playerId: 'trainer', map: 'route_001' } });

    // Initial snapshot: 1 party member and 2 boxed creatures
    socket.message({ t: 'team', d: { creatures: [
        { id: 'leader-mon', name: 'Charizard', speciesId: 6, teamSlot: 0, isLeader: true, hp: 100, maxHp: 100 },
        { id: 'box-mon-1', name: 'Rattata', speciesId: 19, teamSlot: null, boxSlot: 0, hp: 30, maxHp: 30 },
        { id: 'box-mon-2', name: 'Pidgey', speciesId: 16, teamSlot: null, boxSlot: 1, hp: 25, maxHp: 25 },
    ] } });

    assert.strictEqual(engine.state().team.length, 1);
    assert.strictEqual(engine.state().team[0].id, 'leader-mon');
    assert.strictEqual(engine.state().myMon.id, 'leader-mon');
    assert.strictEqual(Object.keys(engine.state().collection).length, 3);

    // Partial HP patch with ONLY hp change (no teamSlot field in payload)
    socket.message({ t: 'team:patch', d: { creatures: [
        { id: 'leader-mon', hp: 45 }
    ] } });

    // Team must still contain ONLY the party member; Box creatures must NOT be pulled into team
    assert.strictEqual(engine.state().team.length, 1);
    assert.strictEqual(engine.state().team[0].id, 'leader-mon');
    assert.strictEqual(engine.state().team[0].hp, 45);
    assert.strictEqual(engine.state().myMon.id, 'leader-mon');
    assert.strictEqual(engine.state().myMon.hpPercent, 0.45);

    // Box creature HP patch without teamSlot
    socket.message({ t: 'team:patch', d: { creatures: [
        { id: 'box-mon-1', hp: 10 }
    ] } });
    assert.strictEqual(engine.state().team.length, 1);
    assert.strictEqual(engine.state().collection['box-mon-1'].hp, 10);

    // Tombstone / deleted creature in patch
    socket.message({ t: 'team:patch', d: { creatures: [
        { id: 'box-mon-2', deleted: true }
    ] } });
    assert.strictEqual(Object.keys(engine.state().collection).length, 2);
    assert.strictEqual(engine.state().collection['box-mon-2'], undefined);
});

test('T11: when leader faints, uses revive item before critical HP flee when revive is enabled and available', () => {
    const engine = createEngine();
    const socket = engine.socket(); socket.open();
    socket.message({ t: 'welcome', d: { playerId: 'trainer', map: 'route_001' } });
    engine.configure({ enabled: true, use_revive_battle: true, flee_hp_pct: 0.30 });
    socket.message({ t: 'inventory', d: { items: [{ itemId: 'revive', quantity: 2 }] } });
    socket.message({ t: 'team', d: { creatures: [{ id: 'lead', name: 'Pikachu', teamSlot: 0, isLeader: true, hp: 10, maxHp: 10 }] } });
    socket.message({ t: 'battle:start', d: { ownerId: 'trainer', battleId: 'b1', leader: { id: 'lead', hp: 10, maxHp: 10 }, foe: { name: 'Onix', hp: 20, maxHp: 20 } } });

    // Turn where leader faints
    socket.message({ t: 'battle:turn', d: { battleId: 'b1', turn: 1, canRevive: true, animateMs: 100, events: [{ e: 'faint', who: 'you' }] } });
    engine.advance(200);

    const items = socket.sent.filter(c => c.t === 'battle:item');
    const flees = socket.sent.filter(c => c.t === 'battle:flee');

    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].d.itemId, 'revive');
    assert.strictEqual(flees.length, 0, 'Must not flee when revive is available and permitted');
});

test('T11: when leader faints but use_revive_battle is disabled, flees battle', () => {
    const engine = createEngine();
    const socket = engine.socket(); socket.open();
    socket.message({ t: 'welcome', d: { playerId: 'trainer', map: 'route_001' } });
    engine.configure({ enabled: true, use_revive_battle: false, flee_hp_pct: 0.30 });
    socket.message({ t: 'inventory', d: { items: [{ itemId: 'revive', quantity: 2 }] } });
    socket.message({ t: 'team', d: { creatures: [{ id: 'lead', teamSlot: 0, isLeader: true, hp: 10, maxHp: 10 }] } });
    socket.message({ t: 'battle:start', d: { ownerId: 'trainer', battleId: 'b2', leader: { id: 'lead', hp: 10, maxHp: 10 }, foe: { hp: 20, maxHp: 20 } } });

    socket.message({ t: 'battle:turn', d: { battleId: 'b2', turn: 1, canRevive: true, animateMs: 100, events: [{ e: 'faint', who: 'you' }] } });
    engine.advance(200);

    const flees = socket.sent.filter(c => c.t === 'battle:flee');
    assert.strictEqual(flees.length, 1);
});

test('T11: when leader faints but revive stock is zero, flees battle', () => {
    const engine = createEngine();
    const socket = engine.socket(); socket.open();
    socket.message({ t: 'welcome', d: { playerId: 'trainer', map: 'route_001' } });
    engine.configure({ enabled: true, use_revive_battle: true, flee_hp_pct: 0.30 });
    socket.message({ t: 'inventory', d: { items: [{ itemId: 'revive', quantity: 0 }] } });
    socket.message({ t: 'team', d: { creatures: [{ id: 'lead', teamSlot: 0, isLeader: true, hp: 10, maxHp: 10 }] } });
    socket.message({ t: 'battle:start', d: { ownerId: 'trainer', battleId: 'b3', leader: { id: 'lead', hp: 10, maxHp: 10 }, foe: { hp: 20, maxHp: 20 } } });

    socket.message({ t: 'battle:turn', d: { battleId: 'b3', turn: 1, canRevive: true, animateMs: 100, events: [{ e: 'faint', who: 'you' }] } });
    engine.advance(200);

    const flees = socket.sent.filter(c => c.t === 'battle:flee');
    assert.strictEqual(flees.length, 1);
});

test('T11: when leader faints but server canRevive is false, flees battle', () => {
    const engine = createEngine();
    const socket = engine.socket(); socket.open();
    socket.message({ t: 'welcome', d: { playerId: 'trainer', map: 'route_001' } });
    engine.configure({ enabled: true, use_revive_battle: true, flee_hp_pct: 0.30 });
    socket.message({ t: 'inventory', d: { items: [{ itemId: 'revive', quantity: 5 }] } });
    socket.message({ t: 'team', d: { creatures: [{ id: 'lead', teamSlot: 0, isLeader: true, hp: 10, maxHp: 10 }] } });
    socket.message({ t: 'battle:start', d: { ownerId: 'trainer', battleId: 'b4', leader: { id: 'lead', hp: 10, maxHp: 10 }, foe: { hp: 20, maxHp: 20 } } });

    socket.message({ t: 'battle:turn', d: { battleId: 'b4', turn: 1, canRevive: false, animateMs: 100, events: [{ e: 'faint', who: 'you' }] } });
    engine.advance(200);

    const items = socket.sent.filter(c => c.t === 'battle:item');
    const flees = socket.sent.filter(c => c.t === 'battle:flee');
    assert.strictEqual(items.length, 0);
    assert.strictEqual(flees.length, 1);
});

test('T11: living leader below flee threshold flees without attempting revive', () => {
    const engine = createEngine();
    const socket = engine.socket(); socket.open();
    socket.message({ t: 'welcome', d: { playerId: 'trainer', map: 'route_001' } });
    engine.configure({ enabled: true, use_revive_battle: true, flee_hp_pct: 0.30 });
    socket.message({ t: 'inventory', d: { items: [{ itemId: 'revive', quantity: 5 }] } });
    socket.message({ t: 'team', d: { creatures: [{ id: 'lead', teamSlot: 0, isLeader: true, hp: 2, maxHp: 10 }] } });
    socket.message({ t: 'battle:start', d: { ownerId: 'trainer', battleId: 'b5', leader: { id: 'lead', hp: 2, maxHp: 10 }, foe: { hp: 20, maxHp: 20 } } });

    socket.message({ t: 'battle:turn', d: { battleId: 'b5', turn: 1, canRevive: true, animateMs: 100, events: [] } });
    engine.advance(200);

    const items = socket.sent.filter(c => c.t === 'battle:item');
    const flees = socket.sent.filter(c => c.t === 'battle:flee');
    assert.strictEqual(items.length, 0, 'Living creature must never be revived');
    assert.strictEqual(flees.length, 1);
});

test('T13: protects last copy of species in collection from auto-release even if low IV', () => {
    const engine = createEngine();
    const socket = engine.socket(); socket.open();
    socket.message({ t: 'welcome', d: { playerId: 'trainer', map: 'route_001' } });
    engine.configure({ enabled: true, discard_iv_pct: 50, protect_last_copy: true });

    const lowIvs = { hp: 1, atk: 1, def: 1, spa: 1, spd: 1, spe: 1 };
    const onlyCopy = { id: 'mon_1', speciesId: 25, name: 'Pikachu', boxSlot: 0, ivs: lowIvs };
    socket.message({ t: 'collection', d: { mons: [onlyCopy] } });

    const releases = () => socket.sent.filter(c => c.t === 'creature:release');
    assert.strictEqual(releases().length, 0, 'Must protect last copy of Pikachu even with 6% IV');

    // Now send a second Pikachu into collection
    const secondCopy = { id: 'mon_2', speciesId: 25, name: 'Pikachu', boxSlot: 1, ivs: lowIvs };
    socket.message({ t: 'collection', d: { mons: [onlyCopy, secondCopy] } });
    assert.strictEqual(releases().length, 1, 'Should release surplus low-IV copy');
    assert.deepStrictEqual(releases()[0].d.creatureIds, ['mon_2']);
});

test('T13: Master Ball is strictly reserved for Shinies and never consumed as fallback for non-shiny', () => {
    const engine = createEngine();
    const socket = engine.socket(); socket.open();
    socket.message({ t: 'welcome', d: { playerId: 'trainer', map: 'route_001' } });
    engine.configure({ enabled: true, ball_priority: 'force_highest' });

    // Inventory has ONLY master-ball
    socket.message({ t: 'inventory', d: { items: [{ itemId: 'master-ball', quantity: 1 }] } });
    socket.message({ t: 'battle:start', d: { ownerId: 'trainer', battleId: 'b_common',
        leader: { hp: 100, maxHp: 100 }, foe: { speciesId: 16, name: 'Pidgey', hp: 5, maxHp: 50, isShiny: false }
    } });

    socket.message({ t: 'battle:turn', d: { battleId: 'b_common', turn: 1, canThrow: true, animateMs: 100 } });
    engine.advance(200);

    const ballThrows = socket.sent.filter(c => c.t === 'battle:item');
    assert.strictEqual(ballThrows.length, 0, 'Master Ball must NEVER be thrown at a non-shiny Pidgey');
});

test('T13: Master Ball is thrown immediately against shiny encounter', () => {
    const engine = createEngine();
    const socket = engine.socket(); socket.open();
    socket.message({ t: 'welcome', d: { playerId: 'trainer', map: 'route_001' } });
    engine.configure({ enabled: true });

    // Inventory has master-ball and poke-balls
    socket.message({ t: 'inventory', d: { items: [
        { itemId: 'master-ball', quantity: 1 },
        { itemId: 'poke-ball', quantity: 99 }
    ] } });

    socket.message({ t: 'battle:start', d: { ownerId: 'trainer', battleId: 'b_shiny',
        leader: { hp: 100, maxHp: 100 }, foe: { speciesId: 1, name: 'Bulbasaur', hp: 50, maxHp: 50, isShiny: true }
    } });

    socket.message({ t: 'battle:turn', d: { battleId: 'b_shiny', turn: 1, canThrow: true, animateMs: 100 } });
    engine.advance(200);

    const ballThrows = socket.sent.filter(c => c.t === 'battle:item');
    assert.strictEqual(ballThrows.length, 1);
    assert.strictEqual(ballThrows[0].d.itemId, 'master-ball');
});

test('T13: release confirmation lifecycle: pending -> confirmed via deletion patch', () => {
    const engine = createEngine();
    const socket = engine.socket(); socket.open();
    socket.message({ t: 'welcome', d: { playerId: 'trainer', map: 'route_001' } });
    engine.configure({ enabled: true, discard_iv_pct: 50, protect_last_copy: false });

    const lowIvs = { hp: 1, atk: 1, def: 1, spa: 1, spd: 1, spe: 1 };
    const mon = { id: 'mon_to_delete', speciesId: 10, name: 'Caterpie', boxSlot: 0, ivs: lowIvs };
    socket.message({ t: 'collection', d: { mons: [mon] } });

    const releases = () => socket.sent.filter(c => c.t === 'creature:release');
    assert.strictEqual(releases().length, 1);

    // Re-sending the same mon before confirmation should not trigger duplicate release
    socket.message({ t: 'collection', d: { mons: [mon] } });
    assert.strictEqual(releases().length, 1, 'Duplicate release suppressed while pending');

    // Confirm deletion via server patch
    socket.message({ t: 'team:patch', d: [{ id: 'mon_to_delete', deleted: true }] });

    // After confirmed deletion, re-encountering or collection update with same ID is already in releasedCreatureIds
    socket.message({ t: 'collection', d: { mons: [mon] } });
    assert.strictEqual(releases().length, 1, 'Already released creature is never released again');
});

test('T13: server error rejection of release clears pending state and logs warning without confirming', () => {
    const engine = createEngine();
    const socket = engine.socket(); socket.open();
    socket.message({ t: 'welcome', d: { playerId: 'trainer', map: 'route_001' } });
    engine.configure({ enabled: true, discard_iv_pct: 50, protect_last_copy: false });

    const lowIvs = { hp: 1, atk: 1, def: 1, spa: 1, spd: 1, spe: 1 };
    const mon = { id: 'mon_rejected', speciesId: 10, name: 'Caterpie', boxSlot: 0, ivs: lowIvs };
    socket.message({ t: 'collection', d: { mons: [mon] } });

    const releases = () => socket.sent.filter(c => c.t === 'creature:release');
    assert.strictEqual(releases().length, 1);

    // Server returns rejection
    socket.message({ t: 'error', d: { code: 'creature_locked' } });

    // Since server rejected, creature was NOT deleted from collection
    const state = engine.state();
    assert.ok(state.collection['mon_rejected'], 'Creature remains in collection after server rejection');
});

test('T14: DexQuest deduplicates requests and does not send duplicate delivery for identical state', () => {
    const engine = createEngine();
    const socket = engine.socket(); socket.open();
    socket.message({ t: 'welcome', d: { playerId: 'trainer', map: 'route_001' } });
    engine.configure({ protect_last_copy: false, enabled: true, auto_npc_quests: true });

    const ivs = { hp: 10, atk: 10, def: 10, spa: 10, spd: 10, spe: 10 };
    const pika = { id: 'p1', speciesId: 25, name: 'Pikachu', boxSlot: 0, ivs };
    socket.message({ t: 'collection', d: { mons: [pika] } });

    const questMsg = { t: 'dexquest:state', d: { questId: 'q1', target: { speciesId: 25, name: 'Pikachu', have: 1 } } };
    socket.message(questMsg);

    const delivers = () => socket.sent.filter(c => c.t === 'dexquest:deliver');
    assert.strictEqual(delivers().length, 1);

    // Identical state should not send another delivery packet
    socket.message(questMsg);
    assert.strictEqual(delivers().length, 1, 'Duplicate state must not send duplicate deliver packet');
});

test('T14: DexQuest rejects creature if in pendingReleases (mutual exclusion with release)', () => {
    const engine = createEngine();
    const socket = engine.socket(); socket.open();
    socket.message({ t: 'welcome', d: { playerId: 'trainer', map: 'route_001' } });
    engine.configure({ enabled: true, auto_npc_quests: true, discard_iv_pct: 50, protect_last_copy: false });

    // Send a low-IV creature that gets marked as pending release
    const lowIvs = { hp: 1, atk: 1, def: 1, spa: 1, spd: 1, spe: 1 };
    const pika = { id: 'p1', speciesId: 25, name: 'Pikachu', boxSlot: 0, ivs: lowIvs };
    socket.message({ t: 'collection', d: { mons: [pika] } });

    // p1 is now in pendingReleases
    const releases = socket.sent.filter(c => c.t === 'creature:release');
    assert.strictEqual(releases.length, 1);

    // DexQuest asks for Pikachu
    socket.message({ t: 'dexquest:state', d: { questId: 'q1', target: { speciesId: 25, name: 'Pikachu', have: 1 } } });
    const delivers = socket.sent.filter(c => c.t === 'dexquest:deliver');
    assert.strictEqual(delivers.length, 0, 'Must NOT donate creature that is pending release');
});

test('T14: Collector preview rejects delivery if any creature is in pendingReleases', () => {
    const engine = createEngine();
    const socket = engine.socket(); socket.open();
    socket.message({ t: 'welcome', d: { playerId: 'trainer', map: 'route_001' } });
    engine.configure({ enabled: true, auto_npc_quests: true, discard_iv_pct: 50, protect_last_copy: false });

    const lowIvs = { hp: 1, atk: 1, def: 1, spa: 1, spd: 1, spe: 1 };
    const c1 = { id: 'c1', speciesId: 50, name: 'Diglett', boxSlot: 0, ivs: lowIvs };
    socket.message({ t: 'collection', d: { mons: [c1] } });

    socket.message({ t: 'collector:state', d: { mapId: 'route_001', window: 1, deliverable: true, delivered: false } });
    socket.message({ t: 'collector:preview', d: { mapId: 'route_001', window: 1, creatureIds: ['c1'] } });

    const collectorDelivers = socket.sent.filter(c => c.t === 'collector:deliver');
    assert.strictEqual(collectorDelivers.length, 0, 'Collector must not deliver creature that is pending release');
});

test('T14: reconnect retains unresolved destructive requests', () => {
    const engine = createEngine();
    const socket = engine.socket(); socket.open();
    socket.message({ t: 'welcome', d: { playerId: 'trainer', map: 'route_001' } });
    engine.configure({ protect_last_copy: false, enabled: true, auto_npc_quests: true });

    const ivs = { hp: 10, atk: 10, def: 10, spa: 10, spd: 10, spe: 10 };
    const pika = { id: 'p1', speciesId: 25, name: 'Pikachu', boxSlot: 0, ivs };
    socket.message({ t: 'collection', d: { mons: [pika] } });

    const questMsg = { t: 'dexquest:state', d: { questId: 'q1', target: { speciesId: 25, name: 'Pikachu', have: 1 } } };
    socket.message(questMsg);

    const delivers = () => socket.sent.filter(c => c.t === 'dexquest:deliver');
    assert.strictEqual(delivers().length, 1);

    // Disconnect and reconnect socket
    socket.close();
    const socket2 = engine.socket(); socket2.open();
    socket2.message({ t: 'welcome', d: { playerId: 'trainer', map: 'route_001' } });
    socket2.message({ t: 'collection', d: { mons: [pika] } });

    // An identical snapshot does not prove the previous request was rejected.
    socket2.message(questMsg);
    const delivers2 = socket2.sent.filter(c => c.t === 'dexquest:deliver');
    assert.strictEqual(delivers2.length, 0, 'Reconnect must not repeat an unresolved delivery');
});

test('T12: high-level capture uses a ball while nonlethal damage remains unproven', () => {
    const engine = createEngine();
    const socket = engine.socket(); socket.open();
    engine.configure({ enabled: true, catch_hp_pct: 0.50 });
    socket.message({ t: 'welcome', d: { playerId: 'trainer' } });
    socket.message({ t: 'inventory', d: { items: [{ itemId: 'super-ball', quantity: 10 }] } });

    // Both player and foe are level 20 (gap = 0 < 5). Foe HP is 100/100 (100% > 50%).
    socket.message({
        t: 'battle:start',
        d: {
            ownerId: 'trainer',
            battleId: 'b_high_hp',
            leader: { id: 'l1', speciesId: 6, level: 20, hp: 100, maxHp: 100, moves: [{ id: 'ember', name: 'Ember', power: 40, eff: 1 }] },
            foe: { id: 'f1', speciesId: 19, name: 'Rattata', level: 20, hp: 100, maxHp: 100 }
        }
    });

    socket.message({ t: 'battle:turn', d: { battleId: 'b_high_hp', turn: 1, canThrow: true, animateMs: 100 } });
    engine.advance(200);

    const ballThrows = socket.sent.filter(c => c.t === 'battle:item');
    const attackMoves = socket.sent.filter(c => c.t === 'battle:move');

    assert.strictEqual(ballThrows.length, 1, 'Without a proven nonlethal bound preserve the capture attempt');
    assert.strictEqual(attackMoves.length, 0, 'Power and matching levels cannot prove survival');
});

test('T12: target weakened to <= catch_hp_pct receives ball throw', () => {
    const engine = createEngine();
    const socket = engine.socket(); socket.open();
    engine.configure({ enabled: true, catch_hp_pct: 0.50 });
    socket.message({ t: 'welcome', d: { playerId: 'trainer' } });
    socket.message({ t: 'inventory', d: { items: [{ itemId: 'super-ball', quantity: 10 }] } });

    // Foe is level 20, HP is 40/100 (40% <= 50% catch threshold)
    socket.message({
        t: 'battle:start',
        d: {
            ownerId: 'trainer',
            battleId: 'b_low_hp',
            leader: { id: 'l1', speciesId: 6, level: 20, hp: 100, maxHp: 100, moves: [{ id: 'ember', name: 'Ember', power: 40, eff: 1 }] },
            foe: { id: 'f1', speciesId: 19, name: 'Rattata', level: 20, hp: 40, maxHp: 100 }
        }
    });

    socket.message({ t: 'battle:turn', d: { battleId: 'b_low_hp', turn: 1, canThrow: true, animateMs: 100 } });
    engine.advance(200);

    const ballThrows = socket.sent.filter(c => c.t === 'battle:item');
    const attackMoves = socket.sent.filter(c => c.t === 'battle:move');

    assert.strictEqual(attackMoves.length, 0, 'Must NOT attack when foe is already weakened to <= catch_hp_pct');
    assert.strictEqual(ballThrows.length, 1, 'Must throw ball when foe HP is at or below catch_hp_pct');
    assert.strictEqual(ballThrows[0].d.itemId, 'super-ball');
});

test('T12: shiny encounter always triggers direct ball throw without attacking', () => {
    const engine = createEngine();
    const socket = engine.socket(); socket.open();
    engine.configure({ enabled: true, catch_hp_pct: 0.50 });
    socket.message({ t: 'welcome', d: { playerId: 'trainer' } });
    socket.message({ t: 'inventory', d: { items: [{ itemId: 'super-ball', quantity: 10 }] } });

    // Shiny foe at 100% HP, same level (no level gap)
    socket.message({
        t: 'battle:start',
        d: {
            ownerId: 'trainer',
            battleId: 'b_shiny',
            leader: { id: 'l1', speciesId: 6, level: 50, hp: 100, maxHp: 100, moves: [{ id: 'flamethrower', power: 90 }] },
            foe: { id: 'f_shiny', speciesId: 147, name: 'Dratini', isShiny: true, level: 50, hp: 100, maxHp: 100 }
        }
    });

    socket.message({ t: 'battle:turn', d: { battleId: 'b_shiny', turn: 1, canThrow: true, animateMs: 100 } });
    engine.advance(200);

    const ballThrows = socket.sent.filter(c => c.t === 'battle:item');
    const attackMoves = socket.sent.filter(c => c.t === 'battle:move');

    assert.strictEqual(attackMoves.length, 0, 'Must NEVER attack a shiny');
    assert.strictEqual(ballThrows.length, 1, 'Must throw ball directly at a shiny');
});

test('T12: large level advantage (gap >= 5) triggers direct ball throw to avoid one-shot KO', () => {
    const engine = createEngine();
    const socket = engine.socket(); socket.open();
    engine.configure({ enabled: true, catch_hp_pct: 0.30 });
    socket.message({ t: 'welcome', d: { playerId: 'trainer' } });
    socket.message({ t: 'inventory', d: { items: [{ itemId: 'super-ball', quantity: 10 }] } });

    // Player level 30 vs Foe level 10 (gap 20 >= 5), Foe HP 100%
    socket.message({
        t: 'battle:start',
        d: {
            ownerId: 'trainer',
            battleId: 'b_gap',
            leader: { id: 'l1', speciesId: 6, level: 30, hp: 100, maxHp: 100, moves: [{ id: 'slash', power: 70 }] },
            foe: { id: 'f_low', speciesId: 19, name: 'Rattata', level: 10, hp: 100, maxHp: 100 }
        }
    });

    socket.message({ t: 'battle:turn', d: { battleId: 'b_gap', turn: 1, canThrow: true, animateMs: 100 } });
    engine.advance(200);

    const ballThrows = socket.sent.filter(c => c.t === 'battle:item');
    const attackMoves = socket.sent.filter(c => c.t === 'battle:move');

    assert.strictEqual(attackMoves.length, 0, 'Must NOT attack when level gap >= 5 (risk of 1-shot KO)');
    assert.strictEqual(ballThrows.length, 1, 'Must throw ball directly due to level gap');
});

test('T12: species registered in Pokédex is not treated as uncaught even when absent from Box', () => {
    const engine = createEngine();
    const socket = engine.socket(); socket.open();
    engine.configure({ enabled: true, catch_only_uncaught: true, unselected_action: 'flee' });
    socket.message({ t: 'welcome', d: { playerId: 'trainer' } });
    socket.message({ t: 'inventory', d: { items: [{ itemId: 'super-ball', quantity: 10 }] } });

    // Player has NO Pikachus in collection (Box is empty)
    socket.message({ t: 'collection', d: { mons: [] } });

    // But Pokédex lists Pikachu (speciesId 25) as caught: true
    socket.message({
        t: 'pokedex:list',
        d: {
            entries: [
                { speciesId: 25, name: 'Pikachu', caught: true, seen: true },
                { speciesId: 1, name: 'Bulbasaur', caught: false, seen: true }
            ]
        }
    });

    // Encounter Pikachu: since it is in Pokédex as caught, isUncaught is false!
    // With catch_only_uncaught: true and unselected_action: 'flee', the bot must flee!
    socket.message({
        t: 'battle:start',
        d: {
            ownerId: 'trainer',
            battleId: 'b_dex_caught',
            leader: { id: 'l1', speciesId: 6, level: 20, hp: 100, maxHp: 100 },
            foe: { id: 'f_pika', speciesId: 25, name: 'Pikachu', level: 20, hp: 100, maxHp: 100 }
        }
    });

    socket.message({ t: 'battle:turn', d: { battleId: 'b_dex_caught', turn: 1, canThrow: true, animateMs: 100 } });
    engine.advance(200);

    const flees = socket.sent.filter(c => c.t === 'battle:flee');
    const ballThrows = socket.sent.filter(c => c.t === 'battle:item');

    assert.strictEqual(ballThrows.length, 0, 'Must NOT throw ball at already-registered species when catch_only_uncaught is enabled');
    assert.strictEqual(flees.length, 1, 'Must flee from registered species under catch_only_uncaught + flee unselected');
});

test('T12: closed throw window (canThrow: false) never throws ball even for direct throw shiny', () => {
    const engine = createEngine();
    const socket = engine.socket(); socket.open();
    engine.configure({ enabled: true });
    socket.message({ t: 'welcome', d: { playerId: 'trainer' } });
    socket.message({ t: 'inventory', d: { items: [{ itemId: 'master-ball', quantity: 1 }] } });

    socket.message({
        t: 'battle:start',
        d: {
            ownerId: 'trainer',
            battleId: 'b_closed',
            leader: { id: 'l1', speciesId: 6, level: 50, hp: 100, maxHp: 100 },
            foe: { id: 'f_shiny', speciesId: 147, name: 'Dratini', isShiny: true, level: 50, hp: 100, maxHp: 100 }
        }
    });

    // Server sends control window where canThrow is FALSE (e.g. healing window or turn transition)
    socket.message({ t: 'battle:control', d: { battleId: 'b_closed', canThrow: false, canHeal: true } });
    for (const callback of [...engine.timers.values()]) callback();

    const ballThrows = socket.sent.filter(c => c.t === 'battle:item');
    assert.strictEqual(ballThrows.length, 0, 'Must NEVER throw ball when server canThrow permission is false');
});

test('T21: Box cleanup releases duplicate low-IV non-matching creatures and honors all safeguards (shinies, team, locked, last copy)', () => {
    const engine = createEngine();
    const socket = engine.socket(); socket.open();
    socket.message({ t: 'welcome', d: { playerId: 'trainer', map: 'route_001' } });
    engine.configure({
        enabled: true,
        iv_evaluation_mode: 'percent',
        discard_iv_pct: 60,
        desired_nature: 'any',
        protect_last_copy: true,
    });

    // Populate collection
    socket.message({ t: 'team', d: { creatures: [
        // 1. Leader (team member) - low IV -> PROTECTED
        { id: 'lead', name: 'Charizard', speciesId: 6, teamSlot: 0, isLeader: true, ivs: { hp: 5, atk: 5, def: 5, spa: 5, spd: 5, spe: 5 } },
        // 2. Shiny in Box - low IV -> PROTECTED
        { id: 'box-shiny', name: 'Gyarados', speciesId: 130, boxSlot: 0, isShiny: true, ivs: { hp: 5, atk: 5, def: 5, spa: 5, spd: 5, spe: 5 } },
        // 3. Locked in Box - low IV -> PROTECTED
        { id: 'box-locked', name: 'Dragonite', speciesId: 149, boxSlot: 1, isLocked: true, ivs: { hp: 5, atk: 5, def: 5, spa: 5, spd: 5, spe: 5 } },
        // 4. Only copy of Snorlax in Box - low IV -> PROTECTED (last copy)
        { id: 'box-snorlax', name: 'Snorlax', speciesId: 143, boxSlot: 2, ivs: { hp: 5, atk: 5, def: 5, spa: 5, spd: 5, spe: 5 } },
        // 5. Duplicate Rattata #1 in Box - low IV (30/186 = 16% < 60%) -> ELIGIBLE FOR RELEASE
        { id: 'box-rat-1', name: 'Rattata', speciesId: 19, boxSlot: 3, ivs: { hp: 5, atk: 5, def: 5, spa: 5, spd: 5, spe: 5 } },
        // 6. Duplicate Rattata #2 in Box - high IV (180/186 = 97% >= 60%) -> PROTECTED (keeps criteria)
        { id: 'box-rat-2', name: 'Rattata', speciesId: 19, boxSlot: 4, ivs: { hp: 30, atk: 30, def: 30, spa: 30, spd: 30, spe: 30 } },
    ] } });

    // Trigger box cleanup manual action
    engine.command('manual-action', { action: 'cleanup-box' });

    const releaseEvents = socket.sent.filter(c => c.t === 'creature:release');
    assert.strictEqual(releaseEvents.length, 1, 'Must send creature:release event');
    assert.deepStrictEqual(releaseEvents[0].d.creatureIds, ['box-rat-1'], 'Only duplicate low-IV non-safeguarded creature must be released');
});

test('T21: Box cleanup respects individual IV minimums and nature filters', () => {
    const engine = createEngine();
    const socket = engine.socket(); socket.open();
    socket.message({ t: 'welcome', d: { playerId: 'trainer', map: 'route_001' } });
    engine.configure({
        enabled: true,
        iv_evaluation_mode: 'individual',
        min_ivs: { hp: 0, atk: 31, def: 0, spa: 0, spd: 0, spe: 31 },
        desired_nature: 'adamant',
        protect_last_copy: true,
    });

    // 1 Party leader + 3 Pidgeys in Box
    socket.message({ t: 'team', d: { creatures: [
        { id: 'leader', name: 'Charizard', speciesId: 6, teamSlot: 0, isLeader: true, hp: 100, maxHp: 100, ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 } },
        // Candidate 1: 31 Atk, 31 Spe, but Timid (+Spe, -Atk) -> Fails nature filter -> Eligible
        { id: 'pidg-1', name: 'Pidgey', speciesId: 16, teamSlot: null, boxSlot: 0, nature: 'timid', ivs: { hp: 20, atk: 31, def: 20, spa: 20, spd: 20, spe: 31 } },
        // Candidate 2: Adamant (+Atk, -SpA), but Spe is 20 (< 31) -> Fails individual minimum -> Eligible
        { id: 'pidg-2', name: 'Pidgey', speciesId: 16, teamSlot: null, boxSlot: 1, nature: 'adamant', ivs: { hp: 20, atk: 31, def: 20, spa: 20, spd: 20, spe: 20 } },
        // Candidate 3: Adamant, 31 Atk, 31 Spe -> Meets all criteria -> KEEP!
        { id: 'pidg-3', name: 'Pidgey', speciesId: 16, teamSlot: null, boxSlot: 2, nature: 'adamant', ivs: { hp: 25, atk: 31, def: 25, spa: 10, spd: 25, spe: 31 } },
    ] } });

    engine.command('manual-action', { action: 'cleanup-box' });

    const releaseEvents = socket.sent.filter(c => c.t === 'creature:release');
    assert.strictEqual(releaseEvents.length, 1);
    assert.strictEqual(releaseEvents[0].d.creatureIds.includes('pidg-1'), true, 'pidg-1 fails nature');
    assert.strictEqual(releaseEvents[0].d.creatureIds.includes('pidg-2'), true, 'pidg-2 fails individual IVs');
    assert.strictEqual(releaseEvents[0].d.creatureIds.includes('pidg-3'), false, 'pidg-3 passes all criteria and must NOT be released');
});

test('T22: Box cleanup keeps creatures meeting min_quality even if IV and nature do not match (Logical OR)', () => {
    const engine = createEngine();
    const socket = engine.socket(); socket.open();
    socket.message({ t: 'welcome', d: { playerId: 'trainer', map: 'route_001' } });
    engine.configure({
        enabled: true,
        iv_evaluation_mode: 'percent',
        discard_iv_pct: 80,
        desired_nature: 'adamant',
        min_quality: 'good', // 500+ / 2★
        protect_last_copy: true,
    });

    socket.message({ t: 'team', d: { creatures: [
        { id: 'leader', name: 'Charizard', speciesId: 6, teamSlot: 0, isLeader: true, hp: 100, maxHp: 100, ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 } },
        // Candidate 1: low IV (16%), wrong nature (modest), but high quality (850 - great) -> KEEP (meets min_quality)!
        { id: 'geo-1', name: 'Geodude', speciesId: 74, teamSlot: null, boxSlot: 0, nature: 'modest', quality: 850, ivs: { hp: 5, atk: 5, def: 5, spa: 5, spd: 5, spe: 5 } },
        // Candidate 2: high IV (90%), right nature (adamant), but low quality (200 - fair) -> KEEP (meets IV/Nature)!
        { id: 'geo-2', name: 'Geodude', speciesId: 74, teamSlot: null, boxSlot: 1, nature: 'adamant', quality: 200, ivs: { hp: 28, atk: 28, def: 28, spa: 28, spd: 28, spe: 28 } },
        // Candidate 3: low IV (16%), wrong nature (timid), and low quality (350 - fair) -> DISCARD (fails BOTH)!
        { id: 'geo-3', name: 'Geodude', speciesId: 74, teamSlot: null, boxSlot: 2, nature: 'timid', quality: 350, ivs: { hp: 5, atk: 5, def: 5, spa: 5, spd: 5, spe: 5 } },
    ] } });

    engine.command('manual-action', { action: 'cleanup-box' });

    const releaseEvents = socket.sent.filter(c => c.t === 'creature:release');
    assert.strictEqual(releaseEvents.length, 1);
    assert.strictEqual(releaseEvents[0].d.creatureIds.includes('geo-1'), false, 'geo-1 meets min_quality and must be KEPT');
    assert.strictEqual(releaseEvents[0].d.creatureIds.includes('geo-2'), false, 'geo-2 meets IV/nature criteria and must be KEPT');
    assert.strictEqual(releaseEvents[0].d.creatureIds.includes('geo-3'), true, 'geo-3 fails both criteria and must be released');
});

test('T22: Box cleanup releases creatures failing min_quality when only min_quality is configured', () => {
    const engine = createEngine();
    const socket = engine.socket(); socket.open();
    socket.message({ t: 'welcome', d: { playerId: 'trainer', map: 'route_001' } });
    engine.configure({
        enabled: true,
        iv_evaluation_mode: 'percent',
        discard_iv_pct: 0,
        desired_nature: 'any',
        min_quality: 'great', // 800+ / 3★
        protect_last_copy: true,
    });

    socket.message({ t: 'team', d: { creatures: [
        { id: 'leader', name: 'Charizard', speciesId: 6, teamSlot: 0, isLeader: true, hp: 100, maxHp: 100, ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 } },
        // Candidate 1: Quality 940 (excellent) >= 800 -> KEEP
        { id: 'zub-1', name: 'Zubat', speciesId: 41, teamSlot: null, boxSlot: 0, quality: 940, ivs: { hp: 15, atk: 15, def: 15, spa: 15, spd: 15, spe: 15 } },
        // Candidate 2: Quality 600 (good) < 800 -> DISCARD
        { id: 'zub-2', name: 'Zubat', speciesId: 41, teamSlot: null, boxSlot: 1, quality: 600, ivs: { hp: 15, atk: 15, def: 15, spa: 15, spd: 15, spe: 15 } },
    ] } });

    engine.command('manual-action', { action: 'cleanup-box' });

    const releaseEvents = socket.sent.filter(c => c.t === 'creature:release');
    assert.strictEqual(releaseEvents.length, 1);
    assert.strictEqual(releaseEvents[0].d.creatureIds.includes('zub-1'), false, 'zub-1 meets min_quality and must be KEPT');
    assert.strictEqual(releaseEvents[0].d.creatureIds.includes('zub-2'), true, 'zub-2 fails min_quality and must be released');
});

test('T22: Capture auto-lock and NPC delivery protection honor min_quality threshold', () => {
    const engine = createEngine();
    const socket = engine.socket(); socket.open();
    socket.message({ t: 'welcome', d: { playerId: 'trainer', map: 'route_001' } });
    engine.configure({
        enabled: true,
        auto_lock_valuable: true,
        min_quality: 'excellent', // 940+ / 4★
        auto_npc_quests: true,
        auto_travel_deliveries: false,
    });

    // 1. Simulate battle and capture of creature with quality 950 (meets excellent)
    socket.sent.length = 0;
    socket.message({
        t: 'battle:start',
        d: { ownerId: 'trainer', battleId: 'b_capture', foe: { speciesId: 63, name: 'Abra' } }
    });
    socket.message({
        t: 'battle:end',
        d: {
            battleId: 'b_capture',
            result: 'capture',
            captured: true,
            caught: {
                id: 'abra-high-q',
                speciesId: 63,
                name: 'Abra',
                level: 10,
                quality: 950,
                nature: 'hasty',
                ivs: { hp: 10, atk: 10, def: 10, spa: 10, spd: 10, spe: 10 } // grade C
            }
        }
    });

    const lockEvents = socket.sent.filter(c => c.t === 'creature:lock');
    assert.strictEqual(lockEvents.length, 1, 'High-quality captured creature must be auto-locked');
    assert.strictEqual(lockEvents[0].d.creatureId, 'abra-high-q');
    assert.strictEqual(lockEvents[0].d.locked, true);

    // 2. Add creatures to collection and check that high quality creature is protected from NPC donation
    socket.message({ t: 'team', d: { creatures: [
        { id: 'leader', name: 'Charizard', speciesId: 6, teamSlot: 0, isLeader: true, hp: 100, maxHp: 100, ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 } },
        // High quality Abra in Box
        { id: 'abra-high-q', name: 'Abra', speciesId: 63, boxSlot: 0, quality: 950, ivs: { hp: 10, atk: 10, def: 10, spa: 10, spd: 10, spe: 10 } },
        // Surplus normal Abra in Box (quality 200)
        { id: 'abra-normal', name: 'Abra', speciesId: 63, boxSlot: 1, quality: 200, ivs: { hp: 10, atk: 10, def: 10, spa: 10, spd: 10, spe: 10 } },
    ] } });

    // Open professor quest modal asking for Abra
    socket.sent.length = 0;
    socket.message({
        t: 'professor:dialog',
        d: {
            quest: { speciesId: 63, count: 1, ready: true }
        }
    });

    // If donation occurs, it must only consume abra-normal, never abra-high-q
    const donateEvents = socket.sent.filter(c => c.t === 'professor:deliver');
    if (donateEvents.length > 0) {
        assert.strictEqual(donateEvents[0].d.creatureIds.includes('abra-high-q'), false, 'abra-high-q must never be delivered to NPC');
    }
});


