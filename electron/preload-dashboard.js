const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
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
    },

    // Host commands (e.g. system suspend or main process signals)
    onHostCommand: (callback) => {
        ipcRenderer.on('host-command', (_event, data) => callback(data));
    }
});
