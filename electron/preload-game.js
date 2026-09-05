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
    let battleWindowOpen = false;

    let myMon = null;
    let enemyMon = null;
    let playerId = null;
    let currentMap = "";
    let playerPos = { x: null, y: null };
    let entities = [];
    let moveSeq = 0;
    let roamInterval = null;
    let roamStepIdx = 0;

    // Map collision and grass tile coordinates
    let mapCols = 0;
    let mapRows = 0;
    let mapGrid = null;
    let grassTiles = [];

    let progress = { rank: 1, xp: 0, wins: 0, losses: 0, captures: 0, shinies: 0 };
    let inventory = { ball: { pokeball: 0, greatball: 0, ultraball: 0 }, potion: 0 };
    let wallet = { coins: 0, crystals: 0 };
    let collection = {};
    let team = [];

    async function loadMapCollision(mapId) {
        if (!mapId) return;
        try {
            const resp = await fetch(`/maps/${mapId}.collision.json`);
            if (!resp.ok) return;
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
            logEvent(`🌿 Malha de mapa carregada: ${grassTiles.length} tiles de grama alta identificados`, "info");
        } catch (e) {
            // ignore network load errors
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

                const isPlayer = (playerId && name === playerId) || name.includes("Player:") || name.toLowerCase().includes("self");
                const isEnemy = !isPlayer && (name.toLowerCase().includes("wild:") || name.toLowerCase().includes("foe:") || name.includes("Wild") || name.includes(":"));

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
            if (d.playerId) playerId = d.playerId;
            if (d.map) {
                currentMap = d.map;
                loadMapCollision(currentMap);
            }

            // Extract initial entities & player position from snapshot
            if (d.snapshot) {
                if (Array.isArray(d.snapshot.entities)) {
                    entities = d.snapshot.entities.map(e => {
                        const isPlayer = e.id === playerId;
                        const isEnemy = !isPlayer && (
                            (e.id && (e.id.toLowerCase().includes("wild:") || e.id.toLowerCase().includes("foe:") || e.id.includes(":"))) ||
                            (e.name && (e.name.toLowerCase().includes("wild") || e.name.toLowerCase().includes("foe")))
                        );
                        if (isPlayer && e.x !== undefined && e.y !== undefined) {
                            playerPos = { x: e.x, y: e.y };
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
                sendEvent("pokedex:claim-all");
                sendEvent("gamepass:claim-all");
                startRoamLoop();
            }, 1000);
        }

        // Authoritative Game State Updates (Player and Entity positions)
        else if (t === "state") {
            const rawEntities = d.entities || [];
            for (const c of rawEntities) {
                if (!c || !c.id) continue;

                // Self Position Update
                if (playerId && c.id === playerId) {
                    if (c.x !== undefined && c.y !== undefined) {
                        playerPos = { x: c.x, y: c.y };
                    }
                }

                // Entity Delta Update
                const existingIdx = entities.findIndex(e => e.id === c.id);
                const isPlayer = (playerId && c.id === playerId);
                const isEnemy = !isPlayer && (
                    (c.id.toLowerCase().includes("wild:") || c.id.toLowerCase().includes("foe:") || c.id.includes(":")) ||
                    (c.name && (c.name.toLowerCase().includes("wild") || c.name.toLowerCase().includes("foe")))
                );

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
                const isPlayer = (playerId && d.id === playerId);
                const isEnemy = !isPlayer && (
                    (d.id.toLowerCase().includes("wild:") || d.id.toLowerCase().includes("foe:") || d.id.includes(":")) ||
                    (d.name && (d.name.toLowerCase().includes("wild") || d.name.toLowerCase().includes("foe")))
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
            if (d.x !== undefined && d.y !== undefined) playerPos = { x: d.x, y: d.y };
            logEvent(`🗺️ Transição de mapa para: ${currentMap}`, "info");
            emitTelemetry();
        }

        // Battle Start
        else if (t === "battle:start") {
            inBattle = true;
            currentBattleId = d.battleId || d.id || null;
            if (d.foe) enemyMon = d.foe;
            if (d.leaderMoves) battleMoves = d.leaderMoves;
            logEvent(`⚔️ Duelo iniciado! (ID: ${currentBattleId || '?'})`, "info");
            emitTelemetry();
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
            inBattle = true;
            if (d.battleId) currentBattleId = d.battleId;
            if (d.myMon) myMon = d.myMon;
            if (d.foe || d.opponent) enemyMon = d.foe || d.opponent;
            if (d.moves && Array.isArray(d.moves) && d.moves.length > 0) battleMoves = d.moves;
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
            inBattle = false;
            battleWindowOpen = false;
            currentBattleId = null;
            battleMoves = [];
            if (battleTurnTimer) {
                clearTimeout(battleTurnTimer);
                battleTurnTimer = null;
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

            // Refresh collection / inventory
            sendEvent("inventory:list");
            sendEvent("pokedex:claim-all");
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

    // Process battle actions strictly using the active battleId
    function processBattleTurn() {
        if (!activeWs || activeWs.readyState !== WebSocket.OPEN || !currentBattleId || !inBattle) return;

        const myHpPct = (myMon && myMon.hpPercent !== undefined) ? myMon.hpPercent : 1.0;
        const foeHpPct = (enemyMon && enemyMon.hpPercent !== undefined) ? enemyMon.hpPercent : 1.0;

        // 1. Flee emergency
        if (myHpPct <= botConfig.flee_hp_pct) {
            logEvent("🏃 HP crítico! Executando fuga tática...", "warning");
            sendEvent("battle:flee", { battleId: currentBattleId });
            return;
        }

        // 2. Heal with potion
        if (myHpPct <= botConfig.potion_hp_pct && inventory.potion > 0 && canUsePotion) {
            logEvent("🧪 Utilizando poção de cura no combate...", "info");
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
            sendEvent("battle:item", { battleId: currentBattleId, itemId: chosenBall });
            return;
        }

        // 4. Attack move with capture protection
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

            logEvent(`⚔️ Desferindo ${chosenMove.name || 'Golpe'} (Poder: ${chosenMove.power || '?'})`, "info");
            sendEvent("battle:move", { battleId: currentBattleId, moveId: chosenMove.id });
        } else {
            // Fallback move slot
            sendEvent("battle:move", { battleId: currentBattleId, moveIndex: 0 });
        }
    }

    // Active Roam & Patrol loop with grass hunting
    function startRoamLoop() {
        if (roamInterval) clearInterval(roamInterval);
        roamInterval = setInterval(() => {
            if (!botConfig.enabled || !botConfig.auto_roam || inBattle || !activeWs || activeWs.readyState !== WebSocket.OPEN) {
                return;
            }

            const px = playerPos.x;
            const py = playerPos.y;
            if (px === null || py === null) return;

            let chosenDir = null;

            // Strategy 1: Hunt visible wild creature on radar
            const wildTargets = entities.filter(e => e.is_enemy && e.x !== null && e.y !== null);
            if (wildTargets.length > 0) {
                let closest = null;
                let minDist = Infinity;
                for (const w of wildTargets) {
                    const dist = Math.abs(w.x - px) + Math.abs(w.y - py);
                    if (dist < minDist) {
                        minDist = dist;
                        closest = w;
                    }
                }
                if (closest && minDist <= 15) {
                    const dx = closest.x - px;
                    const dy = closest.y - py;
                    if (Math.abs(dx) >= Math.abs(dy) && dx !== 0) {
                        const testDir = dx > 0 ? "E" : "W";
                        if (isWalkable(px + (dx > 0 ? 1 : -1), py)) chosenDir = testDir;
                    }
                    if (!chosenDir && dy !== 0) {
                        const testDir = dy > 0 ? "S" : "N";
                        if (isWalkable(px, py + (dy > 0 ? 1 : -1))) chosenDir = testDir;
                    }
                }
            }

            // Strategy 2: If not in grass, navigate toward the nearest grass tile
            if (!chosenDir && grassTiles.length > 0 && !isGrass(px, py)) {
                let closestGrass = null;
                let minGrassDist = Infinity;
                for (const g of grassTiles) {
                    const dist = Math.abs(g.x - px) + Math.abs(g.y - py);
                    if (dist < minGrassDist) {
                        minGrassDist = dist;
                        closestGrass = g;
                    }
                }
                if (closestGrass) {
                    const dx = closestGrass.x - px;
                    const dy = closestGrass.y - py;
                    const candidates = [];
                    if (dx > 0) candidates.push({ dir: "E", nx: px + 1, ny: py });
                    else if (dx < 0) candidates.push({ dir: "W", nx: px - 1, ny: py });
                    if (dy > 0) candidates.push({ dir: "S", nx: px, ny: py + 1 });
                    else if (dy < 0) candidates.push({ dir: "N", nx: px, ny: py - 1 });

                    for (const c of candidates) {
                        if (isWalkable(c.nx, c.ny)) {
                            chosenDir = c.dir;
                            break;
                        }
                    }
                }
            }

            // Strategy 3: If already on grass or no specific target, roam strictly within grass
            if (!chosenDir && isGrass(px, py)) {
                // Prefer directions that remain in grass
                const dirs = [
                    { dir: "N", nx: px, ny: py - 1 },
                    { dir: "E", nx: px + 1, ny: py },
                    { dir: "S", nx: px, ny: py + 1 },
                    { dir: "W", nx: px - 1, ny: py }
                ];
                const grassOptions = dirs.filter(d => isGrass(d.nx, d.ny));
                if (grassOptions.length > 0) {
                    // Pick a grass direction (alternating or random)
                    const pick = grassOptions[roamStepIdx % grassOptions.length];
                    roamStepIdx++;
                    chosenDir = pick.dir;
                }
            }

            // Strategy 4: Fallback pacing around walkable tiles
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

            moveSeq++;
            sendEvent("move", { dir: chosenDir, n: moveSeq });
        }, 360);
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
                logEvent("⏸️ Bot pausado pelo usuário (Controle manual liberado)", "warning");
            } else {
                logEvent("▶️ Bot ativado pelo usuário", "success");
                startRoamLoop();
                if (inBattle && currentBattleId && battleWindowOpen) {
                    processBattleTurn();
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
