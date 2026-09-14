const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function dashboard(config) {
    const events = {};
    const sent = [];
    const saved = [];
    const inputs = new Map();
    const checkboxes = [];
    let hostCommandHandler = null;
    const game = { addEventListener(type, fn) { events[type] = fn; }, send(channel, command) { sent.push(structuredClone(command)); } };
    const window = {
        addEventListener(type, fn) { events[type] = fn; },
        electronAPI: {
            getConfig: async () => config,
            saveConfig: async value => { saved.push(structuredClone(value)); return true; },
            onHostCommand: fn => { hostCommandHandler = fn; }
        }
    };
    const context = vm.createContext({ window, console, document: {
        getElementById(id) {
            if (id === 'game-view') return game;
            if (id.startsWith('cfg-')) { if (!inputs.has(id)) inputs.set(id, {}); return inputs.get(id); }
            return null;
        },
        querySelectorAll(sel) {
            if (typeof sel === 'string' && sel.includes('input[type="checkbox"]')) return checkboxes;
            return [];
        },
    } });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../app/app.js'), 'utf8'), context);
    return { events, sent, saved, context, inputs, window, checkboxes, getHostCommandHandler: () => hostCommandHandler };
}

test('saved configuration reaches guest on first load and every reload', async () => {
    const saved = { enabled: false, strategy_mode: 'collection', catch_hp_pct: 0, discard_iv_pct: 0 };
    const app = dashboard(saved);
    await app.events.DOMContentLoaded();
    app.events['dom-ready']();
    app.events['dom-ready']();
    assert.deepEqual(app.sent.map(c => c.payload), [saved, saved]);
    assert.equal(app.inputs.get('cfg-catch').value, 0);
});

test('saving settings preserves zero thresholds and pause is persisted', async () => {
    const app = dashboard({ enabled: true, catch_hp_pct: 0, flee_hp_pct: 0, potion_hp_pct: 0, discard_iv_pct: 0 });
    await app.events.DOMContentLoaded();
    app.events['dom-ready']();
    await app.window.saveBotSettings();
    assert.equal(app.saved.at(-1).catch_hp_pct, 0);
    assert.equal(app.saved.at(-1).flee_hp_pct, 0);
    assert.equal(app.saved.at(-1).potion_hp_pct, 0);
    assert.equal(app.saved.at(-1).discard_iv_pct, 0);
    await app.window.toggleBotState();
    assert.equal(app.saved.at(-1).enabled, false);
});

test('failed settings persistence does not apply or replace the saved configuration', async () => {
    const app = dashboard({ enabled: false, catch_hp_pct: 0.25 });
    await app.events.DOMContentLoaded();
    app.events['dom-ready']();
    app.inputs.get('cfg-catch').value = 80;
    app.window.electronAPI.saveConfig = async () => false;
    const before = app.sent.length;
    await app.window.saveBotSettings();
    assert.equal(app.sent.length, before);
    app.events['dom-ready']();
    assert.equal(app.sent.at(-1).payload.catch_hp_pct, 0.25);
});

test('presets replace conflicting capture filters and balanced restores its thresholds before saving', async () => {
    const app = dashboard({ enabled: false, catch_only_shiny: true, catch_hp_pct: 0.8, target_species: ['eevee'] });
    await app.events.DOMContentLoaded();
    app.events['dom-ready']();
    const before = app.sent.length;
    app.window.onStrategyChange('collection');
    assert.equal(app.inputs.get('cfg-only-shiny').checked, false);
    assert.equal(app.inputs.get('cfg-only-uncaught').checked, true);
    app.window.onStrategyChange('monetize');
    assert.equal(app.inputs.get('cfg-catch').value, 30);
    app.window.onStrategyChange('balanced');
    assert.equal(app.inputs.get('cfg-catch').value, 50);
    assert.equal(app.inputs.get('cfg-ball-priority').value, 'balanced');
    assert.equal(app.inputs.get('cfg-only-uncaught').checked, false);
    assert.equal(app.sent.length, before, 'preview must not change running game');
    assert.equal(app.saved.length, 0);
    await app.window.saveBotSettings();
    assert.equal(app.saved.at(-1).enabled, false);
    assert.deepEqual(app.saved.at(-1).target_species, ['eevee']);
    assert.equal(app.saved.at(-1).strategy_mode, 'balanced');
});

