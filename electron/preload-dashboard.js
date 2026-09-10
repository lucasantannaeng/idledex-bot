const { contextBridge, ipcRenderer } = require('electron');
const path = require('path');
const fs = require('fs');
const url = require('url');

function getGamePreloadPath() {
    let p = path.join(__dirname, 'preload-game.js');
    if (p.includes('app.asar') && !fs.existsSync(p)) {
        const unpacked = p.replace('app.asar', 'app.asar.unpacked');
        if (fs.existsSync(unpacked)) {
            p = unpacked;
        }
    }
    return url.pathToFileURL(p).href;
}

contextBridge.exposeInMainWorld('electronAPI', {
    // Webview guest preload script file URL
    gamePreloadPath: getGamePreloadPath(),

    // Configuration persistence
    getConfig: () => ipcRenderer.invoke('get-config'),
    saveConfig: (cfg) => ipcRenderer.invoke('save-config', cfg),
    switchAccount: () => ipcRenderer.invoke('switch-account'),

    // Window controls
    minimizeToTray: () => ipcRenderer.send('minimize-to-tray'),
    toggleFullscreen: () => ipcRenderer.send('toggle-fullscreen'),

    // System Tray triggers
    onToggleBotTray: (callback) => {
        ipcRenderer.on('toggle-bot-tray', () => callback());
    }
});
