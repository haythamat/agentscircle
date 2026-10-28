// AgentsCircle desktop app (Electron). Starts the AgentsCircle server inside the app and shows it
// in a window. Your data stays in ~/.agentscircle, shared with the terminal version.

const { app, BrowserWindow, Menu, shell, dialog, ipcMain, nativeTheme } = require('electron');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');

const DATA_DIR = process.env.AGENTSCIRCLE_HOME || path.join(os.homedir(), '.agentscircle');
const LOG_DIR = path.join(DATA_DIR, 'logs');
// First start after the rename: bring over accounts and sessions from ~/.agentroom.
if (!process.env.AGENTSCIRCLE_HOME) require('../src/platform').adoptLegacy(DATA_DIR, path.join(os.homedir(), '.agentroom'));
fs.mkdirSync(LOG_DIR, { recursive: true });

// ---------- logging: everything also goes to ~/.agentscircle/logs/agentscircle.log ----------
const logFile = path.join(LOG_DIR, 'agentscircle.log');
try { if (fs.statSync(logFile).size > 5 * 1024 * 1024) fs.renameSync(logFile, logFile + '.1'); } catch { /* new */ }
const logStream = fs.createWriteStream(logFile, { flags: 'a' });
for (const level of ['log', 'warn', 'error']) {
  const orig = console[level].bind(console);
  console[level] = (...args) => { orig(...args); logStream.write(`${new Date().toISOString()} [${level}] ${args.map((a) => (a instanceof Error ? a.stack : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`); };
}
process.on('uncaughtException', (e) => console.error('Uncaught:', e));
process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e));

// ---------- one window, one app ----------
if (!app.requestSingleInstanceLock()) { app.quit(); }
app.setName('AgentsCircle');

let win = null;
let server = null;
let url = null;
const settingsFile = path.join(DATA_DIR, 'settings.json');
const readSettings = () => { try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { return {}; } };
const writeSettings = (patch) => { const s = { ...readSettings(), ...patch }; fs.writeFileSync(settingsFile, JSON.stringify(s, null, 2)); return s; };

function freePort(start) {
  return new Promise((resolve) => {
    const tryPort = (p) => {
      const srv = net.createServer();
      srv.once('error', () => tryPort(p + 1));
      srv.once('listening', () => srv.close(() => resolve(p)));
      srv.listen(p, '127.0.0.1');
    };
    tryPort(start);
  });
}

function windowState() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'window-state.json'), 'utf8')); } catch { return { width: 1400, height: 900 }; }
}
function saveWindowState() {
  if (!win || win.isMinimized()) return;
  const b = win.getNormalBounds();
  fs.writeFileSync(path.join(DATA_DIR, 'window-state.json'), JSON.stringify({ ...b, maximized: win.isMaximized() }));
}

function isLocal(u) { try { const x = new URL(u); return ['localhost', '127.0.0.1'].includes(x.hostname); } catch { return false; } }

function createWindow() {
  const st = windowState();
  win = new BrowserWindow({
    x: st.x, y: st.y, width: st.width || 1400, height: st.height || 900, minWidth: 900, minHeight: 600,
    title: 'AgentsCircle', show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#121416' : '#f5f6f4',
    // macOS: the window buttons sit inside the sidebar instead of above a separate title bar.
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 18 } } : {}),
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true },
  });
  if (st.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.on('close', saveWindowState);
  win.on('closed', () => { win = null; });
  // Links to the web open in your browser; AgentsCircle's own pages (previews, files) open in a window.
  win.webContents.setWindowOpenHandler(({ url: u }) => {
    if (isLocal(u)) return { action: 'allow', overrideBrowserWindowOptions: { width: 1100, height: 800, autoHideMenuBar: true, webPreferences: { sandbox: true, contextIsolation: true } } };
    if (/^https?:/.test(u)) shell.openExternal(u);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, u) => { if (!isLocal(u)) { e.preventDefault(); if (/^https?:/.test(u)) shell.openExternal(u); } });
  win.loadURL(url);
  if (process.env.AGENTSCIRCLE_SMOKE) smokeTest();
}

// ---------- updates ----------
let updater = null;
let updateState = { status: 'idle', version: null, error: null, progress: null };
function sendUpdate(patch) {
  updateState = { ...updateState, ...patch };
  if (win) win.webContents.send('updates:status', updateState);
  buildMenu();
}
function applyChannel(ch) {
  if (!updater) return;
  const beta = ch === 'beta';
  updater.channel = beta ? 'beta' : 'latest';
  updater.allowPrerelease = beta;
  updater.allowDowngrade = false;
}
function setupUpdates() {
  if (!app.isPackaged || process.env.AGENTSCIRCLE_NO_UPDATES) { updateState.status = 'dev'; return; }
  try { ({ autoUpdater: updater } = require('electron-updater')); } catch (e) { console.error('Updater not available:', e.message); return; }
  updater.logger = console;
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  applyChannel(readSettings().updateChannel);
  updater.on('checking-for-update', () => sendUpdate({ status: 'checking', error: null }));
  updater.on('update-available', (i) => sendUpdate({ status: 'downloading', version: i.version }));
  updater.on('update-not-available', () => sendUpdate({ status: 'up-to-date' }));
  updater.on('download-progress', (p) => sendUpdate({ progress: Math.round(p.percent) }));
  updater.on('update-downloaded', (i) => sendUpdate({ status: 'ready', version: i.version, progress: 100 }));
  updater.on('error', (e) => sendUpdate({ status: 'error', error: String(e && e.message || e).split('\n')[0] }));
  const check = () => updater.checkForUpdates().catch((e) => sendUpdate({ status: 'error', error: e.message }));
  setTimeout(check, 10000);
  setInterval(check, 4 * 60 * 60 * 1000);
}

