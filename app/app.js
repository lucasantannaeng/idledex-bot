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
let currentTargetMode = 'all'; // 'all' | 'selected' | 'none'
let saveRevision = 0;
let lastRenderedMapId = "";
let gameReady = false;

function syncConfigToGame() {
    if (gameReady && currentConfig) {
        gameView.send('host-command', { cmd: 'update-config', payload: currentConfig });
    }
}

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
            gameReady = true;
            syncConfigToGame();
            appendLog('🎮 Interface oficial IdleDex carregada com sucesso.', 'success');
        });
        gameView.addEventListener('did-start-loading', () => { gameReady = false; });

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
            syncConfigToGame();
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

    // Listen for Host Commands (e.g. system suspend or main process signals)
    if (window.electronAPI && window.electronAPI.onHostCommand) {
        window.electronAPI.onHostCommand((data) => {
            if (data && data.cmd === 'toggle-bot') {
                if (data.payload && data.payload.enabled === false) {
                    if (botEnabled) {
                        toggleBotState();
                    } else {
                        currentConfig = { ...(currentConfig || {}), enabled: false };
                        setBotEnabledState(false);
                        if (gameView && gameReady) {
                            gameView.send('host-command', { cmd: 'toggle-bot', payload: { enabled: false } });
                        }
                    }
                } else if (data.payload && data.payload.enabled === true) {
                    if (!botEnabled) {
                        toggleBotState();
                    }
                } else {
                    toggleBotState();
                }
            }
        });
    }

    // Render Initial Empty Radar Grid
    drawRadar([], { x: 0, y: 0 });

    // Bind event listeners for UI buttons and controls (T04 CSP / no inline handlers)
    document.getElementById('btn-switch-account')?.addEventListener('click', switchAccount);
    document.getElementById('btn-toggle-bot')?.addEventListener('click', toggleBotState);
    document.getElementById('btn-toggle-sidebar')?.addEventListener('click', toggleSidebar);
    document.getElementById('btn-minimize-tray')?.addEventListener('click', minimizeToTray);

    document.querySelectorAll('.sidebar-tabs .s-tab').forEach(tab => {
        const panel = tab.getAttribute('data-panel');
        if (panel) {
            tab.addEventListener('click', () => switchPanel(panel));
        }
    });

    const unselectedRadar = document.getElementById('cfg-unselected-action-radar');
    unselectedRadar?.addEventListener?.('change', (e) => onRadarUnselectedActionChange(e.target.value));
    document.getElementById('btn-select-all-species')?.addEventListener?.('click', () => selectAllAreaSpecies(true));
    document.getElementById('btn-deselect-all-species')?.addEventListener?.('click', () => selectAllAreaSpecies(false));

    const cfgStrategy = document.getElementById('cfg-strategy');
    cfgStrategy?.addEventListener?.('change', (e) => onStrategyChange(e.target.value));

    const discardRange = document.getElementById('cfg-discard-iv-pct');
    const discardLbl = document.getElementById('lbl-discard-iv-pct');
    if (discardRange && discardLbl) {
        discardRange.addEventListener?.('input', () => {
            discardLbl.textContent = `${discardRange.value}%`;
        });
    }
    document.getElementById('btn-save-settings')?.addEventListener?.('click', saveBotSettings);
    document.getElementById('btn-clear-logs')?.addEventListener?.('click', clearLogs);
});

// --- 2. TELEMETRY & DATA DISPATCH ---

