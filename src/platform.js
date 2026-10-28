// Things the installed app needs: data versioning (with a backup before any upgrade) and
// signed "agent settings" fixes downloaded from the AgentsCircle repo.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------- data versions ----------
const DATA_VERSION = 1;
// Each entry upgrades the data folder from version i to i + 1.
const MIGRATIONS = [
  // 0 -> 1: the first versioned release. Nothing to convert; folders are created as needed.
  () => {},
];

// Before the rename the app kept its data in ~/.agentroom. On the first start of AgentsCircle,
// copy it over (accounts, logins, connectors, skills, sessions) and point saved paths at the new folder.
// The old folder is left untouched. Worktrees aren't copied: git ties them to their old location.
function adoptLegacy(dataDir, legacyDir) {
  try {
    if (!legacyDir || fs.existsSync(dataDir) || !fs.existsSync(legacyDir)) return false;
    fs.mkdirSync(dataDir, { recursive: true });
    for (const name of fs.readdirSync(legacyDir)) {
      if (['worktrees', 'backups', 'logs', 'window-state.json'].includes(name)) continue;
      fs.cpSync(path.join(legacyDir, name), path.join(dataDir, name), { recursive: true, verbatimSymlinks: true });
    }
    const fix = (f) => {
      try {
        const t = fs.readFileSync(f, 'utf8');
        if (t.includes(legacyDir)) fs.writeFileSync(f, t.split(legacyDir).join(dataDir));
      } catch { /* not readable as text */ }
    };
    for (const name of ['agents.json', 'connectors.json', 'settings.json']) fix(path.join(dataDir, name));
    const sd = path.join(dataDir, 'sessions');
    if (fs.existsSync(sd)) for (const f of fs.readdirSync(sd)) fix(path.join(sd, f));
    try { fs.chmodSync(path.join(dataDir, 'agents.json'), 0o600); fs.chmodSync(path.join(dataDir, 'connectors.json'), 0o600); } catch { /* missing */ }
    return true;
  } catch (e) {
    console.warn('Could not copy data from', legacyDir, e.message);
    return false;
  }
}

