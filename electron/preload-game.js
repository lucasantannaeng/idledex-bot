/**
 * IdleDex Desktop — Game Webview Preload
 * Injects autonomous engine directly into the guest page's Main World via webFrame,
 * intercepting native WebSocket before the game scripts execute.
 */

const { webFrame, ipcRenderer } = require('electron');
const { createConfigSchema } = require('./config-schema');
const { createBridgeContract } = require('./bridge-contract');
const bridgeContract = createBridgeContract();

// 1. Preload -> Host Bridge (T04: strictly allowlisted channels and validated payloads)
const ALLOWED_PRELOAD_CHANNELS = bridgeContract.channels;

function handleIdledexToPreload(event, customIpc = (typeof ipcRenderer !== 'undefined' ? ipcRenderer : null)) {
    try {
        const message = bridgeContract.fromGame(event.detail);
        if (message) customIpc?.sendToHost(message.channel, message.data);
    } catch (e) {}
}

if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('idledex-to-preload', (e) => handleIdledexToPreload(e));
}

// 2. Host -> Preload Bridge (T04: strictly allowlisted host commands)
const ALLOWED_HOST_COMMANDS = bridgeContract.commands;

function handleHostCommand(event, data, customWindow = (typeof window !== 'undefined' ? window : null)) {
    try {
        const message = bridgeContract.fromHost(data);
        if (message) {
            if (customWindow && customWindow.dispatchEvent) {
                customWindow.dispatchEvent(new CustomEvent('idledex-from-preload', { detail: message }));
            }
        }
    } catch (e) {}
}

if (typeof ipcRenderer !== 'undefined' && ipcRenderer.on) {
    ipcRenderer.on('host-command', (e, d) => handleHostCommand(e, d));
}

