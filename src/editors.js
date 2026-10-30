// "Open in" your code editor: finds VS Code, Cursor, Windsurf, Zed and others installed on this
// computer, and opens a file (at a line, when the editor supports it) or the whole project folder.

const fs = require('fs');
const os = require('os');
const path = require('path');
const spawn = require('cross-spawn');

const IS_MAC = process.platform === 'darwin', IS_WIN = process.platform === 'win32';
const which = (cmd) => {
  const r = spawn.sync(IS_WIN ? 'where' : 'which', [cmd], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 && (r.stdout || '').trim() ? (r.stdout || '').trim().split(/\r?\n/)[0] : null;
};
const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');

// cli: command-line launcher; app: macOS app name; win: Windows exe paths; goto: supports file:line.
const EDITORS = [
  { id: 'vscode', name: 'VS Code', cli: 'code', app: 'Visual Studio Code', win: [path.join(LOCAL, 'Programs', 'Microsoft VS Code', 'Code.exe')], goto: true },
  { id: 'cursor', name: 'Cursor', cli: 'cursor', app: 'Cursor', win: [path.join(LOCAL, 'Programs', 'cursor', 'Cursor.exe')], goto: true },
  { id: 'windsurf', name: 'Windsurf', cli: 'windsurf', app: 'Windsurf', win: [path.join(LOCAL, 'Programs', 'Windsurf', 'Windsurf.exe')], goto: true },
  { id: 'zed', name: 'Zed', cli: 'zed', app: 'Zed', win: [], goto: false },
  { id: 'sublime', name: 'Sublime Text', cli: 'subl', app: 'Sublime Text', win: ['C:\\Program Files\\Sublime Text\\sublime_text.exe'], goto: false },
  { id: 'webstorm', name: 'WebStorm', cli: 'webstorm', app: 'WebStorm', win: [], goto: false },
  { id: 'xcode', name: 'Xcode', cli: null, app: 'Xcode', win: [], goto: false, macOnly: true },
];

let cache = null, cachedAt = 0;
function installed() {
  if (cache && Date.now() - cachedAt < 60000) return cache;
  const found = [];
  for (const e of EDITORS) {
    if (e.macOnly && !IS_MAC) continue;
    const appPath = IS_MAC ? ['/Applications', path.join(os.homedir(), 'Applications')].map((d) => path.join(d, `${e.app}.app`)).find((p) => fs.existsSync(p)) : null;
    const exe = IS_WIN ? e.win.find((p) => fs.existsSync(p)) : null;
    const cli = e.cli ? which(e.cli) : null;
    if (appPath || exe || cli) found.push({ id: e.id, name: e.name, goto: e.goto, appPath, exe, cli });
  }
  cache = found; cachedAt = Date.now();
  return found;
}

function open(id, target, { line, folder } = {}) {
  const e = installed().find((x) => x.id === id);
  if (!e) throw new Error('That editor isn\'t installed on this computer.');
  const spot = line && e.goto ? `${target}:${line}` : target;
  let cmd, args;
  if (e.cli) { cmd = e.cli; args = e.goto && line ? (folder ? [folder, '--goto', spot] : ['--goto', spot]) : (folder && folder !== target ? [folder, target] : [target]); }
  else if (IS_MAC && e.appPath) { cmd = 'open'; args = ['-a', e.appPath, target]; }
  else if (e.exe) { cmd = e.exe; args = [target]; }
  else throw new Error(`Couldn't start ${e.name}.`);
  const c = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
  c.on('error', () => {});
  c.unref();
  return { ok: true, editor: e.name };
}

module.exports = { installed, open };