test('T06: activating bot fails when persistence fails and does not start engine', async () => {
    const app = dashboard({ enabled: false });
    await app.events.DOMContentLoaded();
    app.events['dom-ready']();
    app.window.electronAPI.saveConfig = async () => false;

    await app.window.toggleBotState();
    const activates = app.sent.filter(c => c.cmd === 'toggle-bot' && c.payload.enabled === true);
    assert.equal(activates.length, 0, 'Must not send enabled:true to game when persistence fails');
    assert.equal(app.window.isBotEnabled(), false);
});

test('T06: emergency pause halts engine immediately even if saveConfig fails', async () => {
    const app = dashboard({ enabled: true });
    await app.events.DOMContentLoaded();
    app.events['dom-ready']();
    app.window.electronAPI.saveConfig = async () => false;

    await app.window.toggleBotState();
    const pauses = app.sent.filter(c => c.cmd === 'toggle-bot' && c.payload.enabled === false);
    assert.equal(pauses.length, 1, 'Emergency pause must send enabled:false immediately');
    assert.equal(app.window.isBotEnabled(), false);
});

for (const failure of ['false result', 'rejection']) {
    test(`T06: emergency pause survives guest reload after saveConfig ${failure}`, async () => {
        const app = dashboard({ enabled: true, catch_hp_pct: 0.25 });
        await app.events.DOMContentLoaded();
        app.events['dom-ready']();
        app.window.electronAPI.saveConfig = async () => {
            if (failure === 'rejection') throw new Error('Disk unavailable');
            return false;
        };

        await app.window.toggleBotState();
        app.events['did-start-loading']();
        app.events['dom-ready']();

        assert.equal(app.sent.at(-1).cmd, 'update-config');
        assert.equal(app.sent.at(-1).payload.enabled, false,
            'Reload must keep the emergency pause even when it could not be saved');
        assert.equal(app.sent.at(-1).payload.catch_hp_pct, 0.25);
        assert.equal(app.window.isBotEnabled(), false);
    });
}

test('T06: emergency pause survives guest reload while saveConfig is pending', async () => {
    const app = dashboard({ enabled: true });
    await app.events.DOMContentLoaded();
    app.events['dom-ready']();
    let finishSave;
    app.window.electronAPI.saveConfig = () => new Promise(resolve => { finishSave = resolve; });

    const pausing = app.window.toggleBotState();
    try {
        app.events['did-start-loading']();
        app.events['dom-ready']();
        assert.equal(app.sent.at(-1).cmd, 'update-config');
        assert.equal(app.sent.at(-1).payload.enabled, false,
            'A slow disk write must not allow a guest reload to reactivate the bot');
    } finally {
        finishSave(true);
        await pausing;
    }
});

test('T06: saving area targets after a failed emergency pause does not reactivate the bot', async () => {
    const app = dashboard({ enabled: true, target_mode: 'all', target_species: [] });
    await app.events.DOMContentLoaded();
    app.events['dom-ready']();
    app.window.electronAPI.saveConfig = async () => false;
    await app.window.toggleBotState();

    app.window.electronAPI.saveConfig = async value => {
        app.saved.push(structuredClone(value));
        return true;
    };
    await app.window.saveAreaSettings();

    assert.equal(app.saved.at(-1).enabled, false,
        'A later target save must persist the current paused state');
    assert.equal(app.sent.at(-1).cmd, 'update-config');
    assert.equal(app.sent.at(-1).payload.enabled, false);
    assert.equal(app.window.isBotEnabled(), false);
});

