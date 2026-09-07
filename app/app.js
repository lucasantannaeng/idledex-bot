/**
 * IdleDex Desktop Suite v2.0 — App Frontend Controller
 * Manages split-screen webview orchestration, 20x20 tactical canvas radar,
 * combat HP visualization, telemetry state sync, and IPC commands.
 */

'use strict';

// Application State
let botEnabled = true;
let currentConfig = null;
let lastTelemetry = null;
let currentTargetSpecies = [];
let lastRenderedMapId = "";

// DOM Elements
const gameView = document.getElementById('game-view');
const botSidebar = document.getElementById('bot-sidebar');
const botStatusPill = document.getElementById('bot-status-pill');
const pillDot = document.getElementById('pill-dot');
const pillText = document.getElementById('pill-text');
const btnToggleBot = document.getElementById('btn-toggle-bot');
const shardIndicator = document.getElementById('shard-indicator');
const logFeed = document.getElementById('log-feed');
const radarCanvas = document.getElementById('radar-canvas');
const radarCoords = document.getElementById('radar-coords');
const entitiesList = document.getElementById('entities-list');

// Canvas Context
const radarCtx = radarCanvas ? radarCanvas.getContext('2d') : null;

// --- 1. INITIALIZATION ---

window.addEventListener('DOMContentLoaded', async () => {
    appendLog('Iniciando subsistemas da suíte desktop...', 'info');

    // Initialize Webview Preload and Navigation
    if (gameView) {
        if (window.electronAPI && window.electronAPI.gamePreloadPath) {
            gameView.preload = window.electronAPI.gamePreloadPath;
            appendLog('Preload autônomo acoplado ao Webview.', 'info');
        }
        gameView.src = 'https://idledex.com/play';

        // Listen for IPC messages from guest preload
        gameView.addEventListener('ipc-message', (event) => {
            if (event.channel === 'game-telemetry') {
                handleTelemetry(event.args[0]);
            } else if (event.channel === 'game-log') {
                const { time, message, level } = event.args[0] || {};
                appendLog(message, level, time);
            }
        });

        gameView.addEventListener('dom-ready', () => {
            appendLog('🎮 Interface oficial IdleDex carregada com sucesso.', 'success');
        });

        gameView.addEventListener('did-fail-load', (e) => {
            if (e.errorCode !== -3) { // ignore aborts
                appendLog(`⚠️ Falha ao conectar ao servidor do jogo: ${e.errorDescription} (${e.errorCode})`, 'error');
            }
        });

        gameView.addEventListener('console-message', (e) => {
            // Suppress internal harmless server codes matching upstream client logic
            if (e.message.includes('bad_message') || e.message.includes('in_battle_move') || e.message.includes('chat_empty')) {
                return;
            }
            if (e.message.includes('[IdleDex') || e.message.includes('WebSocket') || e.level >= 2) {
                appendLog(`[Jogo] ${e.message}`, e.level >= 2 ? 'warning' : 'info');
            }
        });
    }

    // Load Bot Configuration
    if (window.electronAPI && window.electronAPI.getConfig) {
        try {
            currentConfig = await window.electronAPI.getConfig();
            applyConfigToInputs(currentConfig);
            if (currentConfig.enabled !== undefined) {
                setBotEnabledState(currentConfig.enabled);
            }
        } catch (err) {
            console.error('Falha ao carregar configurações:', err);
        }
    }

    // Listen for System Tray Bot Toggle
    if (window.electronAPI && window.electronAPI.onToggleBotTray) {
        window.electronAPI.onToggleBotTray(() => {
            toggleBotState();
        });
    }

    // Render Initial Empty Radar Grid
    drawRadar([], { x: 0, y: 0 });
});

// --- 2. TELEMETRY & DATA DISPATCH ---

