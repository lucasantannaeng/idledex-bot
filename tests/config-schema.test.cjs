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

test('Phase 21: IV evaluation mode, individual min_ivs, and nature normalization', () => {
    // 1. Defaults
    const defaultConfig = normalizeConfig({});
    assert.equal(defaultConfig.iv_evaluation_mode, 'percent');
    assert.deepEqual(defaultConfig.min_ivs, { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 });
    assert.equal(defaultConfig.desired_nature, 'any');
    assert.equal(defaultConfig.auto_box_cleanup, false);

    // 2. Custom values and stat clamping
    const custom = normalizeConfig({
        iv_evaluation_mode: 'individual',
        min_ivs: { hp: 31, atk: 25, def: 40, spa: -5, spd: 15, spe: 30 },
        desired_nature: 'Adamant',
        auto_box_cleanup: true
    });
    assert.equal(custom.iv_evaluation_mode, 'individual');
    assert.deepEqual(custom.min_ivs, { hp: 31, atk: 25, def: 31, spa: 0, spd: 15, spe: 30 });
    assert.equal(custom.desired_nature, 'adamant');
    assert.equal(custom.auto_box_cleanup, true);

    // 3. Competitive nature keyword
    assert.equal(normalizeConfig({ desired_nature: 'competitive' }).desired_nature, 'competitive');
    assert.equal(normalizeConfig({ desired_nature: 'INVALID_NATURE' }).desired_nature, 'any');
});

test('Phase 21: pinned_species supports up to 2 species and locks conflicting settings', () => {
    // 1. Array of 2 species
    const twoSpecies = normalizeConfig({
        pinned_species: ['Beldum', 'ABSOL'],
        auto_route_switch: true,
        catch_only_uncaught: true
    });
    assert.deepEqual(twoSpecies.pinned_species, ['beldum', 'absol']);
    // Conflict locks: farming IV disables auto route switch and catch only uncaught
    assert.equal(twoSpecies.auto_route_switch, false);
    assert.equal(twoSpecies.catch_only_uncaught, false);

    // 2. Array with more than 2 items is capped at 2
    const capped = normalizeConfig({ pinned_species: ['beldum', 'absol', 'mawile'] });
    assert.deepEqual(capped.pinned_species, ['beldum', 'absol']);

    // 3. Deduplication of species in pinned list
    const dedup = normalizeConfig({ pinned_species: ['beldum', 'beldum'] });
    assert.equal(dedup.pinned_species, 'beldum');

    // 4. Comma-separated string support
    const comma = normalizeConfig({ pinned_species: 'mawile, sableye' });
    assert.deepEqual(comma.pinned_species, ['mawile', 'sableye']);
});


