// Push the session's commits to GitHub (or any remote), pull when the remote is ahead, and put a
// folder on GitHub for the first time. Uses your own git and GitHub sign-in; when git itself has no
// credentials but the GitHub CLI is signed in, it borrows the CLI's sign-in for that one command.

const spawn = require('cross-spawn');

const IS_WIN = process.platform === 'win32';
const which = (cmd) => {
  const r = spawn.sync(IS_WIN ? 'where' : 'which', [cmd], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 && (r.stdout || '').trim() ? (r.stdout || '').trim().split(/\r?\n/)[0] : null;
};

function runAsync(cmd, args, { cwd, timeoutMs = 90000 } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '', child;
    try { child = spawn(cmd, args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GIT_ASKPASS: '', SSH_ASKPASS: '' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return resolve({ code: -1, out: '', err: e.message }); }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } err += '\n(timed out)'; }, timeoutMs);
    child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: err + e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}
const gitSync = (cwd, args) => { const r = spawn.sync('git', args, { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }); return r.status === 0 ? (r.stdout || '').trim() : null; };

// A remote URL without any password or token in it.
const safeUrl = (u) => String(u || '').replace(/\/\/[^@/]+@/, '//');
function webUrl(u) {
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(\.git)?$/.exec(String(u || ''));
  return m ? `https://github.com/${m[1]}/${m[2]}` : null;
}

function friendly(out, remote) {
  const t = out.trim();
  if (/non-fast-forward|fetch first|rejected.*\(fetch first\)|Updates were rejected/i.test(t)) return { code: 'behind', message: `${remote} has commits this folder doesn't have yet. Pull them first, then push.` };
  if (/Authentication failed|could not read Username|terminal prompts disabled|Permission denied \(publickey\)|403|invalid username or password|Invalid credentials/i.test(t)) return { code: 'auth', message: `git couldn't sign in to ${remote}. Sign in to GitHub (Settings, or the button below), then push again.` };
  if (/Could not resolve host|unable to access|Connection timed out|Network is unreachable/i.test(t)) return { code: 'network', message: `Couldn't reach ${remote}. Check your internet connection and try again.` };
  if (/protected branch|GH006/i.test(t)) return { code: 'protected', message: 'That branch is protected on GitHub. Push to another branch and open a pull request.' };
  if (/repository not found|does not appear to be a git repository/i.test(t)) return { code: 'notfound', message: `The remote repository wasn't found, or your account can't see it (${remote}).` };
  if (/timed out/i.test(t)) return { code: 'timeout', message: 'git took too long. Try again.' };
  return { code: 'error', message: t.split('\n').filter(Boolean).slice(-3).join(' ') || 'git push failed.' };
}