function handleTelemetry(data) {
    if (!data) return;
    lastTelemetry = data;

    // Update Bot Status Pill
    if (data.config && data.config.enabled !== undefined && data.config.enabled !== botEnabled) {
        setBotEnabledState(data.config.enabled);
    }

    // Shard / Map indicator
    if (shardIndicator) {
        const mapTitle = data.currentMapName || data.currentMap || "Mapa Desconhecido";
        shardIndicator.textContent = `📍 ${mapTitle}`;
    }

    // Area Spawns & Map Badge
    updateAreaSpawnsUI(data);

    // Last Capture Evaluation
    if (data.lastCapturedMon) {
        updateLastCaptureUI(data.lastCapturedMon);
    }

    // Radar & Entities
    if (data.playerPos && data.playerPos.x !== null) {
        if (radarCoords) {
            let grassTag = "";
            if (data.onGrass) {
                const biome = String(data.currentMapBiome || "").toLowerCase();
                if (biome.includes("cave")) grassTag = " 🪨 [Caverna Selvagem]";
                else if (biome.includes("volcano")) grassTag = " 🌋 [Solo Vulcânico]";
                else if (biome.includes("beach") || biome.includes("desert")) grassTag = " 🏖️ [Areia Selvagem]";
                else if (biome.includes("snow") || biome.includes("glacier")) grassTag = " ❄️ [Neve Alta]";
                else if (biome.includes("lake") || biome.includes("water") || biome.includes("swamp")) grassTag = " 🌾 [Juncos / Margem]";
                else grassTag = " 🌿 [Grama Alta]";
            }
            radarCoords.textContent = `Pos: (${data.playerPos.x}, ${data.playerPos.y})${grassTag}`;
        }
        drawRadar(data.entities || [], data.playerPos);
    } else {
        drawRadar(data.entities || [], { x: 0, y: 0 });
    }
    updateEntitiesList(data.entities || [], data.playerPos);

    // Combat State
    updateCombatUI(data);

    // Trainer Stats
    updateStatsUI(data.progress || {}, data.wallet || {});

    // Inventory
    updateInventoryUI(data.inventory || {});
}

// --- 3. RADAR RENDERING (20x20 Grid) ---

function drawRadar(entities, playerPos) {
    if (!radarCtx || !radarCanvas) return;

    const w = radarCanvas.width;
    const h = radarCanvas.height;
    const gridSize = 20; // 20x20 tiles
    const cellSize = w / gridSize; // 14px per cell

    // Clear background
    radarCtx.fillStyle = '#0a0e17';
    radarCtx.fillRect(0, 0, w, h);

    // Draw Subtle Grid
    radarCtx.strokeStyle = 'rgba(30, 41, 59, 0.7)';
    radarCtx.lineWidth = 1;
    for (let i = 0; i <= gridSize; i++) {
        radarCtx.beginPath();
        radarCtx.moveTo(i * cellSize, 0);
        radarCtx.lineTo(i * cellSize, h);
        radarCtx.stroke();

        radarCtx.beginPath();
        radarCtx.moveTo(0, i * cellSize);
        radarCtx.lineTo(w, i * cellSize);
        radarCtx.stroke();
    }

    // Draw Radar Sweep / Center Rings
    const centerX = w / 2;
    const centerY = h / 2;

    radarCtx.strokeStyle = 'rgba(6, 182, 212, 0.18)';
    radarCtx.beginPath();
    radarCtx.arc(centerX, centerY, cellSize * 4, 0, Math.PI * 2);
    radarCtx.stroke();

    radarCtx.strokeStyle = 'rgba(6, 182, 212, 0.1)';
    radarCtx.beginPath();
    radarCtx.arc(centerX, centerY, cellSize * 8, 0, Math.PI * 2);
    radarCtx.stroke();

    // Render Entities relative to Player
    const px = playerPos.x !== null ? playerPos.x : 0;
    const py = playerPos.y !== null ? playerPos.y : 0;
    const halfGrid = gridSize / 2;

    if (Array.isArray(entities)) {
        for (const ent of entities) {
            if (ent.is_player || ent.x === null || ent.y === null) continue;

            // Compute relative grid coordinates
            const relX = ent.x - px;
            const relY = ent.y - py;

            // Check if within visible grid (-10 to +10)
            if (Math.abs(relX) <= halfGrid && Math.abs(relY) <= halfGrid) {
                const screenX = centerX + (relX * cellSize);
                const screenY = centerY + (relY * cellSize);

                if (ent.is_enemy) {
                    // Wild Pokémon / Enemy: Glowing Red/Rose
                    radarCtx.fillStyle = '#f43f5e';
                    radarCtx.shadowColor = '#f43f5e';
                    radarCtx.shadowBlur = 8;
                    radarCtx.beginPath();
                    radarCtx.arc(screenX, screenY, 4, 0, Math.PI * 2);
                    radarCtx.fill();
                    radarCtx.shadowBlur = 0;
                } else {
                    // NPC or Other Player: Slate Blue
                    radarCtx.fillStyle = '#64748b';
                    radarCtx.beginPath();
                    radarCtx.arc(screenX, screenY, 3, 0, Math.PI * 2);
                    radarCtx.fill();
                }
            }
        }
    }

    // Render Player at exact center: Glowing Cyan/Blue
    radarCtx.fillStyle = '#3b82f6';
    radarCtx.shadowColor = '#06b6d4';
    radarCtx.shadowBlur = 10;
    radarCtx.beginPath();
    radarCtx.arc(centerX, centerY, 5, 0, Math.PI * 2);
    radarCtx.fill();
    radarCtx.shadowBlur = 0;

    // Player Center Core
    radarCtx.fillStyle = '#38bdf8';
    radarCtx.beginPath();
    radarCtx.arc(centerX, centerY, 2, 0, Math.PI * 2);
    radarCtx.fill();
}

