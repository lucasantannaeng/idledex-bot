// ==UserScript==
// @name         IdleDex Bot - Rotinas & Inventário
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  Automação de rotinas e gerenciamento de inventário para idleDEX
// @match        https://idledex.com/play*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    // Configurações do bot - altere conforme necessidade
    const CONFIG = {
        autoCatchEnabled: true,
        preferBall: 'pokeball',      // pokeball, greatball, ultraball
        fleeHpThreshold: 0.5,       // Fugir se HP do oponente > 50%
        catchHpThreshold: 0.3,      // Jogar bola se HP <= 30%
        autoClaimDailyQuests: true,
        autoHealOnFaint: true,
        discordWebhook: null,       // URL do webhook (opcional)
    };

    let gameState = {
        currentOpponent: null,
        opponentHpPercent: 0,
        isAutoHunting: false,
        lastEncounterTime: 0,
        inventory: {},
    };

    let activeSocket = null;
    const commandQueue = [];
    let isProcessingQueue = false;

    // ============== MONITORAMENTO ==============

    // Hook do WebSocket para interceptar eventos
    const OriginalWebSocket = window.WebSocket;
    window.WebSocket = function(...args) {
        const socket = new OriginalWebSocket(...args);
        activeSocket = socket;

        socket.addEventListener('message', handleIncomingMessage);
        socket.addEventListener('open', () => console.log('[IdleDex Bot] WS conectado'));
        socket.addEventListener('close', () => console.log('[IdleDex Bot] WS desconectado'));
        socket.addEventListener('error', (e) => console.error('[IdleDex Bot] WS erro:', e));

        return socket;
    };

    function handleIncomingMessage(event) {
        if (event.data instanceof ArrayBuffer) return; // Protocolo binário nativo

        try {
            const msg = JSON.parse(event.data);
            processMessage(msg);
        } catch (e) {
            // Não é JSON válido, ignora
        }
    }

    function processMessage(msg) {
        const type = msg.type || msg.event || '';

        switch (type) {
            case 'encounter':
                handleEncounter(msg);
                break;
            case 'battle_update':
            case 'damage':
                handleBattleUpdate(msg);
                break;
            case 'faint':
                handleFaint(msg);
                break;
            case 'catch_result':
                handleCatchResult(msg);
                break;
            case 'daily_quests':
                handleDailyQuests(msg);
                break;
            case 'inventory_update':
                handleInventoryUpdate(msg);
                break;
            case 'trade_offer':
                handleTradeOffer(msg);
                break;
            default:
                break;
        }
    }

    // ============== ROTINAS AUTOMÁTICAS ==============

    function handleEncounter(msg) {
        if (!CONFIG.autoCatchEnabled) return;

        gameState.currentOpponent = msg;
        gameState.opponentHpPercent = msg.hp_percent || 1.0;
        gameState.lastEncounterTime = Date.now();

        console.log(`[IdleDex Bot] Encontro: ${msg.species || 'Desconhecido'}`);

        // Auto-iniciar batalha se estiver em AUTO mode
        queueCommand({ type: 'battle_start', target: msg.id });
    }

    function handleBattleUpdate(msg) {
        if (msg.opponent_hp !== undefined) {
            const maxHp = msg.max_hp || 100;
            gameState.opponentHpPercent = msg.opponent_hp / maxHp;
        }

        // Decisão de fuga
        if (gameState.opponentHpPercent > CONFIG.fleeHpThreshold) {
            queueCommand({ type: 'flee' });
            return;
        }

        // Decisão de atacar ou usar poção
        if (msg.player_hp_percent < 0.3 && CONFIG.autoHealOnFaint) {
            queueCommand({ type: 'use_item', item: 'potion', target: 'player' });
        } else {
            queueCommand({ type: 'attack' });
        }
    }

    function handleFaint(msg) {
        console.log(`[IdleDex Bot] Oponente derrotado: ${msg.species || 'Desconhecido'}`);
        gameState.currentOpponent = null;
        gameState.opponentHpPercent = 0;

        // Aguardar próximo encontro automaticamente
        setTimeout(() => {
            queueCommand({ type: 'explore' });
        }, 1000);
    }

    function handleCatchResult(msg) {
        if (msg.success) {
            console.log(`[IdleDex Bot] ✨ Capturado: ${msg.species}`);
            notifyDiscord(`✅ Capturado: ${msg.species} (${msg.iv || 'N/A'} IV)`);
        } else {
            console.log(`[IdleDex Bot] Falha na captura: ${msg.species}`);
        }
        // Tentar novo encontro
        setTimeout(() => queueCommand({ type: 'explore' }), 500);
    }

    function handleDailyQuests(msg) {
        if (!CONFIG.autoClaimDailyQuests) return;

        const quests = msg.quests || [];
        for (const quest of quests) {
            if (quest.completed && !quest.claimed) {
                console.log(`[IdleDex Bot] Resgatando quest: ${quest.description}`);
                queueCommand({ type: 'claim_quest', questId: quest.id });
            }
        }
    }

    function handleInventoryUpdate(msg) {
        gameState.inventory = { ...gameState.inventory, ...msg.items };

        // Auto-vender duplicados se houver muitas repetições
        const duplicates = findDuplicates(msg.items || []);
        if (duplicates.length > 10) {
            console.log(`[IdleDex Bot] Vendendo ${duplicates.length} duplicatas`);
            queueCommand({ type: 'sell_duplicates', count: duplicates.length });
        }
    }

    function findDuplicates(items) {
        const counts = {};
        for (const item of items) {
            counts[item.id] = (counts[item.id] || 0) + 1;
        }
        return Object.entries(counts)
            .filter(([_, count]) => count > 2)
            .map(([id, count]) => ({ id, count: count - 2 }));
    }

    function handleTradeOffer(msg) {
        // Log de ofertas de trade (não automatiza por segurança)
        console.log(`[IdleDex Bot] Oferta de trade: ${msg.offer}`);
    }

    // ============== FILA DE COMANDOS ==============

    function queueCommand(cmd) {
        commandQueue.push(cmd);
        if (!isProcessingQueue) {
            processQueue();
        }
    }

    async function processQueue() {
        isProcessingQueue = true;

        while (commandQueue.length > 0) {
            const cmd = commandQueue.shift();
            await sendCommand(cmd);
            // Delay mínimo entre comandos para evitar rate limiting
            await delay(200);
        }

        isProcessingQueue = false;
    }

    function sendCommand(cmd) {
        if (!activeSocket || activeSocket.readyState !== WebSocket.OPEN) {
            console.warn('[IdleDex Bot] Socket indisponível para comando:', cmd.type);
            return Promise.resolve();
        }

        return new Promise((resolve) => {
            try {
                activeSocket.send(JSON.stringify(cmd));
                resolve();
            } catch (e) {
                console.error('[IdleDex Bot] Erro ao enviar comando:', e);
                resolve();
            }
        });
    }

    // ============== NOTIFICAÇÕES ==============

    function notifyDiscord(message) {
        if (!CONFIG.discordWebhook) return;

        fetch(CONFIG.discordWebhook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: message })
        }).catch(err => console.error('[IdleDex Bot] Erro no webhook:', err));
    }

    // ============== UTILITÁRIOS ==============

    function delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // Expor funções para debugging no console
    window.idleDexBot = {
        config: CONFIG,
        state: gameState,
        queue: commandQueue,
        sendCommand,
        notifyDiscord,
    };

    console.log('[IdleDex Bot] Carregado. Use window.idleDexBot para controles.');
})();
