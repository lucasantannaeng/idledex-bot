/**
 * IdleDex Desktop — Centralized Configuration Schema (T05 / T07)
 * Defines canonical defaults, type checking, domain constraints,
 * schema versioning, and safe migrations.
 */

'use strict';

function createConfigSchema() {
const SCHEMA_VERSION = 1;

const DEFAULT_CONFIG = Object.freeze({
    schemaVersion: 1,
    enabled: false, // Fresh profile starts paused
    strategy_mode: 'balanced', // 'balanced' | 'collection' | 'monetize'
    flee_hp_pct: 0.30, // 0..1 (30%)
    potion_hp_pct: 0.35, // 0..1 (35%)
    potion_mode: 'smart', // 'smart' | 'potion' | 'super-potion' | 'hyper-potion' | 'max-potion'
    use_revive_battle: true,
    use_revive_overworld: true,
    auto_heal_center: true,
    catch_hp_pct: 0.50, // 0..1 (50%)
    catch_only_shiny: false,
    catch_only_uncaught: false,
    ball_priority: 'balanced', // 'balanced', 'economy', 'force_highest'
    move_selection_mode: 'smart', // 'smart', 'max_damage', 'first'
    target_species: [],
    target_mode: 'all', // 'all' | 'selected' | 'none'
    unselected_action: 'battle', // 'battle' | 'flee'
    min_iv_alert: 130, // 0..186
    discard_iv_pct: 0, // 0 disables automatic discard on a fresh profile
    protect_last_copy: true,
    pause_on_no_balls: true,
    roam_step_delay_ms: 300, // 220..5000
    auto_idle: true,
    auto_roam: true,
    auto_claim_dailies: true,
    auto_lock_valuable: true,
    auto_use_boosts: false,
    auto_npc_quests: true,
    auto_travel_deliveries: true,
    auto_travel_surplus_threshold: 5, // 1..100
    auto_route_switch: false,
    pinned_species: null,
    iv_evaluation_mode: 'percent', // 'percent' | 'individual'
    min_ivs: Object.freeze({ hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }),
    desired_nature: 'any', // 'any' | 'competitive' | specific nature
    min_quality: 'any', // 'any' | 'good' | 'great' | 'excellent' | 'superb' | 'perfect'
    auto_box_cleanup: false,
    close_to_tray: false,
});

const VALID_STRATEGY_MODES = new Set(['balanced', 'collection', 'monetize']);
const VALID_POTION_MODES = new Set(['smart', 'potion', 'super-potion', 'hyper-potion', 'max-potion']);
const VALID_BALL_PRIORITIES = new Set(['balanced', 'economy', 'force_highest']);
const VALID_MOVE_MODES = new Set(['smart', 'max_damage', 'first']);
const VALID_UNSELECTED_ACTIONS = new Set(['battle', 'flee']);
const VALID_TARGET_MODES = new Set(['all', 'selected', 'none']);
const VALID_IV_EVAL_MODES = new Set(['percent', 'individual']);
const VALID_QUALITIES = new Set(['any', 'good', 'great', 'excellent', 'superb', 'perfect']);
const VALID_NATURES = new Set([
    'any', 'competitive',
    'hardy', 'docile', 'serious', 'bashful', 'quirky',
    'lonely', 'brave', 'adamant', 'naughty',
    'bold', 'relaxed', 'impish', 'lax',
    'modest', 'mild', 'quiet', 'rash',
    'calm', 'gentle', 'sassy', 'careful',
    'timid', 'hasty', 'jolly', 'naive'
]);

function normalizeFraction(val, fallback, legacy = false) {
    if (typeof val !== 'number' || !Number.isFinite(val)) return fallback;
    if (val >= 0 && val <= 1) return val;
    if (legacy && val > 1 && val <= 100) return Math.round((val / 100) * 1000) / 1000;
    if (val < 0) return 0;
    return 1;
}

function normalizeInt(val, min, max, fallback) {
    if (typeof val !== 'number' || !Number.isFinite(val)) return fallback;
    const rounded = Math.round(val);
    return Math.max(min, Math.min(max, rounded));
}

function normalizeBool(val, fallback) {
    return typeof val === 'boolean' ? val : fallback;
}

function normalizeConfig(raw, fallback = DEFAULT_CONFIG) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return structuredClone(DEFAULT_CONFIG);
    }

    const base = { ...DEFAULT_CONFIG, ...(fallback && typeof fallback === 'object' && !Array.isArray(fallback) ? fallback : {}) };
    const out = {};
    const legacy = raw.schemaVersion === undefined || raw.schemaVersion === 0;

    out.schemaVersion = SCHEMA_VERSION;

    out.enabled = normalizeBool(raw.enabled, base.enabled);

    out.strategy_mode = typeof raw.strategy_mode === 'string' && VALID_STRATEGY_MODES.has(raw.strategy_mode)
        ? raw.strategy_mode : base.strategy_mode;

    out.flee_hp_pct = normalizeFraction(raw.flee_hp_pct, base.flee_hp_pct, legacy);
    out.potion_hp_pct = normalizeFraction(raw.potion_hp_pct, base.potion_hp_pct, legacy);
    out.potion_mode = typeof raw.potion_mode === 'string' && VALID_POTION_MODES.has(raw.potion_mode)
        ? raw.potion_mode : base.potion_mode;

    out.use_revive_battle = normalizeBool(raw.use_revive_battle, base.use_revive_battle);
    out.use_revive_overworld = normalizeBool(raw.use_revive_overworld, base.use_revive_overworld);
    out.auto_heal_center = normalizeBool(raw.auto_heal_center, base.auto_heal_center);

    out.catch_hp_pct = normalizeFraction(raw.catch_hp_pct, base.catch_hp_pct, legacy);
    out.catch_only_shiny = normalizeBool(raw.catch_only_shiny, base.catch_only_shiny);
    out.catch_only_uncaught = normalizeBool(raw.catch_only_uncaught, base.catch_only_uncaught);

    out.ball_priority = typeof raw.ball_priority === 'string' && VALID_BALL_PRIORITIES.has(raw.ball_priority)
        ? raw.ball_priority : base.ball_priority;
    out.move_selection_mode = typeof raw.move_selection_mode === 'string' && VALID_MOVE_MODES.has(raw.move_selection_mode)
        ? raw.move_selection_mode : base.move_selection_mode;

    if (Array.isArray(raw.target_species)) {
        const cleaned = [];
        const seen = new Set();
        for (const item of raw.target_species) {
            if (item != null) {
                const str = String(item).trim();
                if (str.length > 0 && !seen.has(str)) {
                    seen.add(str);
                    cleaned.push(str);
                }
            }
        }
        out.target_species = cleaned;
    } else {
        out.target_species = Array.isArray(base.target_species) ? [...base.target_species] : [];
    }

    if (typeof raw.target_mode === 'string' && VALID_TARGET_MODES.has(raw.target_mode)) {
        out.target_mode = raw.target_mode;
    } else if (raw.target_species !== undefined) {
        out.target_mode = out.target_species.length > 0 ? 'selected' : 'all';
    } else {
        out.target_mode = base.target_mode;
    }

    out.unselected_action = typeof raw.unselected_action === 'string' && VALID_UNSELECTED_ACTIONS.has(raw.unselected_action)
        ? raw.unselected_action : base.unselected_action;

    out.min_iv_alert = normalizeInt(raw.min_iv_alert, 0, 186, base.min_iv_alert);
    out.discard_iv_pct = normalizeInt(raw.discard_iv_pct, 0, 100, base.discard_iv_pct);
    out.protect_last_copy = normalizeBool(raw.protect_last_copy, base.protect_last_copy);
    out.pause_on_no_balls = normalizeBool(raw.pause_on_no_balls, base.pause_on_no_balls);

    out.roam_step_delay_ms = normalizeInt(raw.roam_step_delay_ms, 220, 5000, base.roam_step_delay_ms);

    out.auto_idle = normalizeBool(raw.auto_idle, base.auto_idle);
    out.auto_roam = normalizeBool(raw.auto_roam, base.auto_roam);
    out.auto_claim_dailies = normalizeBool(raw.auto_claim_dailies, base.auto_claim_dailies);
    out.auto_lock_valuable = normalizeBool(raw.auto_lock_valuable, base.auto_lock_valuable);
    out.auto_use_boosts = normalizeBool(raw.auto_use_boosts, base.auto_use_boosts);
    out.auto_npc_quests = normalizeBool(raw.auto_npc_quests, base.auto_npc_quests);
    out.auto_travel_deliveries = normalizeBool(raw.auto_travel_deliveries, base.auto_travel_deliveries);
    out.auto_travel_surplus_threshold = normalizeInt(raw.auto_travel_surplus_threshold, 1, 100, base.auto_travel_surplus_threshold);
    out.auto_route_switch = normalizeBool(raw.auto_route_switch, base.auto_route_switch);

    out.iv_evaluation_mode = typeof raw.iv_evaluation_mode === 'string' && VALID_IV_EVAL_MODES.has(raw.iv_evaluation_mode)
        ? raw.iv_evaluation_mode : (base.iv_evaluation_mode || 'percent');

    const rawMin = (raw.min_ivs && typeof raw.min_ivs === 'object') ? raw.min_ivs : (base.min_ivs || {});
    out.min_ivs = {
        hp: normalizeInt(rawMin.hp, 0, 31, 0),
        atk: normalizeInt(rawMin.atk, 0, 31, 0),
        def: normalizeInt(rawMin.def, 0, 31, 0),
        spa: normalizeInt(rawMin.spa ?? rawMin.spAtk, 0, 31, 0),
        spd: normalizeInt(rawMin.spd ?? rawMin.spDef, 0, 31, 0),
        spe: normalizeInt(rawMin.spe ?? rawMin.speed, 0, 31, 0),
    };

    const rawNat = typeof raw.desired_nature === 'string' ? raw.desired_nature.toLowerCase().trim() : '';
    out.desired_nature = VALID_NATURES.has(rawNat) ? rawNat : (base.desired_nature || 'any');

    const rawQual = typeof raw.min_quality === 'string' ? raw.min_quality.toLowerCase().trim() : '';
    out.min_quality = VALID_QUALITIES.has(rawQual) ? rawQual : (base.min_quality || 'any');

    out.auto_box_cleanup = normalizeBool(raw.auto_box_cleanup, base.auto_box_cleanup || false);

    if (raw.pinned_species === undefined) {
        out.pinned_species = base.pinned_species;
    } else if (Array.isArray(raw.pinned_species)) {
        const cleaned = [];
        const seen = new Set();
        for (const item of raw.pinned_species) {
            if (item != null) {
                const str = String(item).trim().toLowerCase();
                if (str.length > 0 && !seen.has(str)) {
                    seen.add(str);
                    cleaned.push(str);
                    if (cleaned.length >= 2) break;
                }
            }
        }
        out.pinned_species = cleaned.length === 0 ? null : (cleaned.length === 1 ? cleaned[0] : cleaned);
    } else if (raw.pinned_species != null && typeof raw.pinned_species === 'string') {
        const trimmed = raw.pinned_species.trim();
        if (!trimmed) {
            out.pinned_species = null;
        } else if (trimmed.includes(',')) {
            const parts = trimmed.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
            const unique = [...new Set(parts)].slice(0, 2);
            out.pinned_species = unique.length === 0 ? null : (unique.length === 1 ? unique[0] : unique);
        } else {
            out.pinned_species = trimmed.toLowerCase();
        }
    } else {
        out.pinned_species = null;
    }

    out.close_to_tray = normalizeBool(raw.close_to_tray, base.close_to_tray);

    // --- MUTUAL EXCLUSION / CONFLICT LOCKS ---
    // 1. When species are pinned for IV farming, auto route switch and catch-only-uncaught are locked
    const hasPinned = out.pinned_species != null &&
        (typeof out.pinned_species === 'string' ? out.pinned_species.length > 0 : out.pinned_species.length > 0);
    if (hasPinned) {
        out.auto_route_switch = false;
        out.catch_only_uncaught = false;
    }

    return out;
}

return {
    SCHEMA_VERSION,
    DEFAULT_CONFIG,
    normalizeConfig,
    normalizeFraction,
    normalizeInt,
    normalizeBool,
};

}

module.exports = { ...createConfigSchema(), createConfigSchema };