function updateEntitiesList(entities, playerPos) {
    if (!entitiesList) return;

    if (!Array.isArray(entities) || entities.length === 0) {
        entitiesList.innerHTML = '<div style="color:var(--text-dim);">Nenhuma entidade detectada no alcance.</div>';
        return;
    }

    const px = playerPos && playerPos.x !== null ? playerPos.x : 0;
    const py = playerPos && playerPos.y !== null ? playerPos.y : 0;

    const enemies = entities
        .filter(e => e.is_enemy && e.x !== null && e.y !== null)
        .map(e => {
            const dist = Math.abs(e.x - px) + Math.abs(e.y - py);
            return { ...e, dist };
        })
        .sort((a, b) => a.dist - b.dist);

    if (enemies.length === 0) {
        entitiesList.innerHTML = '<div style="color:var(--text-dim);">Área limpa de criaturas selvagens.</div>';
        return;
    }

    let html = '';
    for (const foe of enemies.slice(0, 6)) {
        const cleanName = foe.name.replace(/^Wild:\s*/i, '').replace(/^Foe:\s*/i, '');
        html += `
            <div style="display:flex; justify-content:space-between; align-items:center; background:rgba(15,23,42,0.6); padding:4px 8px; border-radius:4px; border-left:2px solid var(--rose);">
                <span style="color:var(--text-bright); font-weight:500;">${escapeHtml(cleanName)}</span>
                <span style="font-family:var(--font-mono); color:var(--cyan); font-size:0.72rem;">${foe.dist}m (${foe.x}, ${foe.y})</span>
            </div>
        `;
    }
    entitiesList.innerHTML = html;
}

// --- 3.1 AREA SPAWNS & CAPTURE TARGETS UI ---

