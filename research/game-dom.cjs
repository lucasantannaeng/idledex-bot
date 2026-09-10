// Inspect or interact with the official game's DOM during local validation.
async function main() {
    const targets = await (await fetch('http://localhost:9222/json/list')).json();
    const target = targets.find(t => t.type === 'webview' && t.url === 'https://idledex.com/play');
    if (!target) throw new Error('Game not available');
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    const expression = process.argv[2] || `JSON.stringify([...document.querySelectorAll('button')].map(b=>({text:b.innerText,title:b.title,aria:b.getAttribute('aria-label')})))`;
    try {
        const response = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('CDP timeout')), 10000);
            socket.onmessage = event => {
                const message = JSON.parse(event.data);
                if (message.id === 1) { clearTimeout(timer); resolve(message); }
            };
            socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
        });
        if (response.error || response.result?.exceptionDetails) throw new Error(JSON.stringify(response));
        console.log(response.result.result.value);
    } finally { socket.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
