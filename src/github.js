// Start a session from a GitHub repository: list your repos (through the GitHub CLI when it's
// signed in), and clone one into your projects folder. Uses your own git / GitHub sign-in;
// AgentsCircle never stores GitHub credentials.

const fs = require('fs');
const os = require('os');
const path = require('path');
const spawn = require('cross-spawn');

const IS_WIN = process.platform === 'win32';

function runAsync(cmd, args, { cwd, timeoutMs = 20000, env } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '';
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', ...(env || {}) }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { return resolve({ code: -1, out: '', err: e.message }); }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } err += '\n(timed out)'; }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: err + e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}
const which = (cmd) => {
  const r = spawn.sync(IS_WIN ? 'where' : 'which', [cmd], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 && (r.stdout || '').trim() ? (r.stdout || '').trim().split(/\r?\n/)[0] : null;
};

// "owner/name", https://github.com/owner/name(.git), git@github.com:owner/name.git
function parseRepo(input) {
  const s = String(input || '').trim().replace(/\/+$/, '');
  let m = /^(?:https?:\/\/)?(?:www\.)?github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/.*)?$/i.exec(s)
    || /^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i.exec(s)
    || /^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(s);
  if (!m) return null;
  return { owner: m[1], name: m[2], full: `${m[1]}/${m[2]}`, url: `https://github.com/${m[1]}/${m[2]}.git` };
}

module.exports = function createGithub({ settings }) {
  function projectsDir() {
    const chosen = settings.get().projectsDir;
    if (chosen) return chosen;
    for (const d of ['Projects', 'projects', 'Developer', 'dev', 'code', 'src']) {
      const p = path.join(os.homedir(), d);
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return p;
    }
    return path.join(os.homedir(), 'AgentsCircle Projects');
  }

  async function status() {
    const gh = which('gh');
    const git = which('git');
    if (!gh) return { gh: false, git: !!git, signedIn: false, user: null, projectsDir: projectsDir() };
    const r = await runAsync('gh', ['api', 'user', '--jq', '.login'], { timeoutMs: 12000 });
    const user = r.code === 0 ? r.out.trim() : null;
    return { gh: true, git: !!git, signedIn: !!user, user, projectsDir: projectsDir() };
  }

  // Repositories you own, collaborate on or reach through an organization, newest first
  // (GitHub's REST API through the GitHub CLI, so it uses your sign-in).
  async function repos() {
    const r = await runAsync('gh', ['api', '--paginate', 'user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member', '--jq', '.[] | [.full_name, (.description // ""), .private, .updated_at] | @tsv'], { timeoutMs: 45000 });
    if (r.code !== 0) throw new Error((r.err || r.out).trim().split('\n').pop() || 'Could not list your repositories.');
    return r.out.split('\n').filter(Boolean).map((line) => {
      const [full, description, priv, updatedAt] = line.split('\t');
      return { full, description: description || '', private: priv === 'true', updatedAt };
    }).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 500);
  }

  // Clone (or reuse an existing clone of the same repository). Returns the folder.
  async function clone(input, parent) {
    const repo = parseRepo(input);
    if (!repo) throw new Error('Paste a GitHub repository: a link like https://github.com/owner/name, or owner/name.');
    const base = path.resolve(String(parent || projectsDir()).replace(/^~(?=$|[\\/])/, os.homedir()));
    fs.mkdirSync(base, { recursive: true });
    const dest = path.join(base, repo.name);
    if (fs.existsSync(dest)) {
      const r = await runAsync('git', ['-C', dest, 'remote', 'get-url', 'origin']);
      const same = r.code === 0 && parseRepo(r.out.trim()) && parseRepo(r.out.trim()).full.toLowerCase() === repo.full.toLowerCase();
      if (same) return { folder: dest, reused: true, repo: repo.full };
      if (fs.readdirSync(dest).length) throw new Error(`${dest} already exists and isn't a copy of ${repo.full}. Choose another "Save in" folder.`);
    }
    const st = await status();
    // Plain git first (works for public repos, and for private ones once "gh auth setup-git" ran);
    // when signed in to the GitHub CLI and git can't get in, let gh do it with your sign-in.
    const tidy = () => { try { if (fs.existsSync(dest) && !fs.readdirSync(dest).filter((f) => f !== '.git').length) fs.rmSync(dest, { recursive: true, force: true }); } catch { /* leave it */ } };
    let r = await runAsync('git', ['clone', repo.url, dest], { timeoutMs: 20 * 60000 });
    if (r.code !== 0 && st.signedIn) { tidy(); const g = await runAsync('gh', ['repo', 'clone', repo.full, dest], { timeoutMs: 20 * 60000 }); if (g.code === 0) r = g; else r.err += '\n' + g.err; }
    if (r.code !== 0) {
      tidy();
      const msg = (r.err || '').trim();
      if (/authentication|could not read username|terminal prompts disabled|403|not found|repository .* does not exist|could not resolve to a repository/i.test(msg)) {
        const e = new Error(st.signedIn
          ? `GitHub says ${repo.full} doesn't exist or your account (${st.user}) can't access it.`
          : `GitHub didn't let AgentsCircle download ${repo.full}. If it's private, sign in to GitHub first.`);
        e.code = 'auth'; throw e;
      }
      throw new Error(msg.split('\n').filter(Boolean).slice(-2).join(' ') || 'Cloning failed.');
    }
    return { folder: dest, reused: false, repo: repo.full };
  }

  return { status, repos, clone, parseRepo, projectsDir };
};