function updateAreaSpawnsUI(data) {
    const badgeEl = document.getElementById('current-map-badge');
    const listEl = document.getElementById('area-species-list');
    const unselectedRadar = document.getElementById('cfg-unselected-action-radar');

    if (badgeEl) {
        badgeEl.textContent = data.currentMapName || data.currentMap || "Aguardando Mapa...";
    }

    if (unselectedRadar && currentConfig && currentConfig.unselected_action) {
        unselectedRadar.value = currentConfig.unselected_action;
    }

    if (!listEl) return;

    const mapId = data.currentMap || "";
    const species = Array.isArray(data.availableSpecies) ? data.availableSpecies : [];

    if (species.length === 0) {
        if (!mapId) {
            listEl.innerHTML = '<div style="color:var(--text-dim); font-size:0.75rem;">Aguardando conexão com o jogo...</div>';
        } else {
            listEl.innerHTML = '<div style="color:var(--text-dim); font-size:0.75rem;">Nenhuma criatura selvagem nesta área.</div>';
        }
        return;
    }

    // Only re-render list if map changed or list was empty to preserve scroll/input state
    if (mapId !== lastRenderedMapId || listEl.children.length <= 1) {
        lastRenderedMapId = mapId;

        let html = '';
        for (const sp of species) {
            const sid = sp.speciesId || "";
            const isChecked = currentTargetSpecies.length === 0 || currentTargetSpecies.includes(sid);
            const freqBadge = sp.frequency ? `<span style="font-size:0.68rem; padding:1px 5px; border-radius:3px; background:rgba(30,41,59,0.8); color:var(--cyan);">${sp.frequency}</span>` : '';
            const caughtIco = sp.caught ? `<span title="Registrado na Pokédex" style="font-size:0.72rem;">📕</span>` : '';

            html += `
                <label style="display:flex; justify-content:space-between; align-items:center; background:rgba(15,23,42,0.5); padding:3px 7px; border-radius:4px; cursor:pointer; font-size:0.76rem;">
                    <div style="display:flex; align-items:center; gap:6px;">
                        <input type="checkbox" value="${escapeHtml(sid)}" ${isChecked ? 'checked' : ''} onchange="onAreaSpeciesToggle('${escapeHtml(sid)}', this.checked)">
                        <span style="color:var(--text-bright); font-weight:500;">${escapeHtml(sp.name || sid)}</span>
                        ${caughtIco}
                    </div>
                    <div style="display:flex; align-items:center; gap:5px;">
                        <span style="color:var(--text-dim); font-size:0.70rem;">Lv${sp.minLevel}-${sp.maxLevel}</span>
                        ${freqBadge}
                    </div>
                </label>
            `;
        }
        listEl.innerHTML = html;
    }
}

function onAreaSpeciesToggle(speciesId, isChecked) {
    if (!speciesId) return;
    const allCheckboxes = Array.from(document.querySelectorAll('#area-species-list input[type="checkbox"]'));
    const checkedValues = allCheckboxes.filter(cb => cb.checked).map(cb => cb.value);

    // If all are checked, we can store empty array to mean 'all' or explicit list
    currentTargetSpecies = checkedValues;
    saveAreaSettings();
}

function selectAllAreaSpecies(selectAll) {
    const allCheckboxes = Array.from(document.querySelectorAll('#area-species-list input[type="checkbox"]'));
    allCheckboxes.forEach(cb => { cb.checked = !!selectAll; });
    currentTargetSpecies = selectAll ? allCheckboxes.map(cb => cb.value) : [];
    saveAreaSettings();
}

function onRadarUnselectedActionChange(val) {
    const configSelect = document.getElementById('cfg-unselected-action');
    if (configSelect) configSelect.value = val;
    saveAreaSettings();
}

async function saveAreaSettings() {
    const unselectedAction = getVal('cfg-unselected-action-radar') || getVal('cfg-unselected-action') || 'battle';
    if (!currentConfig) currentConfig = {};
    currentConfig.target_species = currentTargetSpecies;
    currentConfig.unselected_action = unselectedAction;

    // Persist
    if (window.electronAPI && window.electronAPI.saveConfig) {
        await window.electronAPI.saveConfig(currentConfig);
    }
    if (gameView) {
        gameView.send('host-command', { cmd: 'update-config', payload: currentConfig });
    }
    const actionDesc = unselectedAction === 'flee' ? 'Fugir Imediatamente' : 'Batalhar por XP';
    appendLog(`🎯 Alvos da área atualizados: ${currentTargetSpecies.length > 0 ? currentTargetSpecies.join(', ') : 'Todos'} | Não selecionados: ${actionDesc}`, 'info');
}

// --- 3.2 LAST CAPTURE EVALUATION UI ---

