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
    engine.configure({ enabled: true });
    socket.message({ t: 'map:change', d: { map: 'route_001' } });
    socket.message({ t: 'collector:state', d: { mapId: 'route_001', window: 1, deliverable: true, delivered: false } });
    assert.equal(socket.sent.filter(command => command.t === 'collector:deliver').length, 0);
    assert.equal(socket.sent.filter(command => command.t === 'collector:preview').length, 1);
    socket.message({ t: 'team', d: { creatures: [{ id: 'shiny', isShiny: true, teamSlot: null, boxSlot: 0 }] } });
    socket.message({ t: 'collector:preview', d: { mapId: 'route_001', window: 1, creatureIds: ['shiny'] } });
    assert.equal(socket.sent.filter(command => command.t === 'collector:deliver').length, 0);
    socket.message({ t: 'team', d: { creatures: [{ id: 'safe', teamSlot: null, boxSlot: 1, ivs: { hp: 1, atk: 1, def: 1, spa: 1, spd: 1, spe: 1 } }] } });
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
    engine.configure({ enabled: true });
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
    assert.equal(engine.state().currentMapBiome, 'snow');
});
