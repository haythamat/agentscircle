// Find conversations you had with Claude Code or Codex outside AgentsCircle (they write
// transcripts to disk) and turn one into chat messages, so a circle can continue it.
//   Claude Code: <config dir>/projects/<folder with symbols as ->/<session id>.jsonl
//   Codex:       <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl
// Only text between you and the agent is kept; tool calls and their output are left out.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const MAX_FILE = 60 * 1024 * 1024;   // skip transcripts bigger than this
const CODEX_DAYS = 120;              // how far back to look for Codex sessions
const PER_MESSAGE = 12000;           // longest single message kept

module.exports = function conversations({ accounts }) {
  const refs = new Map(); // opaque id -> { file, kind, source }

  const same = (a, b) => {
    if (!a || !b) return false;
    const n = (p) => path.resolve(p).replace(/[\\/]+$/, '');
    return process.platform === 'win32' || process.platform === 'darwin' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
  };
  const readLines = (file) => {
    const st = fs.statSync(file);
    if (st.size > MAX_FILE) return null;
    return fs.readFileSync(file, 'utf8').split('\n');
  };
  const parse = (l) => { try { return JSON.parse(l); } catch { return null; } };
  // Text the user typed, without the extra context the CLI adds around it.
  const cleanUser = (t) => String(t || '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/g, '')
    .replace(/<user_instructions>[\s\S]*?<\/user_instructions>/g, '')
    .trim();
  const isNoise = (t) => !t || /^(<command-name>|<command-message>|<local-command-std|<command-args>|Caveat: The messages below|\[Request interrupted)/.test(t) || /^# AGENTS\.md instructions/.test(t);
  // AgentsCircle's own runs also leave transcripts; don't offer those back.
  const isOurs = (firstUser) => /^You are @[a-z0-9_-]+ \(.+\), one AI coding agent in a shared group chat/.test(firstUser || '') || /^You are writing a hand-off summary of a group chat/.test(firstUser || '');
  const textOf = (content, types) => (typeof content === 'string' ? content : Array.isArray(content) ? content.filter((b) => types.includes(b.type) && b.text).map((b) => b.text).join('\n') : '');

  // ---------- Claude Code ----------
  function claudeRoots() {
    const roots = new Map();
    const add = (dir, label) => { if (dir && fs.existsSync(path.join(dir, 'projects')) && !roots.has(dir)) roots.set(dir, label); };
    add(process.env.CLAUDE_CONFIG_DIR, 'Claude Code');
    add(path.join(os.homedir(), '.claude'), 'Claude Code');
    for (const a of accounts.list()) {
      const t = accounts.tool(a);
      if (t.id === 'claude' && a.configDir) add(a.configDir, `Claude Code (@${a.id})`);
    }
    return roots;
  }
  function readClaude(file) {
    const lines = readLines(file); if (!lines) return null;
    const msgs = []; let cwd = null; let id = path.basename(file, '.jsonl');
    for (const l of lines) {
      const o = parse(l); if (!o) continue;
      if (o.isSidechain || o.isMeta) continue;
      if (o.cwd && !cwd) cwd = o.cwd;
      if (o.sessionId && id === path.basename(file, '.jsonl')) id = o.sessionId;
      const m = o.message || {};
      if (o.type === 'user' && o.isCompactSummary) { msgs.push({ role: 'summary', text: textOf(m.content, ['text']), at: o.timestamp }); continue; }
      if (o.type === 'user' && m.role === 'user') {
        if (Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result')) continue;
        const t = cleanUser(textOf(m.content, ['text']));
        if (!isNoise(t)) msgs.push({ role: 'user', text: t, at: o.timestamp });
      } else if (o.type === 'assistant' && m.role === 'assistant') {
        const t = textOf(m.content, ['text']).trim();
        if (!t) continue;
        const prev = msgs[msgs.length - 1];
        if (prev && prev.role === 'assistant' && prev.mid && prev.mid === m.id) prev.text += '\n' + t; // one reply split over several records
        else msgs.push({ role: 'assistant', text: t, at: o.timestamp, mid: m.id });
      }
    }
    return { id, cwd, msgs };
  }
  function listClaude(folder) {
    const out = [];
    const encoded = path.resolve(folder).replace(/[^a-zA-Z0-9]/g, '-');
    for (const [root, label] of claudeRoots()) {
      const pdir = path.join(root, 'projects');
      let dirs = [];
      try { dirs = fs.readdirSync(pdir); } catch { continue; }
      // The folder name is the project path with symbols turned into "-". Check the exact
      // match first and confirm with the cwd recorded inside.
      for (const d of dirs.filter((x) => x.toLowerCase() === encoded.toLowerCase())) {
        for (const f of fs.readdirSync(path.join(pdir, d)).filter((x) => x.endsWith('.jsonl'))) {
          const file = path.join(pdir, d, f);
          try {
            const c = readClaude(file);
            if (!c || (c.cwd && !same(c.cwd, folder))) continue;
            const users = c.msgs.filter((m) => m.role === 'user');
            if (!users.length || isOurs(users[0].text)) continue;
            out.push(entry('claude', label, file, c));
          } catch { /* unreadable transcript */ }
        }
      }
    }
    return out;
  }

  // ---------- Codex ----------
  function codexRoots() {
    const roots = new Map();
    const add = (dir, label) => { if (dir && fs.existsSync(path.join(dir, 'sessions')) && !roots.has(dir)) roots.set(dir, label); };
    add(process.env.CODEX_HOME, 'Codex');
    add(path.join(os.homedir(), '.codex'), 'Codex');
    for (const a of accounts.list()) {
      const t = accounts.tool(a);
      if (t.id === 'codex' && a.configDir) add(a.configDir, `Codex (@${a.id})`);
    }
    return roots;
  }
  function readCodex(file, headOnly) {
    let lines;
    if (headOnly) {
      const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(64 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
      lines = buf.slice(0, n).toString('utf8').split('\n').slice(0, -1);
    } else lines = readLines(file);
    if (!lines) return null;
    const msgs = []; let cwd = null; let id = null;
    for (const l of lines) {
      const o = parse(l); if (!o) continue;
      if (o.type === 'session_meta' && o.payload) { cwd = o.payload.cwd || cwd; id = o.payload.id || id; continue; }
      const it = o.type === 'response_item' ? o.payload : (o.type === 'message' ? o : null);
      if (!it || it.type !== 'message') continue;
      const raw = textOf(it.content, ['input_text', 'output_text', 'text']);
      if (!cwd) { const mm = /<cwd>([^<]+)<\/cwd>/.exec(raw); if (mm) cwd = mm[1].trim(); }
      if (it.role === 'user') { const t = cleanUser(raw); if (!isNoise(t)) msgs.push({ role: 'user', text: t, at: o.timestamp }); }
      else if (it.role === 'assistant' && raw.trim()) msgs.push({ role: 'assistant', text: raw.trim(), at: o.timestamp });
    }
    return { id: id || path.basename(file, '.jsonl'), cwd, msgs };
  }
  function listCodex(folder) {
    const out = [];
    const since = Date.now() - CODEX_DAYS * 86400000;
    for (const [root, label] of codexRoots()) {
      const files = [];
      const walk = (dir, depth) => {
        let names = []; try { names = fs.readdirSync(dir); } catch { return; }
        for (const n of names) {
          const p = path.join(dir, n);
          if (depth < 3) { if (/^\d+$/.test(n)) walk(p, depth + 1); continue; }
          if (n.endsWith('.jsonl')) { try { const st = fs.statSync(p); if (st.mtimeMs >= since) files.push(p); } catch { /* gone */ } }
        }
      };
      walk(path.join(root, 'sessions'), 0);
      for (const file of files) {
        try {
          const head = readCodex(file, true);
          if (!head || !same(head.cwd, folder)) continue;
          const c = readCodex(file, false);
          const users = c.msgs.filter((m) => m.role === 'user');
          if (!users.length || isOurs(users[0].text)) continue;
          out.push(entry('codex', label, file, c));
        } catch { /* unreadable transcript */ }
      }
    }
    return out;
  }

  function entry(kind, source, file, c) {
    const ref = crypto.createHash('sha256').update(file).digest('hex').slice(0, 20);
    refs.set(ref, { file, kind, source });
    const st = fs.statSync(file);
    const firstUser = c.msgs.find((m) => m.role === 'user');
    return {
      ref, kind, source, sessionId: c.id,
      title: firstUser.text.replace(/\s+/g, ' ').slice(0, 140),
      messages: c.msgs.filter((m) => m.role !== 'summary').length,
      updatedAt: new Date(st.mtimeMs).toISOString(),
      resume: kind === 'claude' ? `claude --resume ${c.id}` : `codex resume ${c.id}`,
    };
  }

  // Everything found for one project folder, newest first.
  function list(folder) {
    const all = [...listClaude(folder), ...listCodex(folder)];
    return all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 50);
  }

  // The conversation as chat messages for a circle.
  function read(ref) {
    const r = refs.get(ref);
    if (!r) throw new Error('That conversation is no longer in the list. Open the list again.');
    const c = r.kind === 'claude' ? readClaude(r.file) : readCodex(r.file, false);
    if (!c) throw new Error('That conversation is too large to bring in.');
    const tool = r.kind === 'claude' ? 'Claude Code' : 'Codex';
    const msgs = c.msgs.map((m) => ({ ...m, text: m.text.length > PER_MESSAGE ? m.text.slice(0, PER_MESSAGE) + '\n…(cut)' : m.text }));
    return { tool, source: r.source, sessionId: c.id, msgs };
  }

  return { list, read };
};