module.exports = function createGitSync() {
  function state(folder) {
    const branch = gitSync(folder, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (!branch) return { repo: false };
    const remotes = (gitSync(folder, ['remote']) || '').split('\n').filter(Boolean);
    const upstream = gitSync(folder, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    const remote = upstream ? upstream.split('/')[0] : (remotes.includes('origin') ? 'origin' : remotes[0] || null);
    const url = remote ? gitSync(folder, ['remote', 'get-url', remote]) : null;
    let ahead = null, behind = null;
    if (upstream) {
      const lr = gitSync(folder, ['rev-list', '--left-right', '--count', `${upstream}...HEAD`]);
      if (lr) { const [b, a] = lr.split(/\s+/).map(Number); ahead = a; behind = b; }
    } else if (branch !== 'HEAD') {
      ahead = Number(gitSync(folder, ['rev-list', '--count', 'HEAD']) || 0);
    }
    return { repo: true, branch, detached: branch === 'HEAD', remote, remotes, upstream, url: safeUrl(url), web: webUrl(url), ahead, behind, hasCommits: !!gitSync(folder, ['rev-parse', '--verify', '-q', 'HEAD']), gh: !!which('gh') };
  }

  // git, and if it can't sign in while the GitHub CLI can, git again with the CLI's sign-in.
  async function gitWithAuth(folder, args) {
    let r = await runAsync('git', args, { cwd: folder });
    if (r.code !== 0 && friendly(r.err + r.out, '').code === 'auth') {
      const gh = which('gh');
      if (gh) {
        const helper = `!"${gh.replace(/\\/g, '/')}" auth git-credential`;
        const r2 = await runAsync('git', ['-c', 'credential.helper=', '-c', `credential.helper=${helper}`, ...args], { cwd: folder });
        if (r2.code === 0 || friendly(r2.err + r2.out, '').code !== 'auth') r = r2;
      }
    }
    return r;
  }

  async function push(folder) {
    const st = state(folder);
    if (!st.repo) throw Object.assign(new Error('This folder isn\'t a git repository.'), { code: 'norepo' });
    if (st.detached) throw Object.assign(new Error('You\'re not on a branch (detached HEAD). Switch to a branch first.'), { code: 'detached' });
    if (!st.remote) throw Object.assign(new Error('This folder isn\'t linked to GitHub yet.'), { code: 'noremote' });
    if (!st.hasCommits) throw Object.assign(new Error('Nothing to push yet: commit first.'), { code: 'nocommits' });
    const args = st.upstream ? ['push'] : ['push', '-u', st.remote, st.branch];
    const r = await gitWithAuth(folder, args);
    if (r.code !== 0) { const f = friendly(r.err + r.out, st.web || st.url || st.remote); throw Object.assign(new Error(f.message), { code: f.code }); }
    return { ok: true, pushed: st.ahead, ...state(folder) };
  }

  async function pull(folder) {
    const st = state(folder);
    if (!st.upstream) throw new Error('This branch isn\'t linked to a remote branch yet. Push it first.');
    const r = await gitWithAuth(folder, ['pull', '--ff-only']);
    if (r.code !== 0) {
      const t = r.err + r.out;
      if (/Not possible to fast-forward|diverged/i.test(t)) throw Object.assign(new Error('Your commits and the remote\'s have both moved on. Ask an agent to merge them (for example: "@claude pull and merge origin, then commit"), then push.'), { code: 'diverged' });
      if (/would be overwritten|commit your changes or stash/i.test(t)) throw Object.assign(new Error('Some files you changed would be overwritten. Commit them first, then pull.'), { code: 'dirty' });
      const f = friendly(t, st.web || st.remote); throw Object.assign(new Error(f.message), { code: f.code });
    }
    return { ok: true, ...state(folder) };
  }

  // First time on GitHub: a new repository (private unless you choose public), linked and pushed.
  async function publish(folder, { name, isPublic }) {
    const gh = which('gh');
    if (!gh) throw Object.assign(new Error('Putting a folder on GitHub needs the GitHub CLI. Sign in to GitHub in Settings first.'), { code: 'nogh' });
    const st = state(folder);
    if (!st.repo) throw new Error('This folder isn\'t a git repository.');
    if (st.remote) throw new Error(`This folder is already linked to ${st.web || st.url}.`);
    if (!st.hasCommits) throw Object.assign(new Error('Commit something first, then put it on GitHub.'), { code: 'nocommits' });
    const clean = String(name || '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100);
    if (!clean) throw new Error('Pick a name for the repository.');
    const r = await runAsync(gh, ['repo', 'create', clean, isPublic ? '--public' : '--private', '--source', '.', '--remote', 'origin', '--push'], { cwd: folder, timeoutMs: 120000 });
    if (r.code !== 0) {
      const t = (r.err + r.out).trim();
      if (/not logged|auth login|authentication/i.test(t)) throw Object.assign(new Error('Sign in to GitHub first (Settings, or the button below).'), { code: 'auth' });
      if (/already exists/i.test(t)) throw new Error(`You already have a repository called ${clean} on GitHub. Pick another name.`);
      throw new Error(t.split('\n').filter(Boolean).slice(-2).join(' ') || 'Creating the repository failed.');
    }
    return { ok: true, ...state(folder) };
  }

  return { state, push, pull, publish };
};
