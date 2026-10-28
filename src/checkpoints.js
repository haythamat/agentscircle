// Checkpoints: a snapshot of the project before and after each agent turn, stored
// as hidden git commits (refs/agentscircle/...). Your branch, index and history are
// never touched. Undo restores only the files that turn changed.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const spawn = require('cross-spawn');

function git(args, cwd, env, asBuffer) {
  const r = spawn.sync('git', args, { cwd, env: env ? { ...process.env, ...env } : process.env, encoding: asBuffer ? 'buffer' : 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) return null;
  return asBuffer ? r.stdout : (r.stdout || '').replace(/\s+$/, '');
}

const isRepo = (folder) => git(['rev-parse', '--is-inside-work-tree'], folder) === 'true';

function snapshot(folder, ref, message) {
  if (!isRepo(folder)) return null;
  const tmp = path.join(os.tmpdir(), `agentscircle-index-${crypto.randomBytes(6).toString('hex')}`);
  try {
    // Start from a copy of the real index so unchanged files aren't re-read.
    const real = git(['rev-parse', '--git-path', 'index'], folder);
    const realPath = real && path.resolve(folder, real);
    if (realPath && fs.existsSync(realPath)) fs.copyFileSync(realPath, tmp);
    const env = { GIT_INDEX_FILE: tmp };
    if (git(['add', '-A', '--', '.'], folder, env) === null) return null;
    const tree = git(['write-tree'], folder, env);
    if (!tree) return null;
    const head = git(['rev-parse', '--verify', '-q', 'HEAD'], folder);
    const commit = git(['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', message], folder, {
      GIT_AUTHOR_NAME: 'AgentsCircle', GIT_AUTHOR_EMAIL: 'agentscircle@localhost', GIT_COMMITTER_NAME: 'AgentsCircle', GIT_COMMITTER_EMAIL: 'agentscircle@localhost',
    });
    if (!commit) return null;
    git(['update-ref', ref, commit], folder);
    return commit;
  } finally {
    fs.rm(tmp, { force: true }, () => {});
  }
}

function changedFiles(folder, before, after) {
  const out = git(['diff', '--name-status', '--no-renames', before, after], folder);
  if (out === null) return null;
  return out.split('\n').filter(Boolean).map((l) => { const [st, ...p] = l.split('\t'); return { path: p.join('\t'), status: st[0] === 'A' ? 'added' : st[0] === 'D' ? 'deleted' : 'modified' }; });
}

function diff(folder, before, after, file) {
  return git(['diff', '--no-color', before, after, ...(file ? ['--', file] : [])], folder);
}

// Put each file back the way it was at `sha` (deleting files that didn't exist then).
function restore(folder, sha, files) {
  const done = [];
  for (const rel of files) {
    const full = path.resolve(folder, rel);
    if (path.relative(folder, full).startsWith('..')) continue;
    const exists = git(['cat-file', '-e', `${sha}:${rel}`], folder) !== null;
    if (exists) {
      const buf = git(['show', `${sha}:${rel}`], folder, null, true);
      if (buf === null) continue;
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, buf);
      done.push({ path: rel, action: 'restored' });
    } else if (fs.existsSync(full)) {
      fs.rmSync(full, { force: true });
      done.push({ path: rel, action: 'removed' });
    }
  }
  return done;
}

function initRepo(folder) {
  if (isRepo(folder)) return true;
  return git(['init'], folder) !== null;
}

module.exports = { isRepo, snapshot, changedFiles, diff, restore, initRepo };
