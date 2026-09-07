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
        potion_hp_pct: 0.35,
        potion_mode: 'smart', // 'smart', 'potion', 'super-potion', 'hyper-potion', 'max-potion'
        use_revive_battle: true,
        use_revive_overworld: true,
        auto_heal_center: true,
        catch_hp_pct: 0.50,
        catch_only_shiny: false,
        catch_only_uncaught: false,
        ball_priority: 'balanced', // 'balanced', 'economy', 'force_highest'
        move_selection_mode: 'smart', // 'smart', 'max_damage', 'first'
        target_species: [], // array of speciesIds to catch in current area
        unselected_action: 'battle', // 'battle' (lutar por XP) ou 'flee' (fugir)
        min_iv_alert: 130,
        discard_iv_pct: 50, // Corte percentual de IV para descarte automático via creature:release
        pause_on_no_balls: true, // Pausar patrulha se esgotar Pokébolas e foco for captura
        roam_step_delay_ms: 300,
        auto_idle: true,
        auto_roam: true,
    };

    let currentMapSpecies = [];
    let lastCapturedMon = null;
    const releasedCreatureIds = new Set();

    let activeWs = null;
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

    let canRevive = true;
    let progress = { rank: 1, xp: 0, wins: 0, losses: 0, captures: 0, shinies: 0 };
    let inventory = {
        ball: { pokeball: 0, greatball: 0, ultraball: 0, masterball: 0 },
        potions: { potion: 0, "super-potion": 0, "hyper-potion": 0, "max-potion": 0 },
        revives: { revive: 0, "max-revive": 0 },
        potion: 0
    };
    let wallet = { silver: 0, gold: 0, coins: 0, crystals: 0 };
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
                        currentMapName: getMapFriendlyName(currentMap),
                        availableSpecies: currentMapSpecies,
                        lastCapturedMon,
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

    
    // --- ELEMENTAL TYPE CHART & SMART COMBAT ENGINE ---
    
    // --- OFFICIAL BALL & POTION CATALOGS (v2.2) ---
    const BALL_CATALOG = {
        "poke-ball": { name: "Poké Ball", multiplier: 1 },
        "great-ball": { name: "Great Ball", multiplier: 3 },
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

    // --- COMPETITIVE BEST NATURES DATABASE (GEN 1 - 5: KANTO TO UNOVA) ---
    const BEST_NATURES_GEN1_TO_5 = {"bulbasaur": ["modest", "timid"], "ivysaur": ["modest", "timid"], "venusaur": ["modest", "timid", "calm"], "charmander": ["adamant", "jolly"], "charmeleon": ["adamant", "jolly"], "charizard": ["timid", "jolly", "modest", "adamant"], "squirtle": ["calm", "careful", "bold"], "wartortle": ["calm", "careful", "bold"], "blastoise": ["modest", "bold", "calm"], "caterpie": ["adamant", "jolly"], "metapod": ["impish", "relaxed", "adamant"], "butterfree": ["modest", "timid"], "weedle": ["adamant", "jolly"], "kakuna": ["impish", "relaxed", "adamant"], "beedrill": ["adamant", "jolly"], "pidgey": ["adamant", "jolly"], "pidgeotto": ["adamant", "jolly"], "pidgeot": ["adamant", "jolly"], "rattata": ["adamant", "jolly"], "raticate": ["adamant", "jolly"], "spearow": ["adamant", "jolly"], "fearow": ["adamant", "jolly"], "ekans": ["adamant", "jolly"], "arbok": ["adamant", "jolly"], "pikachu": ["adamant", "jolly"], "raichu": ["timid", "naive", "hasty"], "sandshrew": ["impish", "relaxed", "adamant"], "sandslash": ["adamant", "impish"], "nidoran-f": ["impish", "relaxed", "adamant"], "nidorina": ["impish", "relaxed", "adamant"], "nidoqueen": ["bold", "modest", "timid"], "nidoran-m": ["adamant", "jolly"], "nidorino": ["adamant", "jolly"], "nidoking": ["timid", "modest", "naive"], "clefairy": ["calm", "careful", "bold"], "clefable": ["bold", "calm"], "vulpix": ["modest", "timid"], "ninetales": ["timid", "modest"], "jigglypuff": ["calm", "careful", "bold"], "wigglytuff": ["modest", "calm"], "zubat": ["adamant", "jolly"], "golbat": ["adamant", "jolly"], "oddish": ["modest", "timid"], "gloom": ["modest", "timid"], "vileplume": ["bold", "modest", "calm"], "paras": ["adamant", "jolly"], "parasect": ["careful", "adamant"], "venonat": ["modest", "timid"], "venomoth": ["timid", "modest"], "diglett": ["adamant", "jolly"], "dugtrio": ["adamant", "jolly"], "meowth": ["adamant", "jolly"], "persian": ["adamant", "jolly"], "psyduck": ["modest", "timid"], "golduck": ["modest", "timid"], "mankey": ["adamant", "jolly"], "primeape": ["adamant", "jolly"], "growlithe": ["adamant", "jolly"], "arcanine": ["jolly", "adamant", "timid", "modest"], "poliwag": ["modest", "timid"], "poliwhirl": ["adamant", "jolly"], "poliwrath": ["adamant"], "abra": ["modest", "timid"], "kadabra": ["modest", "timid"], "alakazam": ["timid", "modest"], "machop": ["adamant", "jolly"], "machoke": ["adamant", "jolly"], "machamp": ["adamant", "brave"], "bellsprout": ["naive", "hasty"], "weepinbell": ["naive", "hasty"], "victreebel": ["modest", "adamant", "naive"], "tentacool": ["calm", "careful", "bold"], "tentacruel": ["timid", "calm", "bold"], "geodude": ["impish", "relaxed", "adamant"], "graveler": ["impish", "relaxed", "adamant"], "golem": ["adamant", "impish"], "ponyta": ["adamant", "jolly"], "rapidash": ["adamant", "jolly"], "slowpoke": ["impish", "relaxed", "adamant"], "slowbro": ["bold", "relaxed", "quiet"], "magnemite": ["modest", "timid"], "magneton": ["modest", "timid"], "farfetchd": ["adamant", "jolly"], "doduo": ["adamant", "jolly"], "dodrio": ["adamant", "jolly"], "seel": ["calm", "careful", "bold"], "dewgong": ["calm", "careful"], "grimer": ["impish", "relaxed", "adamant"], "muk": ["adamant", "careful"], "shellder": ["impish", "relaxed", "adamant"], "cloyster": ["jolly", "adamant", "impish"], "gastly": ["modest", "timid"], "haunter": ["modest", "timid"], "gengar": ["timid", "modest"], "onix": ["impish", "relaxed", "adamant"], "drowzee": ["calm", "careful", "bold"], "hypno": ["calm", "careful"], "krabby": ["adamant", "jolly"], "kingler": ["adamant", "jolly"], "voltorb": ["modest", "timid"], "electrode": ["timid", "naive"], "exeggcute": ["modest", "timid"], "exeggutor": ["modest", "quiet"], "cubone": ["adamant", "jolly"], "marowak": ["adamant", "brave"], "hitmonlee": ["adamant", "jolly"], "hitmonchan": ["adamant", "jolly"], "lickitung": ["calm", "careful", "bold"], "koffing": ["impish", "relaxed", "adamant"], "weezing": ["bold", "impish"], "rhyhorn": ["impish", "relaxed", "adamant"], "rhydon": ["adamant", "impish"], "chansey": ["bold", "calm"], "tangela": ["bold", "modest"], "kangaskhan": ["adamant", "jolly"], "horsea": ["modest", "timid"], "seadra": ["modest", "timid"], "goldeen": ["adamant", "jolly"], "seaking": ["adamant", "jolly"], "staryu": ["modest", "timid"], "starmie": ["timid", "modest"], "mr-mime": ["timid", "modest"], "scyther": ["adamant", "jolly"], "jynx": ["timid", "modest"], "electabuzz": ["timid", "naive"], "magmar": ["modest", "timid", "naive"], "pinsir": ["adamant", "jolly"], "tauros": ["adamant", "jolly"], "magikarp": ["adamant", "jolly"], "gyarados": ["adamant", "jolly"], "lapras": ["modest", "calm"], "ditto": ["timid", "jolly", "bold", "calm"], "eevee": ["adamant", "jolly"], "vaporeon": ["bold", "calm", "modest"], "jolteon": ["timid", "modest"], "flareon": ["adamant"], "porygon": ["modest", "timid"], "omanyte": ["modest", "timid"], "omastar": ["modest", "timid"], "kabuto": ["adamant", "jolly"], "kabutops": ["adamant", "jolly"], "aerodactyl": ["jolly", "adamant"], "snorlax": ["adamant", "careful", "brave"], "articuno": ["timid", "calm"], "zapdos": ["timid", "bold", "modest"], "moltres": ["timid", "modest"], "dratini": ["adamant", "jolly"], "dragonair": ["adamant", "jolly"], "dragonite": ["adamant", "jolly"], "mewtwo": ["timid", "modest"], "mew": ["timid", "jolly", "bold", "calm"], "chikorita": ["calm", "careful", "bold"], "bayleef": ["calm", "careful", "bold"], "meganium": ["calm", "bold"], "cyndaquil": ["modest", "timid"], "quilava": ["modest", "timid"], "typhlosion": ["timid", "modest"], "totodile": ["adamant", "jolly"], "croconaw": ["adamant", "jolly"], "feraligatr": ["adamant", "jolly"], "sentret": ["adamant", "jolly"], "furret": ["adamant", "jolly"], "hoothoot": ["calm", "careful", "bold"], "noctowl": ["calm", "modest"], "ledyba": ["adamant", "jolly"], "ledian": ["adamant", "jolly"], "spinarak": ["adamant", "jolly"], "ariados": ["adamant", "jolly"], "crobat": ["jolly", "timid"], "chinchou": ["calm", "careful", "bold"], "lanturn": ["modest", "calm"], "pichu": ["modest", "timid"], "cleffa": ["calm", "careful", "bold"], "igglybuff": ["calm", "careful", "bold"], "togepi": ["calm", "careful", "bold"], "togetic": ["bold", "calm"], "natu": ["modest", "timid"], "xatu": ["timid", "bold"], "mareep": ["modest", "timid"], "flaaffy": ["modest", "timid"], "ampharos": ["modest", "quiet"], "bellossom": ["calm", "modest"], "marill": ["adamant", "jolly"], "azumarill": ["adamant"], "sudowoodo": ["impish", "relaxed", "adamant"], "politoed": ["bold", "calm"], "hoppip": ["adamant", "jolly"], "skiploom": ["adamant", "jolly"], "jumpluff": ["adamant", "jolly"], "aipom": ["adamant", "jolly"], "sunkern": ["modest", "timid"], "sunflora": ["modest", "quiet"], "yanma": ["modest", "timid"], "wooper": ["impish", "relaxed", "adamant"], "quagsire": ["relaxed"], "espeon": ["timid", "modest"], "umbreon": ["calm", "careful"], "murkrow": ["adamant", "jolly"], "slowking": ["calm", "quiet"], "misdreavus": ["timid", "modest"], "unown": ["modest", "timid"], "wobbuffet": ["bold", "calm"], "girafarig": ["timid"], "pineco": ["impish", "relaxed", "adamant"], "forretress": ["relaxed", "impish"], "dunsparce": ["impish", "relaxed", "adamant"], "gligar": ["impish", "jolly"], "steelix": ["impish", "relaxed"], "snubbull": ["adamant", "jolly"], "granbull": ["adamant", "impish"], "qwilfish": ["jolly", "impish"], "scizor": ["adamant"], "shuckle": ["bold", "impish"], "heracross": ["adamant", "jolly"], "sneasel": ["adamant", "jolly"], "teddiursa": ["adamant", "jolly"], "ursaring": ["adamant"], "slugma": ["modest", "timid"], "magcargo": ["bold", "modest"], "swinub": ["adamant", "jolly"], "piloswine": ["adamant"], "corsola": ["impish", "relaxed", "adamant"], "remoraid": ["modest", "timid"], "octillery": ["modest", "quiet"], "delibird": ["adamant", "jolly"], "mantine": ["calm"], "skarmory": ["impish", "bold"], "houndour": ["modest", "timid"], "houndoom": ["timid", "hasty"], "kingdra": ["modest", "adamant"], "phanpy": ["impish", "relaxed", "adamant"], "donphan": ["adamant", "impish"], "porygon2": ["bold", "calm"], "stantler": ["adamant", "jolly"], "smeargle": ["jolly", "timid"], "tyrogue": ["adamant", "jolly"], "hitmontop": ["adamant", "impish"], "smoochum": ["modest", "timid"], "elekid": ["adamant", "jolly"], "magby": ["naive", "hasty"], "miltank": ["impish", "careful"], "blissey": ["bold", "calm"], "raikou": ["timid", "modest"], "entei": ["adamant", "jolly"], "suicune": ["bold", "timid", "calm"], "larvitar": ["adamant", "jolly"], "pupitar": ["adamant", "jolly"], "tyranitar": ["adamant", "jolly"], "lugia": ["bold", "timid"], "ho-oh": ["adamant", "careful"], "celebi": ["timid", "bold", "modest"], "treecko": ["modest", "timid"], "grovyle": ["modest", "timid"], "sceptile": ["timid", "modest", "naive"], "torchic": ["adamant", "jolly"], "combusken": ["adamant", "jolly"], "blaziken": ["adamant", "jolly"], "mudkip": ["impish", "relaxed", "adamant"], "marshtomp": ["impish", "relaxed", "adamant"], "swampert": ["adamant", "relaxed"], "poochyena": ["adamant", "jolly"], "mightyena": ["adamant", "jolly"], "zigzagoon": ["adamant", "jolly"], "linoone": ["adamant", "jolly"], "wurmple": ["modest", "timid"], "silcoon": ["impish", "relaxed", "adamant"], "beautifly": ["modest", "timid"], "cascoon": ["impish", "relaxed", "adamant"], "dustox": ["calm", "careful", "bold"], "lotad": ["modest", "timid"], "lombre": ["modest", "timid"], "ludicolo": ["modest", "timid"], "seedot": ["adamant", "jolly"], "nuzleaf": ["adamant", "jolly"], "shiftry": ["adamant", "naughty"], "taillow": ["adamant", "jolly"], "swellow": ["jolly", "adamant"], "wingull": ["modest", "timid"], "pelipper": ["bold", "calm"], "ralts": ["modest", "timid"], "kirlia": ["modest", "timid"], "gardevoir": ["timid", "modest"], "surskit": ["modest", "timid"], "masquerain": ["timid", "modest"], "shroomish": ["adamant", "jolly"], "breloom": ["adamant", "jolly"], "slakoth": ["adamant", "jolly"], "vigoroth": ["adamant", "jolly"], "slaking": ["jolly", "adamant"], "nincada": ["adamant", "jolly"], "ninjask": ["jolly", "adamant"], "shedinja": ["adamant", "lonely"], "whismur": ["modest", "timid"], "loudred": ["modest", "timid"], "exploud": ["modest"], "makuhita": ["impish", "relaxed", "adamant"], "hariyama": ["adamant"], "azurill": ["adamant", "jolly"], "nosepass": ["impish", "relaxed", "adamant"], "skitty": ["adamant", "jolly"], "delcatty": ["adamant", "jolly"], "sableye": ["bold", "calm"], "mawile": ["adamant"], "aron": ["impish", "relaxed", "adamant"], "lairon": ["impish", "relaxed", "adamant"], "aggron": ["adamant"], "meditite": ["adamant", "jolly"], "medicham": ["jolly", "adamant"], "electrike": ["modest", "timid"], "manectric": ["timid", "modest"], "plusle": ["modest", "timid"], "minun": ["modest", "timid"], "volbeat": ["calm", "careful", "bold"], "illumise": ["calm", "careful", "bold"], "roselia": ["timid", "modest"], "gulpin": ["calm", "careful", "bold"], "swalot": ["calm", "bold"], "carvanha": ["adamant", "jolly"], "sharpedo": ["adamant", "jolly"], "wailmer": ["calm", "careful", "bold"], "wailord": ["modest", "calm"], "numel": ["naive", "hasty"], "camerupt": ["quiet", "modest"], "torkoal": ["bold", "relaxed"], "spoink": ["modest", "timid"], "grumpig": ["calm", "modest"], "spinda": ["adamant", "jolly"], "trapinch": ["adamant", "jolly"], "vibrava": ["adamant", "jolly"], "flygon": ["adamant", "jolly"], "cacnea": ["adamant", "jolly"], "cacturne": ["adamant", "mild"], "swablu": ["calm", "careful", "bold"], "altaria": ["careful", "adamant", "modest"], "zangoose": ["jolly", "adamant"], "seviper": ["modest", "adamant"], "lunatone": ["modest", "timid"], "solrock": ["impish", "relaxed", "adamant"], "barboach": ["impish", "relaxed", "adamant"], "whiscash": ["adamant"], "corphish": ["adamant", "jolly"], "crawdaunt": ["adamant"], "baltoy": ["calm", "careful", "bold"], "claydol": ["bold", "calm"], "lileep": ["calm", "careful", "bold"], "cradily": ["careful"], "anorith": ["adamant", "jolly"], "armaldo": ["adamant", "jolly"], "feebas": ["calm", "careful", "bold"], "milotic": ["bold", "calm"], "castform": ["modest", "timid"], "kecleon": ["adamant"], "shuppet": ["adamant", "jolly"], "banette": ["adamant", "jolly"], "duskull": ["calm", "careful", "bold"], "dusclops": ["bold", "calm"], "tropius": ["calm", "careful", "bold"], "chimecho": ["calm", "bold"], "absol": ["jolly", "adamant"], "wynaut": ["calm", "careful", "bold"], "snorunt": ["modest", "timid"], "glalie": ["jolly"], "spheal": ["calm", "careful", "bold"], "sealeo": ["calm", "careful", "bold"], "walrein": ["calm", "bold"], "clamperl": ["modest", "timid"], "huntail": ["adamant", "jolly"], "gorebyss": ["modest", "timid"], "relicanth": ["adamant"], "luvdisc": ["modest", "timid"], "bagon": ["adamant", "jolly"], "shelgon": ["impish", "relaxed", "adamant"], "salamence": ["jolly", "naive", "adamant", "timid"], "beldum": ["adamant", "jolly"], "metang": ["impish", "relaxed", "adamant"], "metagross": ["adamant", "jolly"], "regirock": ["impish", "careful"], "regice": ["calm", "modest"], "registeel": ["calm", "careful"], "latias": ["timid", "calm"], "latios": ["timid", "modest"], "kyogre": ["timid", "modest"], "groudon": ["adamant", "jolly"], "rayquaza": ["jolly", "naive", "adamant"], "jirachi": ["jolly", "timid"], "deoxys": ["timid", "naive", "hasty"], "turtwig": ["impish", "relaxed", "adamant"], "grotle": ["impish", "relaxed", "adamant"], "torterra": ["adamant", "impish"], "chimchar": ["naive", "hasty"], "monferno": ["naive", "hasty"], "infernape": ["naive", "jolly", "hasty", "timid"], "piplup": ["modest", "timid"], "prinplup": ["modest", "timid"], "empoleon": ["modest", "calm"], "starly": ["adamant", "jolly"], "staravia": ["adamant", "jolly"], "staraptor": ["jolly", "adamant"], "bidoof": ["impish", "relaxed", "adamant"], "bibarel": ["adamant"], "kricketot": ["adamant", "jolly"], "kricketune": ["adamant", "jolly"], "shinx": ["adamant", "jolly"], "luxio": ["adamant", "jolly"], "luxray": ["adamant", "jolly"], "budew": ["modest", "timid"], "roserade": ["timid", "modest"], "cranidos": ["adamant", "jolly"], "rampardos": ["jolly", "adamant"], "shieldon": ["impish", "relaxed", "adamant"], "bastiodon": ["impish", "careful"], "burmy": ["calm", "careful", "bold"], "wormadam": ["calm", "careful", "bold"], "mothim": ["modest", "timid"], "combee": ["calm", "careful", "bold"], "vespiquen": ["impish", "careful"], "pachirisu": ["impish"], "buizel": ["adamant", "jolly"], "floatzel": ["adamant", "jolly"], "cherubi": ["modest", "timid"], "cherrim": ["timid", "modest"], "shellos": ["calm", "careful", "bold"], "gastrodon": ["relaxed", "calm"], "ambipom": ["jolly"], "drifloon": ["modest", "timid"], "drifblim": ["modest", "timid"], "buneary": ["adamant", "jolly"], "lopunny": ["jolly"], "mismagius": ["timid"], "honchkrow": ["adamant"], "glameow": ["adamant", "jolly"], "purugly": ["adamant", "jolly"], "chingling": ["modest", "timid"], "stunky": ["adamant", "jolly"], "skuntank": ["adamant"], "bronzor": ["calm", "careful", "bold"], "bronzong": ["relaxed", "sassy"], "bonsly": ["impish", "relaxed", "adamant"], "mime-jr": ["modest", "timid"], "happiny": ["calm", "careful", "bold"], "chatot": ["modest", "timid"], "spiritomb": ["bold", "calm"], "gible": ["adamant", "jolly"], "gabite": ["adamant", "jolly"], "garchomp": ["jolly", "adamant"], "munchlax": ["calm", "careful", "bold"], "riolu": ["adamant", "jolly"], "lucario": ["jolly", "timid", "adamant"], "hippopotas": ["impish", "relaxed", "adamant"], "hippowdon": ["impish"], "skorupi": ["impish", "relaxed", "adamant"], "drapion": ["jolly", "adamant"], "croagunk": ["adamant", "jolly"], "toxicroak": ["jolly", "adamant"], "carnivine": ["adamant", "jolly"], "finneon": ["modest", "timid"], "lumineon": ["timid", "bold"], "mantyke": ["calm", "careful", "bold"], "snover": ["naive", "hasty"], "abomasnow": ["quiet"], "weavile": ["jolly"], "magnezone": ["modest", "timid"], "lickilicky": ["careful", "adamant"], "rhyperior": ["adamant"], "tangrowth": ["relaxed"], "electivire": ["jolly"], "magmortar": ["modest", "timid"], "togekiss": ["timid", "modest"], "yanmega": ["modest", "timid"], "leafeon": ["jolly", "adamant"], "glaceon": ["modest", "timid"], "gliscor": ["impish", "jolly"], "mamoswine": ["jolly", "adamant"], "porygon-z": ["timid"], "gallade": ["jolly", "adamant"], "probopass": ["bold", "calm"], "dusknoir": ["adamant", "impish"], "froslass": ["timid"], "rotom": ["bold", "timid", "calm", "modest"], "uxie": ["bold", "relaxed"], "mesprit": ["timid", "modest"], "azelf": ["timid", "jolly"], "dialga": ["modest", "timid"], "palkia": ["timid", "hasty"], "heatran": ["timid", "modest", "calm"], "regigigas": ["adamant", "jolly"], "giratina": ["bold", "impish", "modest"], "cresselia": ["bold", "calm"], "phione": ["modest", "timid"], "manaphy": ["timid"], "darkrai": ["timid"], "shaymin": ["timid"], "arceus": ["jolly", "timid", "adamant", "modest"], "snivy": ["modest", "timid"], "servine": ["modest", "timid"], "serperior": ["timid"], "tepig": ["adamant", "jolly"], "pignite": ["adamant", "jolly"], "emboar": ["adamant"], "oshawott": ["modest", "timid"], "dewott": ["modest", "timid"], "samurott": ["adamant", "modest"], "patrat": ["adamant", "jolly"], "watchog": ["adamant", "jolly"], "lillipup": ["adamant", "jolly"], "herdier": ["adamant", "jolly"], "stoutland": ["adamant"], "purrloin": ["adamant", "jolly"], "liepard": ["jolly"], "pansage": ["modest", "timid"], "simisage": ["modest", "timid"], "pansear": ["modest", "timid"], "simisear": ["modest", "timid"], "panpour": ["modest", "timid"], "simipour": ["modest", "timid"], "munna": ["calm", "careful", "bold"], "musharna": ["bold", "calm"], "pidove": ["adamant", "jolly"], "tranquill": ["adamant", "jolly"], "unfezant": ["adamant", "jolly"], "blitzle": ["modest", "timid"], "zebstrika": ["timid"], "roggenrola": ["impish", "relaxed", "adamant"], "boldore": ["impish", "relaxed", "adamant"], "gigalith": ["brave", "adamant"], "woobat": ["modest", "timid"], "swoobat": ["timid"], "drilbur": ["adamant", "jolly"], "excadrill": ["jolly", "adamant"], "audino": ["bold", "calm"], "timburr": ["adamant", "jolly"], "gurdurr": ["impish", "relaxed", "adamant"], "conkeldurr": ["adamant", "brave"], "tympole": ["modest", "timid"], "palpitoad": ["modest", "timid"], "seismitoad": ["modest", "relaxed"], "throh": ["careful"], "sawk": ["jolly"], "sewaddle": ["adamant", "jolly"], "swadloon": ["impish", "relaxed", "adamant"], "leavanny": ["jolly"], "venipede": ["adamant", "jolly"], "whirlipede": ["impish", "relaxed", "adamant"], "scolipede": ["jolly"], "cottonee": ["calm", "careful", "bold"], "whimsicott": ["timid"], "petilil": ["modest", "timid"], "lilligant": ["timid", "modest"], "basculin": ["jolly"], "sandile": ["adamant", "jolly"], "krokorok": ["adamant", "jolly"], "krookodile": ["jolly", "adamant"], "darumaka": ["adamant", "jolly"], "darmanitan": ["jolly", "adamant"], "maractus": ["modest", "timid"], "dwebble": ["impish", "relaxed", "adamant"], "crustle": ["adamant"], "scraggy": ["adamant", "jolly"], "scrafty": ["careful", "adamant"], "sigilyph": ["timid"], "yamask": ["impish", "relaxed", "adamant"], "cofagrigus": ["bold", "quiet"], "tirtouga": ["impish", "relaxed", "adamant"], "carracosta": ["adamant"], "archen": ["adamant", "jolly"], "archeops": ["jolly", "naive"], "trubbish": ["impish", "relaxed", "adamant"], "garbodor": ["impish"], "zorua": ["naive", "hasty"], "zoroark": ["timid", "naive"], "minccino": ["adamant", "jolly"], "cinccino": ["jolly"], "gothita": ["modest", "timid"], "gothorita": ["modest", "timid"], "gothitelle": ["calm"], "solosis": ["brave", "quiet", "relaxed", "sassy"], "duosion": ["brave", "quiet", "relaxed", "sassy"], "reuniclus": ["quiet", "bold"], "ducklett": ["modest", "timid"], "swanna": ["timid", "modest"], "vanillite": ["modest", "timid"], "vanillish": ["modest", "timid"], "vanilluxe": ["modest", "timid"], "deerling": ["adamant", "jolly"], "sawsbuck": ["jolly", "adamant"], "emolga": ["timid"], "karrablast": ["adamant", "jolly"], "escavalier": ["brave", "adamant"], "foongus": ["calm", "careful", "bold"], "amoonguss": ["calm", "bold"], "frillish": ["calm", "careful", "bold"], "jellicent": ["bold", "calm"], "alomomola": ["bold", "impish"], "joltik": ["modest", "timid"], "galvantula": ["timid"], "ferroseed": ["impish", "relaxed", "adamant"], "ferrothorn": ["relaxed", "sassy"], "klink": ["adamant", "jolly"], "klang": ["adamant", "jolly"], "klinklang": ["adamant"], "tynamo": ["modest", "timid"], "eelektrik": ["modest", "timid"], "eelektross": ["quiet", "modest", "adamant"], "elgyem": ["brave", "quiet", "relaxed", "sassy"], "beheeyem": ["quiet"], "litwick": ["modest", "timid"], "lampent": ["modest", "timid"], "chandelure": ["timid", "modest"], "axew": ["adamant", "jolly"], "fraxure": ["adamant", "jolly"], "haxorus": ["jolly", "adamant"], "cubchoo": ["adamant", "jolly"], "beartic": ["adamant"], "cryogonal": ["timid", "calm"], "shelmet": ["modest", "timid"], "accelgor": ["timid"], "stunfisk": ["bold", "calm"], "mienfoo": ["adamant", "jolly"], "mienshao": ["jolly", "naive"], "druddigon": ["adamant"], "golett": ["adamant", "jolly"], "golurk": ["adamant"], "pawniard": ["adamant", "jolly"], "bisharp": ["adamant", "jolly"], "bouffalant": ["adamant"], "rufflet": ["adamant", "jolly"], "braviary": ["jolly", "adamant"], "vullaby": ["impish", "relaxed", "adamant"], "mandibuzz": ["bold", "impish"], "heatmor": ["naive", "hasty"], "durant": ["jolly"], "deino": ["modest", "timid"], "zweilous": ["adamant", "jolly"], "hydreigon": ["timid", "modest"], "larvesta": ["modest", "timid"], "volcarona": ["timid", "modest"], "cobalion": ["jolly", "timid"], "terrakion": ["jolly", "adamant"], "virizion": ["jolly", "timid"], "tornadus": ["timid", "naive"], "thundurus": ["timid", "naive"], "reshiram": ["timid", "modest"], "zekrom": ["adamant", "jolly"], "landorus": ["jolly", "naive"], "kyurem": ["timid", "modest", "hasty"], "keldeo": ["timid", "modest"], "meloetta": ["timid", "modest", "naive"], "genesect": ["naive", "hasty", "timid"]};

    function evaluateCapturedCreature(caught) {
        if (!caught) return null;
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

        const bestList = BEST_NATURES_GEN1_TO_5[speciesId] || ["adamant", "jolly", "modest", "timid", "bold", "calm", "impish", "careful"];
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

        if (isShiny && b.masterball > 0) return "master-ball";

        if (botConfig.ball_priority === "force_highest") {
            if (b.ultraball > 0) return "ultra-ball";
            if (b.greatball > 0) return "great-ball";
            if (b.pokeball > 0) return "poke-ball";
            if (b.masterball > 0) return "master-ball";
            return null;
        }

        if (botConfig.ball_priority === "economy") {
            if (b.pokeball > 0) return "poke-ball";
            if (b.greatball > 0) return "great-ball";
            if (b.ultraball > 0) return "ultra-ball";
            if (b.masterball > 0) return "master-ball";
            return null;
        }

        if (foeHpPct <= 0.20 && b.ultraball > 0) return "ultra-ball";
        if (foeHpPct <= 0.35 && b.greatball > 0) return "great-ball";
        if (b.pokeball > 0) return "poke-ball";
        if (b.greatball > 0) return "great-ball";
        if (b.ultraball > 0) return "ultra-ball";
        if (b.masterball > 0) return "master-ball";

        return null;
    }

    function getTotalBalls() {
        const b = (inventory && inventory.ball) || {};
        return (b.pokeball || 0) + (b.greatball || 0) + (b.ultraball || 0) + (b.masterball || 0);
    }

    function selectBattleMove(foeTypes, foeHpPct, isCaptureTarget) {
        if (!battleMoves || battleMoves.length === 0) return null;

        const scoredMoves = battleMoves.map(m => {
            const basePower = m.power || 0;
            const eff = getTypeEffectiveness(m.type, foeTypes);
            const score = basePower * eff;
            return { ...m, eff, score };
        });

        if (botConfig.move_selection_mode === "first") {
            return scoredMoves[0];
        }

        if (isCaptureTarget && foeHpPct <= (botConfig.catch_hp_pct + 0.25)) {
            const damagingMoves = scoredMoves.filter(m => (m.power || 0) > 0);
            if (damagingMoves.length > 0) {
                damagingMoves.sort((a, b) => a.score - b.score);
                return damagingMoves[0];
            }
        }

        scoredMoves.sort((a, b) => b.score - a.score);
        return scoredMoves[0];
    }

    function updateInventory(data) {
        const items = Array.isArray(data) ? data : (data.items || []);
        const balls = { pokeball: 0, greatball: 0, ultraball: 0, masterball: 0 };
        const potions = { potion: 0, "super-potion": 0, "hyper-potion": 0, "max-potion": 0 };
        const revives = { revive: 0, "max-revive": 0 };
        let totalPotions = 0;

        for (const item of items) {
            if (!item) continue;
            const kind = String(item.kind || "").toLowerCase();
            const iid = String(item.id || item.itemId || "").toLowerCase();
            const qty = Number(item.quantity || item.qty || 1);

            if (kind.includes("ball") || iid.includes("ball")) {
                if (iid.includes("master")) balls.masterball += qty;
                else if (iid.includes("ultra")) balls.ultraball += qty;
                else if (iid.includes("great") || iid.includes("super-ball")) balls.greatball += qty;
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
            }
        }

        inventory = { ball: balls, potions, revives, potion: totalPotions };
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
                setTimeout(() => { sendEvent("map:preview", { mapId: currentMap }); }, 600);
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
                            silver: p.wallet.silver ?? p.wallet.coins ?? 0,
                            gold: p.wallet.gold ?? p.wallet.crystals ?? 0,
                            coins: p.wallet.silver ?? p.wallet.coins ?? 0,
                            crystals: p.wallet.gold ?? p.wallet.crystals ?? 0
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
            logEvent(`🗺️ Transição de mapa para: ${getMapFriendlyName(currentMap)}`, "info");
            setTimeout(() => { sendEvent("map:preview", { mapId: currentMap }); }, 300);
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
            }
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
            if (d.xp !== undefined) progress.xp = d.xp;
            if (d.wins !== undefined) progress.wins = d.wins;
            if (d.losses !== undefined) progress.losses = d.losses;
            if (d.captures !== undefined) progress.captures = d.captures;
            if (d.shinies !== undefined) progress.shinies = d.shinies;
            emitTelemetry();
        }

        // Wallet
        else if (t === "wallet") {
            if (d.silver !== undefined) wallet.silver = d.silver;
            if (d.gold !== undefined) wallet.gold = d.gold;
            if (d.coins !== undefined) wallet.coins = d.coins;
            else if (d.silver !== undefined) wallet.coins = d.silver;
            if (d.crystals !== undefined) wallet.crystals = d.crystals;
            else if (d.gold !== undefined) wallet.crystals = d.gold;
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
            if (d.canThrow !== undefined) canThrowBall = !!d.canThrow;
            if (d.canHeal !== undefined) canUsePotion = !!d.canHeal;
            if (d.canRevive !== undefined) canRevive = !!d.canRevive;
            battleWindowOpen = (d.open !== false);

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
            battleTurnTimer = setTimeout(() => {
                if (!inBattle || !botConfig.enabled || !currentBattleId || actionInFlight) return;
                if (isThrowBarOpen()) {
                    processBattleTurn();
                }
            }, 300);
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

            const victory = d.victory;
            const captured = d.captured;
            const foeName = (enemyMon && (enemyMon.name || enemyMon.species)) || "Criatura";

            if (captured) {
                if (d.caught) {
                    const evalData = evaluateCapturedCreature(d.caught);
                    if (evalData) {
                        lastCapturedMon = evalData;
                        const star = evalData.isShiny ? " ✨" : "";
                        const natMsg = evalData.isBestNature ? `Nature: ${evalData.nature} (⭐ TOP NATURE!)` : `Nature: ${evalData.nature}`;
                        const tierMsg = `IV: ${evalData.ivTotal}/186 (${evalData.ivPct}% - Grau ${evalData.grade})`;
                        logEvent(`🎉 [CAPTURA] ${evalData.name}${star} Lv${evalData.level}! ${natMsg}, ${tierMsg}`, evalData.grade === "S" ? "success" : "info");
                    } else {
                        logEvent(`✨ ${foeName} capturado com sucesso!`, "success");
                    }
                } else {
                    logEvent(`✨ ${foeName} capturado com sucesso!`, "success");
                }
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
        if (!mon || !mon.id || releasedCreatureIds.has(mon.id)) return;

        // Strict Safety Gate: Never release shiny, special event tiers, or locked creatures
        if (mon.isShiny || mon.shiny || (mon.eventTier && mon.eventTier > 0) || mon.isLocked) {
            return;
        }

        const stats = mon.stats || mon.ivs || {};
        const ivSum = (stats.hp || 0) + (stats.atk || 0) + (stats.def || 0) + 
                      (stats.spAtk || stats.spa || 0) + (stats.spDef || stats.spd || 0) + (stats.speed || stats.spe || 0);
        const ivPct = Math.round((ivSum / 186) * 100);

        const cutoffPct = botConfig.discard_iv_pct !== undefined ? botConfig.discard_iv_pct : 50;

        // Auto release low IV creatures via official creature:release protocol
        if (cutoffPct > 0 && ivPct < cutoffPct) {
            releasedCreatureIds.add(mon.id);
            sendEvent("creature:release", { creatureIds: [mon.id] });
            const speciesName = mon.species || mon.name || 'Criatura';
            logEvent(`🗑️ Liberação automática de ${speciesName} (IV: ${ivSum}/186 - ${ivPct}% < ${cutoffPct}%)`, "info");
        }
    }

    function checkOutOfBattleMaintenance() {
        if (!activeWs || activeWs.readyState !== WebSocket.OPEN || inBattle || !botConfig.enabled) return;

        // 1. Auto Revive in Overworld
        if (botConfig.use_revive_overworld && Array.isArray(team) && team.length > 0) {
            const faintedMember = team.find(m => m && (m.hp === 0 || m.isFainted));
            if (faintedMember) {
                const chosenRevive = getBestRevive();
                if (chosenRevive) {
                    logEvent(`💊 Revivendo ${faintedMember.name || 'Pokémon'} fora de combate com ${chosenRevive}...`, "info");
                    sendEvent("item:use", { itemId: chosenRevive, creatureId: faintedMember.id, quantity: 1 });
                    return;
                }
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
                logEvent(`🏥 Acionando Centro Pokémon para cura global da equipe (HP Equipe: ${Math.round(teamHpPct * 100)}%)...`, "info");
                sendEvent("heal:full", { creatureIds: team.map(m => m.id) });
            }
        }
    }

    
    // Check if the duel throw/combat bar is open and ready to accept turn input
    function isThrowBarOpen() {
        const throwBar = document.querySelector('.hud-throw-bar');
        if (!throwBar) {
            // Fallback: check if move buttons are mounted and enabled
            const enabledMoves = document.querySelectorAll('.hud-duel-moves button:not([disabled])');
            return enabledMoves.length > 0;
        }
        if (throwBar.classList.contains('hud-duel-waiting')) return false;
        return throwBar.hasAttribute('data-open') || !!document.querySelector('.hud-duel-moves button:not([disabled])');
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
        const foeSpecies = (enemyMon && (enemyMon.species || enemyMon.name)) || "";
        const isUncaught = foeSpecies ? !collection[foeSpecies] : false;

        // Determine if current wild foe qualifies for capture
        const foeSpeciesId = (enemyMon && (enemyMon.speciesId || foeSpecies.toLowerCase())) || "";

        // Determine if current wild foe qualifies for capture & area whitelist
        let isCaptureTarget = false;
        let shouldFleeUnselected = false;

        if (Array.isArray(botConfig.target_species) && botConfig.target_species.length > 0) {
            // Whitelist mode active for current area
            if (botConfig.target_species.includes(foeSpeciesId) || (isShiny && botConfig.catch_only_shiny)) {
                isCaptureTarget = true;
            } else {
                isCaptureTarget = false;
                if (botConfig.unselected_action === "flee") {
                    shouldFleeUnselected = true;
                }
            }
        } else {
            // General catch rules mode
            if (botConfig.catch_only_shiny) {
                isCaptureTarget = isShiny;
            } else if (botConfig.catch_only_uncaught) {
                isCaptureTarget = isUncaught;
            } else {
                isCaptureTarget = (botConfig.catch_hp_pct > 0);
            }
        }

        // Flee immediately if configured to flee from unselected species in this area
        if (shouldFleeUnselected) {
            logEvent(`🏃 Fugindo de ${foeSpecies} (${foeSpeciesId} não está na lista de alvos da área)...`, "info");
            executeBattleAction("battle:flee", { battleId: currentBattleId }, '.hud-throw-balls .hud-throw-flee:not([disabled])');
            return;
        }

        // Tactical Zero-Ball Strategy: Flee or farm XP if inventory has no balls
        const totalBalls = getTotalBalls();
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

        // 1. Flee emergency
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
                    // Potion button disabled or not rendered: fall through to attack
                    logEvent(`🧪 ${chosenPotion} não disponível no HUD neste turno...`, "info");
                }
            }
        }

        // 3. Catch wild creature with chosen ball
        if (isCaptureTarget && foeHpPct <= botConfig.catch_hp_pct && canThrowBall) {
            const chosenBall = getBestBall(foeHpPct, isShiny, isUncaught);
            if (chosenBall) {
                const ballSelector = `.hud-throw-balls button.hud-throw-ball[data-item-id="${chosenBall}"]:not([disabled]):not(.hud-throw-flee)`;
                const ballBtn = document.querySelector(ballSelector);
                if (ballBtn) {
                    logEvent(`🎯 Arremessando ${chosenBall} (HP Inimigo: ${Math.round(foeHpPct * 100)}%${isShiny ? ' ✨SHINY' : ''})`, "info");
                    executeBattleAction("battle:item", { battleId: currentBattleId, itemId: chosenBall }, ballSelector);
                    return;
                } else {
                    // Ball button disabled or not rendered: fall through to attack
                    logEvent(`🎯 ${chosenBall} não disponível para arremesso neste turno...`, "info");
                }
            }
        }

        // 4. Attack move with elemental type advantage & capture protection
        const foeTypes = (enemyMon && (enemyMon.types || enemyMon.type)) || [];
        const chosenMove = selectBattleMove(foeTypes, foeHpPct, isCaptureTarget);

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
        }, botConfig.roam_step_delay_ms || 300);
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