function updateLastCaptureUI(mon) {
    if (!mon) return;
    const gradeBadge = document.getElementById('last-cap-grade');
    const bodyEl = document.getElementById('last-cap-body');

    if (gradeBadge) {
        gradeBadge.textContent = `Grau ${mon.grade || 'C'}`;
        if (mon.grade === 'S') {
            gradeBadge.style.background = 'var(--emerald)';
            gradeBadge.style.color = '#000';
        } else if (mon.grade === 'A') {
            gradeBadge.style.background = 'var(--cyan)';
            gradeBadge.style.color = '#000';
        } else {
            gradeBadge.style.background = 'var(--slate)';
            gradeBadge.style.color = 'var(--text-bright)';
        }
    }

    if (bodyEl) {
        const star = mon.isShiny ? ' ✨SHINY' : '';
        const bestNatBadge = mon.isBestNature 
            ? `<span style="color:var(--emerald); font-weight:bold;">${mon.nature} (⭐ TOP NATURE!)</span>`
            : `<span style="color:var(--cyan);">${mon.nature}</span>`;
        
        bodyEl.innerHTML = `
            <div style="font-size:0.82rem; font-weight:600; color:var(--text-bright); margin-bottom:3px;">
                ${escapeHtml(mon.name)}${star} <span style="color:var(--text-dim); font-size:0.72rem;">Lv${mon.level}</span>
            </div>
            <div style="display:flex; justify-content:space-between; margin-bottom:3px;">
                <span>Nature: ${bestNatBadge}</span>
                <span style="font-family:var(--font-mono); color:var(--text-bright);">IV: <b>${mon.ivTotal}</b>/186 (${mon.ivPct}%)</span>
            </div>
            <div style="font-size:0.70rem; font-family:var(--font-mono); color:var(--text-dim); display:flex; gap:6px;">
                <span>HP:${mon.ivs.hp}</span> <span>ATK:${mon.ivs.atk}</span> <span>DEF:${mon.ivs.def}</span>
                <span>SPA:${mon.ivs.spa}</span> <span>SPD:${mon.ivs.spd}</span> <span>SPE:${mon.ivs.spe}</span>
            </div>
        `;
    }
}

// --- 4. COMBAT VISUALIZATION ---

function updateCombatUI(data) {
    const statusEl = document.getElementById('combat-status');
    const enemyNameEl = document.getElementById('combat-enemy-name');
    const enemyHpText = document.getElementById('combat-enemy-hp-text');
    const enemyHpBar = document.getElementById('combat-enemy-hp-bar');
    const playerNameEl = document.getElementById('combat-player-name');
    const playerHpText = document.getElementById('combat-player-hp-text');
    const playerHpBar = document.getElementById('combat-player-hp-bar');

    if (!statusEl) return;

    if (data.inBattle && data.enemyMon) {
        statusEl.textContent = '⚔️ Em Batalha';
        statusEl.style.color = 'var(--rose)';

        const opp = data.enemyMon;
        const oppName = opp.name || opp.species || 'Criatura Selvagem';
        const oppHp = opp.hpPercent !== undefined ? Math.round(opp.hpPercent * 100) : 100;
        const isShiny = !!(opp.isShiny || opp.shiny);
        const isUncaught = (opp.species && data.collection) ? !data.collection[opp.species] : false;

        let badgeStr = '';
        if (isShiny) badgeStr += ' ✨SHINY';
        if (isUncaught) badgeStr += ' 📕NOVO';

        if (enemyNameEl) enemyNameEl.textContent = `${oppName} (Nv. ${opp.level || '?'})${badgeStr}`;
        if (enemyHpText) enemyHpText.textContent = `${oppHp}%`;
        if (enemyHpBar) enemyHpBar.style.width = `${Math.max(0, Math.min(100, oppHp))}%`;
    } else {
        statusEl.textContent = '🛡️ Em Espera';
        statusEl.style.color = 'var(--emerald)';

        if (enemyNameEl) enemyNameEl.textContent = 'Nenhum Oponente';
        if (enemyHpText) enemyHpText.textContent = '--';
        if (enemyHpBar) enemyHpBar.style.width = '0%';
    }

    if (data.myMon) {
        const mon = data.myMon;
        const monName = mon.name || mon.species || 'Seu Pokémon';
        const monHp = mon.hpPercent !== undefined ? Math.round(mon.hpPercent * 100) : 100;

        if (playerNameEl) playerNameEl.textContent = monName;
        if (playerHpText) playerHpText.textContent = `${monHp}%`;
        if (playerHpBar) playerHpBar.style.width = `${Math.max(0, Math.min(100, monHp))}%`;
    }
}

