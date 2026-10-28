// Parallel mode: each agent works in its own git worktree, on its own branch, starting
// from a snapshot of your folder (including uncommitted files). When you're happy you
// "apply" an agent's work back into your folder with a three-way merge per file.
// Your branch, staging area and history are never touched.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const spawn = require('cross-spawn');
const checkpoints = require('./checkpoints');

function git(args, cwd, opts = {}) {
  const r = spawn.sync('git', args, { cwd, encoding: opts.buffer ? 'buffer' : 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024, input: opts.input });
  return { ok: r.status === 0, code: r.status, out: opts.buffer ? r.stdout : String(r.stdout || '').replace(/\s+$/, ''), err: String(r.stderr || '') };
}
const slug = (s) => String(s || 'session').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'session';

module.exports = function createWorktrees({ dataDir }) {
  const root = path.join(dataDir, 'worktrees');

  function ensure(s, agent) {
    s.worktrees = s.worktrees || {};
    const cur = s.worktrees[agent.id];
    if (cur && fs.existsSync(cur.dir)) return cur;
    if (!checkpoints.isRepo(s.folder)) throw new Error('Parallel mode needs git in this folder. Turn it on with the banner at the top of the chat.');
    const base = checkpoints.snapshot(s.folder, `refs/agentscircle/${s.id}/base-${agent.id}`, `AgentsCircle: starting point for @${agent.id}`);
    if (!base) throw new Error('Could not take a snapshot of your folder.');
    const branch = `agentscircle/${slug(s.name)}-${s.id.slice(0, 4)}/${agent.id}`;
    const dir = path.join(root, s.id, agent.id);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    git(['worktree', 'prune'], s.folder);
    if (git(['rev-parse', '--verify', '-q', branch], s.folder).ok) git(['branch', '-D', branch], s.folder);
    const r = git(['worktree', 'add', '-b', branch, dir, base], s.folder);
    if (!r.ok) throw new Error(`Couldn't create a worktree: ${r.err.trim().split('\n').pop()}`);
    s.worktrees[agent.id] = { dir, branch, base, createdAt: new Date().toISOString() };
    return s.worktrees[agent.id];
  }

  // The agent's current state (committed or not) as a hidden commit.
  function snapshotOf(s, agentId) {
    const w = s.worktrees && s.worktrees[agentId];
    if (!w || !fs.existsSync(w.dir)) return null;
    return checkpoints.snapshot(w.dir, `refs/agentscircle/${s.id}/wt-${agentId}-now`, `AgentsCircle: @${agentId} work so far`);
  }

  function status(s) {
    const out = [];
    for (const [agentId, w] of Object.entries(s.worktrees || {})) {
      const exists = fs.existsSync(w.dir);
      const snap = exists ? snapshotOf(s, agentId) : null;
      const files = snap ? checkpoints.changedFiles(s.folder, w.base, snap) || [] : [];
      const commits = exists ? (git(['log', '--format=%h %s', `${w.base}..${w.branch}`], s.folder).out || '').split('\n').filter(Boolean) : [];
      out.push({ agent: agentId, branch: w.branch, dir: w.dir, exists, createdAt: w.createdAt, appliedAt: w.appliedAt || null, files, commits, snap });
    }
    return out;
  }

  function diff(s, agentId, file) {
    const w = s.worktrees && s.worktrees[agentId];
    if (!w) throw new Error('No branch for that agent.');
    const snap = snapshotOf(s, agentId);
    return checkpoints.diff(s.folder, w.base, snap, file) || '';
  }

  const show = (cwd, rev, file) => { const r = git(['show', `${rev}:${file}`], cwd, { buffer: true }); return r.ok ? r.out : null; };
  const isBinary = (buf) => buf && buf.subarray(0, 8000).includes(0);

  // Three-way merge of the agent's changes into your folder, file by file.
  function apply(s, agentId) {
    const w = s.worktrees && s.worktrees[agentId];
    if (!w) throw new Error('No branch for that agent.');
    const snap = snapshotOf(s, agentId);
    const changes = checkpoints.changedFiles(s.folder, w.base, snap) || [];
    if (!changes.length) return { applied: [], conflicts: [], skipped: [] };
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentscircle-merge-'));
    const applied = []; const conflicts = []; const skipped = [];
    try {
      for (const ch of changes) {
        const rel = ch.path;
        const full = path.join(s.folder, rel);
        if (path.relative(s.folder, full).startsWith('..')) continue;
        const baseBuf = show(s.folder, w.base, rel);
        const theirs = show(s.folder, snap, rel);
        let ours = null;
        try { ours = fs.readFileSync(full); } catch { /* missing */ }
        const same = (a, b) => (a === null && b === null) || (a && b && Buffer.compare(a, b) === 0);
        if (ch.status === 'deleted') {
          if (ours === null) { applied.push({ path: rel, action: 'already gone' }); continue; }
          if (same(ours, baseBuf)) { fs.rmSync(full, { force: true }); applied.push({ path: rel, action: 'deleted' }); }
          else { conflicts.push({ path: rel, why: `@${agentId} deleted it, but you changed it since. Kept your version.` }); }
          continue;
        }
        if (ours === null || same(ours, baseBuf)) {
          fs.mkdirSync(path.dirname(full), { recursive: true });
          fs.writeFileSync(full, theirs);
          applied.push({ path: rel, action: ours === null ? 'added' : 'updated' });
          continue;
        }
        if (same(ours, theirs)) { applied.push({ path: rel, action: 'already the same' }); continue; }
        if (isBinary(ours) || isBinary(theirs) || isBinary(baseBuf)) { skipped.push({ path: rel, why: 'Binary file changed on both sides. Kept your version.' }); continue; }
        const id = crypto.randomBytes(4).toString('hex');
        const fo = path.join(tmp, `${id}-ours`), fb = path.join(tmp, `${id}-base`), ft = path.join(tmp, `${id}-theirs`);
        fs.writeFileSync(fo, ours); fs.writeFileSync(fb, baseBuf || ''); fs.writeFileSync(ft, theirs);
        const r = spawn.sync('git', ['merge-file', '-p', '-L', 'yours', '-L', 'start', '-L', `@${agentId}`, fo, fb, ft], { encoding: 'buffer', windowsHide: true });
        if (r.status < 0 || r.status === null) { skipped.push({ path: rel, why: 'Merge failed. Kept your version.' }); continue; }
        fs.writeFileSync(full, r.stdout);
        if (r.status > 0) conflicts.push({ path: rel, why: `${r.status} conflict${r.status > 1 ? 's' : ''} marked with <<<<<<< yours / >>>>>>> @${agentId}` });
        else applied.push({ path: rel, action: 'merged' });
      }
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    w.appliedAt = new Date().toISOString();
    return { applied, conflicts, skipped };
  }

  function discard(s, agentId) {
    const w = s.worktrees && s.worktrees[agentId];
    if (!w) return;
    git(['worktree', 'remove', '--force', w.dir], s.folder);
    fs.rmSync(w.dir, { recursive: true, force: true });
    git(['worktree', 'prune'], s.folder);
    git(['branch', '-D', w.branch], s.folder);
    delete s.worktrees[agentId];
  }

  return { ensure, status, diff, apply, discard, snapshotOf };
};
