const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function dashboard(config) {
    const events = {};
    const inputs = new Map();
    const sent = [];
    const saved = [];
    const game = {
        addEventListener: (type, fn) => { events[type] = fn; },
        send: (_channel, command) => { sent.push(structuredClone(command)); },
    };
    const window = {
        addEventListener: (type, fn) => { events[type] = fn; },
        electronAPI: {
            getConfig: async () => config,
            saveConfig: async candidate => { saved.push(structuredClone(candidate)); return true; },
            onHostCommand: fn => { events.hostCommand = fn; },
        },
    };
    const context = vm.createContext({ window, console, document: {
        getElementById(id) {
            if (id === 'game-view') return game;
            if (!id.startsWith('cfg-')) return null;
            if (!inputs.has(id)) inputs.set(id, {});
            return inputs.get(id);
        },
        querySelectorAll: () => [],
    } });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../app/app.js'), 'utf8'), context);
    return { events, inputs, sent, saved, window, context };
}

test('engine auto-pause invalidates settings already waiting for persistence', async () => {
    const app = dashboard({ enabled: true, auto_idle: false });
    await app.events.DOMContentLoaded();
    app.events['dom-ready']();
    let completeSave;
    let saves = 0;
    app.window.electronAPI.saveConfig = () => ++saves === 1
        ? new Promise(resolve => { completeSave = resolve; })
        : Promise.resolve(true);

    const saving = app.window.saveBotSettings();
    app.window.handleTelemetry({ config: { enabled: false, auto_idle: false } });
    const sendsAfterPause = app.sent.length;
    completeSave(true);
    await saving;

    assert.equal(app.window.getCurrentConfig().enabled, false,
        'The pending settings must not replace the engine pause with an older active config');
    assert.equal(app.sent.slice(sendsAfterPause).some(command => command.payload.enabled === true), false);
});

test('failed radar behavior save restores both dropdowns before the next general save', async () => {
    const app = dashboard({ enabled: false, target_mode: 'all', target_species: [], unselected_action: 'battle' });
    await app.events.DOMContentLoaded();
    app.events['dom-ready']();
    app.window.handleTelemetry({ currentMap: 'route_test', availableSpecies: [] });
    app.window.electronAPI.saveConfig = async () => false;

    app.inputs.get('cfg-unselected-action-radar').value = 'flee';
    app.window.onRadarUnselectedActionChange('flee');
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(app.inputs.get('cfg-unselected-action-radar').value, 'battle');
    assert.equal(app.inputs.get('cfg-unselected-action').value, 'battle',
        'A failed immediate save must not leave the other copy of the field at an unapplied value');
    app.window.electronAPI.saveConfig = async config => { app.saved.push(structuredClone(config)); return true; };
    await app.window.saveBotSettings();
    assert.equal(app.saved.at(-1).unselected_action, 'battle');
});

test('main safety pause cancels an activation waiting for persistence', async () => {
    const app = dashboard({ enabled: false, auto_idle: true });
    await app.events.DOMContentLoaded();
    app.events['dom-ready']();
    let completeSave;
    app.window.electronAPI.saveConfig = () => new Promise(resolve => { completeSave = resolve; });
    const activation = app.window.toggleBotState();
    app.events.hostCommand({ cmd: 'toggle-bot', payload: { enabled: false, auto_idle: false, reason: 'suspend' } });
    const sendsAfterPause = app.sent.length;
    completeSave(true);
    await activation;
    assert.equal(app.window.getCurrentConfig().enabled, false);
    assert.equal(app.window.getCurrentConfig().auto_idle, false);
    assert.equal(app.sent.slice(sendsAfterPause).some(command => command.payload.enabled === true), false);
});