// 3. Inject Main World Engine
function initMainWorldEngine(configSchema) {
    'use strict';

    console.log("[IdleDex Desktop] Inicializando motor autônomo no mundo principal...");

    let botConfig = configSchema.normalizeConfig({});

    let currentMapSpecies = [];
    let configReady = false;
    let lastCapturedMon = null;
    let battleKnownCreatureIds = new Set();
    let pendingCaptures = [];
    let lastProfessorState = null;
    let collectorState = null;
    let collectorDeliveryKey = null;
    let lastDexQuestState = null;
    let lastHealRequest = null;
    let rejectedHealState = null;
    let nextHealAt = 0;
    let nextRecoveryItemAt = 0;
    const releasedCreatureIds = new Set();
    const pendingReleases = new Map(); // id -> { speciesName, ivSum, ivPct, cutoffPct, requestedAt }
    // One outstanding request per NPC, retained across reconnect until inventory
    // confirms consumption. Species-based APIs do not identify the chosen copy.
    const pendingDonations = new Map();
    const pendingLocks = new Set();
    let pokedexLoaded = false;
    const pokedexCaughtSpecies = new Set();
    let currentMapAbortController = null;
    let mapAvailable = false;
    let mapStatus = 'idle'; // 'idle' | 'loading' | 'available' | 'unavailable' | 'empty'
    const routeSwitchState = {
        active: false,
        targetRoute: null,
        requestedAt: 0,
        attempts: 0,
        timeoutTimer: null,
    };

    function isSpeciesUncaught(speciesId, speciesName) {
        const sId = (speciesId !== undefined && speciesId !== null) ? String(speciesId) : '';
        const sName = speciesName ? String(speciesName).toLowerCase() : '';

        // 1. If currently in collection (party or box), it is definitely not uncaught
        const inCollection = Object.values(collection).some(mon => {
            const monId = (mon.speciesId !== undefined && mon.speciesId !== null) ? String(mon.speciesId) : '';
            const monName = (mon.species || mon.name) ? String(mon.species || mon.name).toLowerCase() : '';
            return (sId && monId === sId) || (sName && monName === sName);
        });
        if (inCollection) return false;

        // 2. If permanent Pokédex data is loaded, consult it
        // Species registered in Pokédex but missing from Box is NOT uncaught
        if (pokedexLoaded) {
            const registered = (sId && pokedexCaughtSpecies.has(sId)) || (sName && pokedexCaughtSpecies.has(sName));
            return !registered;
        }

        // 3. If Pokédex is not loaded (unknown state), fallback to collection absence:
        // "estado desconhecido não equivale automaticamente a falso"
        return Boolean(sId || sName);
    }

    function addReleasedId(id) {
        if (!id) return;
        if (releasedCreatureIds.size >= 500) {
            const firstKey = releasedCreatureIds.values().next().value;
            if (firstKey !== undefined) releasedCreatureIds.delete(firstKey);
        }
        releasedCreatureIds.add(id);
    }

    let activeWs = null;
    let commandGeneration = 0;
    function scheduleSessionTask(callback, delay) {
        const socket = activeWs;
        const generation = commandGeneration;
        return setTimeout(() => {
            if (socket && activeWs === socket && socket.readyState === WebSocket.OPEN && generation === commandGeneration) callback();
        }, delay);
    }
    let inBattle = false;
    let actionInFlight = false;
    let lastTurnNumber = -1;
    let currentBattleId = null;
    let battleMoves = [];
    let canThrowBall = true;
    let canUsePotion = true;
    let battleTurnTimer = null;
    let battleWatchdog = null;
    let battleWindowOpen = false;
    let battleReadyAt = 0;
    let battleExpiresAt = Infinity;

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
    let lastStepExecutedAt = 0;

    // Map collision, fringe mask, and validated tall grass coordinates
    let mapCols = 0;
    let mapRows = 0;
    let mapGrid = null;
    let mapFringeMask = null;
    let cleanGrassGrid = null;
    let grassTiles = [];
    let currentMapBiome = "forest";
    let loadingMap = false;
    let mapLoadVersion = 0;

    // Session metrics (Component 5)
    let sessionStartTime = Date.now();
    let sessionCaptures = 0;
    let sessionXpGained = 0;
    let sessionSilverGained = 0;
    let reconnectCount = 0;
    let hasConnected = false;
    let initialXp = null;
    let initialSilver = null;

    // Dead-end detection (Component 4)
    let lastStepPos = { x: null, y: null };
    let stuckCounter = 0;

    // Auto-route-switch cooldown (Component 3)
    let lastRouteSwitchTime = 0;

    let canRevive = true;
    let progress = { rank: 1, xp: 0, wins: 0, losses: 0, captures: 0, shinies: 0 };
    let inventory = {
        ball: { pokeball: 0, greatball: 0, superball: 0, ultraball: 0, masterball: 0 },
        potions: { potion: 0, "super-potion": 0, "hyper-potion": 0, "max-potion": 0 },
        revives: { revive: 0, "max-revive": 0 },
        boosts: { "shiny-boost": 0, "xp-share-boost": 0, "capture-boost": 0, "map-boost": 0 },
        potion: 0
    };
    let itemEffects = {
        mapBoost: null,
        tracker: null,
        shinyBoost: null,
        captureBoost: null,
        xpShareBoost: null,
        fishingBait: null,
        bless: null
    };
    let lastMaintenanceCheck = 0;
    let lastRecoveryCheck = 0;
    let wallet = { silver: 0, gold: 0 };
    let collection = {};
    let collectionLoaded = false;
    let team = [];
    let lastHuntMap = null;
    try { lastHuntMap = sessionStorage.getItem('idledex-last-hunt-map'); } catch {}
    let lastTravelCollectionKey = null;

    // State machine for Option 3: Auto-Travel & NPC Deliveries
    let autoTravelState = {
        active: false,
        originMap: null,
        targetMap: "npclab",
        phase: "idle", // 'idle' | 'traveling_to_lab' | 'delivering' | 'returning'
        lastTravelTime: 0,
        cooldownMs: 180000, // 3 min cooldown between auto-travel runs
        timeoutTimer: null,
        deliveriesDone: 0,
        pendingDelivery: null,
        returnAttempts: 0
    };

    function returnFromLab(reason) {
        if (!autoTravelState.active || !botConfig.enabled) return;
        clearTimeout(autoTravelState.timeoutTimer);
        autoTravelState.phase = 'returning';
        autoTravelState.pendingDelivery = null;
        autoTravelState.returnAttempts++;
        logEvent(`[AUTO-TRAVEL] ${reason} Retornando para ${getMapFriendlyName(autoTravelState.originMap)}.`, 'info');
        sendEvent('map:travel', { mapId: autoTravelState.originMap });
        autoTravelState.timeoutTimer = scheduleSessionTask(() => {
            if (!autoTravelState.active || autoTravelState.phase !== 'returning') return;
            if (autoTravelState.returnAttempts < 3) returnFromLab('Retorno ainda não confirmado.');
            else {
                botConfig.enabled = false;
                logEvent('[AUTO-TRAVEL] Retorno recusado ou sem resposta. Bot pausado; escolha uma rota no jogo para retomar.', 'error');
                emitTelemetry();
            }
        }, 10000);
    }

    function beginLabDelivery() {
        autoTravelState.phase = 'delivering';
        autoTravelState.pendingDelivery = null;
        lastProfessorState = null;
        clearTimeout(autoTravelState.timeoutTimer);
        autoTravelState.timeoutTimer = scheduleSessionTask(() => {
            if (autoTravelState.active && autoTravelState.phase === 'delivering') {
                returnFromLab('Professor sem confirmação no prazo; nenhuma entrega adicional será enviada.');
            }
        }, 25000);
        sendEvent('professor:open');
        if (botConfig.auto_heal_center) requestAffordableHeal();
    }

    function checkAutoTravelDeliveries(manual = false) {
        if (!botConfig.enabled || !botConfig.auto_travel_deliveries || !botConfig.auto_npc_quests) return false;
        if (inBattle || autoTravelState.active || routeSwitchState.active) return false;
        if (!currentMap || currentMap === "npclab" || currentMap.startsWith("lobby")) return false;

        const now = Date.now();
        if (now - autoTravelState.lastTravelTime < autoTravelState.cooldownMs) return false;

        // Group unlocked, non-shiny creatures in player collection by speciesId
        const speciesCounts = {};
        const speciesNames = {};
        for (const id in collection) {
            const mon = collection[id];
            if (!isDonatableCreature(mon)) continue;
            const spId = mon.speciesId || mon.species;
            if (!spId) continue;
            speciesCounts[spId] = (speciesCounts[spId] || 0) + 1;
            if (mon.name || mon.species) speciesNames[spId] = mon.name || mon.species;
        }

        const threshold = botConfig.auto_travel_surplus_threshold || 5;
        let eligibleSpecies = null;
        let surplusCount = 0;

        for (const spId in speciesCounts) {
            const count = speciesCounts[spId];
            if (count > threshold && canDonateSpecies(spId, 5)) {
                eligibleSpecies = spId;
                surplusCount = count - 1; // Preserve 1 copy for trainer
                break;
            }
        }

        if (!eligibleSpecies) return false;
        const collectionKey = JSON.stringify(Object.entries(speciesCounts).sort());
        if (!manual && collectionKey === lastTravelCollectionKey) return false;
        lastTravelCollectionKey = collectionKey;

        autoTravelState.active = true;
        autoTravelState.originMap = currentMap;
        autoTravelState.targetMap = "npclab";
        autoTravelState.phase = "traveling_to_lab";
        autoTravelState.lastTravelTime = now;
        autoTravelState.deliveriesDone = 0;
        autoTravelState.pendingDelivery = null;
        autoTravelState.returnAttempts = 0;

        // Immediately pause grass roaming
        if (roamInterval) {
            clearInterval(roamInterval);
            roamInterval = null;
        }

        logEvent(`🚀 [AUTO-TRAVEL] Acúmulo de ${surplusCount} cópias de ${speciesNames[eligibleSpecies] || eligibleSpecies}! Pausando patrulha e viajando para o Laboratório do Professor (npclab)...`, "warning");

        // Watchdog timeout to prevent hang if packet is lost (25s)
        if (autoTravelState.timeoutTimer) clearTimeout(autoTravelState.timeoutTimer);
        autoTravelState.timeoutTimer = scheduleSessionTask(() => {
            if (autoTravelState.active && autoTravelState.phase !== "idle") {
                logEvent(`⚠️ [AUTO-TRAVEL] Timeout de viagem/entrega (25s). Solicitando retorno ? rota...`, "warning");
                returnFromLab('Viagem sem confirmação no prazo.');
            }
        }, 25000);

        sendEvent("map:travel", { mapId: "npclab" });
        return true;
    }

    function checkAutoRouteSwitch() {
        if (!botConfig.enabled || !botConfig.auto_route_switch) return false;
        if (inBattle || autoTravelState.active || routeSwitchState.active) return false;
        if (!currentMap || !currentMap.startsWith("route_")) return false;
        if (!Array.isArray(currentMapSpecies) || currentMapSpecies.length === 0) return false;

        const now = Date.now();
        if (now - lastRouteSwitchTime < 30000) return false; // 30s cooldown

        // Check if there is a pinned species present on this route
        if (botConfig.pinned_species) {
            const pinnedList = Array.isArray(botConfig.pinned_species)
                ? botConfig.pinned_species.map(s => String(s).toLowerCase().trim())
                : [String(botConfig.pinned_species).toLowerCase().trim()];
            const hasPinned = currentMapSpecies.some(s => {
                const sId = String(s.speciesId || '').toLowerCase().trim();
                const sName = String(s.name || '').toLowerCase().trim();
                return pinnedList.some(p => p && (sId === p || sName === p));
            });
            if (hasPinned) {
                // User pinned this species for high-IV farming: stay on this route!
                return false;
            }
        }

        // Target species (or all species if target list is empty)
        let relevantSpecies = currentMapSpecies;
        if (botConfig.target_mode === 'none') {
            return false;
        } else if (botConfig.target_mode === 'selected' && Array.isArray(botConfig.target_species) && botConfig.target_species.length > 0) {
            const selectedSet = new Set(botConfig.target_species.map(String));
            relevantSpecies = currentMapSpecies.filter(s => selectedSet.has(String(s.speciesId)));
        } else if (Array.isArray(botConfig.target_species) && botConfig.target_species.length > 0 && botConfig.target_mode !== 'all') {
            const selectedSet = new Set(botConfig.target_species.map(String));
            relevantSpecies = currentMapSpecies.filter(s => selectedSet.has(String(s.speciesId)));
        }

        if (relevantSpecies.length === 0) return false;

        // Check if all relevant species are marked as caught
        const allCaught = relevantSpecies.every(s => s.caught === true);
        if (!allCaught) return false;

        // Calculate next sequential route
        const match = currentMap.match(/^route_(\d+)$/);
        if (!match) return false;
        const currentRouteNum = parseInt(match[1], 10);
        const nextRouteNum = currentRouteNum + 1;
        if (nextRouteNum > 150) {
            logEvent(`🏁 [AUTO-ROTA] Todas as rotas acessíveis completadas! Permanecendo em ${getMapFriendlyName(currentMap)}.`, "info");
            return false;
        }

        const nextRouteId = `route_${String(nextRouteNum).padStart(3, '0')}`;
        lastRouteSwitchTime = now;

        routeSwitchState.active = true;
        routeSwitchState.targetRoute = nextRouteId;
        routeSwitchState.requestedAt = now;
        routeSwitchState.attempts = (routeSwitchState.attempts || 0) + 1;

        logEvent(`🗺️ [AUTO-ROTA] Todas as espécies alvo de ${getMapFriendlyName(currentMap)} foram capturadas! Solicitando viagem para ${getMapFriendlyName(nextRouteId)}...`, "info");

        if (roamInterval) {
            clearInterval(roamInterval);
            roamInterval = null;
        }

        if (routeSwitchState.timeoutTimer) clearTimeout(routeSwitchState.timeoutTimer);
        routeSwitchState.timeoutTimer = scheduleSessionTask(() => {
            if (routeSwitchState.active) {
                logEvent(`⚠️ [AUTO-ROTA] Tempo limite aguardando confirmação de viagem para ${getMapFriendlyName(routeSwitchState.targetRoute)} (15s). Retomando patrulha em ${getMapFriendlyName(currentMap)}.`, "warning");
                routeSwitchState.active = false;
                routeSwitchState.targetRoute = null;
                routeSwitchState.timeoutTimer = null;
                if (!inBattle && botConfig.enabled) {
                    startRoamLoop();
                }
            }
        }, 15000);

        sendEvent("map:travel", { mapId: nextRouteId });
        return true;
    }

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

    function decodeFringeMask(b64) {
        if (!b64) return null;
        try {
            const raw = atob(b64);
            const arr = new Uint8Array(raw.length);
            for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
            return arr;
        } catch (e) {
            return null;
        }
    }

    function isFringe(x, y) {
        if (!mapFringeMask || x < 0 || y < 0 || x >= mapCols || y >= mapRows) return false;
        const r = y * mapCols + x;
        const byteIdx = r >> 3;
        if (byteIdx >= mapFringeMask.length) return false;
        return (mapFringeMask[byteIdx] & (1 << (r & 7))) !== 0;
    }

    async function loadMapCollision(mapId) {
        if (!mapId) return;
        const loadVersion = ++mapLoadVersion;
        if (currentMapAbortController) {
            try { currentMapAbortController.abort(); } catch (e) {}
            currentMapAbortController = null;
        }

        let controller = null;
        if (typeof AbortController !== 'undefined') {
            controller = new AbortController();
            currentMapAbortController = controller;
        }
        const timeoutId = controller ? setTimeout(() => {
            try { controller.abort(); } catch (e) {}
        }, 10000) : null;

        loadingMap = true;
        mapAvailable = false;
        mapStatus = 'loading';
        mapGrid = null;
        mapFringeMask = null;
        cleanGrassGrid = null;
        grassTiles = [];
        mapCols = mapRows = 0;

        try {
            const fetchOpts = controller ? { signal: controller.signal } : {};
            let resp = await fetch(`/maps/${mapId}.collision.json`, fetchOpts);
            if (!resp.ok) {
                // Try hyphenated fallback if mapId contains underscore
                resp = await fetch(`/maps/${mapId.replace(/_/g, '-')}.collision.json`, fetchOpts);
            }
            if (loadVersion !== mapLoadVersion || mapId !== currentMap) return;
            if (!resp.ok) {
                mapAvailable = false;
                mapStatus = 'unavailable';
                logEvent(`⚠️ [MAPA] Falha ao carregar colisão de ${mapId} (HTTP ${resp.status || 'erro'}). Movimento suspenso.`, "warning");
                emitTelemetry();
                return;
            }

            const data = await resp.json();
            if (loadVersion !== mapLoadVersion || mapId !== currentMap) return;
            if (!data || typeof data !== 'object' ||
                !Number.isInteger(data.cols) || !Number.isInteger(data.rows) ||
                data.cols <= 0 || data.rows <= 0 || data.cols > 1000 || data.rows > 1000 ||
                !Array.isArray(data.grid) || data.grid.length !== data.cols * data.rows ||
                !data.grid.every(cell => Number.isInteger(cell) && cell >= 0 && cell <= 255)) {
                mapAvailable = false;
                mapStatus = 'unavailable';
                logEvent(`⚠️ [MAPA] Malha de colisão corrompida ou inválida em ${mapId}. Movimento suspenso.`, "error");
                emitTelemetry();
                return;
            }

            mapCols = data.cols || 0;
            mapRows = data.rows || 0;
            currentMapBiome = data.biome || "forest";
            mapGrid = data.grid ? new Uint8Array(data.grid) : null;
            mapFringeMask = decodeFringeMask(data.art && data.art.fringeMask);
            cleanGrassGrid = (mapGrid && mapCols > 0) ? new Uint8Array(mapCols * mapRows) : null;
            grassTiles = [];

            if (mapGrid && mapCols > 0 && mapRows > 0) {
                // Step 1: Pre-filter tiles that are value 1 and NOT covered by fringe (tree canopies / roofs)
                const candidateGrass = new Uint8Array(mapCols * mapRows);
                for (let y = 0; y < mapRows; y++) {
                    for (let x = 0; x < mapCols; x++) {
                        const idx = y * mapCols + x;
                        if (mapGrid[idx] === 1 && !isFringe(x, y)) {
                            candidateGrass[idx] = 1;
                        }
                    }
                }

                // Step 2: Floodfill component clustering to prune isolated brush artifacts (< 4 contiguous tiles)
                const visited = new Uint8Array(mapCols * mapRows);
                for (let y = 0; y < mapRows; y++) {
                    for (let x = 0; x < mapCols; x++) {
                        const startIdx = y * mapCols + x;
                        if (candidateGrass[startIdx] === 1 && !visited[startIdx]) {
                            const comp = [];
                            const queue = [{ x, y }];
                            visited[startIdx] = 1;
                            let head = 0;

                            while (head < queue.length) {
                                const curr = queue[head++];
                                comp.push(curr);
                                const neighbors = [
                                    { nx: curr.x + 1, ny: curr.y },
                                    { nx: curr.x - 1, ny: curr.y },
                                    { nx: curr.x, ny: curr.y + 1 },
                                    { nx: curr.x, ny: curr.y - 1 }
                                ];
                                for (const n of neighbors) {
                                    if (n.nx >= 0 && n.nx < mapCols && n.ny >= 0 && n.ny < mapRows) {
                                        const nIdx = n.ny * mapCols + n.nx;
                                        if (candidateGrass[nIdx] === 1 && !visited[nIdx]) {
                                            visited[nIdx] = 1;
                                            queue.push({ x: n.nx, y: n.ny });
                                        }
                                    }
                                }
                            }

                            // Keep authentic tall grass patches (size >= 4 tiles)
                            if (comp.length >= 4) {
                                for (const tile of comp) {
                                    const cIdx = tile.y * mapCols + tile.x;
                                    cleanGrassGrid[cIdx] = 1;
                                    grassTiles.push(tile);
                                }
                            }
                        }
                    }
                }
            }
            if (grassTiles.length === 0) {
                mapAvailable = true;
                mapStatus = 'empty';
                logEvent(`⚠️ [MAPA] Nenhum agrupamento de grama detectado em ${mapId}. Patrulha restrita a caminhos transitáveis.`, "warning");
            } else {
                mapAvailable = true;
                mapStatus = 'available';
                logEvent(`🌿 Malha de mapa processada (${mapId}): ${grassTiles.length} tiles de grama estimados por heurística de clusterização`, "info");
            }
        } catch (e) {
            if (timeoutId) clearTimeout(timeoutId);
            if (loadVersion !== mapLoadVersion || mapId !== currentMap) return;
            mapAvailable = false;
            mapStatus = 'unavailable';
            if (e?.name === 'AbortError') {
                logEvent(`⚠️ [MAPA] Tempo limite ao carregar colisão de ${mapId} (10s). Movimento suspenso.`, "warning");
            } else {
                logEvent(`⚠️ [MAPA] Erro ao carregar mapa ${mapId}: ${e?.message || e}. Movimento suspenso.`, "warning");
            }
        } finally {
            if (timeoutId) clearTimeout(timeoutId);
            if (loadVersion === mapLoadVersion) {
                loadingMap = false;
                if (currentMapAbortController === controller) currentMapAbortController = null;
                emitTelemetry();
            }
        }
    }

    function isGrass(x, y) {
        if (!cleanGrassGrid || x < 0 || y < 0 || x >= mapCols || y >= mapRows) return false;
        return cleanGrassGrid[y * mapCols + x] === 1;
    }

    function isWalkable(x, y) {
        if (!mapAvailable || !mapGrid || x < 0 || y < 0 || x >= mapCols || y >= mapRows) return false;
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
                        connected: Boolean(activeWs && activeWs.readyState === WebSocket.OPEN),
                        autoTravel: { active: autoTravelState.active, phase: autoTravelState.phase,
                            originMap: autoTravelState.originMap, deliveriesDone: autoTravelState.deliveriesDone },
                        inBattle,
                        currentBattleId,
                        battleMoves,
                        playerId,
                        currentMap,
                        currentMapName: getMapFriendlyName(currentMap),
                        currentMapBiome,
                        mapStatus,
                        mapAvailable,
                        routeSwitch: {
                            active: routeSwitchState.active,
                            targetRoute: routeSwitchState.targetRoute,
                            requestedAt: routeSwitchState.requestedAt
                        },
                        availableSpecies: currentMapSpecies,
                        lastCapturedMon,
                        playerPos,
                        onGrass: (playerPos && playerPos.x !== null) ? isGrass(playerPos.x, playerPos.y) : false,
                        myMon,
                        enemyMon,
                        entities,
                        progress,
                        inventory,
                        itemEffects,
                        wallet,
                        collection,
                        team,
                        config: botConfig,
                        sessionMetrics: {
                            uptime: Math.floor((Date.now() - sessionStartTime) / 1000),
                            sessionCaptures,
                            sessionXpGained,
                            sessionSilverGained,
                            capturesPerHour: Math.round(sessionCaptures / Math.max((Date.now() - sessionStartTime) / 3600000, 1 / 3600)),
                            xpPerHour: Math.round(sessionXpGained / Math.max((Date.now() - sessionStartTime) / 3600000, 1 / 3600)),
                            silverPerHour: Math.round(sessionSilverGained / Math.max((Date.now() - sessionStartTime) / 3600000, 1 / 3600)),
                            reconnectCount
                        }
                    }
                }
            }));
        } catch (e) {}
    }

    // Binary frame parser aligned with upstream xye(t) (T09: strictly transactional)
    function parseBinaryFrame(buffer) {
        try {
            if (!buffer) return null;
            const data = (buffer instanceof Uint8Array)
                ? buffer
                : (ArrayBuffer.isView(buffer)
                    ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
                    : new Uint8Array(buffer));

            if (data.length < 6 || data[0] !== 0x01) return null;
            const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

            let offset = 1;
            const tick = view.getUint32(offset, true);
            offset += 4;

            const flags = data[offset++];
            let candidateAck = null;
            if (flags & 0x01) {
                if (offset + 4 > data.length) return null; // Truncated ack
                candidateAck = view.getUint32(offset, true);
                offset += 4;
            }

            if (offset + 2 > data.length) return null; // Truncated entityCount
            const entityCount = view.getUint16(offset, true);
            offset += 2;

            // Sanity check entityCount against available buffer length (each entity is at least 2 bytes)
            if (entityCount > 1000 || offset + (entityCount * 2) > data.length) {
                return null;
            }

            const parsedEntities = [];
            let candidatePlayerPos = null;

            for (let i = 0; i < entityCount; i++) {
                if (offset + 2 > data.length) return null; // Truncated entity header
                const f = data[offset++];
                const g = data[offset++]; // UTF-8 byte length
                if (offset + g > data.length) return null; // Truncated entity name string

                const nameBytes = data.subarray(offset, offset + g);
                const name = new TextDecoder('utf-8', { fatal: false }).decode(nameBytes);
                offset += g;

                let x = null, y = null, dir = null;
                if (f & 0x01) {
                    if (offset + 2 > data.length) return null; // Truncated x coord
                    x = view.getUint16(offset, true);
                    offset += 2;
                }
                if (f & 0x02) {
                    if (offset + 2 > data.length) return null; // Truncated y coord
                    y = view.getUint16(offset, true);
                    offset += 2;
                }
                if (f & 0x04) {
                    if (offset >= data.length) return null; // Truncated direction byte
                    const dirCode = data[offset++];
                    dir = ["N", "E", "S", "W"][dirCode] || "S";
                }

                const idStr = String(name || "").toLowerCase();
                const isPlayer = Boolean(playerId && String(name) === String(playerId)) || name === "self" || name === "player:self";
                const isOtherPlayer = !isPlayer && (idStr.startsWith("player:") || idStr.startsWith("user:"));
                const isEnemy = !isPlayer && !isOtherPlayer && (
                    idStr.startsWith("wild:") ||
                    idStr.startsWith("foe:") ||
                    idStr.includes("wild")
                );

                if (isPlayer && x !== null && y !== null) {
                    candidatePlayerPos = { x, y };
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

            // Transactional commit: apply state updates atomically only after full frame validity is confirmed
            if (candidateAck !== null) {
                moveSeq = Math.max(moveSeq, Number(candidateAck));
            }
            if (candidatePlayerPos !== null) {
                playerPos = candidatePlayerPos;
            }
            entities = parsedEntities;
            emitTelemetry();
            return true;
        } catch (err) {
            // Ignore binary parse errors without side-effects or throwing
            return null;
        }
    }

    function sendEvent(t, d) {
        if (activeWs && activeWs.readyState === WebSocket.OPEN) {
            if (t === 'creature:lock' && d?.locked === true) {
                if (pendingLocks.has(d.creatureId) || pendingLocks.size >= 500) return;
                pendingLocks.add(d.creatureId);
            }
            const payload = { t };
            if (d !== undefined && d !== null) payload.d = d;
            activeWs.send(JSON.stringify(payload));
        }
    }

    function configureAndStartIdle() {
        if (!configReady) return;
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

        // Authoritative Bot Control: Ensure native server-side auto-idle is STOPPED
        // while the bot's custom autonomous engine is active. This eliminates packet races,
        // duplicate turn dispatches ('bad_message undefined'), and accidental killing of capture targets.
        if (botConfig.enabled) {
            sendEvent("idle:stop");
            logEvent("🛡️ Controle Autoritativo do Bot ativo (Auto-Idle nativo do servidor desligado)", "info");
        } else if (botConfig.auto_idle) {
            sendEvent("idle:start");
            logEvent("⚡ Modo Auto-Idle nativo ativado no servidor", "info");
        } else {
            sendEvent("idle:stop");
        }
    }

    
    // --- ELEMENTAL TYPE CHART & SMART COMBAT ENGINE ---
    
    // --- OFFICIAL BALL & POTION CATALOGS (v2.2 & v2.4) ---
    const BALL_CATALOG = {
        "poke-ball": { name: "Poké Ball", multiplier: 1 },
        "great-ball": { name: "Great Ball", multiplier: 2 },
        "super-ball": { name: "Super Ball", multiplier: 3 },
        "ultra-ball": { name: "Ultra Ball", multiplier: 4 },
        "master-ball": { name: "Master Ball", multiplier: 100 }
    };

    const POTION_CATALOG = {
        "potion": { name: "Poção", healAmount: 20 },
        "super-potion": { name: "Super Poção", healAmount: 60 },
        "hyper-potion": { name: "Hyper Poção", healAmount: 120 },
        "max-potion": { name: "Max Poção", healAmount: 9999 }
    };

    function canonicalItemId(itemId) {
        if (!itemId) return itemId;
        return String(itemId).toLowerCase().trim();
    }

    // --- OFFICIAL ROUTE NAMES (1-150) & MAP TRANSLATION ---
    const ROUTE_NAMES = {"route_001": "Rota 1 — Floresta Nascente", "route_002": "Rota 2 — Bosque dos Brotos", "route_003": "Rota 3 — Trilha do Musgo", "route_004": "Rota 4 — Mata dos Cipós", "route_005": "Rota 5 — Caverna Rasa", "route_006": "Rota 6 — Clareira Serena", "route_007": "Rota 7 — Lago Espelhado", "route_008": "Rota 8 — Margem Tranquila", "route_009": "Rota 9 — Areal Brilhante", "route_010": "Rota 10 — Praia Dourada", "route_011": "Rota 11 — Bosque dos Vaga-lumes", "route_012": "Rota 12 — Refúgio Verde", "route_013": "Rota 13 — Copa Alta", "route_014": "Rota 14 — Lago das Garças", "route_015": "Rota 15 — Enseada dos Juncos", "route_016": "Rota 16 — Baía Serena", "route_017": "Rota 17 — Costa das Conchas", "route_018": "Rota 18 — Baía dos Corais", "route_019": "Rota 19 — Gruta dos Morcegos", "route_020": "Rota 20 — Pântano Nebuloso", "route_021": "Rota 21 — Mar Aberto", "route_022": "Rota 22 — Águas Profundas", "route_023": "Rota 23 — Praia dos Caranguejos", "route_024": "Rota 24 — Falésia Costeira", "route_025": "Rota 25 — Charco Raso", "route_026": "Rota 26 — Mangue Denso", "route_027": "Rota 27 — Lamaçal Verde", "route_028": "Rota 28 — Lagoa Funda", "route_029": "Rota 29 — Lago das Correntezas", "route_030": "Rota 30 — Trilha Sufocada", "route_031": "Rota 31 — Mata Fechada", "route_032": "Rota 32 — Selva dos Cipós", "route_033": "Rota 33 — Coração da Mata", "route_034": "Rota 34 — Selva Umbrosa", "route_035": "Rota 35 — Brejo dos Sapos", "route_036": "Rota 36 — Várzea Sombria", "route_037": "Rota 37 — Pântano das Raízes", "route_038": "Rota 38 — Caverna de Pedra", "route_039": "Rota 39 — Túnel Escavado", "route_040": "Rota 40 — Sombra das Árvores", "route_041": "Rota 41 — Caverna Úmida", "route_042": "Rota 42 — Galeria de Quartzo", "route_043": "Rota 43 — Sopé Verdejante", "route_044": "Rota 44 — Recife Submerso", "route_045": "Rota 45 — Trilha da Serra", "route_046": "Rota 46 — Emaranhado Verde", "route_047": "Rota 47 — Mata dos Espinhos", "route_048": "Rota 48 — Selva Profunda", "route_049": "Rota 49 — Represa Antiga", "route_050": "Rota 50 — Costa dos Nenúfares", "route_051": "Rota 51 — Caverna dos Ecos", "route_052": "Rota 52 — Passagem Estreita", "route_053": "Rota 53 — Encosta Gramada", "route_054": "Rota 54 — Campos Nevados", "route_055": "Rota 55 — Trilha Gelada", "route_056": "Rota 56 — Bosque de Inverno", "route_057": "Rota 57 — Planície Branca", "route_058": "Rota 58 — Bosque Impenetrável", "route_059": "Rota 59 — Mata das Sombras", "route_060": "Rota 60 — Charco Profundo", "route_061": "Rota 61 — Nevasca Suave", "route_062": "Rota 62 — Campo dos Flocos", "route_063": "Rota 63 — Colina Congelada", "route_064": "Rota 64 — Vale do Inverno", "route_065": "Rota 65 — Despenhadeiro Gelado", "route_066": "Rota 66 — Colinas Ventosas", "route_067": "Rota 67 — Serra dos Falcões", "route_068": "Rota 68 — Geleira Azul", "route_069": "Rota 69 — Campo de Gelo", "route_070": "Rota 70 — Lago Congelado", "route_071": "Rota 71 — Planalto Polar", "route_072": "Rota 72 — Fenda Glacial", "route_073": "Rota 73 — Banquisa Eterna", "route_074": "Rota 74 — Espelho de Gelo", "route_075": "Rota 75 — Caverna Funda", "route_076": "Rota 76 — Neve Profunda", "route_077": "Rota 77 — Cume Silencioso", "route_078": "Rota 78 — Canal Azul", "route_079": "Rota 79 — Salão das Estalactites", "route_080": "Rota 80 — Ruínas Cobertas", "route_081": "Rota 81 — Caverna Silenciosa", "route_082": "Rota 82 — Mirante Verde", "route_083": "Rota 83 — Passo da Serra", "route_084": "Rota 84 — Encosta Rochosa", "route_085": "Rota 85 — Gruta de Cristal", "route_086": "Rota 86 — Coração da Geleira", "route_087": "Rota 87 — Colunas Antigas", "route_088": "Rota 88 — Pátio Esquecido", "route_089": "Rota 89 — Templo em Ruínas", "route_090": "Rota 90 — Trilha das Raízes", "route_091": "Rota 91 — Sopé do Vulcão", "route_092": "Rota 92 — Campos de Cinza", "route_093": "Rota 93 — Salão dos Ecos", "route_094": "Rota 94 — Muralha Caída", "route_095": "Rota 95 — Campos do Norte", "route_096": "Rota 96 — Tundra Silenciosa", "route_097": "Rota 97 — Maré Baixa", "route_098": "Rota 98 — Costa dos Ventos", "route_099": "Rota 99 — Lago Cristalino", "route_100": "Rota 100 — Aurora Glacial", "route_101": "Rota 101 — Cripta Aberta", "route_102": "Rota 102 — Cidade Perdida", "route_103": "Rota 103 — Altar Partido", "route_104": "Rota 104 — Torre Tombada", "route_105": "Rota 105 — Terra Rachada", "route_106": "Rota 106 — Planície Árida", "route_107": "Rota 107 — Jardim de Corais", "route_108": "Rota 108 — Veio de Minério", "route_109": "Rota 109 — Serra Alta", "route_110": "Rota 110 — Lodaçal Antigo", "route_111": "Rota 111 — Vale da Poeira", "route_112": "Rota 112 — Corrente Escura", "route_113": "Rota 113 — Naufrágio Antigo", "route_114": "Rota 114 — Fossa Marinha", "route_115": "Rota 115 — Cânion Vermelho", "route_116": "Rota 116 — Caverna Cega", "route_117": "Rota 117 — Abismo Interno", "route_118": "Rota 118 — Cordilheira Seca", "route_119": "Rota 119 — Brejo da Névoa", "route_120": "Rota 120 — Pântano Árido", "route_121": "Rota 121 — Encosta Estéril", "route_122": "Rota 122 — Caverna Esquecida", "route_123": "Rota 123 — Fenda sem Fundo", "route_124": "Rota 124 — Vale Escondido", "route_125": "Rota 125 — Serra do Alvorecer", "route_126": "Rota 126 — Deserto dos Ossos", "route_127": "Rota 127 — Dunas Baixas", "route_128": "Rota 128 — Mesa Alta", "route_129": "Rota 129 — Selva Seca", "route_130": "Rota 130 — Última Mata", "route_131": "Rota 131 — Câmara Selada", "route_132": "Rota 132 — Caverna do Fim", "route_133": "Rota 133 — Coração da Pedra", "route_134": "Rota 134 — Serra do Retorno", "route_135": "Rota 135 — Rio de Magma", "route_136": "Rota 136 — Cratera Menor", "route_137": "Rota 137 — Vale Vulcânico", "route_138": "Rota 138 — Encosta Fumegante", "route_139": "Rota 139 — Deserto Profundo", "route_140": "Rota 140 — Floresta Silenciosa", "route_141": "Rota 141 — Chaminé de Cinzas", "route_142": "Rota 142 — Fornalha Natural", "route_143": "Rota 143 — Campos de Obsidiana", "route_144": "Rota 144 — Garganta de Fogo", "route_145": "Rota 145 — Lago de Lava", "route_146": "Rota 146 — Coração do Vulcão", "route_147": "Rota 147 — Borda da Caldeira", "route_148": "Rota 148 — Trono de Lava", "route_149": "Rota 149 — Planície Abissal", "route_150": "Rota 150 — Fundo do Mundo"};

    const MAP_NAMES = {
        lobby1: "Vila Central",
        lobby2: "Vila do Porto",
        lobby3: "Vila das Colinas",
        npclab: "Laboratório do Professor",
        guildlobby: "Sede das Guildas",
        evento1: "Domo Glacial",
        evento2: "Arena de Cinzas",
        ranked: "Coliseu",
        "fishing-lake": "Lago do Festival de Pesca",
        "gym-cocoon": "Ginásio do Rochedo",
        "gym-plume": "Ginásio da Cascata",
        "gym-venom": "Ginásio do Trovão",
        "gym-volt": "Ginásio do Arco-Íris",
        gym1: "Ginásio da Alma",
        "gym-kanto-6": "Ginásio do Pântano",
        "gym-kanto-7": "Ginásio do Vulcão",
        "gym-kanto-8": "Ginásio da Terra",
        "kanto-championship": "Liga de Kanto",
        "gym-torrent": "Ginásio do Zéfiro",
        "gym-aurora": "Ginásio da Colmeia",
        "gym-fist": "Ginásio da Planície",
        "gym-mind": "Ginásio da Névoa",
        gym2: "Ginásio da Tempestade",
        "gym-johto-6": "Ginásio Mineral",
        "gym-johto-7": "Ginásio da Geleira",
        "gym-johto-8": "Ginásio Ascendente",
        "johto-championship": "Liga de Johto",
        "gym-quake": "Ginásio da Pedra",
        "gym-boulder": "Ginásio do Punho",
        "gym-iron": "Ginásio do Dínamo",
        "gym-hoenn-4": "Ginásio do Calor",
        "gym-hoenn-5": "Ginásio do Equilíbrio",
        "gym-hoenn-6": "Ginásio da Pluma",
        "gym-hoenn-7": "Ginásio da Mente",
        "gym-hoenn-8": "Ginásio da Chuva",
        "hoenn-championship": "Liga de Hoenn",
        "gym-wyvern": "Ginásio do Carvão",
        "gym-apex": "Ginásio da Floresta",
        "gym-sinnoh-3": "Ginásio do Combate",
        "gym-sinnoh-4": "Ginásio do Brejo",
        "gym-sinnoh-5": "Ginásio da Relíquia",
        "gym-sinnoh-6": "Ginásio da Mina",
        "gym-sinnoh-7": "Ginásio do Gelo",
        "gym-sinnoh-8": "Ginásio do Farol",
        "sinnoh-championship": "Liga de Sinnoh",
        seafoam: "Ilhas Espuma",
        "power-plant": "Usina Abandonada",
        "ember-summit": "Cume das Brasas",
        "bell-tower": "Torre do Sino",
        "cerulean-cave": "Caverna Celeste",
        "ultra-space-1": "Ultra Espaço I",
        "ultra-space-2": "Ultra Espaço II",
        "ultra-space-3": "Ultra Espaço III",
        "ultra-space-4": "Ultra Espaço IV",
        florestapvp: "Floresta Contestada",
        praiapvp: "Costa dos Náufragos",
        terrapvp: "Ermo Rachado",
        nevepvp: "Tundra Impiedosa",
        pantanopvp: "Pântano Traiçoeiro",
        ruinaspvp: "Ruínas Malditas",
        motnahapvp: "Montanha Sangrenta",
        vulcaopvp: "Caldeira Infernal"
    };

    function getMapFriendlyName(mapId) {
        if (!mapId) return "Aguardando Mapa...";
        if (MAP_NAMES[mapId]) return MAP_NAMES[mapId];
        if (ROUTE_NAMES[mapId]) return ROUTE_NAMES[mapId];
        if (mapId.startsWith("route_")) {
            const num = parseInt(mapId.replace("route_", ""), 10);
            if (!isNaN(num)) return `Rota ${num}`;
        }
        return mapId;
    }

    // --- OFFICIAL IN-GAME QUALITY SYSTEM (0 to 1000) ---
    const QUALITY_THRESHOLDS = {
        fair: 0,
        good: 500,
        great: 800,
        excellent: 940,
        superb: 990,
        perfect: 1000
    };

    function getCreatureQuality(mon) {
        if (!mon) return null;
        if (Number.isFinite(mon.quality)) return mon.quality;
        if (Number.isFinite(mon.qualitySelf?.score)) return mon.qualitySelf.score;
        return null;
    }

    function meetsQualityThreshold(mon, minQuality) {
        if (!mon || !minQuality || minQuality === 'any') return false;
        const threshold = QUALITY_THRESHOLDS[minQuality];
        if (threshold === undefined) return false;
        const q = getCreatureQuality(mon);
        return q !== null && q >= threshold;
    }

    // --- COMPETITIVE BEST NATURES DATABASE (GEN 1 - 5: KANTO TO UNOVA) ---
    const BEST_NATURES_GEN1_TO_5 = {"bulbasaur": ["modest", "timid"], "ivysaur": ["modest", "timid"], "venusaur": ["modest", "timid", "calm"], "charmander": ["adamant", "jolly"], "charmeleon": ["adamant", "jolly"], "charizard": ["timid", "jolly", "modest", "adamant"], "squirtle": ["calm", "careful", "bold"], "wartortle": ["calm", "careful", "bold"], "blastoise": ["modest", "bold", "calm"], "caterpie": ["adamant", "jolly"], "metapod": ["impish", "relaxed", "adamant"], "butterfree": ["modest", "timid"], "weedle": ["adamant", "jolly"], "kakuna": ["impish", "relaxed", "adamant"], "beedrill": ["adamant", "jolly"], "pidgey": ["adamant", "jolly"], "pidgeotto": ["adamant", "jolly"], "pidgeot": ["adamant", "jolly"], "rattata": ["adamant", "jolly"], "raticate": ["adamant", "jolly"], "spearow": ["adamant", "jolly"], "fearow": ["adamant", "jolly"], "ekans": ["adamant", "jolly"], "arbok": ["adamant", "jolly"], "pikachu": ["adamant", "jolly"], "raichu": ["timid", "naive", "hasty"], "sandshrew": ["impish", "relaxed", "adamant"], "sandslash": ["adamant", "impish"], "nidoran-f": ["impish", "relaxed", "adamant"], "nidorina": ["impish", "relaxed", "adamant"], "nidoqueen": ["bold", "modest", "timid"], "nidoran-m": ["adamant", "jolly"], "nidorino": ["adamant", "jolly"], "nidoking": ["timid", "modest", "naive"], "clefairy": ["calm", "careful", "bold"], "clefable": ["bold", "calm"], "vulpix": ["modest", "timid"], "ninetales": ["timid", "modest"], "jigglypuff": ["calm", "careful", "bold"], "wigglytuff": ["modest", "calm"], "zubat": ["adamant", "jolly"], "golbat": ["adamant", "jolly"], "oddish": ["modest", "timid"], "gloom": ["modest", "timid"], "vileplume": ["bold", "modest", "calm"], "paras": ["adamant", "jolly"], "parasect": ["careful", "adamant"], "venonat": ["modest", "timid"], "venomoth": ["timid", "modest"], "diglett": ["adamant", "jolly"], "dugtrio": ["adamant", "jolly"], "meowth": ["adamant", "jolly"], "persian": ["adamant", "jolly"], "psyduck": ["modest", "timid"], "golduck": ["modest", "timid"], "mankey": ["adamant", "jolly"], "primeape": ["adamant", "jolly"], "growlithe": ["adamant", "jolly"], "arcanine": ["jolly", "adamant", "timid", "modest"], "poliwag": ["modest", "timid"], "poliwhirl": ["adamant", "jolly"], "poliwrath": ["adamant"], "abra": ["modest", "timid"], "kadabra": ["modest", "timid"], "alakazam": ["timid", "modest"], "machop": ["adamant", "jolly"], "machoke": ["adamant", "jolly"], "machamp": ["adamant", "brave"], "bellsprout": ["naive", "hasty"], "weepinbell": ["naive", "hasty"], "victreebel": ["modest", "adamant", "naive"], "tentacool": ["calm", "careful", "bold"], "tentacruel": ["timid", "calm", "bold"], "geodude": ["impish", "relaxed", "adamant"], "graveler": ["impish", "relaxed", "adamant"], "golem": ["adamant", "impish"], "ponyta": ["adamant", "jolly"], "rapidash": ["adamant", "jolly"], "slowpoke": ["impish", "relaxed", "adamant"], "slowbro": ["bold", "relaxed", "quiet"], "magnemite": ["modest", "timid"], "magneton": ["modest", "timid"], "farfetchd": ["adamant", "jolly"], "doduo": ["adamant", "jolly"], "dodrio": ["adamant", "jolly"], "seel": ["calm", "careful", "bold"], "dewgong": ["calm", "careful"], "grimer": ["impish", "relaxed", "adamant"], "muk": ["adamant", "careful"], "shellder": ["impish", "relaxed", "adamant"], "cloyster": ["jolly", "adamant", "impish"], "gastly": ["modest", "timid"], "haunter": ["modest", "timid"], "gengar": ["timid", "modest"], "onix": ["impish", "relaxed", "adamant"], "drowzee": ["calm", "careful", "bold"], "hypno": ["calm", "careful"], "krabby": ["adamant", "jolly"], "kingler": ["adamant", "jolly"], "voltorb": ["modest", "timid"], "electrode": ["timid", "naive"], "exeggcute": ["modest", "timid"], "exeggutor": ["modest", "quiet"], "cubone": ["adamant", "jolly"], "marowak": ["adamant", "brave"], "hitmonlee": ["adamant", "jolly"], "hitmonchan": ["adamant", "jolly"], "lickitung": ["calm", "careful", "bold"], "koffing": ["impish", "relaxed", "adamant"], "weezing": ["bold", "impish"], "rhyhorn": ["impish", "relaxed", "adamant"], "rhydon": ["adamant", "impish"], "chansey": ["bold", "calm"], "tangela": ["bold", "modest"], "kangaskhan": ["adamant", "jolly"], "horsea": ["modest", "timid"], "seadra": ["modest", "timid"], "goldeen": ["adamant", "jolly"], "seaking": ["adamant", "jolly"], "staryu": ["modest", "timid"], "starmie": ["timid", "modest"], "mr-mime": ["timid", "modest"], "scyther": ["adamant", "jolly"], "jynx": ["timid", "modest"], "electabuzz": ["timid", "naive"], "magmar": ["modest", "timid", "naive"], "pinsir": ["adamant", "jolly"], "tauros": ["adamant", "jolly"], "magikarp": ["adamant", "jolly"], "gyarados": ["adamant", "jolly"], "lapras": ["modest", "calm"], "ditto": ["timid", "jolly", "bold", "calm"], "eevee": ["adamant", "jolly"], "vaporeon": ["bold", "calm", "modest"], "jolteon": ["timid", "modest"], "flareon": ["adamant"], "porygon": ["modest", "timid"], "omanyte": ["modest", "timid"], "omastar": ["modest", "timid"], "kabuto": ["adamant", "jolly"], "kabutops": ["adamant", "jolly"], "aerodactyl": ["jolly", "adamant"], "snorlax": ["adamant", "careful", "brave"], "articuno": ["timid", "calm"], "zapdos": ["timid", "bold", "modest"], "moltres": ["timid", "modest"], "dratini": ["adamant", "jolly"], "dragonair": ["adamant", "jolly"], "dragonite": ["adamant", "jolly"], "mewtwo": ["timid", "modest"], "mew": ["timid", "jolly", "bold", "calm"], "chikorita": ["calm", "careful", "bold"], "bayleef": ["calm", "careful", "bold"], "meganium": ["calm", "bold"], "cyndaquil": ["modest", "timid"], "quilava": ["modest", "timid"], "typhlosion": ["timid", "modest"], "totodile": ["adamant", "jolly"], "croconaw": ["adamant", "jolly"], "feraligatr": ["adamant", "jolly"], "sentret": ["adamant", "jolly"], "furret": ["adamant", "jolly"], "hoothoot": ["calm", "careful", "bold"], "noctowl": ["calm", "modest"], "ledyba": ["adamant", "jolly"], "ledian": ["adamant", "jolly"], "spinarak": ["adamant", "jolly"], "ariados": ["adamant", "jolly"], "crobat": ["jolly", "timid"], "chinchou": ["calm", "careful", "bold"], "lanturn": ["modest", "calm"], "pichu": ["modest", "timid"], "cleffa": ["calm", "careful", "bold"], "igglybuff": ["calm", "careful", "bold"], "togepi": ["calm", "careful", "bold"], "togetic": ["bold", "calm"], "natu": ["modest", "timid"], "xatu": ["timid", "bold"], "mareep": ["modest", "timid"], "flaaffy": ["modest", "timid"], "ampharos": ["modest", "quiet"], "bellossom": ["calm", "modest"], "marill": ["adamant", "jolly"], "azumarill": ["adamant"], "sudowoodo": ["impish", "relaxed", "adamant"], "politoed": ["bold", "calm"], "hoppip": ["adamant", "jolly"], "skiploom": ["adamant", "jolly"], "jumpluff": ["adamant", "jolly"], "aipom": ["adamant", "jolly"], "sunkern": ["modest", "timid"], "sunflora": ["modest", "quiet"], "yanma": ["modest", "timid"], "wooper": ["impish", "relaxed", "adamant"], "quagsire": ["relaxed"], "espeon": ["timid", "modest"], "umbreon": ["calm", "careful"], "murkrow": ["adamant", "jolly"], "slowking": ["calm", "quiet"], "misdreavus": ["timid", "modest"], "unown": ["modest", "timid"], "wobbuffet": ["bold", "calm"], "girafarig": ["timid"], "pineco": ["impish", "relaxed", "adamant"], "forretress": ["relaxed", "impish"], "dunsparce": ["impish", "relaxed", "adamant"], "gligar": ["impish", "jolly"], "steelix": ["impish", "relaxed"], "snubbull": ["adamant", "jolly"], "granbull": ["adamant", "impish"], "qwilfish": ["jolly", "impish"], "scizor": ["adamant"], "shuckle": ["bold", "impish"], "heracross": ["adamant", "jolly"], "sneasel": ["adamant", "jolly"], "teddiursa": ["adamant", "jolly"], "ursaring": ["adamant"], "slugma": ["modest", "timid"], "magcargo": ["bold", "modest"], "swinub": ["adamant", "jolly"], "piloswine": ["adamant"], "corsola": ["impish", "relaxed", "adamant"], "remoraid": ["modest", "timid"], "octillery": ["modest", "quiet"], "delibird": ["adamant", "jolly"], "mantine": ["calm"], "skarmory": ["impish", "bold"], "houndour": ["modest", "timid"], "houndoom": ["timid", "hasty"], "kingdra": ["modest", "adamant"], "phanpy": ["impish", "relaxed", "adamant"], "donphan": ["adamant", "impish"], "porygon2": ["bold", "calm"], "stantler": ["adamant", "jolly"], "smeargle": ["jolly", "timid"], "tyrogue": ["adamant", "jolly"], "hitmontop": ["adamant", "impish"], "smoochum": ["modest", "timid"], "elekid": ["adamant", "jolly"], "magby": ["naive", "hasty"], "miltank": ["impish", "careful"], "blissey": ["bold", "calm"], "raikou": ["timid", "modest"], "entei": ["adamant", "jolly"], "suicune": ["bold", "timid", "calm"], "larvitar": ["adamant", "jolly"], "pupitar": ["adamant", "jolly"], "tyranitar": ["adamant", "jolly"], "lugia": ["bold", "timid"], "ho-oh": ["adamant", "careful"], "celebi": ["timid", "bold", "modest"], "treecko": ["modest", "timid"], "grovyle": ["modest", "timid"], "sceptile": ["timid", "modest", "naive"], "torchic": ["adamant", "jolly"], "combusken": ["adamant", "jolly"], "blaziken": ["adamant", "jolly"], "mudkip": ["impish", "relaxed", "adamant"], "marshtomp": ["impish", "relaxed", "adamant"], "swampert": ["adamant", "relaxed"], "poochyena": ["adamant", "jolly"], "mightyena": ["adamant", "jolly"], "zigzagoon": ["adamant", "jolly"], "linoone": ["adamant", "jolly"], "wurmple": ["modest", "timid"], "silcoon": ["impish", "relaxed", "adamant"], "beautifly": ["modest", "timid"], "cascoon": ["impish", "relaxed", "adamant"], "dustox": ["calm", "careful", "bold"], "lotad": ["modest", "timid"], "lombre": ["modest", "timid"], "ludicolo": ["modest", "timid"], "seedot": ["adamant", "jolly"], "nuzleaf": ["adamant", "jolly"], "shiftry": ["adamant", "naughty"], "taillow": ["adamant", "jolly"], "swellow": ["jolly", "adamant"], "wingull": ["modest", "timid"], "pelipper": ["bold", "calm"], "ralts": ["modest", "timid"], "kirlia": ["modest", "timid"], "gardevoir": ["timid", "modest"], "surskit": ["modest", "timid"], "masquerain": ["timid", "modest"], "shroomish": ["adamant", "jolly"], "breloom": ["adamant", "jolly"], "slakoth": ["adamant", "jolly"], "vigoroth": ["adamant", "jolly"], "slaking": ["jolly", "adamant"], "nincada": ["adamant", "jolly"], "ninjask": ["jolly", "adamant"], "shedinja": ["adamant", "lonely"], "whismur": ["modest", "timid"], "loudred": ["modest", "timid"], "exploud": ["modest"], "makuhita": ["impish", "relaxed", "adamant"], "hariyama": ["adamant"], "azurill": ["adamant", "jolly"], "nosepass": ["impish", "relaxed", "adamant"], "skitty": ["adamant", "jolly"], "delcatty": ["adamant", "jolly"], "sableye": ["bold", "calm"], "mawile": ["adamant"], "aron": ["impish", "relaxed", "adamant"], "lairon": ["impish", "relaxed", "adamant"], "aggron": ["adamant"], "meditite": ["adamant", "jolly"], "medicham": ["jolly", "adamant"], "electrike": ["modest", "timid"], "manectric": ["timid", "modest"], "plusle": ["modest", "timid"], "minun": ["modest", "timid"], "volbeat": ["calm", "careful", "bold"], "illumise": ["calm", "careful", "bold"], "roselia": ["timid", "modest"], "gulpin": ["calm", "careful", "bold"], "swalot": ["calm", "bold"], "carvanha": ["adamant", "jolly"], "sharpedo": ["adamant", "jolly"], "wailmer": ["calm", "careful", "bold"], "wailord": ["modest", "calm"], "numel": ["naive", "hasty"], "camerupt": ["quiet", "modest"], "torkoal": ["bold", "relaxed"], "spoink": ["modest", "timid"], "grumpig": ["calm", "modest"], "spinda": ["adamant", "jolly"], "trapinch": ["adamant", "jolly"], "vibrava": ["adamant", "jolly"], "flygon": ["adamant", "jolly"], "cacnea": ["adamant", "jolly"], "cacturne": ["adamant", "mild"], "swablu": ["calm", "careful", "bold"], "altaria": ["careful", "adamant", "modest"], "zangoose": ["jolly", "adamant"], "seviper": ["modest", "adamant"], "lunatone": ["modest", "timid"], "solrock": ["impish", "relaxed", "adamant"], "barboach": ["impish", "relaxed", "adamant"], "whiscash": ["adamant"], "corphish": ["adamant", "jolly"], "crawdaunt": ["adamant"], "baltoy": ["calm", "careful", "bold"], "claydol": ["bold", "calm"], "lileep": ["calm", "careful", "bold"], "cradily": ["careful"], "anorith": ["adamant", "jolly"], "armaldo": ["adamant", "jolly"], "feebas": ["calm", "careful", "bold"], "milotic": ["bold", "calm"], "castform": ["modest", "timid"], "kecleon": ["adamant"], "shuppet": ["adamant", "jolly"], "banette": ["adamant", "jolly"], "duskull": ["calm", "careful", "bold"], "dusclops": ["bold", "calm"], "tropius": ["calm", "careful", "bold"], "chimecho": ["calm", "bold"], "absol": ["jolly", "adamant"], "wynaut": ["calm", "careful", "bold"], "snorunt": ["modest", "timid"], "glalie": ["jolly"], "spheal": ["calm", "careful", "bold"], "sealeo": ["calm", "careful", "bold"], "walrein": ["calm", "bold"], "clamperl": ["modest", "timid"], "huntail": ["adamant", "jolly"], "gorebyss": ["modest", "timid"], "relicanth": ["adamant"], "luvdisc": ["modest", "timid"], "bagon": ["adamant", "jolly"], "shelgon": ["impish", "relaxed", "adamant"], "salamence": ["jolly", "naive", "adamant", "timid"], "beldum": ["adamant", "jolly"], "metang": ["impish", "relaxed", "adamant"], "metagross": ["adamant", "jolly"], "regirock": ["impish", "careful"], "regice": ["calm", "modest"], "registeel": ["calm", "careful"], "latias": ["timid", "calm"], "latios": ["timid", "modest"], "kyogre": ["timid", "modest"], "groudon": ["adamant", "jolly"], "rayquaza": ["jolly", "naive", "adamant"], "jirachi": ["jolly", "timid"], "deoxys": ["timid", "naive", "hasty"], "turtwig": ["impish", "relaxed", "adamant"], "grotle": ["impish", "relaxed", "adamant"], "torterra": ["adamant", "impish"], "chimchar": ["naive", "hasty"], "monferno": ["naive", "hasty"], "infernape": ["naive", "jolly", "hasty", "timid"], "piplup": ["modest", "timid"], "prinplup": ["modest", "timid"], "empoleon": ["modest", "calm"], "starly": ["adamant", "jolly"], "staravia": ["adamant", "jolly"], "staraptor": ["jolly", "adamant"], "bidoof": ["impish", "relaxed", "adamant"], "bibarel": ["adamant"], "kricketot": ["adamant", "jolly"], "kricketune": ["adamant", "jolly"], "shinx": ["adamant", "jolly"], "luxio": ["adamant", "jolly"], "luxray": ["adamant", "jolly"], "budew": ["modest", "timid"], "roserade": ["timid", "modest"], "cranidos": ["adamant", "jolly"], "rampardos": ["jolly", "adamant"], "shieldon": ["impish", "relaxed", "adamant"], "bastiodon": ["impish", "careful"], "burmy": ["calm", "careful", "bold"], "wormadam": ["calm", "careful", "bold"], "mothim": ["modest", "timid"], "combee": ["calm", "careful", "bold"], "vespiquen": ["impish", "careful"], "pachirisu": ["impish"], "buizel": ["adamant", "jolly"], "floatzel": ["adamant", "jolly"], "cherubi": ["modest", "timid"], "cherrim": ["timid", "modest"], "shellos": ["calm", "careful", "bold"], "gastrodon": ["relaxed", "calm"], "ambipom": ["jolly"], "drifloon": ["modest", "timid"], "drifblim": ["modest", "timid"], "buneary": ["adamant", "jolly"], "lopunny": ["jolly"], "mismagius": ["timid"], "honchkrow": ["adamant"], "glameow": ["adamant", "jolly"], "purugly": ["adamant", "jolly"], "chingling": ["modest", "timid"], "stunky": ["adamant", "jolly"], "skuntank": ["adamant"], "bronzor": ["calm", "careful", "bold"], "bronzong": ["relaxed", "sassy"], "bonsly": ["impish", "relaxed", "adamant"], "mime-jr": ["modest", "timid"], "happiny": ["calm", "careful", "bold"], "chatot": ["modest", "timid"], "spiritomb": ["bold", "calm"], "gible": ["adamant", "jolly"], "gabite": ["adamant", "jolly"], "garchomp": ["jolly", "adamant"], "munchlax": ["calm", "careful", "bold"], "riolu": ["adamant", "jolly"], "lucario": ["jolly", "timid", "adamant"], "hippopotas": ["impish", "relaxed", "adamant"], "hippowdon": ["impish"], "skorupi": ["impish", "relaxed", "adamant"], "drapion": ["jolly", "adamant"], "croagunk": ["adamant", "jolly"], "toxicroak": ["jolly", "adamant"], "carnivine": ["adamant", "jolly"], "finneon": ["modest", "timid"], "lumineon": ["timid", "bold"], "mantyke": ["calm", "careful", "bold"], "snover": ["naive", "hasty"], "abomasnow": ["quiet"], "weavile": ["jolly"], "magnezone": ["modest", "timid"], "lickilicky": ["careful", "adamant"], "rhyperior": ["adamant"], "tangrowth": ["relaxed"], "electivire": ["jolly"], "magmortar": ["modest", "timid"], "togekiss": ["timid", "modest"], "yanmega": ["modest", "timid"], "leafeon": ["jolly", "adamant"], "glaceon": ["modest", "timid"], "gliscor": ["impish", "jolly"], "mamoswine": ["jolly", "adamant"], "porygon-z": ["timid"], "gallade": ["jolly", "adamant"], "probopass": ["bold", "calm"], "dusknoir": ["adamant", "impish"], "froslass": ["timid"], "rotom": ["bold", "timid", "calm", "modest"], "uxie": ["bold", "relaxed"], "mesprit": ["timid", "modest"], "azelf": ["timid", "jolly"], "dialga": ["modest", "timid"], "palkia": ["timid", "hasty"], "heatran": ["timid", "modest", "calm"], "regigigas": ["adamant", "jolly"], "giratina": ["bold", "impish", "modest"], "cresselia": ["bold", "calm"], "phione": ["modest", "timid"], "manaphy": ["timid"], "darkrai": ["timid"], "shaymin": ["timid"], "arceus": ["jolly", "timid", "adamant", "modest"], "snivy": ["modest", "timid"], "servine": ["modest", "timid"], "serperior": ["timid"], "tepig": ["adamant", "jolly"], "pignite": ["adamant", "jolly"], "emboar": ["adamant"], "oshawott": ["modest", "timid"], "dewott": ["modest", "timid"], "samurott": ["adamant", "modest"], "patrat": ["adamant", "jolly"], "watchog": ["adamant", "jolly"], "lillipup": ["adamant", "jolly"], "herdier": ["adamant", "jolly"], "stoutland": ["adamant"], "purrloin": ["adamant", "jolly"], "liepard": ["jolly"], "pansage": ["modest", "timid"], "simisage": ["modest", "timid"], "pansear": ["modest", "timid"], "simisear": ["modest", "timid"], "panpour": ["modest", "timid"], "simipour": ["modest", "timid"], "munna": ["calm", "careful", "bold"], "musharna": ["bold", "calm"], "pidove": ["adamant", "jolly"], "tranquill": ["adamant", "jolly"], "unfezant": ["adamant", "jolly"], "blitzle": ["modest", "timid"], "zebstrika": ["timid"], "roggenrola": ["impish", "relaxed", "adamant"], "boldore": ["impish", "relaxed", "adamant"], "gigalith": ["brave", "adamant"], "woobat": ["modest", "timid"], "swoobat": ["timid"], "drilbur": ["adamant", "jolly"], "excadrill": ["jolly", "adamant"], "audino": ["bold", "calm"], "timburr": ["adamant", "jolly"], "gurdurr": ["impish", "relaxed", "adamant"], "conkeldurr": ["adamant", "brave"], "tympole": ["modest", "timid"], "palpitoad": ["modest", "timid"], "seismitoad": ["modest", "relaxed"], "throh": ["careful"], "sawk": ["jolly"], "sewaddle": ["adamant", "jolly"], "swadloon": ["impish", "relaxed", "adamant"], "leavanny": ["jolly"], "venipede": ["adamant", "jolly"], "whirlipede": ["impish", "relaxed", "adamant"], "scolipede": ["jolly"], "cottonee": ["calm", "careful", "bold"], "whimsicott": ["timid"], "petilil": ["modest", "timid"], "lilligant": ["timid", "modest"], "basculin": ["jolly"], "sandile": ["adamant", "jolly"], "krokorok": ["adamant", "jolly"], "krookodile": ["jolly", "adamant"], "darumaka": ["adamant", "jolly"], "darmanitan": ["jolly", "adamant"], "maractus": ["modest", "timid"], "dwebble": ["impish", "relaxed", "adamant"], "crustle": ["adamant"], "scraggy": ["adamant", "jolly"], "scrafty": ["careful", "adamant"], "sigilyph": ["timid"], "yamask": ["impish", "relaxed", "adamant"], "cofagrigus": ["bold", "quiet"], "tirtouga": ["impish", "relaxed", "adamant"], "carracosta": ["adamant"], "archen": ["adamant", "jolly"], "archeops": ["jolly", "naive"], "trubbish": ["impish", "relaxed", "adamant"], "garbodor": ["impish"], "zorua": ["naive", "hasty"], "zoroark": ["timid", "naive"], "minccino": ["adamant", "jolly"], "cinccino": ["jolly"], "gothita": ["modest", "timid"], "gothorita": ["modest", "timid"], "gothitelle": ["calm"], "solosis": ["brave", "quiet", "relaxed", "sassy"], "duosion": ["brave", "quiet", "relaxed", "sassy"], "reuniclus": ["quiet", "bold"], "ducklett": ["modest", "timid"], "swanna": ["timid", "modest"], "vanillite": ["modest", "timid"], "vanillish": ["modest", "timid"], "vanilluxe": ["modest", "timid"], "deerling": ["adamant", "jolly"], "sawsbuck": ["jolly", "adamant"], "emolga": ["timid"], "karrablast": ["adamant", "jolly"], "escavalier": ["brave", "adamant"], "foongus": ["calm", "careful", "bold"], "amoonguss": ["calm", "bold"], "frillish": ["calm", "careful", "bold"], "jellicent": ["bold", "calm"], "alomomola": ["bold", "impish"], "joltik": ["modest", "timid"], "galvantula": ["timid"], "ferroseed": ["impish", "relaxed", "adamant"], "ferrothorn": ["relaxed", "sassy"], "klink": ["adamant", "jolly"], "klang": ["adamant", "jolly"], "klinklang": ["adamant"], "tynamo": ["modest", "timid"], "eelektrik": ["modest", "timid"], "eelektross": ["quiet", "modest", "adamant"], "elgyem": ["brave", "quiet", "relaxed", "sassy"], "beheeyem": ["quiet"], "litwick": ["modest", "timid"], "lampent": ["modest", "timid"], "chandelure": ["timid", "modest"], "axew": ["adamant", "jolly"], "fraxure": ["adamant", "jolly"], "haxorus": ["jolly", "adamant"], "cubchoo": ["adamant", "jolly"], "beartic": ["adamant"], "cryogonal": ["timid", "calm"], "shelmet": ["modest", "timid"], "accelgor": ["timid"], "stunfisk": ["bold", "calm"], "mienfoo": ["adamant", "jolly"], "mienshao": ["jolly", "naive"], "druddigon": ["adamant"], "golett": ["adamant", "jolly"], "golurk": ["adamant"], "pawniard": ["adamant", "jolly"], "bisharp": ["adamant", "jolly"], "bouffalant": ["adamant"], "rufflet": ["adamant", "jolly"], "braviary": ["jolly", "adamant"], "vullaby": ["impish", "relaxed", "adamant"], "mandibuzz": ["bold", "impish"], "heatmor": ["naive", "hasty"], "durant": ["jolly"], "deino": ["modest", "timid"], "zweilous": ["adamant", "jolly"], "hydreigon": ["timid", "modest"], "larvesta": ["modest", "timid"], "volcarona": ["timid", "modest"], "cobalion": ["jolly", "timid"], "terrakion": ["jolly", "adamant"], "virizion": ["jolly", "timid"], "tornadus": ["timid", "naive"], "thundurus": ["timid", "naive"], "reshiram": ["timid", "modest"], "zekrom": ["adamant", "jolly"], "landorus": ["jolly", "naive"], "kyurem": ["timid", "modest", "hasty"], "keldeo": ["timid", "modest"], "meloetta": ["timid", "modest", "naive"], "genesect": ["naive", "hasty", "timid"]};

    function getBestNatures(mon) {
        for (const value of [mon?.speciesId, mon?.species, mon?.name]) {
            if (typeof value !== 'string') continue;
            const natures = BEST_NATURES_GEN1_TO_5[value.toLowerCase().trim()];
            if (natures) return natures;
        }
        return ["adamant", "jolly", "modest", "timid", "bold", "calm", "impish", "careful"];
    }

    function evaluateCapturedCreature(caught) {
        if (!caught || !hasCompleteIVs(caught)) return null;
        const speciesId = String(caught.speciesId || (caught.name ? caught.name.toLowerCase() : "")).toLowerCase();
        const nature = String(caught.nature || "").toLowerCase();
        const ivs = caught.ivs || {};
        const ivHp = Number(ivs.hp || 0);
        const ivAtk = Number(ivs.atk || 0);
        const ivDef = Number(ivs.def || 0);
        const ivSpa = Number(ivs.spa || 0);
        const ivSpd = Number(ivs.spd || 0);
        const ivSpe = Number(ivs.spe || 0);
        const ivTotal = ivHp + ivAtk + ivDef + ivSpa + ivSpd + ivSpe;
        const ivPct = Math.round((ivTotal / 186) * 1000) / 10;

        const bestList = getBestNatures(caught);
        const isBestNature = bestList.includes(nature);

        let grade = "C";
        if (ivTotal >= 158 || (isBestNature && ivTotal >= 140)) {
            grade = "S";
        } else if (ivTotal >= 130) {
            grade = "A";
        } else if (ivTotal >= 93) {
            grade = "B";
        }

        return {
            id: caught.id || caught.creatureId,
            speciesId,
            name: caught.name || speciesId,
            level: caught.level || 1,
            isShiny: !!caught.isShiny,
            nature,
            isBestNature,
            bestNatures: bestList,
            ivTotal,
            ivPct,
            grade,
            quality: getCreatureQuality(caught),
            ivs: { hp: ivHp, atk: ivAtk, def: ivDef, spa: ivSpa, spd: ivSpd, spe: ivSpe }
        };
    }

    const TYPE_CHART = {
        normal: { rock: 0.5, ghost: 0, steel: 0.5 },
        fire: { fire: 0.5, water: 0.5, grass: 2, ice: 2, bug: 2, rock: 0.5, dragon: 0.5, steel: 2 },
        water: { fire: 2, water: 0.5, grass: 0.5, ground: 2, rock: 2, dragon: 0.5 },
        electric: { water: 2, electric: 0.5, grass: 0.5, ground: 0, flying: 2, dragon: 0.5 },
        grass: { fire: 0.5, water: 2, grass: 0.5, poison: 0.5, ground: 2, flying: 0.5, bug: 0.5, rock: 2, dragon: 0.5, steel: 0.5 },
        ice: { fire: 0.5, water: 0.5, grass: 2, ice: 0.5, ground: 2, flying: 2, dragon: 2, steel: 0.5 },
        fighting: { normal: 2, ice: 2, poison: 0.5, flying: 0.5, psychic: 0.5, bug: 0.5, rock: 2, ghost: 0, dark: 2, steel: 2, fairy: 0.5 },
        poison: { grass: 2, poison: 0.5, ground: 0.5, rock: 0.5, ghost: 0.5, steel: 0, fairy: 2 },
        ground: { fire: 2, electric: 2, grass: 0.5, poison: 2, flying: 0, bug: 0.5, rock: 2, steel: 2 },
        flying: { electric: 0.5, grass: 2, fighting: 2, bug: 2, rock: 0.5, steel: 0.5 },
        psychic: { fighting: 2, poison: 2, psychic: 0.5, dark: 0, steel: 0.5 },
        bug: { fire: 0.5, grass: 2, fighting: 0.5, poison: 0.5, flying: 0.5, psychic: 2, ghost: 0.5, dark: 2, steel: 0.5, fairy: 0.5 },
        rock: { fire: 2, ice: 2, fighting: 0.5, ground: 0.5, flying: 2, bug: 2, steel: 0.5 },
        ghost: { normal: 0, psychic: 2, ghost: 2, dark: 0.5 },
        dragon: { dragon: 2, steel: 0.5, fairy: 0 },
        dark: { fighting: 0.5, psychic: 2, ghost: 2, dark: 0.5, fairy: 0.5 },
        steel: { fire: 0.5, water: 0.5, electric: 0.5, ice: 2, rock: 2, steel: 0.5, fairy: 2 },
        fairy: { fire: 0.5, fighting: 2, poison: 0.5, dragon: 2, dark: 2, steel: 0.5 }
    };

    function getTypeEffectiveness(moveType, foeTypes) {
        if (!moveType || !foeTypes) return 1.0;
        const mt = String(moveType).toLowerCase();
        const targets = Array.isArray(foeTypes) ? foeTypes : [foeTypes];
        let multiplier = 1.0;
        for (const ft of targets) {
            if (!ft) continue;
            const ftStr = String(ft).toLowerCase();
            if (TYPE_CHART[mt] && TYPE_CHART[mt][ftStr] !== undefined) {
                multiplier *= TYPE_CHART[mt][ftStr];
            }
        }
        return multiplier;
    }

    function getBestPotion(currentHp, maxHp) {
        const missingHp = Math.max(0, maxHp - currentHp);
        const p = inventory.potions || {};

        if (botConfig.potion_mode && botConfig.potion_mode !== "smart") {
            const chosen = botConfig.potion_mode;
            if (p[chosen] > 0) return chosen;
        }

        // Smart Escalation with official formulas:
        // potion = 20 HP, super-potion = 60 HP, hyper-potion = 120 HP, max-potion = 100% max HP
        if (missingHp > 180 && p["max-potion"] > 0) return "max-potion";
        if (missingHp >= 120 && p["hyper-potion"] > 0) return "hyper-potion";
        if (missingHp >= 60 && p["super-potion"] > 0) return "super-potion";
        if (p["potion"] > 0) return "potion";

        // Fallbacks
        if (p["super-potion"] > 0) return "super-potion";
        if (p["hyper-potion"] > 0) return "hyper-potion";
        if (p["max-potion"] > 0) return "max-potion";
        return null;
    }

    function getBestRevive() {
        const r = inventory.revives || {};
        if (r["revive"] > 0) return "revive";
        if (r["max-revive"] > 0) return "max-revive";
        return null;
    }

    function getBestBall(foeHpPct, isShiny, isUncaught) {
        const b = inventory.ball || {};
        const pokeballCount = b.pokeball || 0;
        const greatCount = b.greatball || 0;
        const superCount = b.superball || 0;
        const ultraCount = b.ultraball || 0;
        const masterCount = b.masterball || 0;

        if (isShiny && masterCount > 0) return "master-ball";

        if (botConfig.ball_priority === "force_highest") {
            if (ultraCount > 0) return "ultra-ball";
            if (superCount > 0) return "super-ball";
            if (greatCount > 0) return "great-ball";
            if (pokeballCount > 0) return "poke-ball";
            return null;
        }

        if (botConfig.ball_priority === "economy") {
            if (pokeballCount > 0) return "poke-ball";
            if (greatCount > 0) return "great-ball";
            if (superCount > 0) return "super-ball";
            if (ultraCount > 0) return "ultra-ball";
            return null;
        }

        // Smart priority: Shiny gets best ball available immediately
        if (isShiny) {
            if (masterCount > 0) return "master-ball";
            if (ultraCount > 0) return "ultra-ball";
            if (superCount > 0) return "super-ball";
            if (greatCount > 0) return "great-ball";
            if (pokeballCount > 0) return "poke-ball";
            return null;
        }

        // Tiered multiplier thresholds: Ultra (4x) <= 15%, Super (3x) <= 30%, Great (2x) <= 50%, Poké (1x)
        if (foeHpPct <= 0.15 && ultraCount > 0) return "ultra-ball";
        if (foeHpPct <= 0.30 && superCount > 0) return "super-ball";
        if (foeHpPct <= 0.50 && greatCount > 0) return "great-ball";
        if (pokeballCount > 0) return "poke-ball";
        if (greatCount > 0) return "great-ball";
        if (superCount > 0) return "super-ball";
        if (ultraCount > 0) return "ultra-ball";

        return null;
    }

    function getTotalBalls(isShiny = false) {
        const b = (inventory && inventory.ball) || {};
        const standard = (b.pokeball || 0) + (b.greatball || 0) + (b.superball || 0) + (b.ultraball || 0);
        return isShiny ? standard + (b.masterball || 0) : standard;
    }

    function selectBattleMove(foeTypes, foeHpPct, isCaptureTarget) {
        if (!battleMoves || battleMoves.length === 0) return null;

        const scoredMoves = battleMoves.map(m => {
            const basePower = m.power || 0;
            const eff = getTypeEffectiveness(m.type, foeTypes);
            const score = basePower * eff;
            return { ...m, eff, score };
        });

        // No verified damage bound or nonlethal move contract is available.
        // Power, type and level alone cannot prove the target will survive.
        // Keep the requested nonlethal-weakening feature open until evidenced;
        // the caller uses a permitted ball (or waits) instead of risking a KO.
        if (isCaptureTarget) return null;

        if (botConfig.move_selection_mode === "first") {
            return scoredMoves[0];
        }

        // Standard offensive combat: highest damage score first
        scoredMoves.sort((a, b) => b.score - a.score);
        return scoredMoves[0];
    }

    function updateInventory(data) {
        const items = Array.isArray(data) ? data : (data.items || []);
        const balls = { pokeball: 0, greatball: 0, superball: 0, ultraball: 0, masterball: 0 };
        const potions = { potion: 0, "super-potion": 0, "hyper-potion": 0, "max-potion": 0 };
        const revives = { revive: 0, "max-revive": 0 };
        const boosts = { "shiny-boost": 0, "xp-share-boost": 0, "capture-boost": 0, "map-boost": 0 };
        let totalPotions = 0;

        for (const item of items) {
            if (!item) continue;
            const kind = String(item.kind || "").toLowerCase();
            const iid = String(item.id || item.itemId || "").toLowerCase();
            const qty = Number(item.quantity ?? item.qty ?? 0);
            if (!Number.isFinite(qty) || qty <= 0) continue;

            if (kind.includes("ball") || iid.includes("ball")) {
                if (iid.includes("master")) balls.masterball += qty;
                else if (iid.includes("ultra")) balls.ultraball += qty;
                else if (iid.includes("super")) balls.superball += qty;
                else if (iid.includes("great")) balls.greatball += qty;
                else balls.pokeball += qty;
            } else if (kind.includes("potion") || iid.includes("potion")) {
                totalPotions += qty;
                if (iid.includes("max")) potions["max-potion"] += qty;
                else if (iid.includes("hyper")) potions["hyper-potion"] += qty;
                else if (iid.includes("super")) potions["super-potion"] += qty;
                else potions.potion += qty;
            } else if (kind.includes("revive") || iid.includes("revive")) {
                if (iid.includes("max")) revives["max-revive"] += qty;
                else revives.revive += qty;
            } else if (iid.includes("boost") || kind.includes("boost")) {
                if (iid.includes("shiny")) boosts["shiny-boost"] += qty;
                else if (iid.includes("xp") || iid.includes("share")) boosts["xp-share-boost"] += qty;
                else if (iid.includes("capture") || iid.includes("catch")) boosts["capture-boost"] += qty;
                else if (iid.includes("map")) boosts["map-boost"] += qty;
            }
        }

        inventory = { ball: balls, potions, revives, boosts, potion: totalPotions };
        emitTelemetry();
    }
    function withHealth(mon) {
        if (!mon) return mon;
        return { ...mon, ...(Number.isFinite(mon.hp) && mon.maxHp > 0
            ? { hpPercent: Math.max(0, Math.min(1, mon.hp / mon.maxHp)) } : {}) };
    }

    const rewardRequests = new Map();
    function requestReward(t, d) {
        const now = Date.now();
        for (const [key, sentAt] of rewardRequests) {
            if (now - sentAt >= 60000) rewardRequests.delete(key);
        }
        const key = JSON.stringify([t, d]);
        if (rewardRequests.has(key) || !activeWs || activeWs.readyState !== WebSocket.OPEN) return;
        rewardRequests.set(key, now);
        sendEvent(t, d);
    }

    function applyBattleEvents(events) {
        if (!Array.isArray(events)) return;
        for (const event of events) {
            let side = event.who;
            let hp;
            if (event.e === 'attack') {
                side = event.by === 'you' ? 'foe' : 'you';
                hp = event.targetHp;
            } else if (event.e === 'heal' || event.e === 'residual') {
                hp = event.hpAfter;
            } else if (event.e === 'faint') {
                hp = 0;
            } else if ((event.e === 'swap' || event.e === 'swap_enemy') && event.view) {
                if (event.e === 'swap') {
                    myMon = withHealth(event.view);
                    battleMoves = event.view.moves || [];
                } else enemyMon = withHealth(event.view);
            }
            if (!Number.isFinite(hp)) continue;
            if (side === 'you' && myMon) {
                myMon = withHealth({ ...myMon, hp });
                const id = myMon.creatureId || myMon.id;
                team = team.map(mon => mon.id === id ? withHealth({ ...mon, hp }) : mon);
            } else if (side === 'foe' && enemyMon) {
                enemyMon = withHealth({ ...enemyMon, hp });
            }
        }
    }

    function updateCreatures(creatures, patch = false, complete = !patch) {
        if (!Array.isArray(creatures)) return;
        if (complete) collectionLoaded = true;
        if (!patch) collection = {};
        for (const mon of creatures) {
            if (!mon?.id) continue;
            if (mon.deleted || mon.removed) {
                delete collection[mon.id];
                if (pendingReleases.has(mon.id)) {
                    const pending = pendingReleases.get(mon.id);
                    pendingReleases.delete(mon.id);
                    addReleasedId(mon.id);
                    logEvent(`🗑️ Liberação confirmada de ${pending.speciesName} (IV: ${pending.ivSum}/186 - ${pending.ivPct}%)`, 'info');
                }
            } else {
                collection[mon.id] = withHealth({ ...(collection[mon.id] || {}), ...mon });
            }
        }

        if (complete) {
            for (const [id, pending] of pendingReleases.entries()) {
                if (!collection[id]) {
                    pendingReleases.delete(id);
                    addReleasedId(id);
                    logEvent(`🗑️ Liberação confirmada de ${pending.speciesName} (IV: ${pending.ivSum}/186 - ${pending.ivPct}%)`, 'info');
                }
            }
        }

        // Derive party from merged collection entries having explicit teamSlot
        const allCreatures = Object.values(collection);
        const hasSlottedSchema = allCreatures.some(mon => Object.hasOwn(mon, 'teamSlot'));

        if (hasSlottedSchema) {
            team = allCreatures
                .filter(mon => mon.teamSlot !== null && mon.teamSlot !== undefined)
                .sort((a, b) => a.teamSlot - b.teamSlot);
        } else if (!patch && allCreatures.length > 0) {
            // Legacy schema snapshot where teamSlot field does not exist at all
            team = allCreatures.slice(0, 6);
        } else {
            team = [];
        }

        if (!inBattle) myMon = team.find(mon => mon.isLeader) || team[0] || null;
        if (collectionLoaded) {
            reconcileDonations();
            resolveCapturedCreatures();
        }
    }

    function resolveCapturedCreatures() {
        if (!collectionLoaded) return;
        pendingCaptures = pendingCaptures.filter(capture => {
            const candidates = Object.values(collection).filter(mon =>
                !capture.knownIds.has(mon.id) && String(mon.speciesId) === String(capture.speciesId) &&
                (!capture.id || mon.id === capture.id));
            if (candidates.length !== 1 || !hasCompleteIVs(candidates[0]) || !hasKnownKeepCriteria(candidates[0])) return true;
            const mon = candidates[0];
            const evaluation = evaluateCapturedCreature(mon);
            lastCapturedMon = evaluation;
            let qualityLog = "";
            if (evaluation.quality !== null && evaluation.quality !== undefined && evaluation.quality >= 0) {
                const qScore = evaluation.quality;
                let qTier = '1★';
                if (qScore >= 1000) qTier = '6★';
                else if (qScore >= 990) qTier = '5★';
                else if (qScore >= 940) qTier = '4★';
                else if (qScore >= 800) qTier = '3★';
                else if (qScore >= 500) qTier = '2★';
                qualityLog = `, Nota: ${qScore} [${qTier}]`;
            }
            logEvent(`📊 ${mon.name || mon.speciesId}: IV ${evaluation.ivTotal}/186 (${evaluation.grade}${qualityLog}).`, 'info');
            if (botConfig.enabled) {
                const qScore = evaluation.quality ?? getCreatureQuality(mon);
                const isUltraRare = mon.isShiny || mon.shiny || evaluation.grade === 'S' || (mon.eventTier > 0) || (mon.form?.eventTier > 0) || (qScore !== null && qScore >= 990);
                if (botConfig.auto_lock_valuable && isUltraRare) {
                    if (!mon.isLocked && !mon.locked) sendEvent('creature:lock', { creatureId: mon.id, locked: true });
                } else if (botConfig.auto_discard_caught) {
                    checkMonIVStrategy(mon, true);
                }
            }
            return false;
        });
    }

function handleGameMessage(msg) {
        if (!msg) return;
        const t = msg.t || msg.type;
        const d = msg.d !== undefined ? msg.d : msg;

        if (t === 'error') {
            const code = d?.code || msg.code || 'unknown';
            if (code === 'heal_insufficient_funds') rejectedHealState = lastHealRequest;
            if (code === 'creature_locked' || code === 'release_failed' || String(code).includes('release')) {
                for (const [id, pending] of pendingReleases.entries()) {
                    // This error shape carries no verified operation identifier.
                    // It cannot reconcile every in-flight release or authorize retry.
                    logEvent(`⚠️ Erro ${code}; liberação de ${pending.speciesName} permanece sem confirmação.`, 'warning');
                }
            }
            if (code === 'travel_forbidden' || code === 'route_locked' || code === 'map_invalid' || String(code).includes('travel') || String(code).includes('route')) {
                if (routeSwitchState.active) {
                    logEvent(`⚠️ [AUTO-ROTA] Viagem para rota ${getMapFriendlyName(routeSwitchState.targetRoute)} recusada pelo servidor: ${code}. Permanecendo em ${getMapFriendlyName(currentMap)}.`, 'warning');
                    if (routeSwitchState.timeoutTimer) {
                        clearTimeout(routeSwitchState.timeoutTimer);
                        routeSwitchState.timeoutTimer = null;
                    }
                    routeSwitchState.active = false;
                    routeSwitchState.targetRoute = null;
                    if (!inBattle && botConfig.enabled) {
                        startRoamLoop();
                    }
                }
            }
            logEvent(`Servidor recusou uma ação: ${code}`, 'warning');
            return;
        }

        if (t === 'shard:redirect') {
            const shardId = d?.shard !== undefined ? d.shard : (msg.shard !== undefined ? msg.shard : null);
            logEvent(`🔀 Redirecionado para Shard ${shardId !== null ? shardId : 'novo'}`, "info");
            emitTelemetry();
            return;
        }

        // Welcome Packet — Official IdleDex Initial State
        if (t === "welcome") {
            // The initial roster is partial; only the subsequent team snapshot
            // confirms the Box and operations outstanding across reconnects.
            collectionLoaded = false;
            collection = {};
            team = [];
            if (d.playerId) {
                playerId = String(d.playerId);
                try { sessionStorage.setItem('idledex_playerId', playerId); } catch (e) {}
            }
            if (d.map) {
                currentMap = d.map;
                if (typeof currentMap === 'string' && currentMap.startsWith('route_')) {
                    lastHuntMap = currentMap;
                    try { sessionStorage.setItem('idledex-last-hunt-map', currentMap); } catch {}
                }
                if (routeSwitchState.active && (currentMap === routeSwitchState.targetRoute || d.map === routeSwitchState.targetRoute)) {
                    if (routeSwitchState.timeoutTimer) {
                        clearTimeout(routeSwitchState.timeoutTimer);
                        routeSwitchState.timeoutTimer = null;
                    }
                    logEvent(`🎯 [AUTO-ROTA] Chegada à rota ${getMapFriendlyName(currentMap)} confirmada via welcome!`, "success");
                    routeSwitchState.active = false;
                    routeSwitchState.targetRoute = null;
                    routeSwitchState.attempts = 0;
                }
                loadMapCollision(currentMap);
                scheduleSessionTask(() => { sendEvent("map:preview", { mapId: currentMap }); }, 600);
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
                    updateCreatures(p.team, false, false);
                    if (p.wallet) {
                        wallet = {
                            silver: p.wallet.silver ?? p.wallet.coins ?? 0,
                            gold: p.wallet.gold ?? p.wallet.crystals ?? 0
                        };
                    }
                    if (p.inventory) {
                        updateInventory(p.inventory);
                    }
                    if (p.itemEffects) {
                        itemEffects = Object.assign({}, itemEffects, p.itemEffects);
                    }
                }
            }

            logEvent(`🎮 Conectado ao mapa ${currentMap || 'Mundo'} (Treinador: ${playerId || 'Player'})`, "success");
            sendEvent('box:open');
            emitTelemetry();

            scheduleSessionTask(() => {
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
            if (typeof currentMap === 'string' && currentMap.startsWith('route_')) {
                lastHuntMap = currentMap;
                try { sessionStorage.setItem('idledex-last-hunt-map', currentMap); } catch {}
            }
            logEvent(`🗺️ Transição de mapa para: ${getMapFriendlyName(currentMap)}`, "info");
            scheduleSessionTask(() => { sendEvent("map:preview", { mapId: currentMap }); }, 300);

            // AUTO-TRAVEL STATE MACHINE TRANSITIONS
            if (autoTravelState.active) {
                if (currentMap === autoTravelState.targetMap && autoTravelState.phase === "traveling_to_lab") {
                    beginLabDelivery();
                }
                else if (currentMap === autoTravelState.originMap && autoTravelState.phase === "returning") {
                    if (autoTravelState.timeoutTimer) {
                        clearTimeout(autoTravelState.timeoutTimer);
                        autoTravelState.timeoutTimer = null;
                    }
                    autoTravelState.active = false;
                    autoTravelState.phase = "idle";
                    autoTravelState.lastTravelTime = Date.now();
                    logEvent(`🎯 [AUTO-TRAVEL] Retorno à rota ${getMapFriendlyName(currentMap)} concluído com sucesso! Retomando patrulha na grama alta.`, "success");
                    if (!inBattle) {
                        startRoamLoop();
                    }
                }
            }

            // ROUTE SWITCH STATE MACHINE TRANSITIONS
            if (routeSwitchState.active && (currentMap === routeSwitchState.targetRoute || (d && d.map === routeSwitchState.targetRoute))) {
                if (routeSwitchState.timeoutTimer) {
                    clearTimeout(routeSwitchState.timeoutTimer);
                    routeSwitchState.timeoutTimer = null;
                }
                logEvent(`🎯 [AUTO-ROTA] Chegada à rota ${getMapFriendlyName(currentMap)} confirmada!`, "success");
                routeSwitchState.active = false;
                routeSwitchState.targetRoute = null;
                routeSwitchState.attempts = 0;
                if (!inBattle && botConfig.enabled) {
                    startRoamLoop();
                }
            }

            emitTelemetry();
        }

        // Map Preview (Area Spawns)
        else if (t === "map:preview") {
            if (d && Array.isArray(d.species)) {
                currentMapSpecies = d.species.map(sp => ({
                    speciesId: sp.speciesId,
                    name: sp.name || sp.speciesId,
                    minLevel: sp.minLevel || 1,
                    maxLevel: sp.maxLevel || 1,
                    frequency: sp.frequency || "common",
                    caught: !!sp.caught,
                    seen: !!sp.seen
                }));
                emitTelemetry();

                if (botConfig.auto_route_switch) {
                    scheduleSessionTask(() => {
                        if (!inBattle && botConfig.enabled && !autoTravelState.active) {
                            checkAutoRouteSwitch();
                        }
                    }, 3500);
                }
            }
        }

        // Battle Start
        else if (t === "battle:start") {
            // CRITICAL MULTI-PLAYER FIX: Ignore battles started by other players on the map!
            if (!isMyBattle(d)) {
                return;
            }

            inBattle = true;
            battleKnownCreatureIds = new Set(Object.keys(collection));
            currentBattleId = d.battleId || d.id || null;
            myMon = withHealth(d.leader || myMon);
            enemyMon = withHealth(d.foe || null);

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

            // Reset turn locks and state for new battle
            actionInFlight = false;
            canThrowBall = false;
            canUsePotion = false;
            canRevive = false;
            lastTurnNumber = -1;
            battleWindowOpen = false;

            // Start battle watchdog poller to handle DOM interactive state cleanly without duplicate dispatches
            if (battleWatchdog) clearInterval(battleWatchdog);
            battleWatchdog = setInterval(() => {
                if (!inBattle) {
                    clearInterval(battleWatchdog);
                    battleWatchdog = null;
                    return;
                }
                if (!botConfig.enabled || !currentBattleId || actionInFlight) return;

                if (isThrowBarOpen()) {
                    processBattleTurn();
                }
            }, 350);
        }

        // Progress & Stats
        else if (t === "progress:state" || t === "progress") {
            if (d.rank) progress.rank = d.rank;
            if (d.xp !== undefined) {
                if (initialXp === null) initialXp = d.xp;
                else if (d.xp >= initialXp) sessionXpGained = d.xp - initialXp;
                progress.xp = d.xp;
            }
            if (d.wins !== undefined) progress.wins = d.wins;
            if (d.losses !== undefined) progress.losses = d.losses;
            if (d.captures !== undefined) progress.captures = d.captures;
            if (d.shinies !== undefined) progress.shinies = d.shinies;
            emitTelemetry();
        }

        // Wallet
        else if (t === "wallet") {
            const curSilver = d.silver !== undefined ? d.silver : d.coins;
            if (curSilver !== undefined) {
                if (initialSilver === null) initialSilver = curSilver;
                else if (curSilver >= initialSilver) sessionSilverGained = curSilver - initialSilver;
                wallet.silver = curSilver;
            }
            if (d.gold !== undefined) wallet.gold = d.gold;
            else if (d.crystals !== undefined) wallet.gold = d.crystals;
            emitTelemetry();
        }

        // Inventory
        else if (t === "inventory") {
            updateInventory(d);
        }

        // Collection Updates
        else if (t === "collection" || t === "collection:patch") {
            const mons = Array.isArray(d) ? d : (d.mons || d.monsters);
            if (!Array.isArray(mons)) return;
            // Compatibility for the legacy full-collection envelope. A patch
            // alone never establishes that the entire Box has arrived.
            if (t === 'collection') collectionLoaded = true;
            const previousIds = new Set(Object.keys(collection));
            for (const mon of mons) {
                if (mon && mon.id) {
                    if (mon.deleted || mon.removed) {
                        delete collection[mon.id];
                        if (pendingReleases.has(mon.id)) {
                            const pending = pendingReleases.get(mon.id);
                            pendingReleases.delete(mon.id);
                            addReleasedId(mon.id);
                            logEvent(`🗑️ Liberação confirmada de ${pending.speciesName} (IV: ${pending.ivSum}/186 - ${pending.ivPct}%)`, 'info');
                        }
                    } else {
                        collection[mon.id] = { ...(collection[mon.id] || {}), ...mon };
                    }
                }
            }
            reconcileDonations();
            resolveCapturedCreatures();
            if (botConfig.auto_discard_caught) {
                for (const mon of [...mons].sort((a, b) => Number(previousIds.has(a?.id)) - Number(previousIds.has(b?.id)))) {
                    if (mon && !mon.deleted && !mon.removed) checkMonIVStrategy(collection[mon.id], true);
                }
            }
            emitTelemetry();
        }

        // Active Team
        else if (t === "team" || t === "team:patch") {
            updateCreatures(Array.isArray(d) ? d : (d.creatures || d.team), t === 'team:patch');
            emitTelemetry();
        }

        // Item Effects & Session Buffs
        else if (t === "item-effects:state") {
            if (d) {
                itemEffects = Object.assign({}, itemEffects, d);
                emitTelemetry();
            }
        }

        // Daily Quests (Auto Claim)
        else if (t === "daily:list" || t === "daily:state") {
            if (botConfig.enabled && botConfig.auto_claim_dailies && d) {
                const quests = d.quests || (Array.isArray(d) ? d : []);
                for (const q of quests) {
                    if (q && q.id && Number.isFinite(q.progress) && Number.isFinite(q.goal) && q.progress >= q.goal && !q.claimed) {
                        requestReward("daily:claim", { questId: q.id });
                        logEvent(`🎁 [MISSÃO DIÁRIA] Solicitando resgate: ${q.name || q.id}...`, "info");
                    }
                }
            }
        }

        // Login Streak Calendar Bonus
        else if (t === "calendar:state") {
            if (botConfig.enabled && botConfig.auto_claim_dailies && d && d.claimable === true) {
                requestReward("daily:bonus");
                logEvent(`📅 [LOGIN CONSECUTIVO] Solicitando bônus de calendário...`, "info");
            }
        }

        // Pokédex Milestones & Entries
        else if (t === "pokedex:list" || t === "pokedex:state") {
            if (d && Array.isArray(d.entries)) {
                pokedexLoaded = true;
                pokedexCaughtSpecies.clear();
                for (const entry of d.entries) {
                    if (!entry) continue;
                    if (entry.caught === true) {
                        if (entry.speciesId !== undefined && entry.speciesId !== null) {
                            pokedexCaughtSpecies.add(String(entry.speciesId));
                        }
                        if (entry.name) {
                            pokedexCaughtSpecies.add(String(entry.name).toLowerCase());
                        }
                    }
                }
            }
            if (botConfig.enabled && botConfig.auto_claim_dailies && d) {
                const hasUnclaimed = Array.isArray(d.milestones) && d.milestones.some(m => m.ready === true);
                if (hasUnclaimed) {
                    requestReward("pokedex:claim-all");
                    logEvent(`📖 [POKÉDEX] Solicitando marcos da Pokédex...`, "info");
                }
            }
        }

        // Gamepass / Battle Pass
        else if (t === "gamepass:state") {
            if (botConfig.enabled && botConfig.auto_claim_dailies && d) {
                const missionsReady = Array.isArray(d.missions) && d.missions.some(m => !m.claimed && m.progress >= m.goal);
                const tiersReady = Array.isArray(d.tiers) && d.tiers.some(tier => d.points >= tier.points &&
                    (!tier.freeClaimed || (d.premium && !tier.premiumClaimed)));
                if (missionsReady || tiersReady) {
                    requestReward("gamepass:claim-all");
                    logEvent(`🎫 [GAMEPASS] Solicitando recompensas do Passe de Batalha...`, "info");
                }
            }
        }

        // Official News & Announcements Reward Claim
        else if (t === "news:page" || t === "news:list") {
            if (botConfig.enabled && botConfig.auto_claim_dailies && d && Array.isArray(d.posts)) {
                for (const post of d.posts) {
                    if (post && post.id && Array.isArray(post.reward) && post.reward.length > 0 && !post.claimed) {
                        requestReward("news:claim", { postId: post.id });
                        logEvent(`📰 [NOTÍCIAS] Solicitando recompensa do post: ${post.title || post.id}...`, "info");
                    }
                }
            }
        }

        // Professor Oak Delivery (Bronze Coins)
        else if (t === "professor:state") {
            if (botConfig.enabled && botConfig.auto_npc_quests && currentMap === 'npclab' && d && Array.isArray(d.lots)) {
                const lotSize = d.lotSize || 5;
                const stateKey = JSON.stringify([d.charges, lotSize, d.lots]);
                const isTrip = autoTravelState.active && autoTravelState.phase === 'delivering';
                if (autoTravelState.active && !isTrip) return;
                if (isTrip && autoTravelState.pendingDelivery) {
                    const pending = autoTravelState.pendingDelivery;
                    const remaining = d.lots.find(lot => lot.speciesId === pending.speciesId)?.available ?? 0;
                    if (!(d.charges < pending.charges || remaining < pending.available)) return;
                    autoTravelState.deliveriesDone++;
                    logEvent(`🔬 [PROFESSOR] Entrega confirmada pelo servidor para espécie ${pending.speciesId}!`, "success");
                    autoTravelState.pendingDelivery = null;
                }
                if (d.charges < lotSize || !Number.isFinite(d.charges)) {
                    if (isTrip) returnFromLab('Sem cargas suficientes para outro lote.');
                    return;
                }
                if (stateKey === lastProfessorState) return;
                for (const lot of d.lots) {
                    if (lot && lot.available > lotSize && canDonateSpecies(lot.speciesId, lotSize) && !pendingDonations.has('professor')) {
                        lastProfessorState = stateKey;
                        if (isTrip) autoTravelState.pendingDelivery = {
                            speciesId: lot.speciesId, charges: d.charges, available: lot.available,
                        };
                        reserveDonation('professor', donationCandidates(lot.speciesId), lotSize);
                        sendEvent("professor:deliver", { speciesId: lot.speciesId });
                        logEvent(`🔬 [PROFESSOR] Solicitando entrega de lote de ${lot.name || lot.speciesId} (+${lot.bronzePerLot || 1} Moedas de Bronze)...`, "info");
                        return;
                    }
                }
                if (isTrip) returnFromLab('Não há mais lotes elegíveis para entrega.');
            }
        }

        // DexQuest Delivery
        else if (t === "dexquest:state") {
            if (botConfig.enabled && botConfig.auto_npc_quests && d && d.target && d.target.have > 0 && canDonateSpecies(d.target.speciesId, 1) && !pendingDonations.has('dexquest')) {
                const questKey = JSON.stringify([d.target.speciesId, d.target.have, d.questId || d.id || currentMap]);
                if (questKey === lastDexQuestState) return;
                lastDexQuestState = questKey;
                reserveDonation('dexquest', donationCandidates(d.target.speciesId), 1);
                sendEvent("dexquest:deliver", { speciesId: d.target.speciesId });
                logEvent(`🎯 [DEXQUEST] Solicitando entrega de ${d.target.name || d.target.speciesId} para missão de rota...`, "info");
            } else if (d?.target && d.target.have === 0 && lastDexQuestState !== null) {
                lastDexQuestState = null;
                logEvent('🎯 [DEXQUEST] Entrega confirmada pelo servidor para missão de rota!', 'success');
            }
        }

        // Collector Delivery
        else if (t === "collector:state") {
            const wasDelivering = collectorState && !collectorState.delivered;
            collectorState = d;
            if (wasDelivering && d.delivered) {
                logEvent('🏺 [COLECIONADOR] Entrega confirmada com sucesso pelo servidor!', 'success');
            }
            if (botConfig.enabled && botConfig.auto_npc_quests && d?.mapId === currentMap && d.deliverable && !d.delivered) {
                sendEvent('collector:preview');
            }
        }
        else if (t === 'collector:preview') {
            if (!botConfig.enabled || !botConfig.auto_npc_quests || !collectorState?.deliverable || collectorState.delivered) return;
            if (d?.mapId !== currentMap || d.window !== collectorState.window || !Array.isArray(d.creatureIds) || !d.creatureIds.length) return;
            const key = JSON.stringify([d.mapId, d.window, d.creatureIds]);
            const candidates = d.creatureIds.map(id => collection[id]);
            if (key === collectorDeliveryKey || pendingDonations.has('collector') || !canConsumeBatch(candidates)) return;
            collectorDeliveryKey = key;
            reserveDonation('collector', candidates, candidates.length);
            sendEvent('collector:deliver');
            logEvent('🏺 [COLECIONADOR] Solicitando entrega após conferir a prévia...', 'info');
        }

        // Combat Turn & Control
        else if (t === "battle:turn" || t === "battle:control") {
            // CRITICAL MULTI-PLAYER FIX: Ignore turns from other players' battles!
            if (!inBattle || !currentBattleId || d.battleId !== currentBattleId) {
                return;
            }

            if (d.myMon || d.leader) myMon = withHealth(d.myMon || d.leader);
            if (d.foe || d.opponent) enemyMon = withHealth(d.foe || d.opponent);
            applyBattleEvents(Array.isArray(d.turn?.events) ? d.turn.events : (Array.isArray(d.events) ? d.events : null));
            if (d.moves && Array.isArray(d.moves) && d.moves.length > 0) battleMoves = d.moves;
            if (d.leader && Array.isArray(d.leader.moves) && d.leader.moves.length > 0) battleMoves = d.leader.moves;
            if (d.leaderMoves && Array.isArray(d.leaderMoves) && d.leaderMoves.length > 0) battleMoves = d.leaderMoves;
            if (d.canThrow !== undefined) canThrowBall = !!d.canThrow;
            if (d.canHeal !== undefined) canUsePotion = !!d.canHeal;
            if (d.canRevive !== undefined) canRevive = !!d.canRevive;
            battleWindowOpen = d.open !== false && (canThrowBall || canUsePotion || canRevive || d.canFlee !== false || d.turn !== undefined);
            const animationMs = t === 'battle:turn' && Number.isFinite(d.animateMs) ? Math.max(0, d.animateMs) : 0;
            const windowMs = t === 'battle:turn' ? d.turnMs : d.windowMs;
            battleReadyAt = Date.now() + animationMs;
            battleExpiresAt = Number.isFinite(windowMs) && windowMs > 0 ? Date.now() + windowMs : Infinity;
            if (d.final !== undefined) battleWindowOpen = false;

            // Unlock action dispatch on new turn from server
            if (d.turn !== undefined && d.turn !== lastTurnNumber) {
                lastTurnNumber = d.turn;
                actionInFlight = false;
            } else if (d.open === true) {
                actionInFlight = false;
            }

            emitTelemetry();

            if (!botConfig.enabled || !battleWindowOpen) return;

            if (battleTurnTimer) clearTimeout(battleTurnTimer);
            battleTurnTimer = scheduleSessionTask(() => {
                if (!inBattle || !botConfig.enabled || !currentBattleId || actionInFlight) return;
                if (isThrowBarOpen()) {
                    processBattleTurn();
                }
            }, animationMs + 20);
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
            actionInFlight = false;
            canThrowBall = false;
            canUsePotion = false;
            canRevive = false;
            lastTurnNumber = -1;
            if (battleTurnTimer) {
                clearTimeout(battleTurnTimer);
                battleTurnTimer = null;
            }
            if (battleWatchdog) {
                clearInterval(battleWatchdog);
                battleWatchdog = null;
            }

            const victory = d.result === 'win' || d.victory === true;
            const captured = d.result === 'capture' || d.captured === true;
            const foeName = (enemyMon && (enemyMon.name || enemyMon.species)) || "Criatura";

            if (captured) {
                lastCapturedMon = null;
                const caughtSpeciesId = d.caught?.speciesId ?? enemyMon?.speciesId;
                const caughtSpeciesName = d.caught?.name ?? enemyMon?.name ?? enemyMon?.species;
                if (caughtSpeciesId !== undefined && caughtSpeciesId !== null) {
                    pokedexCaughtSpecies.add(String(caughtSpeciesId));
                }
                if (caughtSpeciesName) {
                    pokedexCaughtSpecies.add(String(caughtSpeciesName).toLowerCase());
                }
                pendingCaptures.push({
                    speciesId: caughtSpeciesId,
                    id: d.caught?.id ?? d.caught?.creatureId,
                    knownIds: battleKnownCreatureIds,
                });
                if (pendingCaptures.length > 10) pendingCaptures.shift();
                if (d.caught) {
                    const evalData = evaluateCapturedCreature(d.caught);
                    if (evalData) {
                        lastCapturedMon = evalData;
                        const star = evalData.isShiny ? " ✨" : "";
                        const natMsg = evalData.isBestNature ? `Nature: ${evalData.nature} (⭐ TOP NATURE!)` : `Nature: ${evalData.nature}`;
                        const tierMsg = `IV: ${evalData.ivTotal}/186 (${evalData.ivPct}% - Grau ${evalData.grade})`;
                        let qualityMsg = "";
                        if (evalData.quality !== null && evalData.quality !== undefined && evalData.quality >= 0) {
                            const qScore = evalData.quality;
                            let qLabel = "Razoável 1★";
                            if (qScore >= 1000) qLabel = "Perfeito 6★";
                            else if (qScore >= 990) qLabel = "Excepcional 5★";
                            else if (qScore >= 940) qLabel = "Excelente 4★";
                            else if (qScore >= 800) qLabel = "Ótimo 3★";
                            else if (qScore >= 500) qLabel = "Bom 2★";
                            const pct = Math.floor(qScore / 10);
                            qualityMsg = ` | Nota: ${qScore} (${qLabel}, top ${100 - pct}%)`;
                        }
                        logEvent(`🎉 [CAPTURA] ${evalData.name}${star} Lv${evalData.level}! ${natMsg}, ${tierMsg}${qualityMsg}`, evalData.grade === "S" ? "success" : "info");

                        // Auto-lock valuable creatures (Shinies, Event Tiers, Grade S, or Quality threshold >= 990)
                        if (botConfig.enabled && botConfig.auto_lock_valuable && evalData.id) {
                            const qScore = evalData.quality ?? getCreatureQuality(d.caught);
                            const isValuable = evalData.isShiny || evalData.grade === "S" || (d.caught.eventTier && d.caught.eventTier > 0) || (qScore !== null && qScore >= 990);
                            if (isValuable) {
                                sendEvent("creature:lock", { creatureId: evalData.id, locked: true });
                                logEvent(`🔒 [PROTEÇÃO] ${evalData.name} bloqueado contra descarte/perda acidental!`, "success");
                            }
                        }
                    } else {
                        logEvent(`✨ ${foeName} capturado com sucesso!`, "success");
                    }
                } else {
                    logEvent(`✨ ${foeName} capturado com sucesso!`, "success");
                }
                progress.captures = (progress.captures || 0) + 1;
                sessionCaptures++;
                resolveCapturedCreatures();
            } else if (victory) {
                logEvent(`⚔️ Vitória sobre ${foeName}!`, "success");
                progress.wins = (progress.wins || 0) + 1;
            } else if (d.result === 'lose' || d.victory === false) {
                logEvent(`💀 Derrota contra ${foeName}...`, "warning");
                progress.losses = (progress.losses || 0) + 1;
            } else {
                logEvent(`Duelo encerrado (${d.result || 'sem resultado informado'}).`, 'info');
            }

            enemyMon = null;
            emitTelemetry();

            // Resume roaming after battle exit animation completes (or trigger auto-travel delivery / route switch)
            if (botConfig.enabled) {
                scheduleSessionTask(() => {
                    if (!inBattle && botConfig.enabled) {
                        const traveled = checkAutoTravelDeliveries();
                        if (!traveled) {
                            const switchedRoute = checkAutoRouteSwitch();
                            if (!switchedRoute) {
                                startRoamLoop();
                            }
                        }
                    }
                }, 1200);
            }
        }
    }

    function hasCompleteIVs(mon) {
        return ['hp', 'atk', 'def', 'spa', 'spd', 'spe'].every(key =>
            Number.isInteger(mon?.ivs?.[key]) && mon.ivs[key] >= 0 && mon.ivs[key] <= 31);
    }

    function isProtectedCreature(mon) {
        return !mon || mon.isShiny || mon.shiny || mon.isLocked || mon.locked || mon.isLeader || mon.mega || mon.isMega || mon.isListed ||
            pendingLocks.has(mon.id) ||
            (mon.eventTier > 0) || (mon.form?.eventTier > 0) ||
            (mon.teamSlot !== undefined && mon.teamSlot !== null) ||
            team.some(member => member.id === mon.id);
    }

    function isDonatableCreature(mon) {
        return Boolean(
            collectionLoaded &&
            mon &&
            !isProtectedCreature(mon) &&
            !isNewBattleCreature(mon) &&
            hasKnownKeepCriteria(mon) &&
            !meetsQualityThreshold(mon, botConfig.min_quality) &&
            !releasedCreatureIds.has(mon.id) &&
            !pendingReleases.has(mon.id) &&
            !isReservedForDonation(mon) &&
            Number.isInteger(mon?.boxSlot) &&
            mon.boxSlot >= 0 &&
            hasCompleteIVs(mon) &&
            evaluateCapturedCreature(mon)?.grade !== 'S'
        );
    }

    function canDonateSpecies(speciesId, count) {
        const candidates = donationCandidates(speciesId);
        return candidates.length >= count && canConsumeBatch(candidates.slice(0, count));
    }

    function donationCandidates(speciesId) {
        return Object.values(collection).filter(mon =>
            String(mon.speciesId !== undefined ? mon.speciesId : (mon.species || '')) === String(speciesId) &&
            isDonatableCreature(mon)
        );
    }

    function isReservedForDonation(mon) {
        return [...pendingDonations.values()].some(pending =>
            pending.ids.has(mon.id) || pending.species.has(String(mon.speciesId ?? mon.species ?? '')));
    }

    function canConsumeBatch(mons) {
        if (!mons.length || !mons.every(isDonatableCreature) || new Set(mons.map(mon => mon.id)).size !== mons.length) return false;
        if (botConfig.protect_last_copy === false) return true;
        const consumed = new Set(mons.map(mon => mon.id));
        return mons.every(mon => {
            const species = String(mon.speciesId ?? mon.species ?? '');
            return species && Object.values(collection).some(other =>
                String(other.speciesId ?? other.species ?? '') === species &&
                !consumed.has(other.id) && !pendingReleases.has(other.id) &&
                !releasedCreatureIds.has(other.id) && !isReservedForDonation(other));
        });
    }

    function reserveDonation(npc, mons, count) {
        pendingDonations.set(npc, {
            ids: new Set(mons.map(mon => mon.id)),
            species: new Set(mons.map(mon => String(mon.speciesId ?? mon.species ?? ''))),
            count,
        });
    }

    function reconcileDonations() {
        if (!collectionLoaded) return;
        for (const id of pendingLocks) {
            if (!collection[id] || collection[id].isLocked || collection[id].locked) pendingLocks.delete(id);
        }
        for (const [npc, pending] of pendingDonations) {
            const removed = [...pending.ids].filter(id => !collection[id]).length;
            if (removed >= pending.count) pendingDonations.delete(npc);
        }
    }

    function hasSurplusCopies(mon, excludedIds = new Set()) {
        if (!mon) return false;
        const targetSpeciesId = String(mon.speciesId !== undefined ? mon.speciesId : (mon.species || ''));
        if (!targetSpeciesId) return false;
        const otherCopies = Object.values(collection).filter(c => {
            if (!c || !c.id || c.id === mon.id || excludedIds.has(c.id)) return false;
            const sId = String(c.speciesId !== undefined ? c.speciesId : (c.species || ''));
            if (sId !== targetSpeciesId) return false;
            if (releasedCreatureIds.has(c.id)) return false;
            if (pendingReleases.has(c.id)) return false;
            if (isReservedForDonation(c)) return false;
            return true;
        });
        return otherCopies.length >= 1;
    }

    function isNewBattleCreature(mon) {
        return inBattle && mon && !battleKnownCreatureIds.has(mon.id);
    }

    function hasKnownKeepCriteria(mon, config = botConfig) {
        if (config.min_quality && config.min_quality !== 'any' && getCreatureQuality(mon) === null) return false;
        if (config.desired_nature && config.desired_nature !== 'any' && !String(mon?.nature || '').trim()) return false;
        return true;
    }

    function monMatchesKeepCriteria(mon, config = botConfig) {
        if (!mon || !hasCompleteIVs(mon) || !hasKnownKeepCriteria(mon, config)) return true;

        const mode = config.iv_evaluation_mode || 'percent';
        const stats = mon.ivs || {};
        const hp = Number(stats.hp || 0);
        const atk = Number(stats.atk || 0);
        const def = Number(stats.def || 0);
        const spa = Number(stats.spa !== undefined ? stats.spa : (stats.spAtk || 0));
        const spd = Number(stats.spd !== undefined ? stats.spd : (stats.spDef || 0));
        const spe = Number(stats.spe !== undefined ? stats.spe : (stats.speed || 0));
        const ivSum = hp + atk + def + spa + spd + spe;
        const ivPct = (ivSum / 186) * 100;

        const cutoffPct = config.discard_iv_pct ?? 0;
        const desiredNature = String(config.desired_nature || 'any').toLowerCase().trim();
        const minIvs = config.min_ivs || {};
        const hasIndividualMin = mode === 'individual' && Object.values(minIvs).some(v => v > 0);
        const hasPercentMin = mode === 'percent' && cutoffPct > 0;
        const hasNatureFilter = desiredNature !== 'any';
        const hasQualityFilter = Boolean(config.min_quality && config.min_quality !== 'any');

        // If no filter is active, keep everything
        if (!hasIndividualMin && !hasPercentMin && !hasNatureFilter && !hasQualityFilter) {
            return true;
        }

        // Strict AND rule: creature must meet ALL active criteria to be kept.
        // If it fails ANY active criterion, it is marked for discard (returns false).

        // 1. Quality filter check
        if (hasQualityFilter && !meetsQualityThreshold(mon, config.min_quality)) {
            return false;
        }

        // 2. IV filter check
        if (mode === 'individual') {
            if (hasIndividualMin && (
                hp < (minIvs.hp ?? 0) ||
                atk < (minIvs.atk ?? 0) ||
                def < (minIvs.def ?? 0) ||
                spa < (minIvs.spa ?? 0) ||
                spd < (minIvs.spd ?? 0) ||
                spe < (minIvs.spe ?? 0))) {
                return false;
            }
        } else {
            if (hasPercentMin && ivPct < cutoffPct) {
                return false;
            }
        }

        // 3. Nature filter check
        if (hasNatureFilter) {
            const monNature = String(mon.nature || '').toLowerCase().trim();
            if (desiredNature === 'competitive') {
                const bestList = getBestNatures(mon);
                if (!bestList.includes(monNature)) {
                    return false;
                }
            } else if (monNature !== desiredNature) {
                return false;
            }
        }

        // Passes all active criteria
        return true;
    }

    function checkMonIVStrategy(mon, isPostCapture = false) {
        if (!collectionLoaded) return;
        if (!botConfig.enabled || !mon || !mon.id || releasedCreatureIds.has(mon.id) || pendingReleases.has(mon.id) || isReservedForDonation(mon) || pendingReleases.size >= 500) return;
        if (isNewBattleCreature(mon)) return;

        // Strict Safety Gate: Never release shiny, special event tiers, locked creatures, or party members
        if (isProtectedCreature(mon) || !hasCompleteIVs(mon)) {
            return;
        }

        const inBox = Number.isInteger(mon.boxSlot) && mon.boxSlot >= 0;
        const isEligiblePostCapture = isPostCapture && (mon.teamSlot === null || mon.teamSlot === undefined) && !team.some(member => member.id === mon.id);
        if (!inBox && !isEligiblePostCapture) {
            return;
        }

        // Conservative policy: protect last copy of each species (configurable via protect_last_copy)
        if (botConfig.protect_last_copy !== false && !hasSurplusCopies(mon)) {
            return;
        }

        const mode = botConfig.iv_evaluation_mode || 'percent';
        const cutoffPct = botConfig.discard_iv_pct ?? 0;
        const desiredNature = String(botConfig.desired_nature || 'any').toLowerCase().trim();
        const minIvs = botConfig.min_ivs || {};
        const hasIndividualMin = mode === 'individual' && Object.values(minIvs).some(v => v > 0);
        const hasPercentMin = mode === 'percent' && cutoffPct > 0;
        const hasNatureFilter = desiredNature !== 'any';
        const hasQualityFilter = Boolean(botConfig.min_quality && botConfig.min_quality !== 'any');

        if (!hasIndividualMin && !hasPercentMin && !hasNatureFilter && !hasQualityFilter) {
            return;
        }

        if (monMatchesKeepCriteria(mon, botConfig)) {
            return;
        }

        const stats = mon.ivs || {};
        const ivSum = Number(stats.hp || 0) + Number(stats.atk || 0) + Number(stats.def || 0) + 
                      Number(stats.spa !== undefined ? stats.spa : (stats.spAtk || 0)) + 
                      Number(stats.spd !== undefined ? stats.spd : (stats.spDef || 0)) + 
                      Number(stats.spe !== undefined ? stats.spe : (stats.speed || 0));
        const ivPct = Math.round((ivSum / 186) * 100);

        const speciesName = mon.species || mon.name || 'Criatura';
        const qScore = getCreatureQuality(mon);
        const qMsg = (qScore !== null && qScore >= 0) ? `, Nota: ${qScore}` : '';
        const tag = isPostCapture ? '[DESCARTE PÓS-CAPTURA] ' : '';
        pendingReleases.set(mon.id, {
            speciesName,
            ivSum,
            ivPct,
            cutoffPct,
            requestedAt: Date.now(),
        });
        sendEvent("creature:release", { creatureIds: [mon.id] });
        logEvent(`📤 ${tag}Solicitando liberação de ${speciesName} (IV: ${ivSum}/186 - ${ivPct}%${mon.nature ? ', Nature: ' + mon.nature : ''}${qMsg})...`, "info");
    }

    function executeBoxCleanup(manual = false) {
        if (!activeWs || activeWs.readyState !== WebSocket.OPEN) {
            if (manual) logEvent('⚠️ Limpeza de Box indisponível: conexão com o jogo não está aberta.', 'warning');
            return;
        }

        if (!collectionLoaded) {
            if (manual) {
                sendEvent('box:open');
                logEvent('⏳ Limpeza de Box indisponível: aguardando a coleção completa. Aguarde o carregamento e tente novamente.', 'info');
            }
            return;
        }

        const mode = botConfig.iv_evaluation_mode || 'percent';
        const cutoffPct = botConfig.discard_iv_pct ?? 0;
        const desiredNature = String(botConfig.desired_nature || 'any').toLowerCase().trim();
        const minIvs = botConfig.min_ivs || {};
        const hasIndividualMin = mode === 'individual' && Object.values(minIvs).some(v => v > 0);
        const hasPercentMin = mode === 'percent' && cutoffPct > 0;
        const hasNatureFilter = desiredNature !== 'any';
        const hasQualityFilter = Boolean(botConfig.min_quality && botConfig.min_quality !== 'any');

        if (!hasIndividualMin && !hasPercentMin && !hasNatureFilter && !hasQualityFilter) {
            if (manual) {
                logEvent('⚠️ Limpeza de Box ignorada: configure critérios de descarte (IV% > 0, Mínimos Individuais > 0, Nature ou Nota Mínima) antes de executar.', 'warning');
            }
            return;
        }

        const allCreatures = Object.values(collection);
        const boxCreatures = allCreatures.filter(mon =>
            mon && mon.id &&
            Number.isInteger(mon.boxSlot) && mon.boxSlot >= 0 &&
            !isProtectedCreature(mon) &&
            !isNewBattleCreature(mon) &&
            hasCompleteIVs(mon) &&
            !releasedCreatureIds.has(mon.id) &&
            !pendingReleases.has(mon.id) &&
            !isReservedForDonation(mon)
        );

        const discardCandidates = [];
        const selectedIds = new Set();
        for (const mon of boxCreatures) {
            if (botConfig.protect_last_copy !== false && !hasSurplusCopies(mon, selectedIds)) {
                continue;
            }
            if (!monMatchesKeepCriteria(mon, botConfig)) {
                discardCandidates.push(mon);
                selectedIds.add(mon.id);
            }
        }

        if (discardCandidates.length === 0) {
            if (manual) {
                logEvent('🧹 [LIMPEZA DE BOX] Nenhuma criatura na Box elegível para descarte foi encontrada.', 'info');
            }
            return;
        }

        const availableSlots = Math.max(0, 500 - pendingReleases.size);
        const toRelease = discardCandidates.slice(0, Math.min(availableSlots, 30));

        if (toRelease.length === 0) {
            logEvent('⚠️ [LIMPEZA DE BOX] Limite de operações pendentes atingido. Aguarde a confirmação do servidor.', 'warning');
            return;
        }

        const ids = toRelease.map(m => m.id);
        const now = Date.now();
        for (const mon of toRelease) {
            const stats = mon.ivs || {};
            const ivSum = Number(stats.hp || 0) + Number(stats.atk || 0) + Number(stats.def || 0) + 
                          Number(stats.spa !== undefined ? stats.spa : (stats.spAtk || 0)) + 
                          Number(stats.spd !== undefined ? stats.spd : (stats.spDef || 0)) + 
                          Number(stats.spe !== undefined ? stats.spe : (stats.speed || 0));
            const ivPct = Math.round((ivSum / 186) * 100);
            pendingReleases.set(mon.id, {
                speciesName: mon.species || mon.name || 'Criatura',
                ivSum,
                ivPct,
                cutoffPct: botConfig.discard_iv_pct ?? 0,
                requestedAt: now,
            });
        }

        sendEvent("creature:release", { creatureIds: ids });
        logEvent(`🧹 [LIMPEZA DE BOX] Solicitando liberação de ${ids.length} criatura(s) da Box (${discardCandidates.length} candidatas no total)...`, 'info');
    }

    function checkOutOfBattleMaintenance() {
        if (!activeWs || activeWs.readyState !== WebSocket.OPEN || inBattle || !botConfig.enabled) return;

        // 1. Auto Revive in Overworld
        if (botConfig.use_revive_overworld && Array.isArray(team) && team.length > 0) {
            const faintedMember = team.find(m => m && (m.hp === 0 || m.isFainted));
            if (faintedMember) {
                const chosenRevive = getBestRevive();
                if (chosenRevive && Date.now() >= nextRecoveryItemAt) {
                    nextRecoveryItemAt = Date.now() + 10000;
                    logEvent(`💊 Revivendo ${faintedMember.name || 'Pokémon'} fora de combate com ${chosenRevive}...`, "info");
                    sendEvent("item:use", { itemId: chosenRevive, creatureId: faintedMember.id, quantity: 1 });
                    return;
                }
            }
        }

        const injuredMember = team.find(mon => mon.hp > 0 && mon.maxHp > 0 && mon.hp / mon.maxHp <= botConfig.potion_hp_pct);
        if (injuredMember && Date.now() >= nextRecoveryItemAt) {
            const potion = getBestPotion(injuredMember.hp, injuredMember.maxHp);
            if (potion) {
                nextRecoveryItemAt = Date.now() + 10000;
                sendEvent('item:use', { itemId: potion, creatureId: injuredMember.id });
                logEvent(`🧪 Recuperando integrante da equipe com ${potion} antes do próximo encontro.`, 'info');
                return;
            }
        }

        // 2. Auto Heal at Pokémon Center / Nurse Joy
        if (botConfig.auto_heal_center && Array.isArray(team) && team.length > 0) {
            const totalHp = team.reduce((acc, m) => acc + (m.hp || 0), 0);
            const totalMaxHp = team.reduce((acc, m) => acc + (m.maxHp || 100), 0);
            const teamHpPct = totalMaxHp > 0 ? (totalHp / totalMaxHp) : 1.0;
            const allFainted = team.every(m => m.hp === 0);

            const hasPotions = (inventory.potion || 0) > 0;
            const hasRevives = (inventory.revives && (inventory.revives.revive > 0 || inventory.revives["max-revive"] > 0));

            if (allFainted || (teamHpPct <= 0.25 && !hasPotions && !hasRevives)) {
                requestAffordableHeal();
            }
        }

        // 3. Periodic Out-of-Battle Player Automation Queries & Boost Activation (Throttled every 60s)
        const now = Date.now();
        if (now - lastMaintenanceCheck > 60000) {
            lastMaintenanceCheck = now;

            if (botConfig.auto_claim_dailies) {
                // The official UI opens modals separately; these requests only refresh state.
                sendEvent("daily:open");
                sendEvent("calendar:open");
                sendEvent("pokedex:open");
                sendEvent("gamepass:open");
                sendEvent("news:list");
            }

            if (botConfig.auto_npc_quests) {
                // Only interact with specific NPCs if the player is physically on their respective map,
                // eliminating server errors 'professor_not_here' and 'dexquest_not_here'.
                if (currentMap === "npclab" || currentMap === "pallet-town" || currentMap.includes("lab")) {
                    sendEvent("professor:open");
                }
            }

            if (botConfig.auto_travel_deliveries) {
                checkAutoTravelDeliveries();
            }

            if (botConfig.auto_box_cleanup) {
                executeBoxCleanup(false);
            }

            if (botConfig.auto_use_boosts && inventory.boosts) {
                if (inventory.boosts["shiny-boost"] > 0 && !itemEffects.shinyBoost) {
                    sendEvent("shiny-boost:activate", { itemId: "shiny-boost" });
                    logEvent("✨ [BOOST] Ativando Shiny Boost para patrulha...", "info");
                }
                if (inventory.boosts["xp-share-boost"] > 0 && !itemEffects.xpShareBoost) {
                    sendEvent("xp-share-boost:activate", { itemId: "xp-share-boost" });
                    logEvent("📈 [BOOST] Ativando XP Share Boost para patrulha...", "info");
                }
            }
        }
    }

    function requestAffordableHeal() {
        const stateKey = JSON.stringify([wallet.silver, progress.rank, team.map(mon => [mon.id, mon.hp, mon.level])]);
        if (Date.now() < nextHealAt || stateKey === rejectedHealState) return false;
        let budget = Math.max(0, wallet.silver || 0);
        const injured = team.filter(mon => mon.hp < mon.maxHp);
        const selected = [];
        for (const mon of injured) {
            const cost = progress.rank <= 20 ? 0 : mon.level * 2;
            if (!Number.isFinite(cost) || cost > budget) continue;
            selected.push(mon.id);
            budget -= cost;
        }
        // The official free rescue applies only when every party/Box creature is fainted.
        const playable = Object.values(collection).filter(mon => mon.teamSlot != null || mon.boxSlot != null);
        if (!selected.length && injured.length && playable.length && playable.every(mon => mon.hp <= 0)) selected.push(injured[0].id);
        if (!selected.length) return false;
        lastHealRequest = stateKey;
        nextHealAt = Date.now() + 10000;
        sendEvent('heal:full', { creatureIds: selected });
        logEvent(`🏥 Recuperação solicitada para ${selected.length} integrante(s), conforme o saldo disponível.`, 'info');
        return true;
    }

    
    // Check if the duel throw/combat bar is open and ready to accept turn input
    function isThrowBarOpen() {
        if (Date.now() < battleReadyAt || Date.now() >= battleExpiresAt) return false;
        if (battleWindowOpen) return true;
        const throwBar = document.querySelector('.hud-throw-bar');
        if (!throwBar) {
            // Fallback: check if move buttons or ball buttons are mounted and enabled
            const enabledMoves = document.querySelectorAll('.hud-duel-moves button:not([disabled])');
            const enabledBalls = document.querySelectorAll('.hud-throw-balls button:not([disabled])');
            return enabledMoves.length > 0 || enabledBalls.length > 0;
        }
        if (throwBar.classList.contains('hud-duel-waiting')) return false;
        return throwBar.hasAttribute('data-open') || !!document.querySelector('.hud-duel-moves button:not([disabled]), .hud-throw-balls button:not([disabled])');
    }

    // Execute battle action with single-dispatch guarantee (either DOM click OR WebSocket send, never both)
    function executeBattleAction(actionType, payload, domSelector) {
        if (actionInFlight) return false;

        let clicked = false;
        if (domSelector) {
            const btn = document.querySelector(domSelector);
            if (btn && !btn.disabled) {
                actionInFlight = true;
                btn.click();
                clicked = true;
            }
        }

        if (!clicked && payload) {
            actionInFlight = true;
            if (actionType === "battle:item" && payload.itemId) {
                payload.itemId = canonicalItemId(payload.itemId);
            }
            sendEvent(actionType, payload);
        }

        return true;
    }

    // Process battle actions strictly using active battleId, full variable matrix and real DOM clicks
    function processBattleTurn() {
        if (!activeWs || activeWs.readyState !== WebSocket.OPEN || !currentBattleId || !inBattle || !botConfig.enabled) return;
        if (actionInFlight) return; // Prevent duplicate commands for the current turn

        // Ensure throw window is open and animations finished
        if (!isThrowBarOpen()) return;

        const myHpPct = (myMon && myMon.hpPercent !== undefined) ? myMon.hpPercent : 1.0;
        const foeHpPct = (enemyMon && enemyMon.hpPercent !== undefined) ? enemyMon.hpPercent : 1.0;
        const myCurrentHp = (myMon && myMon.hp !== undefined) ? myMon.hp : Math.round(myHpPct * 100);
        const myMaxHp = (myMon && myMon.maxHp !== undefined) ? myMon.maxHp : 100;

        const isShiny = !!(enemyMon && (enemyMon.isShiny || enemyMon.shiny));
        const foeSpecies = (enemyMon && (enemyMon.name || enemyMon.species)) || "";
        const foeSpeciesId = (enemyMon && (enemyMon.speciesId !== undefined && enemyMon.speciesId !== null ? enemyMon.speciesId : foeSpecies.toLowerCase())) || "";
        const isUncaught = isSpeciesUncaught(enemyMon?.speciesId, enemyMon?.species || enemyMon?.name);
        const foeLevel = (enemyMon && (enemyMon.level || enemyMon.lvl)) || 1;
        const myLevel = (myMon && (myMon.level || myMon.lvl)) || 1;

        // Determine if current wild foe qualifies for capture & area whitelist
        let isCaptureTarget = false;
        let shouldFleeUnselected = false;

        const pinnedList = botConfig.pinned_species
            ? (Array.isArray(botConfig.pinned_species)
                ? botConfig.pinned_species.map(s => String(s).toLowerCase().trim())
                : [String(botConfig.pinned_species).toLowerCase().trim()])
            : [];
        const fName = String(foeSpecies).toLowerCase().trim();
        const fId = String(foeSpeciesId).toLowerCase().trim();
        const isPinned = pinnedList.some(p => p && (fName === p || fId === p));

        // PRIORITY HIERARCHY:
        // 1. Shiny is absolute #1 priority (never flee, always capture)
        if (isShiny) {
            isCaptureTarget = true;
            shouldFleeUnselected = false;
        }
        // 2. Pinned species for IV farming (always capture, never flee)
        else if (isPinned) {
            isCaptureTarget = true;
            shouldFleeUnselected = false;
        }
        // 3. Uncaught species is absolute #3 priority when catch_only_uncaught is enabled
        else if (botConfig.catch_only_uncaught && isUncaught) {
            isCaptureTarget = true;
            shouldFleeUnselected = false;
        }
        // 3. Area / Route specific target mode (T07: all | selected | none)
        else if (botConfig.target_mode === 'none') {
            isCaptureTarget = false;
            if (botConfig.unselected_action === "flee") {
                shouldFleeUnselected = true;
            }
        }
        else if (botConfig.target_mode === 'selected' || (Array.isArray(botConfig.target_species) && botConfig.target_species.length > 0 && botConfig.target_mode !== 'all')) {
            const targetList = Array.isArray(botConfig.target_species) ? botConfig.target_species.map(String) : [];
            if (targetList.includes(String(foeSpeciesId))) {
                isCaptureTarget = true;
            } else {
                isCaptureTarget = false;
                if (botConfig.unselected_action === "flee") {
                    shouldFleeUnselected = true;
                }
            }
        }
        // 4. General capture rules mode (target_mode === 'all' or default)
        else {
            if (botConfig.catch_only_shiny) {
                isCaptureTarget = isShiny;
            } else if (botConfig.catch_only_uncaught) {
                isCaptureTarget = isUncaught;
            } else {
                isCaptureTarget = (botConfig.catch_hp_pct > 0);
            }
            if (!isCaptureTarget && botConfig.unselected_action === "flee") {
                shouldFleeUnselected = true;
            }
        }

        // Flee immediately if configured to flee from unselected species in this area
        if (shouldFleeUnselected) {
            logEvent(`🏃 Fugindo de ${foeSpecies} (${foeSpeciesId} não está na lista de alvos da área)...`, "info");
            executeBattleAction("battle:flee", { battleId: currentBattleId }, '.hud-throw-balls .hud-throw-flee:not([disabled])');
            return;
        }

        // Tactical Zero-Ball Strategy: Flee or farm XP if inventory has no balls
        const totalBalls = getTotalBalls(isShiny);
        if (isCaptureTarget && totalBalls === 0) {
            if (botConfig.unselected_action === "battle") {
                logEvent(`⚠️ Sem Pokébolas! Alternando para combate por XP contra ${foeSpecies}...`, "info");
                isCaptureTarget = false;
            } else if (botConfig.unselected_action === "flee") {
                logEvent(`⚠️ Sem Pokébolas e modo de captura ativo! Fugindo de ${foeSpecies}...`, "warning");
                executeBattleAction("battle:flee", { battleId: currentBattleId }, '.hud-throw-balls .hud-throw-flee:not([disabled])');
                return;
            }
        }

        // 1. In-Battle Revive: Revive fainted leader before critical HP fleeing
        const isFainted = Boolean(myMon && (myMon.hp === 0 || myMon.isFainted));
        if (botConfig.use_revive_battle && canRevive && isFainted) {
            const chosenRevive = getBestRevive();
            if (chosenRevive) {
                logEvent(`💊 [REVIVE] Revivendo companheiro caído em combate com ${chosenRevive}...`, "warning");
                executeBattleAction("battle:item", { battleId: currentBattleId, itemId: chosenRevive });
                return;
            }
        }

        // 2. Flee emergency: Living creature below flee threshold (or fainted when revive unavailable)
        if (myHpPct <= botConfig.flee_hp_pct) {
            logEvent("🏃 HP crítico! Executando fuga tática...", "warning");
            executeBattleAction("battle:flee", { battleId: currentBattleId }, '.hud-throw-balls .hud-throw-flee:not([disabled])');
            return;
        }

        // 2. Heal with potion (Smart Escalation / Configured Tier)
        if (myHpPct <= botConfig.potion_hp_pct && canUsePotion) {
            const chosenPotion = getBestPotion(myCurrentHp, myMaxHp);
            if (chosenPotion) {
                const potionSelector = `.hud-throw-balls button.hud-throw-ball[data-item-id="${chosenPotion}"]:not([disabled])`;
                const potionBtn = document.querySelector(potionSelector);
                if (potionBtn) {
                    logEvent(`🧪 Utilizando ${chosenPotion} no combate (HP: ${Math.round(myHpPct * 100)}%)...`, "info");
                    executeBattleAction("battle:item", { battleId: currentBattleId, itemId: chosenPotion }, potionSelector);
                    return;
                } else {
                    executeBattleAction("battle:item", { battleId: currentBattleId, itemId: chosenPotion });
                    logEvent(`🧪 Despachando ${chosenPotion} via pacote direto...`, "info");
                    return;
                }
            }
        }

        // 3. ZERO-KILL GUARD: Catch wild creature with chosen ball
        // Direct Throw Conditions (throw immediately without prior attack):
        // - Wild foe is Shiny (NEVER hit a shiny!)
        // - Large level gap (myLevel - foeLevel >= 5): high risk of one-shot KO
        // - Wild foe is low level (<= 15) and uncaught
        // - Wild foe HP already <= catch_hp_pct threshold
        const isDirectThrow = isShiny || (myLevel - foeLevel >= 5) || (isUncaught && foeLevel <= 15) || (foeHpPct <= botConfig.catch_hp_pct);

        // A direct throw target must wait for server throw permission: never attack a direct throw target during a healing window or turn delay
        if (isCaptureTarget && totalBalls > 0 && isDirectThrow && !canThrowBall) return;

        if (isCaptureTarget && totalBalls > 0 && isDirectThrow && canThrowBall) {
            const chosenBall = getBestBall(foeHpPct, isShiny, isUncaught);
            if (chosenBall) {
                const ballSelector = `.hud-throw-balls button.hud-throw-ball[data-item-id="${chosenBall}"]:not([disabled]):not(.hud-throw-flee)`;
                const ballBtn = document.querySelector(ballSelector);

                if (ballBtn) {
                    const tag = (isShiny || (myLevel - foeLevel >= 5) || (isUncaught && foeLevel <= 15)) ? ' [ARREMESSO DIRETO]' : '';
                    logEvent(`🎯 Arremessando ${chosenBall} (HP Inimigo: ${Math.round(foeHpPct * 100)}%${isShiny ? ' ✨SHINY' : ''}${tag})`, "info");
                    executeBattleAction("battle:item", { battleId: currentBattleId, itemId: chosenBall }, ballSelector);
                    return;
                } else {
                    // Fallback WebSocket dispatch: Guaranteed ball throw without falling through to attack!
                    logEvent(`🎯 [ZERO-KILL GUARD] Despachando ${chosenBall} diretamente via WebSocket (HP Inimigo: ${Math.round(foeHpPct * 100)}%)...`, "info");
                    executeBattleAction("battle:item", { battleId: currentBattleId, itemId: chosenBall });
                    return;
                }
            }
        }

        // 4. Attack move with elemental type advantage & Zero-Kill Guard
        const foeTypes = (enemyMon && (enemyMon.types || enemyMon.type)) || [];
        const chosenMove = selectBattleMove(foeTypes, foeHpPct, isCaptureTarget);

        if (isCaptureTarget && !chosenMove) {
            // ZERO-KILL GUARD ACTIVE: Any attack would risk killing the target!
            const fallbackBall = getBestBall(foeHpPct, isShiny, isUncaught);
            if (fallbackBall && canThrowBall) {
                logEvent(`🛡️ [ZERO-KILL GUARD] Risco crítico de nocaute! Evitando ataque e arremessando ${fallbackBall}...`, "warning");
                executeBattleAction("battle:item", { battleId: currentBattleId, itemId: fallbackBall });
                return;
            } else if (fallbackBall && !canThrowBall) {
                return;
            } else {
                logEvent(`🛡️ [ZERO-KILL GUARD] Sem Pokébolas utilizáveis e sem golpe seguro contra ${foeSpecies}! Executando fuga tática...`, "warning");
                executeBattleAction("battle:flee", { battleId: currentBattleId }, '.hud-throw-balls .hud-throw-flee:not([disabled])');
                return;
            }
        }

        let chosenMoveId = chosenMove ? chosenMove.id : null;
        let chosenMoveName = chosenMove ? (chosenMove.name || chosenMove.id) : "Ataque";
        let chosenMovePower = chosenMove ? (chosenMove.power || "?") : "?";

        // Search strictly inside .hud-duel-moves (never touching .hud-throw-takeover!)
        const targetBtnSelector = chosenMoveId
            ? `.hud-duel-moves button.hud-duel-move[data-move-id="${chosenMoveId}"]:not([disabled]):not(.hud-throw-takeover)`
            : null;
        const fallbackBtnSelector = '.hud-duel-moves button.hud-duel-move:not([disabled]):not(.hud-throw-takeover)';

        const targetBtn = targetBtnSelector ? document.querySelector(targetBtnSelector) : null;
        const fallbackBtn = document.querySelector(fallbackBtnSelector);
        const btnToClick = targetBtn || fallbackBtn;

        if (btnToClick) {
            const actualMoveId = btnToClick.getAttribute('data-move-id') || chosenMoveId;
            const actualName = btnToClick.innerText ? btnToClick.innerText.split('\n')[0] : chosenMoveName;
            const effMsg = (chosenMove && chosenMove.eff && chosenMove.eff > 1) ? " [SUPER EFETIVO!]" : "";
            logEvent(`⚔️ Desferindo ${actualName} (Poder: ${chosenMovePower})${effMsg}`, "info");

            executeBattleAction("battle:move", { battleId: currentBattleId, moveId: actualMoveId }, targetBtnSelector || fallbackBtnSelector);
        } else if (chosenMoveId) {
            // Fallback WebSocket dispatch if duel is open but buttons not rendered in DOM
            logEvent(`⚔️ Desferindo ${chosenMoveName} via comando direto...`, "info");
            executeBattleAction("battle:move", { battleId: currentBattleId, moveId: chosenMoveId }, null);
        }
    }

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
            }, 40);
        }

        // The game's keyboard loop owns prediction, rate limiting and move sequence.
    }

    // Active Roam & Patrol loop with BFS grass navigation
    function startRoamLoop() {
        if (roamInterval) clearInterval(roamInterval);
        roamInterval = setInterval(() => {
            if (!botConfig.enabled || inBattle || autoTravelState.active || routeSwitchState.active || !activeWs || activeWs.readyState !== WebSocket.OPEN) {
                return;
            }

            if (currentMap === 'npclab') {
                if (botConfig.auto_travel_deliveries && botConfig.auto_npc_quests) {
                    autoTravelState.active = true;
                    autoTravelState.originMap = /^route_\d+$/.test(lastHuntMap || '') ? lastHuntMap : 'route_001';
                    autoTravelState.returnAttempts = 0;
                    autoTravelState.deliveriesDone = 0;
                    beginLabDelivery();
                }
                return;
            }
            if (Date.now() - lastRecoveryCheck >= 3000) {
                lastRecoveryCheck = Date.now();
                checkOutOfBattleMaintenance();
            }
            // Maintenance can start a trip in this very tick.
            if (autoTravelState.active) return;
            if (!botConfig.auto_roam) return;

            // Zero-ball auto-pause: if balls are exhausted and player only wants to capture (flee unselected)
            if (botConfig.pause_on_no_balls && getTotalBalls() === 0 && botConfig.unselected_action === "flee") {
                botConfig.enabled = false;
                if (roamInterval) {
                    clearInterval(roamInterval);
                    roamInterval = null;
                }
                logEvent("🛑 Patrulha pausada automaticamente: estoque de Pokébolas esgotado e modo de captura ativo!", "warning");
                emitTelemetry();
                return;
            }

            if (team.length && team.every(mon => mon.hp <= 0)) return;

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

            // Dead-end / Stuck Detection (Component 4.1)
            let forcedEscapeDir = null;
            if (lastStepPos.x === px && lastStepPos.y === py) {
                stuckCounter++;
                if (stuckCounter >= 10) {
                    logEvent(`⚠️ [ANTI-TRAVAMENTO] Patrulha estagnada em (${px}, ${py}) por 10 ciclos. Executando desvio de emergência...`, "warning");
                    lastGrassDir = null;
                    const escapeDirs = ["N", "S", "E", "W"].filter(d => {
                        const dt = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] }[d];
                        return isWalkable(px + dt[0], py + dt[1]);
                    });
                    if (escapeDirs.length > 0) {
                        forcedEscapeDir = escapeDirs[Math.floor(Math.random() * escapeDirs.length)];
                    }
                    stuckCounter = 0;
                }
            } else {
                lastStepPos = { x: px, y: py };
                stuckCounter = 0;
            }

            // Automatically load map collision if not yet cached
            if (!mapGrid && currentMap && !loadingMap) {
                loadMapCollision(currentMap);
                return;
            }
            if (!mapAvailable || !mapGrid) {
                return;
            }

            let chosenDir = forcedEscapeDir;

            // Strategy 1: If player is ALREADY inside tall grass, pace strictly within the grass patch
            if (isGrass(px, py)) {
                const dirs = [
                    { dir: "N", nx: px, ny: py - 1 },
                    { dir: "S", nx: px, ny: py + 1 },
                    { dir: "E", nx: px + 1, ny: py },
                    { dir: "W", nx: px - 1, ny: py }
                ];
                const grassOptions = dirs.filter(d => isWalkable(d.nx, d.ny) && isGrass(d.nx, d.ny));
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
                const delta = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] }[chosenDir];
                if (delta && isWalkable(px + delta[0], py + delta[1])) {
                    const now = (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now();
                    if (now - lastStepExecutedAt < 205) {
                        return;
                    }
                    lastStepExecutedAt = now;
                    stepInDirection(chosenDir);
                    playerPos = { x: px + delta[0], y: py + delta[1] };
                    emitTelemetry();
                }
            }
        }, Math.max(220, Number(botConfig.roam_step_delay_ms) || 300));
    }

    function isGameSocketUrl(rawUrl) {
        if (!rawUrl) return false;
        try {
            const urlStr = typeof rawUrl === 'string' ? rawUrl : (rawUrl.href || String(rawUrl));
            const URLCtor = typeof URL !== 'undefined' ? URL : (typeof window !== 'undefined' ? window.URL : null);
            if (URLCtor) {
                const parsed = new URLCtor(urlStr, 'wss://idledex.com');
                const proto = parsed.protocol.toLowerCase();
                if (proto !== 'wss:' && proto !== 'ws:') return false;
                const host = parsed.hostname.toLowerCase();
                if (host === 'idledex.com' || host.endsWith('.idledex.com') || host === 'localhost' || host === '127.0.0.1') {
                    return true;
                }
                return false;
            }
            const match = urlStr.match(/^(?:([a-z0-9+.-]+):)?\/\/(?:[^@/]+@)?([^/:]+)/i);
            if (!match) return false;
            const proto = (match[1] || 'wss').toLowerCase();
            if (proto !== 'wss' && proto !== 'ws') return false;
            const host = match[2].toLowerCase();
            return host === 'idledex.com' || host.endsWith('.idledex.com') || host === 'localhost' || host === '127.0.0.1';
        } catch {
            return false;
        }
    }

    // Native WebSocket Hook in Main World
    const OrigWebSocket = (typeof window !== 'undefined' && window.WebSocket) ? window.WebSocket : null;
    function HookedWebSocket(...args) {
        const rawUrl = args[0];
        const isGame = isGameSocketUrl(rawUrl);
        const ws = new OrigWebSocket(...args);

        if (!isGame) {
            // Foreign, service, or analytics socket: do NOT attach game hooks or promote to activeWs.
            return ws;
        }

        const sanitizedUrl = typeof rawUrl === 'string' ? rawUrl.split('?')[0] : 'game-endpoint';
        console.log("[IdleDex Desktop] WebSocket do jogo interceptado com sucesso:", sanitizedUrl);

        function promoteThisSocket() {
            if (ws._idledexRetired || activeWs === ws) return;
            if (activeWs && activeWs !== ws) {
                activeWs._idledexRetired = true;
            }
            commandGeneration++;
            const wasConnected = hasConnected;
            activeWs = ws;
            collectionLoaded = false;
            hasConnected = true;
            if (wasConnected) {
                reconnectCount++;
                logEvent(`🔄 [RECONEXÃO #${reconnectCount}] Conexão WebSocket restabelecida com o servidor!`, "success");
            } else {
                logEvent("✅ Conexão WebSocket estabelecida com o servidor!", "success");
            }
            emitTelemetry();
            scheduleSessionTask(() => {
                if (activeWs === ws && ws.readyState === OrigWebSocket.OPEN) configureAndStartIdle();
            }, 1000);
        }

        ws.addEventListener('open', () => {
            if (ws._idledexRetired) return;
            // Only promote on open if there is no healthy active session
            if (!activeWs || activeWs.readyState === OrigWebSocket.CLOSED || activeWs.readyState === OrigWebSocket.CLOSING) {
                promoteThisSocket();
            }
        });

        ws.addEventListener('close', (event) => {
            if (ws._idledexRetired || activeWs !== ws) return;
            // Reset state related to this WebSocket
            activeWs = null;
            collectionLoaded = false;
            pendingCaptures = [];
            inBattle = false;
            battleWindowOpen = false;
            lastTurnNumber = -1;
            currentBattleId = null;
            actionInFlight = false;
            battleMoves = [];
            enemyMon = null;
            clearTimeout(battleTurnTimer);
            clearInterval(battleWatchdog);
            clearInterval(roamInterval);
            battleTurnTimer = battleWatchdog = roamInterval = null;
            lastStepExecutedAt = 0;
            ++mapLoadVersion;
            if (currentMapAbortController) currentMapAbortController.abort();
            currentMapAbortController = null;
            mapAvailable = false;
            mapStatus = 'idle';
            loadingMap = false;
            mapGrid = cleanGrassGrid = mapFringeMask = null;
            grassTiles = [];
            playerPos = { x: null, y: null };
            entities = [];
            clearTimeout(autoTravelState.timeoutTimer);
            autoTravelState.active = false;
            autoTravelState.phase = 'idle';
            if (routeSwitchState.timeoutTimer) {
                clearTimeout(routeSwitchState.timeoutTimer);
                routeSwitchState.timeoutTimer = null;
            }
            routeSwitchState.active = false;
            routeSwitchState.targetRoute = null;
            routeSwitchState.attempts = 0;
            lastProfessorState = null;
            collectorState = null;
            collectorDeliveryKey = null;
            lastDexQuestState = null;
            pokedexLoaded = false;
            pokedexCaughtSpecies.clear();
            logEvent(`🔌 WebSocket desconectado (code: ${event.code}).`, "warning");
            emitTelemetry();
        });

        ws.addEventListener('message', (event) => {
            if (ws._idledexRetired) return;

            let welcomeMsg = null;
            if (typeof event.data === 'string') {
                try {
                    const parsed = JSON.parse(event.data);
                    const t = parsed?.t || parsed?.type;
                    if (t === 'welcome') {
                        welcomeMsg = parsed;
                    }
                } catch (e) {}
            }

            // Official gameplay handshake: welcome message on candidate socket promotes it as active session
            if (welcomeMsg && activeWs !== ws) {
                promoteThisSocket();
            }

            if (activeWs !== ws) return;

            // Handle Blob payloads asynchronously with session generation check
            if (typeof Blob !== 'undefined' && event.data instanceof Blob) {
                const currentGen = commandGeneration;
                const capturingWs = ws;
                event.data.arrayBuffer().then(buffer => {
                    if (activeWs !== capturingWs || capturingWs._idledexRetired || currentGen !== commandGeneration) {
                        return; // Discard stale Blob response from old session
                    }
                    parseBinaryFrame(buffer);
                }).catch(() => {});
                return;
            }

            if (event.data instanceof ArrayBuffer || ArrayBuffer.isView(event.data)) {
                parseBinaryFrame(event.data);
            } else if (typeof event.data === 'string') {
                try {
                    const msg = welcomeMsg || JSON.parse(event.data);
                    handleGameMessage(msg);
                } catch (e) {}
            }
        });

        return ws;
    }

    // Preserve prototype & static constants
    if (OrigWebSocket) {
        HookedWebSocket.prototype = OrigWebSocket.prototype;
        HookedWebSocket.CONNECTING = OrigWebSocket.CONNECTING;
        HookedWebSocket.OPEN = OrigWebSocket.OPEN;
        HookedWebSocket.CLOSING = OrigWebSocket.CLOSING;
        HookedWebSocket.CLOSED = OrigWebSocket.CLOSED;
        window.WebSocket = HookedWebSocket;
    }

    // Listen for commands dispatched from host via preload
    window.addEventListener('idledex-from-preload', (event) => {
        const { cmd, payload } = event.detail || {};
        if (cmd === 'toggle-bot') {
            commandGeneration++;
            botConfig.enabled = (payload && payload.enabled !== undefined) ? payload.enabled : !botConfig.enabled;
            if (typeof payload?.auto_idle === 'boolean') botConfig.auto_idle = payload.auto_idle;
            if (!botConfig.enabled) {
                clearTimeout(autoTravelState.timeoutTimer);
                autoTravelState.active = false;
                autoTravelState.phase = 'idle';
                if (routeSwitchState.timeoutTimer) {
                    clearTimeout(routeSwitchState.timeoutTimer);
                    routeSwitchState.timeoutTimer = null;
                }
                routeSwitchState.active = false;
                routeSwitchState.targetRoute = null;
                // Clean pause: instantly cancel all loops and pending timers
                if (roamInterval) {
                    clearInterval(roamInterval);
                    roamInterval = null;
                }
                lastStepExecutedAt = 0;
                if (battleTurnTimer) {
                    clearTimeout(battleTurnTimer);
                    battleTurnTimer = null;
                }
                if (battleWatchdog) {
                    clearInterval(battleWatchdog);
                    battleWatchdog = null;
                }
                logEvent("⏸️ Bot pausado pelo usuário (Controle manual liberado)", "warning");
                sendEvent(botConfig.auto_idle ? "idle:start" : "idle:stop");
            } else {
                logEvent("▶️ Bot ativado pelo usuário (Controle Autoritativo)", "success");
                sendEvent("idle:stop");
                if (inBattle) {
                    // In battle: do NOT roam; process battle action immediately
                    processBattleTurn();
                } else {
                    startRoamLoop();
                }
            }
            emitTelemetry();
        } else if (cmd === 'update-config') {
            if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
            const normalized = configSchema.normalizeConfig(payload, botConfig);
            if (normalized.enabled !== botConfig.enabled) {
                commandGeneration++;
                if (!normalized.enabled) {
                    clearTimeout(autoTravelState.timeoutTimer);
                    autoTravelState.active = false;
                    autoTravelState.phase = 'idle';
                    if (routeSwitchState.timeoutTimer) {
                        clearTimeout(routeSwitchState.timeoutTimer);
                        routeSwitchState.timeoutTimer = null;
                    }
                    routeSwitchState.active = false;
                    routeSwitchState.targetRoute = null;
                }
            }
            botConfig = normalized;
            configReady = true;
            logEvent("⚙️ Configurações do bot atualizadas", "info");
            configureAndStartIdle();
            emitTelemetry();
        } else if (cmd === 'manual-action') {
            if (payload.action === 'idle-start') {
                if (botConfig.enabled) {
                    logEvent("⚠️ Auto-Idle nativo evitado para não conflitar com o motor do bot", "warning");
                } else {
                    sendEvent("idle:start");
                }
            }
            else if (payload.action === 'idle-stop') sendEvent("idle:stop");
            else if (payload.action === 'claim-all') {
                sendEvent("pokedex:claim-all");
                sendEvent("gamepass:claim-all");
            }
            else if (payload.action === 'trigger-auto-travel') {
                checkAutoTravelDeliveries(true);
            }
            else if (payload.action === 'cleanup-box') {
                executeBoxCleanup(true);
            }
        }
    });

    logEvent("🚀 Motor autônomo injetado com sucesso no contexto oficial do jogo!", "success");
}

// 4. Trigger Main World Injection
if (typeof webFrame !== 'undefined' && webFrame.executeJavaScript) {
    try {
        const injection = webFrame.executeJavaScript('(' + initMainWorldEngine.toString() + ')((' + createConfigSchema.toString() + ')())');
        injection?.catch(error => console.error('[IdleDex Desktop] Engine injection failed:', error.message));
    } catch (e) {
        console.error("[IdleDex Desktop] Falha ao executar webFrame.executeJavaScript:", e);
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        ALLOWED_PRELOAD_CHANNELS,
        ALLOWED_HOST_COMMANDS,
        handleIdledexToPreload,
        handleHostCommand,
    };
}