// --- 5. STATS & INVENTORY ---

function updateStatsUI(progress, wallet) {
    setText('stat-rank', progress.rank ?? 1);
    setText('stat-xp', (progress.xp ?? 0).toLocaleString('pt-BR'));
    setText('stat-wins', (progress.wins ?? 0).toLocaleString('pt-BR'));
    setText('stat-losses', (progress.losses ?? 0).toLocaleString('pt-BR'));
    setText('stat-captures', (progress.captures ?? 0).toLocaleString('pt-BR'));
    setText('stat-shinies', progress.shinies ?? 0);

    const silver = wallet.silver ?? wallet.coins ?? 0;
    const gold = wallet.gold ?? wallet.crystals ?? 0;
    setText('wallet-silver', silver.toLocaleString('pt-BR'));
    setText('wallet-gold', gold.toLocaleString('pt-BR'));
    setText('wallet-coins', silver.toLocaleString('pt-BR'));
    setText('wallet-crystals', gold.toLocaleString('pt-BR'));
}

function updateInventoryUI(inventory) {
    const balls = inventory.ball || {};
    const potions = inventory.potions || {};
    const revives = inventory.revives || {};

    setText('inv-pokeball', (balls.pokeball ?? 0).toLocaleString('pt-BR'));
    setText('inv-greatball', (balls.greatball ?? 0).toLocaleString('pt-BR'));
    setText('inv-superball', (balls.superball ?? 0).toLocaleString('pt-BR'));
    setText('inv-ultraball', (balls.ultraball ?? 0).toLocaleString('pt-BR'));
    setText('inv-masterball', (balls.masterball ?? 0).toLocaleString('pt-BR'));

    setText('inv-potion-basic', (potions.potion ?? 0).toLocaleString('pt-BR'));
    setText('inv-potion-super', (potions['super-potion'] ?? 0).toLocaleString('pt-BR'));
    setText('inv-potion-hyper', (potions['hyper-potion'] ?? 0).toLocaleString('pt-BR'));
    setText('inv-potion-max', (potions['max-potion'] ?? 0).toLocaleString('pt-BR'));

    setText('inv-revive', (revives.revive ?? 0).toLocaleString('pt-BR'));
    setText('inv-max-revive', (revives['max-revive'] ?? 0).toLocaleString('pt-BR'));

    const boosts = inventory.boosts || {};
    setText('inv-boost-shiny', (boosts['shiny-boost'] ?? 0).toLocaleString('pt-BR'));
    setText('inv-boost-xp', (boosts['xp-share-boost'] ?? 0).toLocaleString('pt-BR'));
    setText('inv-boost-capture', (boosts['capture-boost'] ?? 0).toLocaleString('pt-BR'));
    setText('inv-boost-map', (boosts['map-boost'] ?? 0).toLocaleString('pt-BR'));
}

function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

// --- 6. USER CONTROLS & IPC DISPATCH ---

function toggleBotState() {
    botEnabled = !botEnabled;
    setBotEnabledState(botEnabled);

    // Send command to guest webview
    if (gameView) {
        gameView.send('host-command', { cmd: 'toggle-bot', payload: { enabled: botEnabled } });
    }
}

function setBotEnabledState(enabled) {
    botEnabled = enabled;
    if (botStatusPill && pillDot && pillText && btnToggleBot) {
        if (botEnabled) {
            botStatusPill.className = 'status-pill';
            pillDot.style.color = 'var(--emerald)';
            pillText.textContent = 'BOT ATIVO';
            btnToggleBot.textContent = '⏸️ Pausar Bot';
            btnToggleBot.className = 'tb-btn primary';
        } else {
            botStatusPill.className = 'status-pill paused';
            pillDot.style.color = 'var(--amber)';
            pillText.textContent = 'BOT PAUSADO';
            btnToggleBot.textContent = '▶️ Iniciar Bot';
            btnToggleBot.className = 'tb-btn';
        }
    }
}