test('T06: out-of-order saves do not overwrite newer state (monotonic revision)', async () => {
    const app = dashboard({ enabled: false, roam_step_delay_ms: 300 });
    await app.events.DOMContentLoaded();
    app.events['dom-ready']();

    let resolveFirst;
    const firstPromise = new Promise(resolve => { resolveFirst = resolve; });

    let callCount = 0;
    app.window.electronAPI.saveConfig = async (cfg) => {
        callCount++;
        if (callCount === 1) {
            await firstPromise;
            return true;
        }
        return true;
    };

    // Save #1 with 400ms
    app.inputs.get('cfg-roam-delay').value = 400;
    const p1 = app.window.saveBotSettings();

    // Save #2 with 500ms
    app.inputs.get('cfg-roam-delay').value = 500;
    const p2 = app.window.saveBotSettings();

    await p2;
    resolveFirst();
    await p1;

    // The active currentConfig should reflect save #2 (500), not the slower resolving save #1 (400)
    assert.equal(app.window.getCurrentConfig().roam_step_delay_ms, 500);
});

test('T07: area target mode transitions properly between all, none, and selected', async () => {
    const app = dashboard({ enabled: false, target_mode: 'all', target_species: [] });
    await app.events.DOMContentLoaded();
    app.events['dom-ready']();

    app.checkboxes.push({ value: 'pidgey', checked: false });
    app.checkboxes.push({ value: 'rattata', checked: false });

    // 1. Select All -> mode 'all'
    await app.window.selectAllAreaSpecies(true);
    assert.equal(app.saved.at(-1).target_mode, 'all');
    assert.deepEqual(app.saved.at(-1).target_species, ['pidgey', 'rattata']);

    // 2. Deselect All -> mode 'none'
    await app.window.selectAllAreaSpecies(false);
    assert.equal(app.saved.at(-1).target_mode, 'none');
    assert.deepEqual(app.saved.at(-1).target_species, []);

    // 3. Toggle single -> mode 'selected'
    app.checkboxes[0].checked = true;
    await app.window.onAreaSpeciesToggle('pidgey', true);
    assert.equal(app.saved.at(-1).target_mode, 'selected');
    assert.deepEqual(app.saved.at(-1).target_species, ['pidgey']);
});

test('T17: auto-pause received via telemetry persists to disk and keeps bot paused on reload', async () => {
    const app = dashboard({ enabled: true, auto_idle: true, strategy_mode: 'balanced' });
    await app.events.DOMContentLoaded();
    app.events['dom-ready']();

    // Telemetry indicates bot auto-paused (e.g. no balls or lab return failure)
    app.events['ipc-message']({
        channel: 'game-telemetry',
        args: [{
            config: { enabled: false, auto_idle: true }
        }]
    });

    // Wait a tick for async saveConfig to resolve
    await new Promise(setImmediate);

    // Verify that the paused state was automatically persisted to disk
    assert.equal(app.saved.at(-1).enabled, false);
    assert.equal(app.window.isBotEnabled(), false);
});

test('T18: onHostCommand toggle-bot enabled:false pauses active bot and notifies guest', async () => {
    const app = dashboard({ enabled: true });
    await app.events.DOMContentLoaded();
    app.events['dom-ready']();

    assert.equal(app.window.isBotEnabled(), true);
    const before = app.sent.length;

    // Simulate main process host command (e.g. system suspend)
    const hostCommand = app.getHostCommandHandler();
    assert.ok(typeof hostCommand === 'function', 'onHostCommand must be registered');
    await hostCommand({ cmd: 'toggle-bot', payload: { enabled: false } });

    assert.equal(app.window.isBotEnabled(), false);
    assert.equal(app.saved.at(-1).enabled, false);
    const pauseCmd = app.sent.slice(before).find(c => c.cmd === 'toggle-bot' && c.payload.enabled === false);
    assert.ok(pauseCmd, 'Guest must receive pause command');
});
