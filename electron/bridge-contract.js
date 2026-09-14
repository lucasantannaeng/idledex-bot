'use strict';

// No Electron or Node dependencies: the same contract is bundled in the preload.
function createBridgeContract() {
    const channels = new Set(['game-telemetry', 'game-log']);
    const commands = new Set(['update-config', 'toggle-bot', 'manual-action']);
    const actions = new Set(['idle-start', 'idle-stop', 'claim-all', 'trigger-auto-travel']);
    const telemetryFields = new Set(['connected', 'autoTravel', 'inBattle', 'currentBattleId',
        'battleMoves', 'playerId', 'currentMap', 'currentMapName', 'currentMapBiome', 'mapStatus',
        'mapAvailable', 'routeSwitch', 'availableSpecies', 'lastCapturedMon', 'playerPos', 'onGrass',
        'myMon', 'enemyMon', 'entities', 'progress', 'inventory', 'itemEffects', 'wallet', 'collection',
        'team', 'config', 'sessionMetrics']);
    const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor']);
    const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

    function snapshot(value) {
        let nodes = 0;
        let characters = 0;
        const seen = new Set();
        function copy(input, depth) {
            if (++nodes > 100000 || depth > 12) throw new Error('Payload tree limit');
            if (input === null || typeof input === 'boolean' || input === undefined) return input;
            if (typeof input === 'string') {
                characters += input.length;
                if (input.length > 4096 || characters > 2 * 1024 * 1024) throw new Error('Payload string limit');
                return input;
            }
            if (typeof input === 'number' && Number.isFinite(input) && Math.abs(input) <= Number.MAX_SAFE_INTEGER) return input;
            if (typeof input !== 'object' || seen.has(input)) throw new Error('Unsupported payload value');
            seen.add(input);
            const keys = Object.keys(input);
            if (keys.length > 10000 || (Array.isArray(input) && input.length > 10000)) throw new Error('Payload collection limit');
            const result = Array.isArray(input) ? [] : {};
            for (const key of keys) {
                if (forbiddenKeys.has(key) || key.length > 256) throw new Error('Invalid payload key');
                const property = Object.getOwnPropertyDescriptor(input, key);
                if (!property || !Object.hasOwn(property, 'value')) throw new Error('Payload accessor');
                const copied = copy(property.value, depth + 1);
                if (copied !== undefined) result[key] = copied;
            }
            seen.delete(input);
            return result;
        }
        return copy(value, 0);
    }

    function telemetry(data) {
        if (!isRecord(data) || Object.keys(data).some(key => !telemetryFields.has(key))) return null;
        for (const key of ['connected', 'inBattle', 'mapAvailable', 'onGrass']) {
            if (data[key] !== undefined && typeof data[key] !== 'boolean') return null;
        }
        for (const key of ['battleMoves', 'availableSpecies', 'entities', 'team']) {
            if (data[key] !== undefined && !Array.isArray(data[key])) return null;
        }
        for (const key of ['autoTravel', 'routeSwitch', 'lastCapturedMon', 'playerPos', 'myMon',
            'enemyMon', 'progress', 'inventory', 'itemEffects', 'wallet', 'collection', 'config', 'sessionMetrics']) {
            if (data[key] !== undefined && data[key] !== null && !isRecord(data[key])) return null;
        }
        for (const key of ['currentMap', 'currentMapName', 'currentMapBiome', 'mapStatus']) {
            if (data[key] !== undefined && data[key] !== null && (typeof data[key] !== 'string' || data[key].length > 512)) return null;
        }
        if (data.config?.enabled !== undefined && typeof data.config.enabled !== 'boolean') return null;
        if (data.config?.auto_idle !== undefined && typeof data.config.auto_idle !== 'boolean') return null;
        if (data.wallet && Object.values(data.wallet).some(value => typeof value !== 'number' || value < 0)) return null;
        return data;
    }

    function fromGame(detail) {
        try {
            const message = snapshot(detail);
            if (!isRecord(message) || !channels.has(message.channel) || !isRecord(message.data)) return null;
            if (message.channel === 'game-telemetry') {
                const data = telemetry(message.data);
                return data ? { channel: message.channel, data } : null;
            }
            const { message: text, time, level = 'info' } = message.data;
            if (typeof text !== 'string' || text.length > 2048 ||
                (time !== undefined && (typeof time !== 'string' || time.length > 64)) ||
                !['info', 'warning', 'error', 'success'].includes(level)) return null;
            return { channel: 'game-log', data: { message: text, time, level } };
        } catch { return null; }
    }

    function fromHost(raw) {
        try {
            const message = snapshot(raw);
            if (!isRecord(message) || !commands.has(message.cmd) || !isRecord(message.payload)) return null;
            if (message.cmd === 'toggle-bot' && typeof message.payload.enabled !== 'boolean') return null;
            if (message.cmd === 'manual-action' && !actions.has(message.payload.action)) return null;
            return { cmd: message.cmd, payload: message.payload };
        } catch { return null; }
    }
    return { channels, commands, fromGame, fromHost };
}

module.exports = { createBridgeContract };
