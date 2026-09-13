/**
 * IdleDex Desktop — Main Process
 * Manages native window, system tray, persistent session, and IPC communication.
 */

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, session, webContents, powerMonitor } = require('electron');
const { resetGameSession, googleAccountChooser } = require('./account-session');
const path = require('path');
const fs = require('fs');

// Explicit opt-in for local diagnostics; normal launches expose no debug port.
if (process.argv.includes('--inspect-bot') || process.env.IDLEDEX_DEBUG === '1') {
    app.commandLine.appendSwitch('remote-debugging-port', '9222');
}

let mainWindow = null;
let tray = null;
let isQuitting = false;

const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
    }
});

const { SCHEMA_VERSION, DEFAULT_CONFIG, normalizeConfig } = require('./config-schema');
const CONFIG_PATH = path.join(app.getPath('userData'), 'bot-config.json');

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            let saved;
            try {
                saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
            } catch (parseErr) {
                console.error('[CONFIG] Arquivo bot-config.json corrompido, adotando configuração segura padrão:', parseErr.message);
                return normalizeConfig(DEFAULT_CONFIG);
            }
            if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
                if (typeof saved.schemaVersion === 'number' && saved.schemaVersion > SCHEMA_VERSION) {
                    console.warn(`[CONFIG] Arquivo com versão futura de schema (${saved.schemaVersion} > ${SCHEMA_VERSION}); carregando sem sobrescrever.`);
                }
                return normalizeConfig(saved);
            }
        }
    } catch (e) {
        console.error('[CONFIG] Erro ao carregar configuração:', e.message);
    }
    return normalizeConfig(DEFAULT_CONFIG);
}

function saveConfig(cfg) {
    try {
        if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return false;
        if (fs.existsSync(CONFIG_PATH)) {
            try {
                const existing = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
                if (existing && typeof existing.schemaVersion === 'number' && existing.schemaVersion > SCHEMA_VERSION) {
                    console.error(`[CONFIG] Tentativa de salvar bloqueada: arquivo possui versão futura de schema (${existing.schemaVersion} > ${SCHEMA_VERSION}).`);
                    return false;
                }
            } catch (e) {}
        }
        const normalized = normalizeConfig(cfg);
        fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
        const temporaryPath = CONFIG_PATH + '.tmp';
        fs.writeFileSync(temporaryPath, JSON.stringify(normalized, null, 4), 'utf-8');
        fs.renameSync(temporaryPath, CONFIG_PATH);
        return true;
    } catch (e) {
        return false;
    }
}

function getWindowIcon() {
    const candidates = [
        path.join(__dirname, 'icon.png'),
        path.join(__dirname, 'icon.ico'),
        path.join(__dirname, '../build/icon.png'),
        path.join(__dirname, '../app/icon.png')
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    return undefined;
}

function getTrayIcon() {
    const candidates = [
        path.join(__dirname, 'tray-icon.ico'),
        path.join(__dirname, 'tray-icon.png'),
        path.join(__dirname, 'icon.ico'),
        path.join(__dirname, 'icon.png'),
        path.join(__dirname, '../build/icon.ico'),
        path.join(__dirname, '../app/icon.png')
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) {
            const img = nativeImage.createFromPath(p);
            if (!img.isEmpty()) return img;
        }
    }
    return null;
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1480,
        height: 920,
        minWidth: 1040,
        minHeight: 700,
        title: 'IdleDex Desktop',
        icon: getWindowIcon(),
        backgroundColor: '#0a0e17',
        autoHideMenuBar: true,
        show: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false,
            webviewTag: true,
            preload: path.join(__dirname, 'preload-dashboard.js'),
            backgroundThrottling: false, // Prevents background freezing
        }
    });

    mainWindow.loadFile(path.join(__dirname, '../app/index.html'));

    // Restrict navigation of the main window strictly to local files
    mainWindow.webContents.on('will-navigate', (event, url) => {
        try {
            const parsed = new URL(url);
            if (parsed.protocol !== 'file:') {
                event.preventDefault();
            }
        } catch (_) {
            event.preventDefault();
        }
    });

    // Deny popup creation from main dashboard window
    mainWindow.webContents.setWindowOpenHandler(() => {
        return { action: 'deny' };
    });

    // Force window to appear visibly in foreground on user desktop
    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
        mainWindow.focus();
        mainWindow.setAlwaysOnTop(true);
        setTimeout(() => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.setAlwaysOnTop(false);
            }
        }, 1200);
    });

    setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.show();
            mainWindow.focus();
        }
    }, 500);

    // Forward ALL renderer console messages to stdout for diagnosis
    mainWindow.webContents.on('console-message', (event, level, msg, line, sourceId) => {
        const lvl = ['V','I','W','E'][level] || '?';
        console.log(`[HOST ${lvl}] ${msg}`);
    });

    mainWindow.on('close', (event) => {
        if (isQuitting) return;
        const cfg = loadConfig();
        if (cfg.close_to_tray) {
            event.preventDefault();
            mainWindow.hide();
            if (tray && typeof tray.displayBalloon === 'function') {
                try {
                    tray.displayBalloon({
                        title: 'IdleDex Desktop',
                        content: 'O aplicativo continua executando em segundo plano na bandeja.',
                        iconType: 'info'
                    });
                } catch (_) {}
            }
        } else {
            isQuitting = true;
            if (tray && !tray.isDestroyed()) {
                tray.destroy();
                tray = null;
            }
            app.quit();
        }
    });
}