function toggleSidebar() {
    if (botSidebar) {
        botSidebar.classList.toggle('collapsed');
    }
}

function switchPanel(panelId) {
    // Switch tabs
    const tabs = document.querySelectorAll('.s-tab');
    tabs.forEach(tab => {
        const isTarget = tab.getAttribute('onclick')?.includes(`'${panelId}'`);
        tab.classList.toggle('active', isTarget);
    });

    // Switch panels
    const panels = document.querySelectorAll('.panel');
    panels.forEach(p => {
        p.classList.toggle('active', p.id === `panel-${panelId}`);
    });
}

function minimizeToTray() {
    if (window.electronAPI && window.electronAPI.minimizeToTray) {
        window.electronAPI.minimizeToTray();
    }
}

// --- 7. CONFIGURATION LOGIC ---

function applyConfigToInputs(cfg) {
    if (!cfg) return;
    setVal('cfg-strategy', cfg.strategy_mode || 'balanced');
    setVal('cfg-iv-col', cfg.iv_collection_threshold || 150);
    setVal('cfg-iv-sell', cfg.iv_sell_threshold || 120);
    setVal('cfg-flee', Math.round((cfg.flee_hp_pct || 0.30) * 100));
    setVal('cfg-potion', Math.round((cfg.potion_hp_pct || 0.35) * 100));
    setVal('cfg-potion-mode', cfg.potion_mode || 'smart');
    setVal('cfg-unselected-action', cfg.unselected_action || 'battle');
    setVal('cfg-unselected-action-radar', cfg.unselected_action || 'battle');
    if (Array.isArray(cfg.target_species)) {
        currentTargetSpecies = cfg.target_species;
    }
    setCheck('cfg-revive-battle', cfg.use_revive_battle !== false);
    setCheck('cfg-revive-overworld', cfg.use_revive_overworld !== false);
    setCheck('cfg-auto-heal-center', cfg.auto_heal_center !== false);

    setVal('cfg-catch', Math.round((cfg.catch_hp_pct || 0.50) * 100));
    setCheck('cfg-only-shiny', !!cfg.catch_only_shiny);
    setCheck('cfg-only-uncaught', !!cfg.catch_only_uncaught);
    setVal('cfg-ball-priority', cfg.ball_priority || 'balanced');
    setVal('cfg-move-mode', cfg.move_selection_mode || 'smart');
    setVal('cfg-roam-delay', cfg.roam_step_delay_ms || 300);

    setCheck('cfg-auto-roam', cfg.auto_roam !== false);
    setCheck('cfg-auto-idle', cfg.auto_idle !== false);
    const discardPct = cfg.discard_iv_pct !== undefined ? cfg.discard_iv_pct : 50;
    setVal('cfg-discard-iv-pct', discardPct);
    const lblDiscard = document.getElementById('lbl-discard-iv-pct');
    if (lblDiscard) lblDiscard.innerText = discardPct + '%';
    setCheck('cfg-pause-no-balls', cfg.pause_on_no_balls !== false);
    setCheck('cfg-auto-dailies', cfg.auto_claim_dailies !== false);
    setCheck('cfg-auto-lock', cfg.auto_lock_valuable !== false);
    setCheck('cfg-auto-npc-quests', cfg.auto_npc_quests !== false);
    setCheck('cfg-auto-travel-deliveries', cfg.auto_travel_deliveries !== false);
    setVal('cfg-auto-travel-surplus', cfg.auto_travel_surplus_threshold || 5);
    setCheck('cfg-auto-boosts', !!cfg.auto_use_boosts);
}