function handleTelemetry(data) {
    if (!data) return;
    lastTelemetry = data;

    // Update Bot Status Pill & persist auto-pause
    if (data.config && data.config.enabled !== undefined) {
        const autoIdle = !data.config.enabled && !!data.config.auto_idle;
        if (data.config.enabled !== botEnabled) {
            setBotEnabledState(data.config.enabled, autoIdle);
            // If the bot auto-paused (e.g. out of balls, lab error), persist it to disk
            if (!data.config.enabled && currentConfig && currentConfig.enabled) {
                currentConfig.enabled = false;
                if (window.electronAPI && window.electronAPI.saveConfig) {
                    window.electronAPI.saveConfig(currentConfig).catch(() => {});
                }
            }
        } else if (!data.config.enabled && pillText) {
            const expectedText = autoIdle ? 'BOT PAUSADO (AUTO DO JOGO ATIVO)' : 'BOT PAUSADO';
            if (pillText.textContent !== expectedText) {
                pillText.textContent = expectedText;
            }
        }
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

    // Trainer Stats & Session Metrics
    updateStatsUI(data.progress || {}, data.wallet || {});
    if (data.sessionMetrics) {
        updateSessionMetricsUI(data.sessionMetrics);
    }

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
        const emptyDiv = document.createElement('div');
        emptyDiv.style.color = 'var(--text-dim)';
        emptyDiv.textContent = 'Nenhuma entidade detectada no alcance.';
        entitiesList.replaceChildren(emptyDiv);
        return;
    }

    const px = playerPos && Number.isFinite(playerPos.x) ? playerPos.x : 0;
    const py = playerPos && Number.isFinite(playerPos.y) ? playerPos.y : 0;

    const enemies = entities
        .filter(e => e && e.is_enemy && Number.isFinite(e.x) && Number.isFinite(e.y))
        .map(e => {
            const dist = Math.abs(e.x - px) + Math.abs(e.y - py);
            return { ...e, dist };
        })
        .sort((a, b) => a.dist - b.dist);

    if (enemies.length === 0) {
        const emptyDiv = document.createElement('div');
        emptyDiv.style.color = 'var(--text-dim)';
        emptyDiv.textContent = 'Área limpa de criaturas selvagens.';
        entitiesList.replaceChildren(emptyDiv);
        return;
    }

    const fragment = document.createDocumentFragment();
    for (const foe of enemies.slice(0, 6)) {
        const rawName = String(foe.name || 'Desconhecido');
        const cleanName = rawName.replace(/^Wild:\s*/i, '').replace(/^Foe:\s*/i, '');

        const container = document.createElement('div');
        container.style.cssText = 'display:flex; justify-content:space-between; align-items:center; background:rgba(15,23,42,0.6); padding:4px 8px; border-radius:4px; border-left:2px solid var(--rose);';

        const nameSpan = document.createElement('span');
        nameSpan.style.cssText = 'color:var(--text-bright); font-weight:500;';
        nameSpan.textContent = cleanName;

        const metaSpan = document.createElement('span');
        metaSpan.style.cssText = 'font-family:var(--font-mono); color:var(--cyan); font-size:0.72rem;';
        metaSpan.textContent = `${foe.dist}m (${foe.x}, ${foe.y})`;

        container.appendChild(nameSpan);
        container.appendChild(metaSpan);
        fragment.appendChild(container);
    }
    entitiesList.replaceChildren(fragment);
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
        const emptyDiv = document.createElement('div');
        emptyDiv.style.cssText = 'color:var(--text-dim); font-size:0.75rem;';
        emptyDiv.textContent = !mapId ? 'Aguardando conexão com o jogo...' : 'Nenhuma criatura selvagem nesta área.';
        listEl.replaceChildren(emptyDiv);
        return;
    }

    // Only re-render list if map changed or list was empty to preserve scroll/input state
    const existingInputs = typeof listEl.querySelectorAll === 'function'
        ? Array.from(listEl.querySelectorAll('input[type="checkbox"]'))
        : [];
    if (mapId === lastRenderedMapId && existingInputs.length === species.length && existingInputs.length > 0) {
        for (const sp of species) {
            const sid = String(sp.speciesId || "");
            const input = existingInputs.find(cb => cb.value === sid);
            if (input) {
                let shouldCheck = false;
                if (currentTargetMode === 'all') shouldCheck = true;
                else if (currentTargetMode === 'none') shouldCheck = false;
                else shouldCheck = currentTargetSpecies.includes(sid);
                input.checked = shouldCheck;

                const parentLabel = typeof input.closest === 'function' ? input.closest('label') : null;
                const hasBadge = parentLabel && typeof parentLabel.querySelector === 'function' && parentLabel.querySelector('.caught-badge');
                if (parentLabel && sp.caught && !hasBadge) {
                    const leftDiv = input.parentElement;
                    if (leftDiv && typeof leftDiv.appendChild === 'function') {
                        const caughtIco = document.createElement('span');
                        caughtIco.className = 'caught-badge';
                        caughtIco.title = 'Registrado na Pokédex';
                        caughtIco.style.fontSize = '0.72rem';
                        caughtIco.textContent = '📕';
                        leftDiv.appendChild(caughtIco);
                    }
                }
            }
        }
        return;
    }

    lastRenderedMapId = mapId;

    const fragment = document.createDocumentFragment();
    for (const sp of species) {
        const sid = String(sp.speciesId || "");
        let isChecked = false;
        if (currentTargetMode === 'all') isChecked = true;
        else if (currentTargetMode === 'none') isChecked = false;
        else isChecked = currentTargetSpecies.includes(sid);

        const label = document.createElement('label');
        label.style.cssText = 'display:flex; justify-content:space-between; align-items:center; background:rgba(15,23,42,0.5); padding:3px 7px; border-radius:4px; cursor:pointer; font-size:0.76rem;';

        const leftDiv = document.createElement('div');
        leftDiv.style.cssText = 'display:flex; align-items:center; gap:6px;';

        const input = document.createElement('input');
        input.type = 'checkbox';
        input.value = sid;
        input.checked = isChecked;
        input.addEventListener('change', () => onAreaSpeciesToggle(sid, input.checked));

        const nameSpan = document.createElement('span');
        nameSpan.style.cssText = 'color:var(--text-bright); font-weight:500;';
        nameSpan.textContent = sp.name || sid;

        leftDiv.appendChild(input);
        leftDiv.appendChild(nameSpan);

        if (sp.caught) {
            const caughtIco = document.createElement('span');
            caughtIco.className = 'caught-badge';
            caughtIco.title = 'Registrado na Pokédex';
            caughtIco.style.fontSize = '0.72rem';
            caughtIco.textContent = '📕';
            leftDiv.appendChild(caughtIco);
        }

        const rightDiv = document.createElement('div');
        rightDiv.style.cssText = 'display:flex; align-items:center; gap:5px;';

        const lvSpan = document.createElement('span');
        lvSpan.style.cssText = 'color:var(--text-dim); font-size:0.70rem;';
        const minLv = Number.isFinite(sp.minLevel) ? sp.minLevel : '?';
        const maxLv = Number.isFinite(sp.maxLevel) ? sp.maxLevel : '?';
        lvSpan.textContent = `Lv${minLv}-${maxLv}`;
        rightDiv.appendChild(lvSpan);

        if (sp.frequency) {
            const freqBadge = document.createElement('span');
            freqBadge.style.cssText = 'font-size:0.68rem; padding:1px 5px; border-radius:3px; background:rgba(30,41,59,0.8); color:var(--cyan);';
            freqBadge.textContent = String(sp.frequency);
            rightDiv.appendChild(freqBadge);
        }

        label.appendChild(leftDiv);
        label.appendChild(rightDiv);
        fragment.appendChild(label);
    }
    listEl.replaceChildren(fragment);
}

