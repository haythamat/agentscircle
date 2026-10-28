// How much each account has used, read from the files the CLIs already write on this computer.
//   Codex records your plan's limits in its session files (rate_limits: % of the 5-hour and
//   weekly windows used, and when they reset), so Codex accounts get real percentages.
//   Claude Code records tokens per reply but not your plan's limits, so Claude accounts get
//   token totals for the current 5-hour window and the last 7 days, and when the window resets.
// Only usage from this computer is counted for Claude; Codex's percentages are account-wide.

const fs = require('fs');
const os = require('os');
const path = require('path');

const DAY = 86400000;
const WINDOW = 5 * 3600000;

module.exports = function createUsage({ accounts }) {
  const fileCache = new Map(); // file -> { mtimeMs, size, data }

  const recentFiles = (dir, maxDepth, since) => {
    const out = [];
    const walk = (d, depth) => {
      let names = []; try { names = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const n of names) {
        const p = path.join(d, n.name);
        if (n.isDirectory()) { if (depth < maxDepth) walk(p, depth + 1); continue; }
        if (!n.name.endsWith('.jsonl')) continue;
        try { const st = fs.statSync(p); if (st.mtimeMs >= since) out.push({ p, st }); } catch { /* gone */ }
      }
    };
    walk(dir, 0);
    return out;
  };
  const cached = (p, st, parse) => {
    const c = fileCache.get(p);
    if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c.data;
    let data = null;
    try { data = st.size > 80 * 1024 * 1024 ? null : parse(fs.readFileSync(p, 'utf8')); } catch { data = null; }
    fileCache.set(p, { mtimeMs: st.mtimeMs, size: st.size, data });
    return data;
  };

  // ---------- Claude Code ----------
  function claudeEntries(text) {
    const out = [];
    for (const line of text.split('\n')) {
      if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      const m = o.message || {};
      if (o.type !== 'assistant' || !m.usage || !o.timestamp) continue;
      const u = m.usage;
      out.push({ id: `${m.id || ''}:${o.requestId || ''}`, t: Date.parse(o.timestamp), input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0), output: u.output_tokens || 0, cached: u.cache_read_input_tokens || 0 });
    }
    return out;
  }
  function claude(agent, nowMs) {
    const dir = agent.configDir || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    const since = nowMs - 7 * DAY;
    const seen = new Set();
    const all = [];
    for (const { p, st } of recentFiles(path.join(dir, 'projects'), 2, since)) {
      for (const e of cached(p, st, claudeEntries) || []) {
        if (e.t < since || seen.has(e.id)) continue; // one reply is written in several records
        seen.add(e.id); all.push(e);
      }
    }
    all.sort((a, b) => a.t - b.t);
    // Claude Code's 5-hour window starts with the first message after the previous one ended.
    let start = null;
    for (const e of all) if (start === null || e.t >= start + WINDOW) start = e.t;
    const active = start !== null && nowMs < start + WINDOW;
    const sum = (list) => list.reduce((a, e) => ({ input: a.input + e.input, output: a.output + e.output, cached: a.cached + e.cached, replies: a.replies + 1 }), { input: 0, output: 0, cached: 0, replies: 0 });
    return {
      kind: 'tokens',
      window: active ? { ...sum(all.filter((e) => e.t >= start)), startedAt: new Date(start).toISOString(), resetsAt: new Date(start + WINDOW).toISOString() } : null,
      week: sum(all),
      source: dir,
    };
  }

  // ---------- Codex ----------
  function codexLimits(text) {
    let last = null;
    for (const line of text.split('\n')) {
      if (!line.includes('"rate_limits"')) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      const rl = (o.payload && o.payload.rate_limits) || o.rate_limits;
      if (rl && (rl.primary || rl.secondary)) last = { t: Date.parse(o.timestamp) || null, rl };
    }
    return last;
  }
  function codexWindow(w, t, nowMs) {
    if (!w || typeof w.used_percent !== 'number') return null;
    let resets = null;
    if (typeof w.resets_at === 'number') resets = w.resets_at * 1000;
    else if (typeof w.resets_in_seconds === 'number' && t) resets = t + w.resets_in_seconds * 1000;
    const over = resets !== null && resets <= nowMs; // the window has reset since this was recorded
    return { usedPercent: over ? 0 : Math.round(w.used_percent), windowMinutes: w.window_minutes || null, resetsAt: resets && !over ? new Date(resets).toISOString() : null };
  }
  function codex(agent, nowMs) {
    const dir = agent.configDir || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    const files = recentFiles(path.join(dir, 'sessions'), 3, nowMs - 8 * DAY).sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
    for (const { p, st } of files.slice(0, 15)) {
      const r = cached(p, st, codexLimits);
      if (!r) continue;
      const a = codexWindow(r.rl.primary, r.t, nowMs), b = codexWindow(r.rl.secondary, r.t, nowMs);
      const label = (w) => (w && w.windowMinutes ? (w.windowMinutes <= 600 ? `${Math.round(w.windowMinutes / 60)}-hour` : w.windowMinutes >= 10000 ? 'weekly' : `${Math.round(w.windowMinutes / 1440)}-day`) : null);
      return { kind: 'percent', recordedAt: r.t ? new Date(r.t).toISOString() : null, windows: [a && { name: label(a) || 'short', ...a }, b && { name: label(b) || 'long', ...b }].filter(Boolean), source: dir };
    }
    return { kind: 'percent', windows: [], source: dir };
  }

  let last = { at: 0, data: null };
  function all() {
    const nowMs = Date.now();
    if (last.data && nowMs - last.at < 20000) return last.data;
    const out = {};
    for (const a of accounts.list()) {
      const t = accounts.tool(a);
      try {
        if (t.id === 'claude') out[a.id] = claude(a, nowMs);
        else if (t.id === 'codex') out[a.id] = codex(a, nowMs);
      } catch { /* unreadable: skip this account */ }
      if (out[a.id] && a.limitedAt) out[a.id].limitedUntil = accounts.benched(a) ? a.limitedUntil || null : null;
    }
    last = { at: nowMs, data: out };
    return out;
  }
  return { all, clear: () => { last = { at: 0, data: null }; } };
};