async function saveBotSettings() {
    const updated = {
        enabled: botEnabled,
        strategy_mode: getVal('cfg-strategy'),
        iv_collection_threshold: parseInt(getVal('cfg-iv-col'), 10) || 150,
        iv_sell_threshold: parseInt(getVal('cfg-iv-sell'), 10) || 120,
        flee_hp_pct: (parseInt(getVal('cfg-flee'), 10) || 30) / 100,
        potion_hp_pct: (parseInt(getVal('cfg-potion'), 10) || 35) / 100,
        potion_mode: getVal('cfg-potion-mode') || 'smart',
        use_revive_battle: getCheck('cfg-revive-battle'),
        use_revive_overworld: getCheck('cfg-revive-overworld'),
        auto_heal_center: getCheck('cfg-auto-heal-center'),
        catch_hp_pct: (parseInt(getVal('cfg-catch'), 10) || 50) / 100,
        catch_only_shiny: getCheck('cfg-only-shiny'),
        catch_only_uncaught: getCheck('cfg-only-uncaught'),
        ball_priority: getVal('cfg-ball-priority') || 'balanced',
        move_selection_mode: getVal('cfg-move-mode') || 'smart',
        target_species: currentTargetSpecies || [],
        unselected_action: getVal('cfg-unselected-action') || getVal('cfg-unselected-action-radar') || 'battle',
        min_iv_alert: 130,
        roam_step_delay_ms: parseInt(getVal('cfg-roam-delay'), 10) || 300,
        discard_iv_pct: parseInt(getVal('cfg-discard-iv-pct'), 10) || 50,
        pause_on_no_balls: getCheck('cfg-pause-no-balls'),
        auto_roam: getCheck('cfg-auto-roam'),
        auto_idle: getCheck('cfg-auto-idle'),
        auto_claim_dailies: getCheck('cfg-auto-dailies'),
        auto_lock_valuable: getCheck('cfg-auto-lock'),
        auto_npc_quests: getCheck('cfg-auto-npc-quests'),
        auto_travel_deliveries: getCheck('cfg-auto-travel-deliveries'),
        auto_travel_surplus_threshold: parseInt(getVal('cfg-auto-travel-surplus'), 10) || 5,
        auto_use_boosts: getCheck('cfg-auto-boosts'),
    };

    currentConfig = updated;

    // Persist to main process
    if (window.electronAPI && window.electronAPI.saveConfig) {
        await window.electronAPI.saveConfig(updated);
    }

    // Push to guest webview
    if (gameView) {
        gameView.send('host-command', { cmd: 'update-config', payload: updated });
    }

    appendLog('💾 Parâmetros de estratégia salvos e aplicados ao jogo!', 'success');
}


function getVal(id) {
    const el = document.getElementById(id);
    return el ? el.value : '';
}

function setVal(id, val) {
    const el = document.getElementById(id);
    if (el) el.value = val;
}

function getCheck(id) {
    const el = document.getElementById(id);
    return el ? el.checked : false;
}

function setCheck(id, val) {
    const el = document.getElementById(id);
    if (el) el.checked = !!val;
}

// --- 8. LOGGING ---

function appendLog(message, level = 'info', customTime = null) {
    if (!logFeed) return;

    const time = customTime || new Date().toTimeString().split(' ')[0];
    const entry = document.createElement('div');
    entry.className = `log-entry ${level}`;
    entry.innerHTML = `<span style="color:var(--text-dim); font-family:var(--font-mono); margin-right:5px;">[${time}]</span> ${escapeHtml(message)}`;

    logFeed.appendChild(entry);

    // Limit log history to 120 entries
    while (logFeed.children.length > 120) {
        logFeed.removeChild(logFeed.firstChild);
    }

    // Auto-scroll to latest
    logFeed.scrollTop = logFeed.scrollHeight;
}

function clearLogs() {
    if (logFeed) {
        logFeed.innerHTML = '<div class="log-entry info"><span style="color:var(--text-dim);">[00:00:00]</span> Console limpo pelo usuário.</div>';
    }
}

function escapeHtml(str) {
    if (typeof str !== 'string') return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// Global Exports for Inline HTML OnClick handlers
window.toggleBotState = toggleBotState;
window.toggleSidebar = toggleSidebar;
window.switchPanel = switchPanel;
window.minimizeToTray = minimizeToTray;
window.saveBotSettings = saveBotSettings;
window.clearLogs = clearLogs;
window.onAreaSpeciesToggle = onAreaSpeciesToggle;
window.selectAllAreaSpecies = selectAllAreaSpecies;
window.onRadarUnselectedActionChange = onRadarUnselectedActionChange;
window.saveAreaSettings = saveAreaSettings;
