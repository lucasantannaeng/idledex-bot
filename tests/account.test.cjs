const test = require('node:test');
const assert = require('node:assert/strict');
const { resetGameSession, googleAccountChooser } = require('../electron/account-session');

test('account reset closes game and OAuth pages before clearing only the game partition', async () => {
    const calls = [];
    const gameSession = {
        clearStorageData: async () => calls.push('storage'),
        clearAuthCache: async () => calls.push('auth'),
        closeAllConnections: async () => calls.push('connections'),
    };
    const contents = [
        { session: gameSession, once(_event, fn) { this.destroyed = fn; }, close() { calls.push('game-close'); setImmediate(this.destroyed); }, isDestroyed: () => false },
        { session: {}, close: () => { throw Error('dashboard must remain'); }, isDestroyed: () => false },
        { session: gameSession, once(_event, fn) { this.destroyed = fn; }, close() { calls.push('oauth-close'); setImmediate(this.destroyed); }, isDestroyed: () => false },
    ];
    await resetGameSession(gameSession, contents);
    assert.deepEqual(calls, ['game-close', 'oauth-close', 'storage', 'auth', 'connections']);
});

test('Google OAuth chooser preserves request parameters and does not touch unrelated URLs', () => {
    const url = new URL(googleAccountChooser('https://accounts.google.com/o/oauth2/v2/auth?client_id=test&state=opaque&prompt=consent&login_hint=old'));
    assert.equal(url.searchParams.get('prompt'), 'consent select_account');
    assert.equal(url.searchParams.get('state'), 'opaque');
    assert.equal(url.searchParams.has('login_hint'), false);
    assert.equal(googleAccountChooser(url.href), null, 'redirect must not loop');
    assert.equal(googleAccountChooser('https://example.com/o/oauth2/v2/auth?client_id=test'), null);
    assert.equal(googleAccountChooser('https://accounts.google.com/signin'), null);
});
