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
    const game = { addEventListener(type, fn) { events[type] = fn; }, send(channel, command) { sent.push(structuredClone(command)); } };
    const window = { addEventListener(type, fn) { events[type] = fn; }, electronAPI: { getConfig: async () => config, saveConfig: async value => { saved.push(structuredClone(value)); return true; } } };
    const context = vm.createContext({ window, console, document: {
        getElementById(id) {
            if (id === 'game-view') return game;
            if (id.startsWith('cfg-')) { if (!inputs.has(id)) inputs.set(id, {}); return inputs.get(id); }
            return null;
        }, querySelectorAll: () => [],
    } });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../app/app.js'), 'utf8'), context);
    return { events, sent, saved, context, inputs, window };
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
