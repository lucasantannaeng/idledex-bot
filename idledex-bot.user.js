// ==UserScript==
// @name         IdleDex Bot - Protocol-Level In-Browser Automation
// @namespace    http://tampermonkey.net/
// @version      2.0.0
// @description  Automação em tempo real diretamente dentro da aba do navegador para idleDEX sem risco de desconexão.
// @match        https://idledex.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    console.log("[IdleDex Bot] Injetando motor de automação v2.0...");

    const CONFIG = {
        enabled: true,
        autoBattle: true,
        autoCatch: true,
        catchHpPct: 0.40,
        preferredBall: 'poke-ball', // 'poke-ball', 'great-ball', 'ultra-ball'
        autoIdle: true,
        autoClaim: true,
    };

    let activeSocket = null;
    let inBattle = false;

    // 1. Hook WebSocket to capture game connection
    const OrigWebSocket = window.WebSocket;
    window.WebSocket = function(...args) {
        const ws = new OrigWebSocket(...args);
        activeSocket = ws;

        ws.addEventListener('message', (e) => {
            if (typeof e.data !== 'string') return;
            try {
                const msg = JSON.parse(e.data);
                handleGamePacket(msg);
            } catch (err) {}
        });

        ws.addEventListener('open', () => {
            console.log("[IdleDex Bot] WebSocket do jogo conectado e interceptado!");
            updateHudStatus("Conectado");
        });

        ws.addEventListener('close', () => {
            console.log("[IdleDex Bot] WebSocket fechado.");
            updateHudStatus("Desconectado");
        });

        return ws;
    };

    function sendEvent(t, d) {
        if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
            const payload = { t };
            if (d !== undefined) payload.d = d;
            activeSocket.send(JSON.stringify(payload));
        }
    }

    // 2. Handle incoming game packets
    function handleGamePacket(msg) {
        if (!CONFIG.enabled) return;

        const t = msg.t || msg.type;
        const d = msg.d || msg;

        // Combat Turn
        if (t === "battle:turn" || t === "battle:control") {
            inBattle = true;
            const opp = d.opponent || {};
            const oppHp = opp.hpPercent !== undefined ? opp.hpPercent : 1.0;
            const oppName = opp.name || opp.species || "Criatura";

            console.log(`[IdleDex Bot] Batalha ativa vs ${oppName} (HP: ${Math.round(oppHp * 100)}%)`);
            updateHudStatus(`Batalhando: ${oppName} (${Math.round(oppHp * 100)}%)`);

            setTimeout(() => {
                if (!CONFIG.enabled || !inBattle) return;
                // Capture if weak
                if (CONFIG.autoCatch && oppHp <= CONFIG.catchHpPct) {
                    console.log(`[IdleDex Bot] Lançando ${CONFIG.preferredBall}...`);
                    sendEvent("capture:throw", { ballId: CONFIG.preferredBall });
                } else if (CONFIG.autoBattle) {
                    sendEvent("battle:move", { moveIndex: 0 });
                }
            }, 300);
        }

        // Combat Finished
        else if (t === "battle:end") {
            inBattle = false;
            const victory = d.victory;
            const captured = d.captured;
            const outcome = captured ? "✨ Capturado!" : (victory ? "⚔️ Vitória!" : "💀 Derrota");
            console.log(`[IdleDex Bot] ${outcome}`);
            updateHudStatus(outcome);

            if (CONFIG.autoIdle) {
                setTimeout(() => {
                    sendEvent("idle:start");
                }, 1000);
            }
        }

        // Daily quests & rewards
        else if (t === "daily:list" && CONFIG.autoClaim) {
            const quests = d.quests || [];
            for (const q of quests) {
                if (q.completed && !q.claimed) {
                    console.log(`[IdleDex Bot] Resgatando missão: ${q.title || q.id}`);
                    sendEvent("daily:claim", { questId: q.id });
                }
            }
            sendEvent("pokedex:claim-all");
            sendEvent("gamepass:claim-all");
        }
    }

    // 3. Floating In-Game HUD
    function createHud() {
        const hud = document.createElement('div');
        hud.id = 'idledex-bot-hud';
        hud.style.cssText = `
            position: fixed;
            bottom: 20px;
            right: 20px;
            background: #0f172a;
            border: 1px solid #06b6d4;
            color: #f8fafc;
            padding: 10px 14px;
            border-radius: 8px;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace;
            font-size: 12px;
            z-index: 999999;
            box-shadow: 0 4px 16px rgba(0,0,0,0.6);
            display: flex;
            flex-direction: column;
            gap: 6px;
        `;

        hud.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center; gap:12px;">
                <b style="color:#06b6d4;">🤖 IdleDex Bot v2.0</b>
                <button id="idledex-bot-toggle" style="background:#06b6d4; color:#0f172a; border:none; padding:2px 8px; border-radius:4px; font-weight:bold; cursor:pointer;">LIGADO</button>
            </div>
            <div id="idledex-bot-status" style="color:#94a3b8; font-size:11px;">Aguardando WebSocket...</div>
        `;

        document.body.appendChild(hud);

        const btn = document.getElementById('idledex-bot-toggle');
        btn.addEventListener('click', () => {
            CONFIG.enabled = !CONFIG.enabled;
            btn.textContent = CONFIG.enabled ? 'LIGADO' : 'PAUSADO';
            btn.style.background = CONFIG.enabled ? '#06b6d4' : '#64748b';
            updateHudStatus(CONFIG.enabled ? 'Bot Ativo' : 'Pausado');
        });
    }

    function updateHudStatus(text) {
        const el = document.getElementById('idledex-bot-status');
        if (el) el.textContent = text;
    }

    window.addEventListener('DOMContentLoaded', createHud);
})();
