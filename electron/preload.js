// The only bridge between the AgentsCircle page and the desktop app. Exposes a few safe calls.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agentscircleDesktop', {
  appInfo: () => ipcRenderer.invoke('app:info'),
  pickFolder: () => ipcRenderer.invoke('dialog:pick-folder'),
  checkUpdates: () => ipcRenderer.invoke('updates:check'),
  installUpdate: () => ipcRenderer.invoke('updates:install'),
  setChannel: (ch) => ipcRenderer.invoke('updates:channel', ch),
  openPath: (which) => ipcRenderer.invoke('shell:open-path', which),
  onUpdate: (cb) => ipcRenderer.on('updates:status', (_e, s) => cb(s)),
  onOpenSettings: (cb) => ipcRenderer.on('ui:open-settings', (_e, tab) => cb(tab)),
  onNewSession: (cb) => ipcRenderer.on('ui:new-session', () => cb()),
  onToggleSidebar: (cb) => ipcRenderer.on('ui:toggle-sidebar', () => cb()),
  onTogglePanel: (cb) => ipcRenderer.on('ui:toggle-panel', () => cb()),
  setBadge: (n) => ipcRenderer.send('app:badge', Number(n) || 0),
});