function onAreaSpeciesToggle(speciesId, isChecked) {
    if (!speciesId) return;
    const allCheckboxes = Array.from(document.querySelectorAll('#area-species-list input[type="checkbox"]'));
    const checkedValues = allCheckboxes.filter(cb => cb.checked).map(cb => String(cb.value));

    currentTargetSpecies = checkedValues;
    currentTargetMode = 'selected';
    saveAreaSettings();
}

function selectAllAreaSpecies(selectAll) {
    const allCheckboxes = Array.from(document.querySelectorAll('#area-species-list input[type="checkbox"]'));
    allCheckboxes.forEach(cb => { cb.checked = !!selectAll; });
    currentTargetMode = selectAll ? 'all' : 'none';
    currentTargetSpecies = selectAll ? allCheckboxes.map(cb => String(cb.value)) : [];
    saveAreaSettings();
}

function onRadarUnselectedActionChange(val) {
    const configSelect = document.getElementById('cfg-unselected-action');
    if (configSelect) configSelect.value = val;
    saveAreaSettings();
}

async function saveAreaSettings() {
    const unselectedAction = getVal('cfg-unselected-action-radar') || getVal('cfg-unselected-action') || 'battle';
    const thisRev = ++saveRevision;
    const candidate = {
        ...(currentConfig || {}),
        target_species: currentTargetSpecies,
        target_mode: currentTargetMode,
        unselected_action: unselectedAction
    };

    if (window.electronAPI && window.electronAPI.saveConfig) {
        try {
            const ok = await window.electronAPI.saveConfig(candidate);
            if (thisRev !== saveRevision) return;
            if (!ok) {
                appendLog('❌ Falha ao salvar alvos da área no disco. Alterações não aplicadas.', 'error');
                return;
            }
        } catch (err) {
            if (thisRev !== saveRevision) return;
            appendLog(`❌ Erro ao salvar alvos da área: ${err.message}`, 'error');
            return;
        }
    }
    if (thisRev !== saveRevision) return;
    currentConfig = candidate;
    if (gameView && gameReady) {
        gameView.send('host-command', { cmd: 'update-config', payload: currentConfig });
    }
    const actionDesc = unselectedAction === 'flee' ? 'Fugir Imediatamente' : 'Batalhar por XP';
    const modeDesc = currentTargetMode === 'all' ? 'Todas as espécies' : (currentTargetMode === 'none' ? 'Nenhuma espécie comum' : `${currentTargetSpecies.length} selecionadas`);
    appendLog(`🎯 Alvos da área atualizados: ${modeDesc} | Não selecionados: ${actionDesc}`, 'info');
}

// --- 3.2 LAST CAPTURE EVALUATION UI ---

function updateLastCaptureUI(mon) {
    if (!mon) return;
    const gradeBadge = document.getElementById('last-cap-grade');
    const qualityBadge = document.getElementById('last-cap-quality');
    const bodyEl = document.getElementById('last-cap-body');

    if (qualityBadge) {
        const qualityScore = Number.isFinite(mon.quality) ? mon.quality : (Number.isFinite(mon.qualitySelf?.score) ? mon.qualitySelf.score : null);
        if (qualityScore !== null && qualityScore >= 0) {
            let qTier = 'fair';
            let qLabel = 'Razoável 1★';
            if (qualityScore >= 1000) { qTier = 'perfect'; qLabel = 'Perfeito 6★'; }
            else if (qualityScore >= 990) { qTier = 'superb'; qLabel = 'Excepcional 5★'; }
            else if (qualityScore >= 940) { qTier = 'excellent'; qLabel = 'Excelente 4★'; }
            else if (qualityScore >= 800) { qTier = 'great'; qLabel = 'Ótimo 3★'; }
            else if (qualityScore >= 500) { qTier = 'good'; qLabel = 'Bom 2★'; }
            qualityBadge.textContent = qLabel;
            qualityBadge.className = `badge q-${qTier}`;
            qualityBadge.style.display = 'inline-block';
        } else {
            qualityBadge.style.display = 'none';
        }
    }

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
        const levelText = Number.isFinite(mon.level) ? `Lv${mon.level}` : 'Lv?';
        const ivTotal = Number.isFinite(mon.ivTotal) ? mon.ivTotal : 0;
        const ivPct = Number.isFinite(mon.ivPct) ? mon.ivPct : 0;
        const ivs = mon.ivs || {};

        const fragment = document.createDocumentFragment();

        // Row 1: Name, star, level
        const row1 = document.createElement('div');
        row1.style.cssText = 'font-size:0.82rem; font-weight:600; color:var(--text-bright); margin-bottom:3px;';
        const nameText = document.createTextNode(`${mon.name || 'Desconhecido'}${star} `);
        const lvSpan = document.createElement('span');
        lvSpan.style.cssText = 'color:var(--text-dim); font-size:0.72rem;';
        lvSpan.textContent = levelText;
        row1.appendChild(nameText);
        row1.appendChild(lvSpan);
        fragment.appendChild(row1);

        // Row 2: Nature & IV sum/pct
        const row2 = document.createElement('div');
        row2.style.cssText = 'display:flex; justify-content:space-between; margin-bottom:3px;';

        const natSpan = document.createElement('span');
        natSpan.textContent = 'Nature: ';
        const natBadge = document.createElement('span');
        if (mon.isBestNature) {
            natBadge.style.cssText = 'color:var(--emerald); font-weight:bold;';
            natBadge.textContent = `${mon.nature || 'Desconhecida'} (⭐ TOP NATURE!)`;
        } else {
            natBadge.style.cssText = 'color:var(--cyan);';
            natBadge.textContent = String(mon.nature || 'Desconhecida');
        }
        natSpan.appendChild(natBadge);

        const ivSpan = document.createElement('span');
        ivSpan.style.cssText = 'font-family:var(--font-mono); color:var(--text-bright);';
        ivSpan.textContent = 'IV: ';
        const ivBold = document.createElement('b');
        ivBold.textContent = String(ivTotal);
        ivSpan.appendChild(ivBold);
        ivSpan.appendChild(document.createTextNode(`/186 (${ivPct}%)`));

        row2.appendChild(natSpan);
        row2.appendChild(ivSpan);
        fragment.appendChild(row2);

        // Row 3: Individual IVs
        const row3 = document.createElement('div');
        row3.style.cssText = 'font-size:0.70rem; font-family:var(--font-mono); color:var(--text-dim); display:flex; gap:6px;';

        const stats = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
        for (const stat of stats) {
            const statSpan = document.createElement('span');
            const val = Number.isFinite(ivs[stat]) ? ivs[stat] : 0;
            statSpan.textContent = `${stat.toUpperCase()}:${val}`;
            row3.appendChild(statSpan);
        }
        fragment.appendChild(row3);

        bodyEl.replaceChildren(fragment);
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
}

