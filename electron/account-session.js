const { URL } = require('node:url');

async function resetGameSession(gameSession, contents) {
    // Close every page sharing this partition first, including OAuth popups.
    // This releases WebSockets and sessionStorage and prevents stale pages restoring cookies.
    await Promise.all(contents.filter(page => !page.isDestroyed() && page.session === gameSession).map(page => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Game page did not close')), 5000);
        page.once('destroyed', () => { clearTimeout(timer); resolve(); });
        page.close({ waitForBeforeUnload: false });
    })));
    await gameSession.clearStorageData();
    await gameSession.clearAuthCache();
    await gameSession.closeAllConnections();
}

function googleAccountChooser(address) {
    const url = new URL(address);
    if (url.protocol !== 'https:' || url.hostname !== 'accounts.google.com' ||
        !['/o/oauth2/auth', '/o/oauth2/v2/auth'].includes(url.pathname)) return null;
    // If the request already has an authenticated user (authuser), do NOT alter it or re-prompt!
    if (url.searchParams.has('authuser')) return null;
    const original = url.href;
    const prompts = (url.searchParams.get('prompt') || '').split(/\s+/).filter(p => p && p !== 'none');
    if (!prompts.includes('select_account')) prompts.push('select_account');
    url.searchParams.set('prompt', prompts.join(' '));
    url.searchParams.delete('login_hint');
    return url.href === original ? null : url.href;
}

module.exports = { resetGameSession, googleAccountChooser };
