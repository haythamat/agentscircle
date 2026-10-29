// A real terminal inside a session: a shell running in the session's folder, shown in the panel.
// Uses node-pty when it loads (a proper terminal: colours, prompts, vim, Ctrl-C). If it can't load,
// falls back to `script` on macOS/Linux (which also gives the shell a terminal) or plain pipes.
// One terminal per session; it keeps running when you close the panel or switch sessions, and keeps
// the last part of its output so it can be redrawn when you come back.

const fs = require('fs');
const os = require('os');
const path = require('path');
const spawn = require('cross-spawn');

let pty = null, ptyError = null;
try {
  pty = require('node-pty');
  // Some node-pty builds ship macOS's spawn-helper without its execute bit, and every spawn then fails.
  if (process.platform === 'darwin') {
    const dir = path.dirname(require.resolve('node-pty/package.json')).replace('app.asar', 'app.asar.unpacked');
    for (const sub of ['build/Release', `prebuilds/darwin-${process.arch}`]) {
      const helper = path.join(dir, sub, 'spawn-helper');
      try { const st = fs.statSync(helper); if (!(st.mode & 0o111)) fs.chmodSync(helper, 0o755); } catch { /* not there, or read-only */ }
    }
  }
} catch (e) { ptyError = e.message; }

const KEEP = 256 * 1024; // output kept for redraw

function shellFor() {
  if (process.platform === 'win32') {
    const ps = process.env.ComSpec && /powershell|pwsh/i.test(process.env.ComSpec) ? process.env.ComSpec : 'powershell.exe';
    return { file: ps, args: ['-NoLogo'] };
  }
  let sh = process.env.SHELL;
  if (!sh) { try { sh = os.userInfo().shell; } catch { /* none */ } }
  if (!sh || !fs.existsSync(sh)) sh = fs.existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/bash';
  return { file: sh, args: ['-l'] };
}

module.exports = function createTerminals({ onData, onExit }) {
  const terms = new Map(); // session id -> term

  function info(t) { return t && { sessionId: t.sessionId, pid: t.pid, shell: path.basename(t.shell), cwd: t.cwd, mode: t.mode, alive: t.alive, startedAt: t.startedAt }; }

  function push(t, data) {
    t.buf += data;
    if (t.buf.length > KEEP) t.buf = t.buf.slice(-KEEP);
    onData(t.sessionId, data);
  }

  function open(sessionId, cwd, { cols = 100, rows = 30, env = {} } = {}) {
    const old = terms.get(sessionId);
    if (old && old.alive) return { ...info(old), buffer: old.buf };
    if (!fs.existsSync(cwd)) throw new Error(`The session folder isn't there any more: ${cwd}`);
    const { file, args } = shellFor();
    const fullEnv = { ...process.env, ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'AgentsCircle' };
    delete fullEnv.ELECTRON_RUN_AS_NODE;
    const t = { sessionId, cwd, shell: file, buf: '', alive: true, startedAt: new Date().toISOString(), cols, rows };

    let started = false;
    if (pty) {
      try {
        const p = pty.spawn(file, args, { name: 'xterm-256color', cols, rows, cwd, env: fullEnv, useConpty: true });
        t.mode = 'pty'; t.pid = p.pid;
        t.write = (d) => p.write(d);
        t.resize = (c, r) => { try { p.resize(Math.max(2, c), Math.max(2, r)); } catch { /* exited */ } };
        t.kill = () => { try { p.kill(); } catch { /* gone */ } };
        p.onData((d) => push(t, d));
        p.onExit(({ exitCode }) => done(t, exitCode));
        started = true;
      } catch (e) { ptyError = e.message; }
    }
    if (!started) {
      // No node-pty: `script` still gives the shell a terminal on macOS and Linux.
      let cmd = file, cargs = args, mode = 'pipe';
      if (process.platform === 'darwin') { cmd = '/usr/bin/script'; cargs = ['-q', '/dev/null', file, ...args]; mode = 'script'; }
      else if (process.platform === 'linux' && fs.existsSync('/usr/bin/script')) { cmd = '/usr/bin/script'; cargs = ['-qfc', [file, ...args].join(' '), '/dev/null']; mode = 'script'; }
      else if (process.platform !== 'win32') cargs = ['-i'];
      const c = spawn(cmd, cargs, { cwd, env: { ...fullEnv, COLUMNS: String(cols), LINES: String(rows) }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      t.mode = mode; t.pid = c.pid;
      t.write = (d) => { try { c.stdin.write(mode === 'pipe' ? d.replace(/\r/g, '\n') : d); } catch { /* closed */ } };
      t.resize = () => {};
      t.kill = () => { try { c.kill(); } catch { /* gone */ } };
      c.stdout.setEncoding('utf8'); c.stderr.setEncoding('utf8');
      // Without a terminal nothing echoes what you type or turns \n into \r\n, so do it here.
      const fix = (d) => (mode === 'pipe' ? d.replace(/\r?\n/g, '\r\n') : d);
      c.stdout.on('data', (d) => push(t, fix(d)));
      c.stderr.on('data', (d) => push(t, fix(d)));
      c.stdin.on('error', () => {});
      c.on('error', (e) => { push(t, `\r\nCouldn't start ${file}: ${e.message}\r\n`); done(t, -1); });
      c.on('close', (code) => done(t, code));
      if (mode === 'pipe') t.echo = true;
    }
    terms.set(sessionId, t);
    return { ...info(t), buffer: t.buf };
  }

  function done(t, code) {
    if (!t.alive) return;
    t.alive = false;
    t.buf += `\r\n\x1b[2m[Process ended${code ? ` with code ${code}` : ''}]\x1b[0m\r\n`;
    onExit(t.sessionId, code);
  }

  function write(sessionId, data) {
    const t = terms.get(sessionId);
    if (!t || !t.alive || typeof data !== 'string') return;
    if (t.echo) push(t, data.replace(/\r/g, '\r\n'));
    t.write(data);
  }
  function resize(sessionId, cols, rows) {
    const t = terms.get(sessionId);
    if (!t || !t.alive || !(cols > 0 && rows > 0)) return;
    t.cols = cols; t.rows = rows;
    t.resize(cols | 0, rows | 0);
  }
  function kill(sessionId) {
    const t = terms.get(sessionId);
    if (!t) return;
    t.kill();
    terms.delete(sessionId);
  }
  const get = (sessionId) => { const t = terms.get(sessionId); return t ? { ...info(t), buffer: t.buf } : null; };
  const killAll = () => { for (const id of [...terms.keys()]) kill(id); };

  return { open, write, resize, kill, get, killAll, available: () => ({ pty: !!pty, error: ptyError }) };
};