function updateSessionMetricsUI(metrics) {
    if (!metrics) return;
    if (metrics.uptime !== undefined) {
        const s = metrics.uptime;
        const hrs = Math.floor(s / 3600);
        const mins = Math.floor((s % 3600) / 60);
        const secs = s % 60;
        const fmt = `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
        setText('stat-uptime', fmt);
    }
    if (metrics.capturesPerHour !== undefined) {
        setText('stat-captures-hr', `${metrics.capturesPerHour}/h`);
    }
    if (metrics.xpPerHour !== undefined) {
        setText('stat-xp-hr', `${(metrics.xpPerHour || 0).toLocaleString('pt-BR')}/h`);
    }
    if (metrics.silverPerHour !== undefined) {
        setText('stat-silver-hr', `${(metrics.silverPerHour || 0).toLocaleString('pt-BR')}/h`);
    }
    if (metrics.reconnectCount !== undefined) {
        setText('stat-reconnects', metrics.reconnectCount);
    }
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

async function toggleBotState() {
    const nextState = !botEnabled;
    const thisRev = ++saveRevision;

    if (!nextState) {
        // Emergency Pause: stop immediately in UI and guest, then persist
        const candidate = { ...(currentConfig || {}), enabled: false };
        // Reloads and subsequent edits must preserve the pause even when disk fails.
        currentConfig = candidate;
        setBotEnabledState(false);
        if (gameView && gameReady) {
            gameView.send('host-command', { cmd: 'toggle-bot', payload: { enabled: false } });
        }
        if (window.electronAPI?.saveConfig) {
            try {
                const ok = await window.electronAPI.saveConfig(candidate);
                if (thisRev === saveRevision) {
                    if (ok) {
                        currentConfig = candidate;
                    } else {
                        appendLog('⚠️ Bot pausado, mas houve falha ao salvar no disco. Reinício pode carregar estado anterior.', 'warning');
                    }
                }
            } catch (error) {
                if (thisRev === saveRevision) {
                    appendLog(`⚠️ Bot pausado, mas falhou ao gravar disco: ${error.message}`, 'warning');
                }
            }
        } else {
            currentConfig = candidate;
        }
    } else {
        // Activation: candidate must be successfully persisted before activating in guest
        const candidate = { ...(currentConfig || {}), enabled: true };
        if (window.electronAPI?.saveConfig) {
            try {
                const ok = await window.electronAPI.saveConfig(candidate);
                if (thisRev !== saveRevision) return;
                if (!ok) {
                    appendLog('❌ Falha ao persistir ativação do bot no disco. Bot não ativado.', 'error');
                    return;
                }
            } catch (error) {
                if (thisRev !== saveRevision) return;
                appendLog(`❌ Erro ao persistir ativação do bot: ${error.message}`, 'error');
                return;
            }
        }
        if (thisRev !== saveRevision) return;
        currentConfig = candidate;
        setBotEnabledState(true);
        if (gameView && gameReady) {
            gameView.send('host-command', { cmd: 'toggle-bot', payload: { enabled: true } });
        }
        appendLog('▶️ Bot ativado e persistido com sucesso.', 'info');
    }
}

function setBotEnabledState(enabled, autoIdleActive = false) {
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
            pillText.textContent = autoIdleActive ? 'BOT PAUSADO (AUTO DO JOGO ATIVO)' : 'BOT PAUSADO';
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

function setPinnedSelectValue(elementId, val) {
    const sel = document.getElementById(elementId);
    if (!sel) return;
    if (!val) {
        sel.value = '';
        return;
    }
    const valLower = String(val).toLowerCase().trim();
    if (Array.isArray(sel.options) || (sel.options && typeof sel.options[Symbol.iterator] === 'function')) {
        const hasOpt = Array.from(sel.options).some(o => (o.value || '').toLowerCase() === valLower);
        if (!hasOpt && typeof sel.appendChild === 'function') {
            const opt = document.createElement('option');
            opt.value = valLower;
            opt.textContent = valLower.charAt(0).toUpperCase() + valLower.slice(1);
            sel.appendChild(opt);
        }
    }
    sel.value = valLower;
}

function setIvModeUI(mode) {
    const isIndiv = mode === 'individual';
    const pctCont = document.getElementById('iv-container-percent');
    const indCont = document.getElementById('iv-container-individual');
    if (pctCont?.style) pctCont.style.display = isIndiv ? 'none' : 'flex';
    if (indCont?.style) indCont.style.display = isIndiv ? 'block' : 'none';
    const select = document.getElementById('cfg-iv-mode');
    if (select && select.value !== mode) {
        select.value = mode;
    }
}

function updateMinIvSum() {
    const stats = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
    let sum = 0;
    for (const stat of stats) {
        const input = document.getElementById(`cfg-min-iv-${stat}`);
        if (input) {
            let val = parseInt(input.value, 10);
            if (!Number.isFinite(val) || val < 0) val = 0;
            if (val > 31) { val = 31; input.value = '31'; }
            sum += val;
        }
    }
    const sumLbl = document.getElementById('lbl-min-iv-sum');
    if (sumLbl) {
        const pct = Math.round((sum / 186) * 100);
        sumLbl.textContent = `IVs ${sum}/186 (${pct}%)`;
    }
    return sum;
}

function updateConflictLocks() {
    const elIdle = document.getElementById('cfg-auto-idle');
    const elRoam = document.getElementById('cfg-auto-roam');
    const elSwitch = document.getElementById('cfg-auto-route-switch');
    const elUncaught = document.getElementById('cfg-only-uncaught');
    const lockIdle = document.getElementById('lock-auto-idle');
    const lockRoam = document.getElementById('lock-auto-roam');
    const lockSwitch = document.getElementById('lock-auto-route-switch');
    const lockUncaught = document.getElementById('lock-only-uncaught');
    const badgeFarming = document.getElementById('badge-farming-active');

    const sp1 = (getVal('cfg-pinned-species-1') || '').trim();
    const sp2 = (getVal('cfg-pinned-species-2') || '').trim();
    const rawLegacyPin = (getVal('cfg-pinned-species') || '').trim();
    const hasPinned = Boolean(sp1 || sp2 || rawLegacyPin);

    if (badgeFarming?.style) {
        badgeFarming.style.display = hasPinned ? 'inline-block' : 'none';
    }

    const isIdle = elIdle ? Boolean(elIdle.checked) : false;
    const isRoam = elRoam ? Boolean(elRoam.checked) : false;
    const isSwitch = elSwitch ? Boolean(elSwitch.checked) : false;

    // 1. Farming Locks (pinned species locks auto-route-switch and catch-only-uncaught)
    if (hasPinned) {
        if (elSwitch) {
            elSwitch.checked = false;
            elSwitch.disabled = true;
        }
        if (lockSwitch?.style) {
            lockSwitch.textContent = '🔒 Farming';
            lockSwitch.style.display = 'inline';
        }
        if (elUncaught) {
            elUncaught.checked = false;
            elUncaught.disabled = true;
        }
        if (lockUncaught?.style) {
            lockUncaught.style.display = 'inline';
        }
    } else {
        if (lockUncaught?.style) lockUncaught.style.display = 'none';
        if (elUncaught) elUncaught.disabled = false;

        if (!isIdle) {
            if (elSwitch) elSwitch.disabled = false;
            if (lockSwitch?.style) lockSwitch.style.display = 'none';
        }
    }

    // 2. Auto-Idle vs Auto-Roam / Route-Switch Locks
    if (isIdle) {
        if (elRoam) {
            elRoam.checked = false;
            elRoam.disabled = true;
        }
        if (lockRoam?.style) lockRoam.style.display = 'inline';
        if (elSwitch) {
            elSwitch.checked = false;
            elSwitch.disabled = true;
        }
        if (lockSwitch?.style) {
            lockSwitch.textContent = '🔒 Auto-Idle';
            lockSwitch.style.display = 'inline';
        }
        if (elIdle) elIdle.disabled = false;
        if (lockIdle?.style) lockIdle.style.display = 'none';
    } else if (isRoam || isSwitch) {
        if (elIdle) {
            elIdle.checked = false;
            elIdle.disabled = true;
        }
        if (lockIdle?.style) lockIdle.style.display = 'inline';
        if (elRoam) elRoam.disabled = false;
        if (lockRoam?.style) lockRoam.style.display = 'none';
        if (!hasPinned) {
            if (elSwitch) elSwitch.disabled = false;
            if (lockSwitch?.style) lockSwitch.style.display = 'none';
        }
    } else {
        if (elIdle) elIdle.disabled = false;
        if (lockIdle?.style) lockIdle.style.display = 'none';
        if (elRoam) elRoam.disabled = false;
        if (lockRoam?.style) lockRoam.style.display = 'none';
        if (!hasPinned) {
            if (elSwitch) elSwitch.disabled = false;
            if (lockSwitch?.style) lockSwitch.style.display = 'none';
        }
    }
}

function populatePinnedSpeciesDropdowns(availableSpecies) {
    currentAreaSpeciesList = Array.isArray(availableSpecies) ? availableSpecies : [];
    const sel1 = document.getElementById('cfg-pinned-species-1');
    const sel2 = document.getElementById('cfg-pinned-species-2');
    if (!sel1 || !sel2) return;

    const val1 = (sel1.value || '').toLowerCase().trim();
    const val2 = (sel2.value || '').toLowerCase().trim();

    const speciesList = [];
    const seen = new Set();
    for (const sp of currentAreaSpeciesList) {
        if (!sp) continue;
        const name = typeof sp === 'string' ? sp : (sp.name || sp.speciesId || '');
        const id = typeof sp === 'string' ? sp : (sp.speciesId || sp.name || '');
        const canonical = (name || id).trim();
        const key = canonical.toLowerCase();
        if (canonical && !seen.has(key)) {
            seen.add(key);
            speciesList.push({ name: canonical, value: key });
        }
    }

    const buildOptions = (currentVal, placeholder) => {
        const frag = document.createDocumentFragment();
        const defOpt = document.createElement('option');
        defOpt.value = '';
        defOpt.textContent = placeholder;
        frag.appendChild(defOpt);

        let matchFound = false;
        for (const item of speciesList) {
            const opt = document.createElement('option');
            opt.value = item.value;
            opt.textContent = item.name;
            if (item.value === currentVal) {
                opt.selected = true;
                matchFound = true;
            }
            frag.appendChild(opt);
        }

        if (currentVal && !matchFound) {
            const preservedOpt = document.createElement('option');
            preservedOpt.value = currentVal;
            preservedOpt.textContent = currentVal.charAt(0).toUpperCase() + currentVal.slice(1);
            preservedOpt.selected = true;
            frag.appendChild(preservedOpt);
        }

        return frag;
    };

    if (typeof sel1.replaceChildren === 'function') {
        sel1.replaceChildren(buildOptions(val1, '(Espécie 1: Nenhuma)'));
    }
    if (typeof sel2.replaceChildren === 'function') {
        sel2.replaceChildren(buildOptions(val2, '(Espécie 2: Nenhuma)'));
    }
    updateConflictLocks();
}

function triggerBoxCleanup() {
    if (gameView && gameReady) {
        gameView.send('host-command', { cmd: 'manual-action', payload: { action: 'cleanup-box' } });
        appendLog('🧹 Solicitando limpeza de Box ao motor de jogo conforme filtros de IV e Nature...', 'info');
    } else {
        appendLog('⚠️ Jogo não está pronto para executar limpeza de Box no momento.', 'warning');
    }
}

function applyConfigToInputs(cfg) {
    if (!cfg) return;
    setVal('cfg-strategy', cfg.strategy_mode || 'balanced');
    setVal('cfg-flee', Math.round((cfg.flee_hp_pct ?? 0.30) * 100));
    setVal('cfg-potion', Math.round((cfg.potion_hp_pct ?? 0.35) * 100));
    setVal('cfg-potion-mode', cfg.potion_mode || 'smart');
    setVal('cfg-unselected-action', cfg.unselected_action || 'battle');
    setVal('cfg-unselected-action-radar', cfg.unselected_action || 'battle');
    if (Array.isArray(cfg.target_species)) {
        currentTargetSpecies = cfg.target_species.map(String);
    }
    if (cfg.target_mode) {
        currentTargetMode = cfg.target_mode;
    } else if (cfg.target_species !== undefined) {
        currentTargetMode = currentTargetSpecies.length > 0 ? 'selected' : 'all';
    }
    setCheck('cfg-revive-battle', cfg.use_revive_battle !== false);
    setCheck('cfg-revive-overworld', cfg.use_revive_overworld !== false);
    setCheck('cfg-auto-heal-center', cfg.auto_heal_center !== false);

    setVal('cfg-catch', Math.round((cfg.catch_hp_pct ?? 0.50) * 100));
    setCheck('cfg-only-shiny', !!cfg.catch_only_shiny);
    setCheck('cfg-only-uncaught', !!cfg.catch_only_uncaught);
    setVal('cfg-ball-priority', cfg.ball_priority || 'balanced');
    setVal('cfg-move-mode', cfg.move_selection_mode || 'smart');
    setVal('cfg-roam-delay', cfg.roam_step_delay_ms || 300);

    setCheck('cfg-auto-roam', cfg.auto_roam !== false);
    setCheck('cfg-auto-idle', cfg.auto_idle !== false);
    setCheck('cfg-auto-route-switch', !!cfg.auto_route_switch);

    let p1 = '';
    let p2 = '';
    if (Array.isArray(cfg.pinned_species)) {
        p1 = (cfg.pinned_species[0] || '').toLowerCase().trim();
        p2 = (cfg.pinned_species[1] || '').toLowerCase().trim();
    } else if (typeof cfg.pinned_species === 'string' && cfg.pinned_species.trim()) {
        const parts = cfg.pinned_species.split(',').map(s => s.toLowerCase().trim()).filter(Boolean);
        p1 = parts[0] || '';
        p2 = parts[1] || '';
    }
    setVal('cfg-pinned-species', cfg.pinned_species ? (Array.isArray(cfg.pinned_species) ? cfg.pinned_species.join(', ') : cfg.pinned_species) : '');
    setPinnedSelectValue('cfg-pinned-species-1', p1);
    setPinnedSelectValue('cfg-pinned-species-2', p2);

    const ivMode = cfg.iv_evaluation_mode === 'individual' ? 'individual' : 'percent';
    setVal('cfg-iv-mode', ivMode);
    setIvModeUI(ivMode);

    const discardPct = cfg.discard_iv_pct !== undefined ? cfg.discard_iv_pct : 50;
    setVal('cfg-discard-iv-pct', discardPct);
    const lblDiscard = document.getElementById('lbl-discard-iv-pct');
    if (lblDiscard) lblDiscard.innerText = discardPct + '%';

    const minIvs = cfg.min_ivs || {};
    setVal('cfg-min-iv-hp', minIvs.hp ?? 0);
    setVal('cfg-min-iv-atk', minIvs.atk ?? 0);
    setVal('cfg-min-iv-def', minIvs.def ?? 0);
    setVal('cfg-min-iv-spa', minIvs.spa ?? 0);
    setVal('cfg-min-iv-spd', minIvs.spd ?? 0);
    setVal('cfg-min-iv-spe', minIvs.spe ?? 0);
    updateMinIvSum();

    setVal('cfg-desired-nature', (cfg.desired_nature || 'any').toLowerCase().trim());
    setVal('cfg-min-quality', (cfg.min_quality || 'any').toLowerCase().trim());
    setCheck('cfg-auto-box-cleanup', !!cfg.auto_box_cleanup);

    setCheck('cfg-pause-no-balls', cfg.pause_on_no_balls !== false);
    setCheck('cfg-auto-dailies', cfg.auto_claim_dailies !== false);
    setCheck('cfg-auto-lock', cfg.auto_lock_valuable !== false);
    setCheck('cfg-auto-npc-quests', cfg.auto_npc_quests !== false);
    setCheck('cfg-auto-travel-deliveries', cfg.auto_travel_deliveries !== false);
    setVal('cfg-auto-travel-surplus', cfg.auto_travel_surplus_threshold || 5);
    setCheck('cfg-auto-boosts', !!cfg.auto_use_boosts);
    setCheck('cfg-close-to-tray', !!cfg.close_to_tray);

    updateConflictLocks();
}

function onStrategyChange(mode) {
    if (!['balanced', 'collection', 'monetize'].includes(mode)) return;
    // Presets populate the editor; the existing save action persists and applies them.
    // Keep area targets, recovery, deliveries and discard settings chosen by the user.
    setVal('cfg-strategy', mode);
    setCheck('cfg-only-shiny', false);
    setCheck('cfg-only-uncaught', mode === 'collection');
    setVal('cfg-catch', mode === 'monetize' ? 30 : 50);
    setVal('cfg-ball-priority', mode === 'balanced' ? 'balanced' : 'economy');
    setVal('cfg-unselected-action', mode === 'collection' ? 'flee' : 'battle');
    setVal('cfg-unselected-action-radar', mode === 'collection' ? 'flee' : 'battle');
    updateConflictLocks();
    if (mode === 'collection') {
        appendLog('🎯 [PRESET] Modo Coleção: Capturar apenas inéditos, fugir dos demais e Pokébolas econômicas.', 'info');
    } else if (mode === 'monetize') {
        appendLog('💰 [PRESET] Modo Monetização: Lutar contra todos por XP e capturar com HP <= 30%.', 'info');
    } else if (mode === 'balanced') {
        appendLog('⚖️ [PRESET] Equilibrado: captura com HP até 50%, esferas balanceadas e combate dos demais.', 'info');
    }
    appendLog('Preset preparado. Revise os campos e clique em Salvar Ajustes para aplicar. Alvos da área e demais automações foram preservados.', 'info');
}

async function switchAccount() {
    const button = document.getElementById('btn-switch-account');
    if (button?.disabled) return;
    if (button) { button.disabled = true; button.textContent = 'Saindo…'; }
    setBotEnabledState(false);
    currentConfig = { ...(currentConfig || {}), enabled: false };
    if (gameReady) gameView.send('host-command', { cmd: 'toggle-bot', payload: { enabled: false } });
    try {
        const result = await window.electronAPI.switchAccount();
        if (!result?.ok) throw new Error('Session reset failed');
        window.location.reload();
    } catch (error) {
        appendLog('Não foi possível concluir a saída. O bot está pausado. Clique em Sair / Trocar conta para tentar novamente.', 'error');
        if (button) { button.disabled = false; button.textContent = 'Sair / Trocar conta'; }
    }
}

async function saveBotSettings() {
    const thisRev = ++saveRevision;

    const pin1 = (getVal('cfg-pinned-species-1') || '').trim().toLowerCase();
    const pin2 = (getVal('cfg-pinned-species-2') || '').trim().toLowerCase();
    const rawLegacyPin = (getVal('cfg-pinned-species') || '').trim();

    let resolvedPinned = null;
    const pinnedArr = [pin1, pin2].filter(Boolean);
    if (pinnedArr.length > 0) {
        const unique = [...new Set(pinnedArr)];
        resolvedPinned = unique.length === 1 ? unique[0] : unique;
    } else if (rawLegacyPin) {
        const parts = rawLegacyPin.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
        const unique = [...new Set(parts)].slice(0, 2);
        resolvedPinned = unique.length === 0 ? null : (unique.length === 1 ? unique[0] : unique);
    }

    const ivMode = getVal('cfg-iv-mode') || 'percent';
    const minIvs = {
        hp: Math.max(0, Math.min(31, getNumber('cfg-min-iv-hp', 0))),
        atk: Math.max(0, Math.min(31, getNumber('cfg-min-iv-atk', 0))),
        def: Math.max(0, Math.min(31, getNumber('cfg-min-iv-def', 0))),
        spa: Math.max(0, Math.min(31, getNumber('cfg-min-iv-spa', 0))),
        spd: Math.max(0, Math.min(31, getNumber('cfg-min-iv-spd', 0))),
        spe: Math.max(0, Math.min(31, getNumber('cfg-min-iv-spe', 0))),
    };

    const hasPinnedActive = Boolean(resolvedPinned);
    const autoIdleChecked = getCheck('cfg-auto-idle');
    const autoRoamChecked = getCheck('cfg-auto-roam');
    const autoRouteSwitchChecked = getCheck('cfg-auto-route-switch');
    const onlyUncaughtChecked = getCheck('cfg-only-uncaught');

    // Strict conflict enforcement before saving
    let effectiveAutoIdle = autoIdleChecked;
    let effectiveAutoRoam = autoRoamChecked;
    let effectiveRouteSwitch = autoRouteSwitchChecked;
    let effectiveOnlyUncaught = onlyUncaughtChecked;

    if (effectiveAutoIdle) {
        effectiveAutoRoam = false;
        effectiveRouteSwitch = false;
    }
    if (hasPinnedActive) {
        effectiveRouteSwitch = false;
        effectiveOnlyUncaught = false;
    }

    const updated = {
        ...currentConfig,
        enabled: botEnabled,
        strategy_mode: getVal('cfg-strategy') || 'balanced',
        flee_hp_pct: getNumber('cfg-flee', 30) / 100,
        potion_hp_pct: getNumber('cfg-potion', 35) / 100,
        potion_mode: getVal('cfg-potion-mode') || 'smart',
        use_revive_battle: getCheck('cfg-revive-battle'),
        use_revive_overworld: getCheck('cfg-revive-overworld'),
        auto_heal_center: getCheck('cfg-auto-heal-center'),
        catch_hp_pct: getNumber('cfg-catch', 50) / 100,
        catch_only_shiny: getCheck('cfg-only-shiny'),
        catch_only_uncaught: effectiveOnlyUncaught,
        ball_priority: getVal('cfg-ball-priority') || 'balanced',
        move_selection_mode: getVal('cfg-move-mode') || 'smart',
        target_species: currentTargetSpecies || [],
        target_mode: currentTargetMode || 'all',
        unselected_action: getVal('cfg-unselected-action') || getVal('cfg-unselected-action-radar') || 'battle',
        min_iv_alert: 130,
        roam_step_delay_ms: parseInt(getVal('cfg-roam-delay'), 10) || 300,
        auto_route_switch: effectiveRouteSwitch,
        pinned_species: resolvedPinned,
        iv_evaluation_mode: ivMode,
        min_ivs: minIvs,
        desired_nature: (getVal('cfg-desired-nature') || 'any').toLowerCase().trim(),
        min_quality: (getVal('cfg-min-quality') || 'any').toLowerCase().trim(),
        auto_box_cleanup: getCheck('cfg-auto-box-cleanup'),
        discard_iv_pct: getNumber('cfg-discard-iv-pct', 50),
        pause_on_no_balls: getCheck('cfg-pause-no-balls'),
        auto_roam: effectiveAutoRoam,
        auto_idle: effectiveAutoIdle,
        auto_claim_dailies: getCheck('cfg-auto-dailies'),
        auto_lock_valuable: getCheck('cfg-auto-lock'),
        auto_npc_quests: getCheck('cfg-auto-npc-quests'),
        auto_travel_deliveries: getCheck('cfg-auto-travel-deliveries'),
        auto_travel_surplus_threshold: parseInt(getVal('cfg-auto-travel-surplus'), 10) || 5,
        auto_use_boosts: getCheck('cfg-auto-boosts'),
        close_to_tray: getCheck('cfg-close-to-tray'),
    };

    setCheck('cfg-auto-roam', effectiveAutoRoam);
    setCheck('cfg-auto-idle', effectiveAutoIdle);
    setCheck('cfg-auto-route-switch', effectiveRouteSwitch);
    setCheck('cfg-only-uncaught', effectiveOnlyUncaught);
    updateConflictLocks();

    // Persist to main process
    try {
        if (!window.electronAPI?.saveConfig || !await window.electronAPI.saveConfig(updated)) {
            throw new Error('Falha ao gravar configurações');
        }
        if (thisRev !== saveRevision) return;
    } catch (error) {
        if (thisRev !== saveRevision) return;
        appendLog('Não foi possível salvar as configurações. Tente novamente.', 'error');
        return;
    }
    if (thisRev !== saveRevision) return;
    currentConfig = updated;

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

function getNumber(id, fallback) {
    const value = parseInt(getVal(id), 10);
    return Number.isFinite(value) ? value : fallback;
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
    const validLevel = ['info', 'success', 'warning', 'error'].includes(level) ? level : 'info';
    entry.className = `log-entry ${validLevel}`;

    const timeSpan = document.createElement('span');
    timeSpan.style.cssText = 'color:var(--text-dim); font-family:var(--font-mono); margin-right:5px;';
    timeSpan.textContent = `[${time}]`;

    entry.appendChild(timeSpan);
    entry.appendChild(document.createTextNode(` ${String(message ?? '')}`));

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
        const entry = document.createElement('div');
        entry.className = 'log-entry info';
        const timeSpan = document.createElement('span');
        timeSpan.style.color = 'var(--text-dim)';
        timeSpan.textContent = '[00:00:00]';
        entry.appendChild(timeSpan);
        entry.appendChild(document.createTextNode(' Console limpo pelo usuário.'));
        logFeed.replaceChildren(entry);
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
window.onStrategyChange = onStrategyChange;
window.switchAccount = switchAccount;
window.handleTelemetry = handleTelemetry;
window.appendLog = appendLog;
window.getCurrentConfig = () => currentConfig;
window.isBotEnabled = () => botEnabled;
window.setIvModeUI = setIvModeUI;
window.updateMinIvSum = updateMinIvSum;
window.updateConflictLocks = updateConflictLocks;
window.populatePinnedSpeciesDropdowns = populatePinnedSpeciesDropdowns;
window.triggerBoxCleanup = triggerBoxCleanup;
