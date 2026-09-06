/**
 * IdleDex Desktop — Game Webview Preload
 * Injects autonomous engine directly into the guest page's Main World via webFrame,
 * intercepting native WebSocket before the game scripts execute.
 */

const { webFrame, ipcRenderer } = require('electron');

// 1. Preload -> Host Bridge
window.addEventListener('idledex-to-preload', (event) => {
    try {
        const { channel, data } = event.detail || {};
        if (channel) {
            ipcRenderer.sendToHost(channel, data);
        }
    } catch (e) {}
});

// 2. Host -> Preload Bridge
ipcRenderer.on('host-command', (event, data) => {
    try {
        window.dispatchEvent(new CustomEvent('idledex-from-preload', { detail: data }));
    } catch (e) {}
});

// 3. Inject Main World Engine
function initMainWorldEngine() {
    'use strict';

    console.log("[IdleDex Desktop] Inicializando motor autônomo no mundo principal...");

    let botConfig = {
        enabled: true,
        strategy_mode: 'balanced',
        iv_collection_threshold: 150,
        iv_sell_threshold: 120,
        flee_hp_pct: 0.30,
        potion_hp_pct: 0.30,
        catch_hp_pct: 0.50,
        auto_idle: true,
        auto_roam: true,
    };

    let activeWs = null;
    let inBattle = false;
    let currentBattleId = null;
    let battleMoves = [];
    let canThrowBall = true;
    let canUsePotion = true;
    let battleTurnTimer = null;
    let battleWatchdog = null;
    let battleWindowOpen = false;

    let myMon = null;
    let enemyMon = null;
    let playerId = null;
    try {
        const cachedId = sessionStorage.getItem('idledex_playerId');
        if (cachedId) playerId = cachedId;
    } catch (e) {}

    let currentMap = "";
    let playerPos = { x: null, y: null };
    let entities = [];
    let moveSeq = 0;
    let roamInterval = null;
    let roamStepIdx = 0;
    let lastGrassDir = null;

    // Map collision and tall grass coordinates
    let mapCols = 0;
    let mapRows = 0;
    let mapGrid = null;
    let grassTiles = [];
    let loadingMap = false;

    let progress = { rank: 1, xp: 0, wins: 0, losses: 0, captures: 0, shinies: 0 };
    let inventory = { ball: { pokeball: 0, greatball: 0, ultraball: 0 }, potion: 0 };
    let wallet = { coins: 0, crystals: 0 };
    let collection = {};
    let team = [];

    // Check if a battle packet belongs to the local player
    function isMyBattle(d) {
        if (!d) return false;
        if (playerId) {
            const p = String(playerId);
            if (d.ownerId && String(d.ownerId) === p) return true;
            if (d.foeOwnerId && String(d.foeOwnerId) === p) return true;
            return false;
        }
        // If playerId is not yet set, inspect if this is an interactive battle for us
        if (d.interactive === true) {
            if (d.ownerId) {
                playerId = String(d.ownerId);
                try { sessionStorage.setItem('idledex_playerId', playerId); } catch (e) {}
            }
            return true;
        }
        return false;
    }

    async function loadMapCollision(mapId) {
        if (!mapId || loadingMap) return;
        loadingMap = true;
        try {
            let resp = await fetch(`/maps/${mapId}.collision.json`);
            if (!resp.ok) {
                // Try hyphenated fallback if mapId contains underscore
                resp = await fetch(`/maps/${mapId.replace(/_/g, '-')}.collision.json`);
            }
            if (!resp.ok) {
                loadingMap = false;
                return;
            }
            const data = await resp.json();
            mapCols = data.cols || 0;
            mapRows = data.rows || 0;
            mapGrid = data.grid ? new Uint8Array(data.grid) : null;
            grassTiles = [];
            if (mapGrid && mapCols > 0) {
                for (let y = 0; y < mapRows; y++) {
                    for (let x = 0; x < mapCols; x++) {
                        // 1 = Grass (l_.Grass)
                        if (mapGrid[y * mapCols + x] === 1) {
                            grassTiles.push({ x, y });
                        }
                    }
                }
            }
            logEvent(`🌿 Malha de mapa carregada (${mapId}): ${grassTiles.length} tiles de grama alta identificados`, "info");
        } catch (e) {
            // ignore network load errors
        } finally {
            loadingMap = false;
        }
    }

    function isGrass(x, y) {
        if (!mapGrid || x < 0 || y < 0 || x >= mapCols || y >= mapRows) return false;
        return mapGrid[y * mapCols + x] === 1;
    }

    function isWalkable(x, y) {
        if (!mapGrid || x < 0 || y < 0 || x >= mapCols || y >= mapRows) return true;
        const val = mapGrid[y * mapCols + x];
        return val === 1 || val === 2; // 1 = Grass, 2 = Path
    }

    // High-performance BFS pathfinder to locate the nearest reachable grass tile
    function findNextStepToGrass(startX, startY) {
        if (!mapGrid || grassTiles.length === 0 || mapCols <= 0 || mapRows <= 0) return null;
        if (isGrass(startX, startY)) return null;

        const visited = new Uint8Array(mapCols * mapRows);
        visited[startY * mapCols + startX] = 1;

        const queue = [{ x: startX, y: startY, firstDir: null }];
        let head = 0;

        const dirs = [
            { dir: "N", dx: 0, dy: -1 },
            { dir: "S", dx: 0, dy: 1 },
            { dir: "E", dx: 1, dy: 0 },
            { dir: "W", dx: -1, dy: 0 }
        ];

        while (head < queue.length) {
            const curr = queue[head++];
            if (isGrass(curr.x, curr.y)) {
                return curr.firstDir;
            }

            // Cap queue to 4000 nodes for instant sub-millisecond execution
            if (queue.length > 4000) break;

            for (let i = 0; i < 4; i++) {
                const nx = curr.x + dirs[i].dx;
                const ny = curr.y + dirs[i].dy;
                if (nx >= 0 && ny >= 0 && nx < mapCols && ny < mapRows) {
                    const idx = ny * mapCols + nx;
                    if (!visited[idx] && isWalkable(nx, ny)) {
                        visited[idx] = 1;
                        queue.push({
                            x: nx,
                            y: ny,
                            firstDir: curr.firstDir !== null ? curr.firstDir : dirs[i].dir
                        });
                    }
                }
            }
        }
        return null;
    }

    function logEvent(message, level = 'info') {
        const time = new Date().toTimeString().split(' ')[0];
        try {
            window.dispatchEvent(new CustomEvent('idledex-to-preload', {
                detail: {
                    channel: 'game-log',
                    data: { time, message, level }
                }
            }));
        } catch (e) {}
    }

    function emitTelemetry() {
        try {
            window.dispatchEvent(new CustomEvent('idledex-to-preload', {
                detail: {
                    channel: 'game-telemetry',
                    data: {
                        connected: activeWs && activeWs.readyState === WebSocket.OPEN,
                        inBattle,
                        currentBattleId,
                        battleMoves,
                        playerId,
                        currentMap,
                        playerPos,
                        onGrass: (playerPos && playerPos.x !== null) ? isGrass(playerPos.x, playerPos.y) : false,
                        myMon,
                        enemyMon,
                        entities,
                        progress,
                        inventory,
                        wallet,
                        collection,
                        team,
                        config: botConfig
                    }
                }
            }));
        } catch (e) {}
    }

    // Binary frame parser aligned with upstream xye(t)
    function parseBinaryFrame(buffer) {
        try {
            const data = new Uint8Array(buffer);
            if (data.length < 1 || data[0] !== 0x01) return null;
            const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

            let offset = 1;
            const tick = view.getUint32(offset, true);
            offset += 4;

            const flags = data[offset++];
            let ack;
            if (flags & 0x01) {
                ack = view.getUint32(offset, true);
                offset += 4;
                if (ack !== undefined) {
                    moveSeq = Math.max(moveSeq, Number(ack));
                }
            }

            if (offset + 2 > data.length) return null;
            const entityCount = view.getUint16(offset, true);
            offset += 2;

            const parsedEntities = [];
            for (let i = 0; i < entityCount; i++) {
                if (offset + 2 > data.length) break;
                const f = data[offset++];
                const g = data[offset++]; // 1-byte length prefix (Uint8)
                if (offset + g > data.length) break;

                const nameBytes = data.subarray(offset, offset + g);
                const name = new TextDecoder('utf-8').decode(nameBytes);
                offset += g;

                let x = null, y = null, dir = null;
                if ((f & 0x01) && offset + 2 <= data.length) {
                    x = view.getUint16(offset, true);
                    offset += 2;
                }
                if ((f & 0x02) && offset + 2 <= data.length) {
                    y = view.getUint16(offset, true);
                    offset += 2;
                }
                if ((f & 0x04) && offset < data.length) {
                    dir = ["N", "E", "S", "W"][data[offset++]] || "S";
                }

                const idStr = String(name || "").toLowerCase();
                const isPlayer = (playerId && String(name) === String(playerId)) || idStr.includes("self") || idStr.includes("player:");
                const isEnemy = !isPlayer && (
                    idStr.startsWith("wild:") ||
                    idStr.startsWith("foe:") ||
                    idStr.includes("wild")
                );

                if (isPlayer && x !== null && y !== null) {
                    playerPos = { x, y };
                }

                parsedEntities.push({
                    id: name,
                    name,
                    x,
                    y,
                    dir,
                    is_player: isPlayer,
                    is_enemy: isEnemy
                });
            }

            entities = parsedEntities;
            emitTelemetry();
        } catch (err) {
            // ignore binary parse errors
        }
    }

    function sendEvent(t, d) {
        if (activeWs && activeWs.readyState === WebSocket.OPEN) {
            const payload = { t };
            if (d !== undefined && d !== null) payload.d = d;
            activeWs.send(JSON.stringify(payload));
        }
    }

    function configureAndStartIdle() {
        const idlePayload = {
            config: {
                doBattle: true,
                lvlMin: null,
                lvlMax: null,
                avoidSpecies: [],
                roamMaps: [],
                roamEnabled: true,
                usePotion: { enabled: true, itemId: "potion", hpPct: Math.round(botConfig.potion_hp_pct * 100), maxPerBattle: null },
                useRevive: { enabled: true, itemId: "revive", maxPerBattle: null, mode: "next" },
                tryCatch: {
                    enabled: true,
                    ballId: "poke-ball",
                    foeHpPct: Math.round(botConfig.catch_hp_pct * 100),
                    hpPctByBall: {},
                    avoid: [],
                    rules: [],
                    maxThrows: null,
                },
                autoHeal: true,
                autoBossAttack: true,
                keepTeamOrder: false,
                stopAfterDefeats: null,
            }
        };
        sendEvent("idle:config", idlePayload);
        if (botConfig.auto_idle) {
            sendEvent("idle:start");
            logEvent("⚡ Modo Auto-Idle ativado", "success");
        }
    }

    function updateInventory(data) {
        const items = Array.isArray(data) ? data : (data.items || []);
        const balls = { pokeball: 0, greatball: 0, ultraball: 0 };
        let potions = 0;
        for (const item of items) {
            if (!item) continue;
            const kind = String(item.kind || "").toLowerCase();
            const iid = String(item.id || item.itemId || "").toLowerCase();
            const qty = Number(item.quantity || item.qty || 1);
            if (kind.includes("ball") || iid.includes("ball")) {
                if (iid.includes("ultra")) balls.ultraball += qty;
                else if (iid.includes("great")) balls.greatball += qty;
                else balls.pokeball += qty;
            } else if (kind.includes("potion") || iid.includes("potion") || kind.includes("heal")) {
                potions += qty;
            }
        }
        inventory = { ball: balls, potion: potions };
        emitTelemetry();
    }

    function handleGameMessage(msg) {
        if (!msg) return;
        const t = msg.t || msg.type;
        const d = msg.d !== undefined ? msg.d : msg;

        // Welcome Packet — Official IdleDex Initial State
        if (t === "welcome") {
            if (d.playerId) {
                playerId = String(d.playerId);
                try { sessionStorage.setItem('idledex_playerId', playerId); } catch (e) {}
            }
            if (d.map) {
                currentMap = d.map;
                loadMapCollision(currentMap);
            }

            // Extract initial entities & player position from snapshot
            if (d.snapshot) {
                if (Array.isArray(d.snapshot.entities)) {
                    entities = d.snapshot.entities.map(e => {
                        const idStr = String(e.id || "").toLowerCase();
                        const nameStr = String(e.name || "").toLowerCase();
                        const isPlayer = (playerId && String(e.id) === String(playerId)) || nameStr.includes("self");
                        const isEnemy = !isPlayer && (
                            idStr.startsWith("wild:") ||
                            idStr.startsWith("foe:") ||
                            nameStr.startsWith("wild") ||
                            nameStr.startsWith("foe")
                        );
                        if (isPlayer && e.x !== undefined && e.y !== undefined) {
                            playerPos = { x: Number(e.x), y: Number(e.y) };
                        }
                        return {
                            id: e.id,
                            name: e.name || e.id,
                            x: e.x ?? null,
                            y: e.y ?? null,
                            dir: e.dir || "S",
                            is_player: isPlayer,
                            is_enemy: isEnemy
                        };
                    });
                }

                // Extract player progression, team, wallet & inventory from snapshot
                if (d.snapshot.player) {
                    const p = d.snapshot.player;
                    if (Array.isArray(p.team) && p.team.length > 0) {
                        team = p.team;
                        myMon = team[0];
                    }
                    if (p.wallet) {
                        wallet = {
                            coins: p.wallet.coins ?? p.wallet.gold ?? 0,
                            crystals: p.wallet.crystals ?? p.wallet.gems ?? 0
                        };
                    }
                    if (p.inventory) {
                        updateInventory(p.inventory);
                    }
                }
            }

            logEvent(`🎮 Conectado ao mapa ${currentMap || 'Mundo'} (Treinador: ${playerId || 'Player'})`, "success");
            emitTelemetry();

            setTimeout(() => {
                configureAndStartIdle();
                startRoamLoop();
            }, 1000);
        }

        // Authoritative Game State Updates (Player and Entity positions)
        else if (t === "state") {
            if (d.ack !== undefined) {
                moveSeq = Math.max(moveSeq, Number(d.ack));
            }

            const rawEntities = d.entities || [];
            for (const c of rawEntities) {
                if (!c || !c.id) continue;

                const isPlayer = (playerId && String(c.id) === String(playerId));

                // Self Position Update
                if (isPlayer && c.x !== undefined && c.y !== undefined) {
                    playerPos = { x: Number(c.x), y: Number(c.y) };
                }

                // Entity Delta Update
                const idStr = String(c.id || "").toLowerCase();
                const nameStr = String(c.name || "").toLowerCase();
                const isEnemy = !isPlayer && (
                    idStr.startsWith("wild:") ||
                    idStr.startsWith("foe:") ||
                    nameStr.startsWith("wild") ||
                    nameStr.startsWith("foe")
                );

                const existingIdx = entities.findIndex(e => e.id === c.id);
                const updated = {
                    id: c.id,
                    name: c.name || (existingIdx >= 0 ? entities[existingIdx].name : c.id),
                    x: c.x !== undefined ? c.x : (existingIdx >= 0 ? entities[existingIdx].x : null),
                    y: c.y !== undefined ? c.y : (existingIdx >= 0 ? entities[existingIdx].y : null),
                    dir: c.dir || (existingIdx >= 0 ? entities[existingIdx].dir : "S"),
                    is_player: isPlayer,
                    is_enemy: isEnemy
                };

                if (existingIdx >= 0) {
                    entities[existingIdx] = updated;
                } else {
                    entities.push(updated);
                }
            }
            emitTelemetry();
        }

        // Entity Enters Visible Range
        else if (t === "entity:enter") {
            if (d && d.id) {
                const idStr = String(d.id || "").toLowerCase();
                const nameStr = String(d.name || "").toLowerCase();
                const isPlayer = (playerId && String(d.id) === String(playerId));
                const isEnemy = !isPlayer && (
                    idStr.startsWith("wild:") ||
                    idStr.startsWith("foe:") ||
                    nameStr.startsWith("wild") ||
                    nameStr.startsWith("foe")
                );
                const existingIdx = entities.findIndex(e => e.id === d.id);
                const entry = {
                    id: d.id,
                    name: d.name || d.id,
                    x: d.x ?? null,
                    y: d.y ?? null,
                    dir: d.dir || "S",
                    is_player: isPlayer,
                    is_enemy: isEnemy
                };
                if (existingIdx >= 0) entities[existingIdx] = entry;
                else entities.push(entry);
                emitTelemetry();
            }
        }

        // Entity Leaves Visible Range
        else if (t === "entity:leave") {
            if (d && d.id) {
                entities = entities.filter(e => e.id !== d.id);
                emitTelemetry();
            }
        }

        // Map Change
        else if (t === "map:change") {
            if (d.map) {
                currentMap = d.map;
                loadMapCollision(currentMap);
            }
            if (d.x !== undefined && d.y !== undefined) playerPos = { x: Number(d.x), y: Number(d.y) };
            logEvent(`🗺️ Transição de mapa para: ${currentMap}`, "info");
            emitTelemetry();
        }

        // Battle Start
        else if (t === "battle:start") {
            // CRITICAL MULTI-PLAYER FIX: Ignore battles started by other players on the map!
            if (!isMyBattle(d)) {
                return;
            }

            inBattle = true;
            currentBattleId = d.battleId || d.id || null;
            if (d.foe) enemyMon = d.foe;

            // Extract moves from leader
            if (d.leader && Array.isArray(d.leader.moves) && d.leader.moves.length > 0) {
                battleMoves = d.leader.moves;
            } else if (d.leaderMoves && Array.isArray(d.leaderMoves) && d.leaderMoves.length > 0) {
                battleMoves = d.leaderMoves;
            }

            // Instantly stop roaming so no movement packets are sent during duel
            if (roamInterval) {
                clearInterval(roamInterval);
                roamInterval = null;
            }

            const foeName = (enemyMon && (enemyMon.name || enemyMon.species)) || "Criatura";
            logEvent(`⚔️ Duelo iniciado contra ${foeName}! (ID: ${currentBattleId || '?'})`, "info");
            emitTelemetry();

            // Interactive wild battle starts immediately
            battleWindowOpen = true;
            if (battleTurnTimer) clearTimeout(battleTurnTimer);
            battleTurnTimer = setTimeout(() => {
                if (inBattle && botConfig.enabled && currentBattleId) {
                    processBattleTurn();
                }
            }, 450);

            // Start battle watchdog poller to handle DOM interactive state seamlessly
            if (battleWatchdog) clearInterval(battleWatchdog);
            battleWatchdog = setInterval(() => {
                if (!inBattle) {
                    clearInterval(battleWatchdog);
                    battleWatchdog = null;
                    return;
                }
                if (!botConfig.enabled || !currentBattleId) return;

                const hasActiveMove = document.querySelector('.hud-duel-moves button:not([disabled])');
                const hasActiveItem = document.querySelector('.hud-throw-balls button:not([disabled])');
                if (hasActiveMove || hasActiveItem) {
                    processBattleTurn();
                }
            }, 600);
        }

        // Progress & Stats
        else if (t === "progress:state" || t === "progress") {
            if (d.rank) progress.rank = d.rank;
            if (d.xp !== undefined) progress.xp = d.xp;
            if (d.wins !== undefined) progress.wins = d.wins;
            if (d.losses !== undefined) progress.losses = d.losses;
            if (d.captures !== undefined) progress.captures = d.captures;
            if (d.shinies !== undefined) progress.shinies = d.shinies;
            emitTelemetry();
        }

        // Wallet
        else if (t === "wallet") {
            if (d.coins !== undefined) wallet.coins = d.coins;
            if (d.gold !== undefined) wallet.coins = d.gold;
            if (d.crystals !== undefined) wallet.crystals = d.crystals;
            emitTelemetry();
        }

        // Inventory
        else if (t === "inventory") {
            updateInventory(d);
        }

        // Collection Updates
        else if (t === "collection" || t === "collection:patch") {
            const mons = Array.isArray(d) ? d : (d.mons || d.monsters || []);
            for (const mon of mons) {
                if (mon && mon.id) {
                    collection[mon.id] = mon;
                    checkMonIVStrategy(mon);
                }
            }
            emitTelemetry();
        }

        // Active Team
        else if (t === "team" || t === "team:patch") {
            if (Array.isArray(d)) team = d;
            else if (d.team) team = d.team;
            if (team.length > 0) myMon = team[0];
            emitTelemetry();
        }

        // Combat Turn & Control
        else if (t === "battle:turn" || t === "battle:control") {
            // CRITICAL MULTI-PLAYER FIX: Ignore turns from other players' battles!
            if (!inBattle || !currentBattleId || d.battleId !== currentBattleId) {
                return;
            }

            if (d.myMon) myMon = d.myMon;
            if (d.foe || d.opponent) enemyMon = d.foe || d.opponent;
            if (d.moves && Array.isArray(d.moves) && d.moves.length > 0) battleMoves = d.moves;
            if (d.leader && Array.isArray(d.leader.moves) && d.leader.moves.length > 0) battleMoves = d.leader.moves;
            if (d.leaderMoves && Array.isArray(d.leaderMoves) && d.leaderMoves.length > 0) battleMoves = d.leaderMoves;
            if (d.canThrow !== undefined) canThrowBall = d.canThrow;
            if (d.canHeal !== undefined) canUsePotion = d.canHeal;
            battleWindowOpen = (d.open !== false);

            emitTelemetry();

            if (!botConfig.enabled || !battleWindowOpen) return;

            if (battleTurnTimer) clearTimeout(battleTurnTimer);
            battleTurnTimer = setTimeout(() => {
                if (!inBattle || !botConfig.enabled || !currentBattleId) return;
                processBattleTurn();
            }, 320);
        }

        // Combat Finished
        else if (t === "battle:end") {
            // CRITICAL MULTI-PLAYER FIX: Ignore battle end events from other players!
            if (!inBattle || !currentBattleId || d.battleId !== currentBattleId) {
                return;
            }

            inBattle = false;
            battleWindowOpen = false;
            currentBattleId = null;
            battleMoves = [];
            if (battleTurnTimer) {
                clearTimeout(battleTurnTimer);
                battleTurnTimer = null;
            }
            if (battleWatchdog) {
                clearInterval(battleWatchdog);
                battleWatchdog = null;
            }

            const victory = d.victory;
            const captured = d.captured;
            const foeName = (enemyMon && (enemyMon.name || enemyMon.species)) || "Criatura";

            if (captured) {
                logEvent(`✨ ${foeName} capturado com sucesso!`, "success");
                progress.captures = (progress.captures || 0) + 1;
            } else if (victory) {
                logEvent(`⚔️ Vitória sobre ${foeName}!`, "success");
                progress.wins = (progress.wins || 0) + 1;
            } else {
                logEvent(`💀 Derrota contra ${foeName}...`, "warning");
                progress.losses = (progress.losses || 0) + 1;
            }

            enemyMon = null;
            emitTelemetry();

            // Refresh collection / inventory (NO claim-all spam)
            sendEvent("inventory:list");

            // Resume roaming after battle exit animation completes
            if (botConfig.enabled && botConfig.auto_roam) {
                setTimeout(() => {
                    if (!inBattle && botConfig.enabled && botConfig.auto_roam) {
                        startRoamLoop();
                    }
                }, 1200);
            }
        }
    }

    function checkMonIVStrategy(mon) {
        const stats = mon.stats || mon.ivs || {};
        const ivSum = (stats.hp || 0) + (stats.atk || 0) + (stats.def || 0) + 
                      (stats.spAtk || 0) + (stats.spDef || 0) + (stats.speed || 0);

        if (botConfig.strategy_mode === "monetize") {
            if (ivSum <= botConfig.iv_sell_threshold) {
                sendEvent("market:sell", { monId: mon.id });
                logEvent(`💰 Venda automática de ${mon.species || 'Mon'} (IV: ${ivSum})`, "info");
            }
        }
    }

    // Process battle actions strictly using the active battleId and real DOM clicks
    function processBattleTurn() {
        if (!activeWs || activeWs.readyState !== WebSocket.OPEN || !currentBattleId || !inBattle || !botConfig.enabled) return;

        const myHpPct = (myMon && myMon.hpPercent !== undefined) ? myMon.hpPercent : 1.0;
        const foeHpPct = (enemyMon && enemyMon.hpPercent !== undefined) ? enemyMon.hpPercent : 1.0;

        // 1. Flee emergency
        if (myHpPct <= botConfig.flee_hp_pct) {
            logEvent("🏃 HP crítico! Executando fuga tática...", "warning");
            const fleeBtn = document.querySelector('.hud-throw-flee') || document.querySelector('button[data-testid$="-flee"]');
            if (fleeBtn) fleeBtn.click();
            sendEvent("battle:flee", { battleId: currentBattleId });
            return;
        }

        // 2. Heal with potion
        if (myHpPct <= botConfig.potion_hp_pct && inventory.potion > 0 && canUsePotion) {
            logEvent("🧪 Utilizando poção de cura no combate...", "info");
            const potionBtn = document.querySelector('button[data-item-id="potion"]') || document.querySelector('.hud-throw-ball[data-item-id*="potion"]');
            if (potionBtn) potionBtn.click();
            sendEvent("battle:item", { battleId: currentBattleId, itemId: "potion" });
            return;
        }

        // 3. Catch wild creature with tiered balls
        if (foeHpPct <= botConfig.catch_hp_pct && canThrowBall) {
            let chosenBall = "poke-ball";
            if (inventory.ball.ultraball > 0 && foeHpPct <= 0.20) chosenBall = "ultra-ball";
            else if (inventory.ball.greatball > 0 && foeHpPct <= 0.35) chosenBall = "great-ball";
            else if (inventory.ball.pokeball > 0) chosenBall = "poke-ball";
            else if (inventory.ball.greatball > 0) chosenBall = "great-ball";
            else if (inventory.ball.ultraball > 0) chosenBall = "ultra-ball";

            logEvent(`🎯 Arremessando ${chosenBall} (HP Inimigo: ${Math.round(foeHpPct * 100)}%)`, "info");
            const ballBtn = document.querySelector(`button[data-item-id="${chosenBall}"]`) || document.querySelector('.hud-throw-ball[data-item-id]');
            if (ballBtn) ballBtn.click();
            sendEvent("battle:item", { battleId: currentBattleId, itemId: chosenBall });
            return;
        }

        // 4. Attack move with capture protection
        // Dual inspection: memory moves + DOM move buttons
        const domMoveButtons = Array.from(document.querySelectorAll('.hud-duel-move[data-move-id]'));
        
        let chosenMoveId = null;
        let chosenMoveName = "Ataque";
        let chosenMovePower = "?";

        if (battleMoves && battleMoves.length > 0) {
            // Sort moves by power descending
            const sortedMoves = [...battleMoves].sort((a, b) => (b.power || 0) - (a.power || 0));
            let chosenMove = sortedMoves[0];

            // If foe is target for capture and close to catch threshold, choose weaker move to not KO
            if (botConfig.catch_hp_pct > 0 && foeHpPct <= (botConfig.catch_hp_pct + 0.25)) {
                const weakerMoves = sortedMoves.filter(m => (m.power || 0) > 0).reverse();
                if (weakerMoves.length > 0) {
                    chosenMove = weakerMoves[0];
                }
            }

            chosenMoveId = chosenMove.id;
            chosenMoveName = chosenMove.name || chosenMove.id;
            chosenMovePower = chosenMove.power || "?";
        } else if (domMoveButtons.length > 0) {
            // Fallback: extract move ID directly from DOM buttons
            const firstBtn = domMoveButtons[0];
            chosenMoveId = firstBtn.getAttribute('data-move-id');
            chosenMoveName = firstBtn.innerText ? firstBtn.innerText.split('\n')[0] : "Ataque";
        }

        if (chosenMoveId) {
            logEvent(`⚔️ Desferindo ${chosenMoveName} (Poder: ${chosenMovePower})`, "info");

            // 1) Click the matching DOM button if present
            const targetBtn = document.querySelector(`button[data-move-id="${chosenMoveId}"]`) || domMoveButtons[0];
            if (targetBtn) {
                targetBtn.click();
            }

            // 2) Send authoritative WebSocket packet
            sendEvent("battle:move", { battleId: currentBattleId, moveId: chosenMoveId });
        } else {
            // Fallback click on any available duel move button in DOM
            const anyBtn = document.querySelector('.hud-duel-moves button:not([disabled])') || document.querySelector('.hud-duel-move');
            if (anyBtn) {
                logEvent("⚔️ Acionando golpe disponível no HUD de batalha...", "info");
                anyBtn.click();
            }
        }
    }

    // Step player character via real keyboard events and WebSocket packet
    function stepInDirection(dir) {
        const keyMap = {
            N: "ArrowUp",
            S: "ArrowDown",
            E: "ArrowRight",
            W: "ArrowLeft"
        };
        const key = keyMap[dir];
        if (key) {
            window.dispatchEvent(new KeyboardEvent('keydown', { code: key, key: key, bubbles: true }));
            setTimeout(() => {
                window.dispatchEvent(new KeyboardEvent('keyup', { code: key, key: key, bubbles: true }));
            }, 80);
        }

        moveSeq++;
        sendEvent("move", { dir, n: moveSeq });
    }

    // Active Roam & Patrol loop with BFS grass navigation
    function startRoamLoop() {
        if (roamInterval) clearInterval(roamInterval);
        roamInterval = setInterval(() => {
            if (!botConfig.enabled || !botConfig.auto_roam || inBattle || !activeWs || activeWs.readyState !== WebSocket.OPEN) {
                return;
            }

            // Fallback position from player entity if playerPos not yet initialized
            if (playerPos.x === null || playerPos.y === null) {
                const self = entities.find(e => e.is_player || (playerId && String(e.id) === String(playerId)));
                if (self && self.x !== null && self.y !== null) {
                    playerPos = { x: self.x, y: self.y };
                }
            }

            const px = playerPos.x;
            const py = playerPos.y;
            if (px === null || py === null) {
                return;
            }

            // Automatically load map collision if not yet cached
            if (!mapGrid && currentMap && !loadingMap) {
                loadMapCollision(currentMap);
                return;
            }

            let chosenDir = null;

            // Strategy 1: If player is ALREADY inside tall grass, pace strictly within the grass patch
            if (isGrass(px, py)) {
                const dirs = [
                    { dir: "N", nx: px, ny: py - 1 },
                    { dir: "S", nx: px, ny: py + 1 },
                    { dir: "E", nx: px + 1, ny: py },
                    { dir: "W", nx: px - 1, ny: py }
                ];
                const grassOptions = dirs.filter(d => isGrass(d.nx, d.ny));
                if (grassOptions.length > 0) {
                    const opp = { N: "S", S: "N", E: "W", W: "E" };
                    let pick = null;
                    // Step back and forth or explore grass tiles to trigger wild encounters rapidly
                    if (lastGrassDir && grassOptions.some(d => d.dir === opp[lastGrassDir]) && (roamStepIdx % 2 === 0)) {
                        pick = grassOptions.find(d => d.dir === opp[lastGrassDir]);
                    } else {
                        pick = grassOptions[roamStepIdx % grassOptions.length];
                    }
                    roamStepIdx++;
                    chosenDir = pick.dir;
                    lastGrassDir = chosenDir;
                }
            }

            // Strategy 2: If player is OUTSIDE tall grass, run BFS pathfinding straight to nearest grass tile
            if (!chosenDir && grassTiles.length > 0) {
                chosenDir = findNextStepToGrass(px, py);
            }

            // Strategy 3: Fallback pacing around walkable tiles (path/trail)
            if (!chosenDir) {
                const dirs = [
                    { dir: "N", nx: px, ny: py - 1 },
                    { dir: "E", nx: px + 1, ny: py },
                    { dir: "S", nx: px, ny: py + 1 },
                    { dir: "W", nx: px - 1, ny: py }
                ];
                const walkableOptions = dirs.filter(d => isWalkable(d.nx, d.ny));
                if (walkableOptions.length > 0) {
                    const pick = walkableOptions[roamStepIdx % walkableOptions.length];
                    roamStepIdx++;
                    chosenDir = pick.dir;
                } else {
                    chosenDir = ["N", "E", "S", "W"][roamStepIdx % 4];
                    roamStepIdx++;
                }
            }

            if (chosenDir) {
                stepInDirection(chosenDir);
                const delta = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] }[chosenDir];
                if (delta) {
                    playerPos = { x: px + delta[0], y: py + delta[1] };
                }
                emitTelemetry();
            }
        }, 300);
    }

    // Native WebSocket Hook in Main World
    const OrigWebSocket = window.WebSocket;
    function HookedWebSocket(...args) {
        console.log("[IdleDex Desktop] Novo WebSocket interceptado com sucesso:", args[0]);
        const ws = new OrigWebSocket(...args);
        activeWs = ws;

        ws.addEventListener('open', () => {
            logEvent("✅ Conexão WebSocket estabelecida com o servidor!", "success");
            emitTelemetry();
            setTimeout(configureAndStartIdle, 1000);
        });

        ws.addEventListener('close', () => {
            logEvent("🔌 WebSocket desconectado.", "warning");
            emitTelemetry();
        });

        ws.addEventListener('message', (event) => {
            if (event.data instanceof ArrayBuffer) {
                parseBinaryFrame(event.data);
            } else if (typeof event.data === 'string') {
                try {
                    const msg = JSON.parse(event.data);
                    handleGameMessage(msg);
                } catch (e) {}
            }
        });

        return ws;
    }

    // Preserve prototype & static constants
    HookedWebSocket.prototype = OrigWebSocket.prototype;
    HookedWebSocket.CONNECTING = OrigWebSocket.CONNECTING;
    HookedWebSocket.OPEN = OrigWebSocket.OPEN;
    HookedWebSocket.CLOSING = OrigWebSocket.CLOSING;
    HookedWebSocket.CLOSED = OrigWebSocket.CLOSED;
    window.WebSocket = HookedWebSocket;

    // Listen for commands dispatched from host via preload
    window.addEventListener('idledex-from-preload', (event) => {
        const { cmd, payload } = event.detail || {};
        if (cmd === 'toggle-bot') {
            botConfig.enabled = (payload && payload.enabled !== undefined) ? payload.enabled : !botConfig.enabled;
            if (!botConfig.enabled) {
                // Clean pause: instantly cancel all loops and pending timers
                if (roamInterval) {
                    clearInterval(roamInterval);
                    roamInterval = null;
                }
                if (battleTurnTimer) {
                    clearTimeout(battleTurnTimer);
                    battleTurnTimer = null;
                }
                if (battleWatchdog) {
                    clearInterval(battleWatchdog);
                    battleWatchdog = null;
                }
                logEvent("⏸️ Bot pausado pelo usuário (Controle manual liberado)", "warning");
            } else {
                logEvent("▶️ Bot ativado pelo usuário", "success");
                if (inBattle) {
                    // In battle: do NOT roam; process battle action immediately
                    processBattleTurn();
                } else {
                    startRoamLoop();
                }
            }
            emitTelemetry();
        } else if (cmd === 'update-config') {
            Object.assign(botConfig, payload);
            logEvent("⚙️ Configurações do bot atualizadas", "info");
            configureAndStartIdle();
            emitTelemetry();
        } else if (cmd === 'manual-action') {
            if (payload.action === 'idle-start') sendEvent("idle:start");
            else if (payload.action === 'idle-stop') sendEvent("idle:stop");
            else if (payload.action === 'claim-all') {
                sendEvent("pokedex:claim-all");
                sendEvent("gamepass:claim-all");
            }
        }
    });

    logEvent("🚀 Motor autônomo injetado com sucesso no contexto oficial do jogo!", "success");
}

// 4. Trigger Main World Injection
try {
    webFrame.executeJavaScript('(' + initMainWorldEngine.toString() + ')()');
} catch (e) {
    console.error("[IdleDex Desktop] Falha ao executar webFrame.executeJavaScript:", e);
}