ipcMain.handle('app:info', () => ({ version: app.getVersion(), packaged: app.isPackaged, platform: process.platform, channel: readSettings().updateChannel || 'stable', update: updateState, dataDir: DATA_DIR, logsDir: LOG_DIR }));
ipcMain.handle('dialog:pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose a project folder', properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('updates:check', async () => { if (!updater) return updateState; await updater.checkForUpdates().catch((e) => sendUpdate({ status: 'error', error: e.message })); return updateState; });
ipcMain.handle('updates:install', () => { if (updater && updateState.status === 'ready') { server && server.stopAll(); updater.quitAndInstall(); } });
ipcMain.handle('updates:channel', (_e, ch) => {
  const channel = ch === 'beta' ? 'beta' : 'stable';
  writeSettings({ updateChannel: channel });
  if (updater) { applyChannel(channel); updater.checkForUpdates().catch(() => {}); }
  return channel;
});
// Dock badge (macOS) / launcher badge (Linux) with the number of agents waiting for you.
ipcMain.on('app:badge', (_e, n) => { try { app.setBadgeCount(Math.max(0, Math.min(99, Number(n) || 0))); } catch { /* not supported here */ } if (win && process.platform === 'win32' && n > 0 && !win.isFocused()) win.flashFrame(true); });
ipcMain.handle('shell:open-path', (_e, which) => shell.openPath(which === 'logs' ? LOG_DIR : DATA_DIR));

// ---------- menu ----------
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const send = (channel, arg) => win && win.webContents.send(channel, arg);
  const updateItem = updateState.status === 'ready'
    ? { label: `Restart to Update (${updateState.version})`, click: () => { server && server.stopAll(); updater.quitAndInstall(); } }
    : { label: 'Check for Updates…', enabled: !!updater, click: () => { updater && updater.checkForUpdates().catch(() => {}); send('ui:open-settings', 'about'); } };
  const template = [
    ...(isMac ? [{ label: 'AgentsCircle', submenu: [{ role: 'about' }, updateItem, { type: 'separator' }, { label: 'Settings…', accelerator: 'Cmd+,', click: () => send('ui:open-settings', 'accounts') }, { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] }] : []),
    { label: 'File', submenu: [{ label: 'New Session…', accelerator: 'CmdOrCtrl+N', click: () => send('ui:new-session') }, ...(isMac ? [] : [{ label: 'Settings…', accelerator: 'Ctrl+,', click: () => send('ui:open-settings', 'accounts') }]), { type: 'separator' }, isMac ? { role: 'close' } : { role: 'quit' }] },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ label: 'Show or Hide Sidebar', accelerator: 'CmdOrCtrl+B', registerAccelerator: false, click: () => send('ui:toggle-sidebar') }, { label: 'Show or Hide Session Panel', accelerator: 'CmdOrCtrl+J', registerAccelerator: false, click: () => send('ui:toggle-panel') }, { type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
    { role: 'help', submenu: [...(isMac ? [] : [updateItem]), { label: 'Open Logs Folder', click: () => shell.openPath(LOG_DIR) }, { label: 'Open Data Folder', click: () => shell.openPath(DATA_DIR) }, { label: 'Release Notes', click: () => shell.openExternal(releasesUrl()) }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
function releasesUrl() {
  try { const p = require('../package.json'); const pub = [].concat(p.build && p.build.publish || [])[0] || {}; if (pub.owner && pub.repo) return `https://github.com/${pub.owner}/${pub.repo}/releases`; } catch { /* none */ }
  return 'https://github.com';
}

// ---------- smoke test (CI / development) ----------
function smokeTest() {
  win.webContents.once('did-finish-load', () => setTimeout(async () => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(process.env.AGENTSCIRCLE_SMOKE, img.toPNG());
    console.log('Smoke screenshot saved to', process.env.AGENTSCIRCLE_SMOKE);
    app.quit();
  }, Number(process.env.AGENTSCIRCLE_SMOKE_WAIT || 2500)));
}

// ---------- start ----------
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(async () => {
  process.env.AGENTSCIRCLE_DESKTOP = '1';
  process.env.AGENTSCIRCLE_HOME = DATA_DIR;
  process.env.AGENTSCIRCLE_PORT = String(await freePort(Number(process.env.AGENTSCIRCLE_PORT || 4317)));
  try {
    server = require('../src/server.js');
    url = await server.ready;
  } catch (e) {
    console.error('AgentsCircle could not start:', e);
    dialog.showErrorBox('AgentsCircle could not start', `${e.message}\n\nDetails are in ${logFile}`);
    app.exit(1);
    return;
  }
  setupUpdates();
  buildMenu();
  createWindow();
  app.on('activate', () => { if (!win) createWindow(); });
});
app.on('before-quit', () => { saveWindowState(); try { server && server.stopAll(); } catch { /* quitting */ } });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