function createTray() {
    try {
        const icon = getTrayIcon();
        if (!icon) {
            console.warn('[MAIN] No valid tray icon found on disk.');
            return;
        }

        tray = new Tray(icon);
        tray.setToolTip('IdleDex Desktop Suite');

        const contextMenu = Menu.buildFromTemplate([
            { label: 'Exibir IdleDex Desktop', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
            { label: 'Alternar Bot (Ligar / Pausar)', click: () => { if (mainWindow) mainWindow.webContents.send('toggle-bot-tray'); } },
            { type: 'separator' },
            { label: 'Sair Completamente', click: () => { isQuitting = true; app.quit(); } }
        ]);

        tray.setContextMenu(contextMenu);
        tray.on('click', () => {
            if (mainWindow) {
                if (mainWindow.isMinimized()) mainWindow.restore();
                mainWindow.show();
                mainWindow.focus();
            }
        });
        tray.on('double-click', () => {
            if (mainWindow) {
                if (mainWindow.isMinimized()) mainWindow.restore();
                mainWindow.show();
                mainWindow.focus();
            }
        });
    } catch (e) {
        console.warn('[MAIN] Tray initialization skipped:', e.message);
    }
}

// Security Validation Helpers (T02)
function isAuthorizedSender(event) {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    if (!event || !event.sender || !event.senderFrame) return false;
    if (event.sender !== mainWindow.webContents) return false;
    if (event.senderFrame !== mainWindow.webContents.mainFrame) return false;
    return true;
}

function isAllowedGuestUrl(rawUrl) {
    if (!rawUrl || rawUrl === 'about:blank') return true;
    try {
        const u = new URL(rawUrl);
        if (u.protocol !== 'https:') return false;
        if (u.hostname === 'idledex.com') return true;
        if (u.hostname === 'accounts.google.com') return true;
        return false;
    } catch (_) {
        return false;
    }
}

function configureSessionPermissions(ses) {
    if (!ses) return;
    if (typeof ses.setPermissionRequestHandler === 'function') {
        ses.setPermissionRequestHandler((wc, permission, callback) => {
            callback(false);
        });
    }
    if (typeof ses.setPermissionCheckHandler === 'function') {
        ses.setPermissionCheckHandler(() => {
            return false;
        });
    }
}

function sanitizeLogMessage(msg) {
    return String(msg || '')
        .replace(/(session_token|ws_token|token|key|cookie)=([a-zA-Z0-9_\-\.]+)/gi, '$1=[REDACTED]')
        .replace(/(Bearer\s+)[a-zA-Z0-9_\-\.]+/gi, '$1[REDACTED]');
}

// IPC Handlers
ipcMain.handle('get-config', (event) => {
    if (!isAuthorizedSender(event)) return null;
    return loadConfig();
});

ipcMain.handle('save-config', (event, cfg) => {
    if (!isAuthorizedSender(event)) return false;
    return saveConfig(cfg);
});

let switchingAccount = false;
ipcMain.handle('switch-account', async (event) => {
    if (!isAuthorizedSender(event) || switchingAccount) return { ok: false };
    switchingAccount = true;
    try {
        if (!saveConfig({ ...loadConfig(), enabled: false })) throw new Error('Could not save paused state');
        await resetGameSession(session.fromPartition('persist:idledex'), webContents.getAllWebContents());
        return { ok: true };
    } catch (error) {
        return { ok: false };
    } finally {
        switchingAccount = false;
    }
});

ipcMain.on('minimize-to-tray', (event) => {
    if (!isAuthorizedSender(event)) return;
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.hide();
        if (tray && typeof tray.displayBalloon === 'function') {
            try {
                tray.displayBalloon({
                    title: 'IdleDex Desktop',
                    content: 'O aplicativo continua executando em segundo plano na bandeja.',
                    iconType: 'info'
                });
            } catch (_) {}
        }
    }
});

ipcMain.on('toggle-fullscreen', (event) => {
    if (!isAuthorizedSender(event)) return;
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setFullScreen(!mainWindow.isFullScreen());
    }
});

