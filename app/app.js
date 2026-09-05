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
    if (data.currentMap && shardIndicator) {
        shardIndicator.textContent = `Mapa: ${data.currentMap}`;
    }

    // Radar & Entities
    if (data.playerPos && data.playerPos.x !== null) {
        if (radarCoords) {
            const grassTag = data.onGrass ? " 🌿 [Grama Alta]" : "";
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

        if (enemyNameEl) enemyNameEl.textContent = `${oppName} (Nv. ${opp.level || '?'})`;
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

    setText('wallet-coins', (wallet.coins ?? 0).toLocaleString('pt-BR'));
    setText('wallet-crystals', (wallet.crystals ?? 0).toLocaleString('pt-BR'));
}

function updateInventoryUI(inventory) {
    const balls = inventory.ball || {};
    setText('inv-pokeball', (balls.pokeball ?? 0).toLocaleString('pt-BR'));
    setText('inv-greatball', (balls.greatball ?? 0).toLocaleString('pt-BR'));
    setText('inv-ultraball', (balls.ultraball ?? 0).toLocaleString('pt-BR'));
    setText('inv-potion', (inventory.potion ?? 0).toLocaleString('pt-BR'));
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
    setVal('cfg-potion', Math.round((cfg.potion_hp_pct || 0.30) * 100));
    setVal('cfg-catch', Math.round((cfg.catch_hp_pct || 0.50) * 100));
    setCheck('cfg-auto-roam', cfg.auto_roam !== false);
    setCheck('cfg-auto-idle', cfg.auto_idle !== false);
}

async function saveBotSettings() {
    const updated = {
        enabled: botEnabled,
        strategy_mode: getVal('cfg-strategy'),
        iv_collection_threshold: parseInt(getVal('cfg-iv-col'), 10) || 150,
        iv_sell_threshold: parseInt(getVal('cfg-iv-sell'), 10) || 120,
        flee_hp_pct: (parseInt(getVal('cfg-flee'), 10) || 30) / 100,
        potion_hp_pct: (parseInt(getVal('cfg-potion'), 10) || 30) / 100,
        catch_hp_pct: (parseInt(getVal('cfg-catch'), 10) || 50) / 100,
        auto_roam: getCheck('cfg-auto-roam'),
        auto_idle: getCheck('cfg-auto-idle'),
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
