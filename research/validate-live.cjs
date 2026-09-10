const fs = require('node:fs');
const path = require('node:path');
async function connect(target, observe = () => {}) {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let id = 0;
    const pending = new Map();
    ws.onmessage = event => {
        const message = JSON.parse(event.data);
        if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
        else observe(message);
    };
    return { close: () => ws.close(), call: (method, params = {}) => new Promise((resolve, reject) => {
        const requestId = ++id;
        const timer = setTimeout(() => reject(new Error('CDP timeout')), 10000);
        pending.set(requestId, response => { clearTimeout(timer); response.error ? reject(new Error(response.error.message)) : resolve(response.result); });
        ws.send(JSON.stringify({ id: requestId, method, params }));
    }) };
}
async function main() {
    const targets = await (await fetch('http://localhost:9222/json/list')).json();
    const host = targets.find(t => t.type === 'page' && t.url.includes('/idledex-bot/dist-desktop/'));
    const game = targets.find(t => t.type === 'webview' && t.url === 'https://idledex.com/play');
    if (!host || !game) throw new Error('Desktop game not ready');
    const report = { startedAt: new Date().toISOString(), sent: {}, received: {}, errors: [], moves: [], lab: [], samples: [] };
    const guest = await connect(game, message => {
        const direction = message.method === 'Network.webSocketFrameSent' ? 'sent' : message.method === 'Network.webSocketFrameReceived' ? 'received' : null;
        if (!direction || message.params.response.opcode !== 1) return;
        try {
            const packet = JSON.parse(message.params.response.payloadData);
            if (!packet.t) return;
            report[direction][packet.t] = (report[direction][packet.t] || 0) + 1;
            if (['map:travel','map:change','professor:state','professor:deliver','lab:npcs'].includes(packet.t)) report.lab.push({direction,t:packet.t,d:packet.d});
            if (direction === 'sent' && packet.t === 'move') report.moves.push({ n: packet.d?.n, dir: packet.d?.dir });
            if (direction === 'received' && packet.t === 'error') report.errors.push({ code: packet.d?.code ?? packet.code });
        } catch {}
    });
    const dashboard = await connect(host);
    const evaluate = async expression => {
        const result = await dashboard.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
        return result.result?.value;
    };
    let changed = false;
    try {
        await guest.call('Network.enable');
        await evaluate(`(()=>{if(!lastTelemetry?.connected||lastTelemetry.inBattle)throw new Error('Game not idle');
            window.__validationConfig=structuredClone(lastTelemetry.config);
            gameView.send('host-command',{cmd:'update-config',payload:{...window.__validationConfig,enabled:true,auto_idle:false,auto_npc_quests:${process.argv.includes('--lab')},auto_travel_deliveries:${process.argv.includes('--lab')},auto_route_switch:false,auto_claim_dailies:${process.argv.includes('--rewards')},auto_roam:${!process.argv.includes('--rewards') && !process.argv.includes('--lab')},auto_use_boosts:false,discard_iv_pct:0,...${process.argv.includes('--capture') ? '{target_species:[],catch_only_shiny:false,catch_only_uncaught:false,catch_hp_pct:1,flee_hp_pct:0.05,potion_hp_pct:0.6}' : '{}'}}});return true;})()`);
        changed = true;
        if (process.argv.includes('--lab')) await evaluate("gameView.send('host-command',{cmd:'manual-action',payload:{action:'trigger-auto-travel'}})");
        for (let sample = 0; sample < 15; sample++) {
            await new Promise(resolve => setTimeout(resolve, 2000));
            report.samples.push(await evaluate(`(()=>{const t=lastTelemetry;return {connected:t?.connected,inBattle:t?.inBattle,map:t?.currentMap,pos:t?.playerPos,enabled:t?.config?.enabled,onGrass:t?.onGrass,autoTravel:t?.autoTravel,captures:t?.sessionMetrics?.sessionCaptures,party:t?.team?.map(m=>({hp:m.hp,maxHp:m.maxHp})),silver:t?.wallet?.silver}})()`));
        }
    } finally {
        if (changed) await evaluate(`(()=>{gameView.send('host-command',{cmd:'update-config',payload:window.__validationConfig});delete window.__validationConfig;return true;})()`);
        guest.close(); dashboard.close();
        report.finishedAt = new Date().toISOString();
        fs.writeFileSync(path.join(__dirname, process.argv.includes('--lab') ? 'live-validation-lab.json' : 'live-validation.json'), JSON.stringify(report, null, 2));
    }
    console.log(JSON.stringify({sent:report.sent,received:report.received,errors:report.errors,first:report.samples[0],last:report.samples.at(-1)}));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