// App lifecycle
app.whenReady().then(() => {
    if (!ownsInstance) return;

    // Deny permissions by default across sessions
    configureSessionPermissions(session.defaultSession);
    const gameSession = session.fromPartition('persist:idledex');
    configureSessionPermissions(gameSession);

    gameSession.webRequest.onBeforeRequest(
        { urls: ['https://accounts.google.com/o/oauth2/*'] },
        (details, callback) => {
            const redirectURL = googleAccountChooser(details.url);
            callback(redirectURL ? { redirectURL } : {});
        },
    );

    app.on('web-contents-created', (event, contents) => {
        contents.on('will-attach-webview', (attachEvent, webPreferences, params) => {
            // Verify attachment owner is the authorized mainWindow
            if (!mainWindow || mainWindow.isDestroyed() || contents !== mainWindow.webContents) {
                attachEvent.preventDefault();
                return;
            }
            // Verify partition matches persist:idledex
            if (params.partition !== 'persist:idledex') {
                attachEvent.preventDefault();
                return;
            }
            // Verify src is allowed idledex URL or empty/about:blank
            if (params.src && !isAllowedGuestUrl(params.src)) {
                attachEvent.preventDefault();
                return;
            }

            const gamePreload = path.join(__dirname, 'preload-game.js');
            webPreferences.preload = gamePreload;
            webPreferences.contextIsolation = false;
            webPreferences.sandbox = false;
            delete webPreferences.preloadURL;
        });

        // Forward webview guest console messages and secure guest navigation
        contents.on('did-attach-webview', (attachEvent, guestContents) => {
            guestContents.on('will-navigate', (navEvent, url) => {
                if (!isAllowedGuestUrl(url)) {
                    navEvent.preventDefault();
                }
            });
            guestContents.on('will-redirect', (redirEvent, url) => {
                if (!isAllowedGuestUrl(url)) {
                    redirEvent.preventDefault();
                }
            });
            guestContents.setWindowOpenHandler(({ url }) => {
                if (isAllowedGuestUrl(url)) {
                    return {
                        action: 'allow',
                        overrideBrowserWindowOptions: {
                            webPreferences: {
                                partition: 'persist:idledex',
                            }
                        }
                    };
                }
                return { action: 'deny' };
            });

            guestContents.on('console-message', (ev, level, msg) => {
                const lvl = ['V','I','W','E'][level] || '?';
                console.log(`[GUEST ${lvl}] ${sanitizeLogMessage(msg)}`);
            });

            let guestCrashCount = 0;
            guestContents.on('render-process-gone', (event, details) => {
                const reason = details?.reason || 'unknown';
                const exitCode = details?.exitCode ?? -1;
                console.warn(`[MAIN] Webview guest render-process-gone: reason=${reason}, exitCode=${exitCode}`);
                try {
                    const cfg = loadConfig();
                    if (cfg && cfg.enabled) {
                        cfg.enabled = false;
                        saveConfig(cfg);
                    }
                } catch (_) {}
                if (guestCrashCount < 3) {
                    guestCrashCount++;
                    console.log(`[MAIN] Tentando recuperar webview (tentativa ${guestCrashCount}/3)...`);
                    setTimeout(() => {
                        if (!guestContents.isDestroyed()) {
                            guestContents.reload();
                        }
                    }, 2000);
                } else {
                    console.error('[MAIN] Limite de recuperação de renderizador excedido (3 tentativas). Webview suspenso.');
                }
            });

            guestContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
                if (errorCode === -3) return; // ignore ABORTED
                const sanitizedUrl = String(validatedURL || '').split('?')[0];
                console.warn(`[MAIN] Webview did-fail-load: code=${errorCode} (${errorDescription}) em ${sanitizedUrl}`);
            });
        });
    });

    if (typeof powerMonitor !== 'undefined' && powerMonitor && typeof powerMonitor.on === 'function') {
        powerMonitor.on('suspend', () => {
            console.log('[MAIN] Sistema entrando em suspensão. Pausando bot para segurança.');
            try {
                const cfg = loadConfig();
                if (cfg && cfg.enabled) {
                    cfg.enabled = false;
                    saveConfig(cfg);
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('host-command', { cmd: 'toggle-bot', payload: { enabled: false } });
                    }
                }
            } catch (_) {}
        });
        powerMonitor.on('resume', () => {
            console.log('[MAIN] Sistema retornou da suspensão. Estado permanece pausado para segurança.');
        });
    }

    createWindow();
    createTray();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
        else mainWindow.show();
    });
});

app.on('before-quit', () => {
    isQuitting = true;
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        loadConfig,
        saveConfig,
        isAuthorizedSender,
        isAllowedGuestUrl,
        configureSessionPermissions,
        sanitizeLogMessage,
        getMainWindow: () => mainWindow,
        setMainWindowForTesting: (win) => { mainWindow = win; },
    };
}