function migrate(dataDir) {
  const metaFile = path.join(dataDir, 'meta.json');
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch { /* new or pre-1.0 */ }
  const from = Number(meta.dataVersion || 0);
  if (from > DATA_VERSION) {
    console.warn(`AgentsCircle data in ${dataDir} was written by a newer version (${from}). Some things may not show correctly.`);
    return { from, to: from };
  }
  if (from === DATA_VERSION) return { from, to: from };
  const sessionsDir = path.join(dataDir, 'sessions');
  const hasData = fs.existsSync(path.join(dataDir, 'agents.json')) || (fs.existsSync(sessionsDir) && fs.readdirSync(sessionsDir).length > 0);
  if (hasData) {
    // Keep a copy of everything that matters before converting it.
    const backup = path.join(dataDir, 'backups', `before-v${DATA_VERSION}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    fs.mkdirSync(backup, { recursive: true });
    for (const name of ['agents.json', 'connectors.json', 'settings.json', 'sessions']) {
      const src = path.join(dataDir, name);
      if (fs.existsSync(src)) fs.cpSync(src, path.join(backup, name), { recursive: true });
    }
  }
  for (let v = from; v < DATA_VERSION; v++) MIGRATIONS[v](dataDir);
  fs.writeFileSync(metaFile, JSON.stringify({ ...meta, dataVersion: DATA_VERSION, migratedAt: new Date().toISOString() }, null, 2));
  return { from, to: DATA_VERSION };
}

// ---------- settings ----------
function settings(dataDir) {
  const file = path.join(dataDir, 'settings.json');
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
  return {
    get: read,
    set(patch) { const cur = { ...read(), ...patch }; fs.writeFileSync(file, JSON.stringify(cur, null, 2)); return cur; },
  };
}

// ---------- signed agent-settings fixes ----------
// Only these fields can change remotely. Commands to run, extra environment and anything
// else stay as shipped, and every file must be signed with your private key.
const SAFE_FIELDS = new Set(['args', 'permissionArgs', 'permissionInsertAfter', 'parser', 'stdin', 'loginArgs', 'loginHint', 'statusArgs',
  'imageArg', 'imageInsertAfter', 'longPromptViaFile', 'mcp', 'approvals', 'budgetArg']);
const PARSERS = new Set(['text', 'claude-stream', 'codex-json', 'opencode-json']);

function isStrArr(a) { return Array.isArray(a) && a.every((x) => typeof x === 'string'); }
function sanitizeTool(t) {
  const out = {};
  for (const [k, v] of Object.entries(t || {})) {
    if (!SAFE_FIELDS.has(k)) continue;
    if (['args', 'loginArgs', 'statusArgs'].includes(k) && !isStrArr(v)) continue;
    if (k === 'permissionArgs' && !(v && typeof v === 'object' && Object.values(v).every(isStrArr))) continue;
    if (k === 'parser' && !PARSERS.has(v)) continue;
    if (['permissionInsertAfter', 'imageInsertAfter'].includes(k) && !Number.isInteger(v)) continue;
    if (['stdin', 'longPromptViaFile'].includes(k) && typeof v !== 'boolean') continue;
    if (['mcp', 'approvals', 'budgetArg', 'imageArg', 'loginHint'].includes(k) && typeof v !== 'string') continue;
    out[k] = v;
  }
  return out;
}

function remoteTools({ dataDir, config }) {
  const file = path.join(dataDir, 'tools.remote.json');
  const enabled = !!(config && config.toolsUrl && config.toolsPublicKey);
  let lastCheck = null;

  function verify(text, sigB64) {
    if (!enabled) return false;
    try { return crypto.verify(null, Buffer.from(text, 'utf8'), config.toolsPublicKey, Buffer.from(String(sigB64).trim(), 'base64')); } catch { return false; }
  }
  function parse(text, minRevision) {
    const j = JSON.parse(text);
    if (!j || !Array.isArray(j.tools) || !Number.isInteger(j.revision)) return null;
    if (j.revision <= minRevision) return null;
    return { revision: j.revision, tools: Object.fromEntries(j.tools.filter((t) => t && typeof t.id === 'string').map((t) => [t.id, sanitizeTool(t)])) };
  }
  // The saved fix, re-verified every time it's used.
  function overrides(bundledRevision) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!verify(saved.text, saved.signature)) return null;
      return parse(saved.text, bundledRevision);
    } catch { return null; }
  }
  async function check(currentRevision) {
    lastCheck = { at: new Date().toISOString(), result: 'skipped' };
    if (!enabled) return lastCheck;
    try {
      const [r1, r2] = await Promise.all([
        fetch(config.toolsUrl, { signal: AbortSignal.timeout(10000), cache: 'no-store' }),
        fetch(config.toolsUrl + '.sig', { signal: AbortSignal.timeout(10000), cache: 'no-store' }),
      ]);
      if (!r1.ok || !r2.ok) throw new Error(`download failed (${r1.status}/${r2.status})`);
      const text = await r1.text(); const sig = await r2.text();
      if (!verify(text, sig)) throw new Error('signature did not match; ignored');
      const parsed = parse(text, currentRevision);
      if (!parsed) { lastCheck.result = 'up to date'; return lastCheck; }
      fs.writeFileSync(file, JSON.stringify({ text, signature: sig.trim(), savedAt: new Date().toISOString() }));
      lastCheck = { ...lastCheck, result: 'updated', revision: parsed.revision };
    } catch (e) { lastCheck = { ...lastCheck, result: 'error', error: e.message }; }
    return lastCheck;
  }
  return { enabled, overrides, check, lastCheck: () => lastCheck };
}

module.exports = { adoptLegacy, migrate, settings, remoteTools, DATA_VERSION };
