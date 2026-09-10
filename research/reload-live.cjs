// Reload the local desktop dashboard only when its game is outside a battle.
async function main() {
    const targets = await (await fetch('http://localhost:9222/json/list')).json();
    const target = targets.find(t => t.type === 'page' && t.url.includes('/idledex-bot/dist-desktop/'));
    if (!target) throw new Error('Expected local desktop target is not open');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let id = 0;
    const pending = new Map();
    ws.onmessage = event => {
        const message = JSON.parse(event.data);
        if (pending.has(message.id)) {
            pending.get(message.id)(message);
            pending.delete(message.id);
        }
    };
    const call = (method, params = {}) => new Promise((resolve, reject) => {
        const requestId = ++id;
        const timer = setTimeout(() => reject(new Error('CDP timeout')), 10000);
        pending.set(requestId, response => { clearTimeout(timer); response.error ? reject(new Error(response.error.message)) : resolve(response.result); });
        ws.send(JSON.stringify({ id: requestId, method, params }));
    });
    try {
        const state = await call('Runtime.evaluate', { expression: 'Boolean(lastTelemetry && lastTelemetry.inBattle)', returnByValue: true });
        if (state.result.value) throw new Error('Battle active; reload deferred');
        await call('Page.reload', { ignoreCache: true });
        console.log('Local desktop reloaded outside battle');
    } finally { ws.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
