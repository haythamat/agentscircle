// Apps opened from the Mac Dock (or a Windows shortcut) don't get the PATH your terminal
// has, so `claude`, `codex` & co. wouldn't be found. Ask the login shell for its PATH and
// add the folders the agent installers use.

const os = require('os');
const path = require('path');
const spawn = require('cross-spawn');

function fixPath() {
  const home = os.homedir();
  const parts = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  if (process.platform !== 'win32') {
    const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
    try {
      const r = spawn.sync(shell, ['-ilc', 'printf "__AGENTSCIRCLE_PATH__%s__AGENTSCIRCLE_PATH__" "$PATH"'], { encoding: 'utf8', timeout: 6000, env: { ...process.env, DISABLE_AUTO_UPDATE: 'true' } });
      const m = /__AGENTSCIRCLE_PATH__(.*)__AGENTSCIRCLE_PATH__/.exec(r.stdout || '');
      if (m) parts.unshift(...m[1].split(':').filter(Boolean));
    } catch { /* keep what we have */ }
    parts.push(
      path.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin',
      path.join(home, '.npm-global', 'bin'), path.join(home, '.bun', 'bin'), path.join(home, '.opencode', 'bin'),
      path.join(home, '.volta', 'bin'), path.join(home, '.cargo', 'bin'),
    );
  } else {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    parts.push(path.join(appData, 'npm'), path.join(home, '.local', 'bin'), path.join(local, 'Programs', 'cursor-agent'), path.join(home, '.opencode', 'bin'), 'C:\\Program Files\\Git\\cmd');
  }
  process.env.PATH = [...new Set(parts)].join(path.delimiter);
  return process.env.PATH;
}

module.exports = { fixPath };
