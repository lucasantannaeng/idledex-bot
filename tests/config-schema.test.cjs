const test = require('node:test');
const assert = require('node:assert/strict');
const { SCHEMA_VERSION, DEFAULT_CONFIG, normalizeConfig } = require('../electron/config-schema');
const { createEngine } = require('./engine-harness.cjs');

test('T05: engine rejects invalid enabled values at its own configuration boundary', () => {
    const engine = createEngine();
    engine.configure({ enabled: 'false', discard_iv_pct: -20, roam_step_delay_ms: 1 });
    assert.equal(engine.state().config.enabled, false);
});

test('T05: persisted roam delay respects the same 220ms minimum as the engine and UI', () => {
    for (const delay of [0, 205, 219]) {
        const config = normalizeConfig({ schemaVersion: SCHEMA_VERSION, roam_step_delay_ms: delay });
        assert.equal(config.roam_step_delay_ms, 220, `Requested ${delay}ms must persist the actual minimum`);
    }
    assert.equal(normalizeConfig({ roam_step_delay_ms: 300 }).roam_step_delay_ms, 300);
});

test('T05: an unrelated partial update preserves an existing pinned species', () => {
    const previous = normalizeConfig({ pinned_species: 'pikachu', roam_step_delay_ms: 300 });
    const updated = normalizeConfig({ roam_step_delay_ms: 400 }, previous);
    assert.equal(updated.roam_step_delay_ms, 400);
    assert.equal(updated.pinned_species, 'pikachu');
    assert.equal(previous.pinned_species, 'pikachu');
});

test('T05: explicitly clearing the pinned species still removes the previous pin', () => {
    const previous = normalizeConfig({ pinned_species: 'pikachu' });
    assert.equal(normalizeConfig({ pinned_species: null }, previous).pinned_species, null);
    assert.equal(normalizeConfig({ pinned_species: '' }, previous).pinned_species, null);
});

test('T13: a fresh profile starts paused with automatic discard disabled', () => {
    const config = normalizeConfig({});
    assert.equal(config.enabled, false);
    assert.equal(config.discard_iv_pct, 0);
    assert.equal(DEFAULT_CONFIG.discard_iv_pct, 0);
});

test('T13: migration preserves an existing explicit discard preference', () => {
    assert.equal(normalizeConfig({ discard_iv_pct: 50 }).discard_iv_pct, 50);
    assert.equal(normalizeConfig({ discard_iv_pct: 0 }).discard_iv_pct, 0);
});

test('T05: current-schema HP fractions clamp out-of-range input without guessing percent units', () => {
    const config = normalizeConfig({
        schemaVersion: SCHEMA_VERSION,
        flee_hp_pct: 30,
        potion_hp_pct: 35,
        catch_hp_pct: 50,
    });
    assert.equal(config.flee_hp_pct, 1);
    assert.equal(config.potion_hp_pct, 1);
    assert.equal(config.catch_hp_pct, 1);
});

test('T05: valid HP fractions and zero thresholds survive normalization', () => {
    const config = normalizeConfig({
        schemaVersion: SCHEMA_VERSION,
        flee_hp_pct: 0,
        potion_hp_pct: 0.35,
        catch_hp_pct: 1,
    });
    assert.equal(config.flee_hp_pct, 0);
    assert.equal(config.potion_hp_pct, 0.35);
    assert.equal(config.catch_hp_pct, 1);
});

