/**
 * IdleDex Desktop — Main Process
 * Manages native window, system tray, persistent session, and IPC communication.
 */

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, session, webContents } = require('electron');
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

const CONFIG_PATH = path.join(app.getPath('userData'), 'bot-config.json');

function loadConfig() {
    const defaults = {
        enabled: true,
        strategy_mode: 'balanced',
        iv_collection_threshold: 150,
        iv_sell_threshold: 120,
        flee_hp_pct: 0.30,
        potion_hp_pct: 0.35,
        potion_mode: 'smart',
        use_revive_battle: true,
        use_revive_overworld: true,
        auto_heal_center: true,
        catch_hp_pct: 0.50,
        catch_only_shiny: false,
        catch_only_uncaught: false,
        ball_priority: 'balanced',
        move_selection_mode: 'smart',
        target_species: [],
        unselected_action: 'battle',
        min_iv_alert: 130,
        discard_iv_pct: 50,
        pause_on_no_balls: true,
        roam_step_delay_ms: 300,
        auto_idle: true,
        auto_roam: true,
        auto_claim_dailies: true,
        auto_lock_valuable: true,
        auto_use_boosts: false,
        auto_npc_quests: true,
        auto_travel_deliveries: true,
        auto_travel_surplus_threshold: 5,
        close_to_tray: false,
    };
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
            if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
                return { ...defaults, ...saved };
            }
        }
    } catch (e) {}
    return defaults;
}

function saveConfig(cfg) {
    try {
        if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return false;
        fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
        const temporaryPath = CONFIG_PATH + '.tmp';
        fs.writeFileSync(temporaryPath, JSON.stringify(cfg, null, 4), 'utf-8');
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

// IPC Handlers
ipcMain.handle('get-config', () => {
    return loadConfig();
});

ipcMain.handle('save-config', (event, cfg) => {
    return saveConfig(cfg);
});

let switchingAccount = false;
ipcMain.handle('switch-account', async event => {
    if (!mainWindow || event.sender !== mainWindow.webContents ||
        event.senderFrame !== mainWindow.webContents.mainFrame || switchingAccount) return { ok: false };
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

ipcMain.on('minimize-to-tray', () => {
    if (mainWindow) {
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

ipcMain.on('toggle-fullscreen', () => {
    if (mainWindow) {
        mainWindow.setFullScreen(!mainWindow.isFullScreen());
    }
});

// App lifecycle
app.whenReady().then(() => {
    if (!ownsInstance) return;
    session.fromPartition('persist:idledex').webRequest.onBeforeRequest(
        { urls: ['https://accounts.google.com/o/oauth2/*'] },
        (details, callback) => {
            const redirectURL = googleAccountChooser(details.url);
            callback(redirectURL ? { redirectURL } : {});
        },
    );
    // Force preload on ALL webviews from main process — guaranteed to run
    // before the webview loads, eliminating JS-based race conditions
    app.on('web-contents-created', (event, contents) => {
        contents.on('will-attach-webview', (event, webPreferences, params) => {
            const gamePreload = path.join(__dirname, 'preload-game.js');
            console.log('[MAIN] will-attach-webview fired');
            console.log('[MAIN] Forcing preload to:', gamePreload);
            console.log('[MAIN] File exists:', fs.existsSync(gamePreload));
            
            // Force preload via webPreferences (overrides HTML attribute)
            webPreferences.preload = gamePreload;
            webPreferences.contextIsolation = false;
            webPreferences.sandbox = false;
            
            // Ensure no preloadURL from HTML attribute conflicts
            delete webPreferences.preloadURL;
        });

        // Forward webview guest console messages to stdout for debugging
        contents.on('did-attach-webview', (event, webContents) => {
            console.log('[MAIN] did-attach-webview: guest attached');
            webContents.on('console-message', (ev, level, msg) => {
                const lvl = ['V','I','W','E'][level] || '?';
                console.log(`[GUEST ${lvl}] ${msg}`);
            });
        });
    });

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
