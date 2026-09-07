/**
 * IdleDex Desktop — Main Process
 * Manages native window, system tray, persistent session, and IPC communication.
 */

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow = null;
let tray = null;
let isQuitting = false;

const CONFIG_PATH = path.join(app.getPath('userData'), 'bot-config.json');

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
        }
    } catch (e) {}
    return {
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
    };
}

function saveConfig(cfg) {
    try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 4), 'utf-8');
        return true;
    } catch (e) {
        return false;
    }
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1480,
        height: 920,
        minWidth: 1040,
        minHeight: 700,
        title: 'IdleDex Desktop Suite v2.0',
        backgroundColor: '#0a0e17',
        autoHideMenuBar: true,
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

    // Forward ALL renderer console messages to stdout for diagnosis
    mainWindow.webContents.on('console-message', (event, level, msg, line, sourceId) => {
        const lvl = ['V','I','W','E'][level] || '?';
        console.log(`[HOST ${lvl}] ${msg}`);
    });

    mainWindow.on('close', (event) => {
        if (!isQuitting) {
            event.preventDefault();
            mainWindow.hide();
        }
    });
}

function createTray() {
    // Generate a clean 16x16 icon programmatically if file doesn't exist
    const iconPath = path.join(__dirname, 'tray-icon.png');
    let icon;
    if (fs.existsSync(iconPath)) {
        icon = nativeImage.createFromPath(iconPath);
    } else {
        // Fallback: 16x16 cyan dot
        const n = nativeImage.createFromBuffer(
            Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAA0SURBVDhPY/wPBAwUACYGKsD/oRhGE2AAjEZB/BiNAsZgNArYgDEyYEAAmBioAP+HYhhNgAEAvdYHEb5rKxkAAAAASUVORK5CYII=', 'base64')
        );
        icon = n;
    }

    tray = new Tray(icon);
    tray.setToolTip('IdleDex Desktop Suite');

    const contextMenu = Menu.buildFromTemplate([
        { label: 'Exibir IdleDex Desktop', click: () => { mainWindow.show(); mainWindow.focus(); } },
        { label: 'Alternar Bot (Ligar / Pausar)', click: () => { mainWindow.webContents.send('toggle-bot-tray'); } },
        { type: 'separator' },
        { label: 'Sair Completamente', click: () => { isQuitting = true; app.quit(); } }
    ]);

    tray.setContextMenu(contextMenu);
    tray.on('double-click', () => {
        mainWindow.show();
        mainWindow.focus();
    });
}

// IPC Handlers
ipcMain.handle('get-config', () => {
    return loadConfig();
});

ipcMain.handle('save-config', (event, cfg) => {
    return saveConfig(cfg);
});

ipcMain.on('minimize-to-tray', () => {
    if (mainWindow) mainWindow.hide();
});

ipcMain.on('toggle-fullscreen', () => {
    if (mainWindow) {
        mainWindow.setFullScreen(!mainWindow.isFullScreen());
    }
});

// App lifecycle
app.whenReady().then(() => {
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
