// Read-only diagnosis; excludes credentials, collection contents and personal identifiers.
async function main() {
    const targets = await (await fetch('http://localhost:9222/json/list')).json();
    for (const target of targets.filter(t => ['page', 'webview'].includes(t.type))) {
        const ws = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
        const expression = target.type === 'page'
            ? `JSON.stringify({title:document.title,telemetry:typeof lastTelemetry==='undefined'?null:lastTelemetry&&{connected:lastTelemetry.connected,inBattle:lastTelemetry.inBattle,currentMap:lastTelemetry.currentMap,playerPos:lastTelemetry.playerPos,enabled:lastTelemetry.config?.enabled,teamSize:lastTelemetry.team?.length,inventory:lastTelemetry.inventory,rank:lastTelemetry.progress?.rank,wallet:lastTelemetry.wallet,party:lastTelemetry.team?.map(m=>({hp:m.hp,maxHp:m.maxHp,level:m.level})),healthyBox:Object.values(lastTelemetry.collection||{}).filter(m=>m.teamSlot===null&&m.boxSlot!==null&&m.hp>0).length},configLoaded:typeof currentConfig!=='undefined'&&!!currentConfig})`
            : `JSON.stringify({title:document.title,ready:document.readyState,scripts:[...document.scripts].map(s=>s.src).filter(Boolean),battleButtons:document.querySelectorAll('.hud-throw-balls button').length})`;
        const result = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('CDP timeout')), 10000);
            ws.onmessage = event => {
                const data = JSON.parse(event.data);
                if (data.id === 1) { clearTimeout(timeout); resolve(data.result); }
            };
            ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
        });
        console.log(target.type, result.result?.value || result.exceptionDetails);
        ws.close();
    }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
