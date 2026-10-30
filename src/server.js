// AgentsCircle — a local group chat for AI coding agents.
// Runs on your computer, launches each agent's own CLI in your project folder,
// and keeps one shared transcript that every agent sees.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const spawn = require('cross-spawn');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.AGENTSCIRCLE_PORT || 4317);
const DATA_DIR = process.env.AGENTSCIRCLE_HOME || path.join(os.homedir(), '.agentscircle');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const CONTEXT_BUDGET = 60000; // max characters of transcript sent to an agent
const PER_MESSAGE_CAP = 6000;
const IS_WIN = process.platform === 'win32';

fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// Installed app: find the agents the way your terminal does, and upgrade old data safely.
const platform = require('./platform');
if (process.env.AGENTSCIRCLE_DESKTOP) require('./shell-path').fixPath();
if (!process.env.AGENTSCIRCLE_HOME) platform.adoptLegacy(DATA_DIR, path.join(os.homedir(), '.agentroom'));
const migration = platform.migrate(DATA_DIR);
const appSettings = platform.settings(DATA_DIR);
const PKG = require('../package.json');
const remoteTools = platform.remoteTools({ dataDir: DATA_DIR, config: PKG.agentscircle || {} });

// ---------- helpers ----------
const expandHome = (p) => (typeof p === 'string' && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
const now = () => new Date().toISOString();
const uid = () => crypto.randomBytes(6).toString('hex');

function run(cmd, args, cwd) {
  const r = spawn.sync(cmd, args, { cwd, encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? (r.stdout || '').trim() : null;
}

// ---------- agents (accounts) ----------
const vault = require('./secrets')(DATA_DIR);
const accounts = require('./accounts')({ root: ROOT, dataDir: DATA_DIR, remote: remoteTools, vault });
const VERSION = require('../package.json').version;
// Connector sign-in (OAuth) is done once by AgentsCircle; agents reach signed-in connectors through
// the local proxy below, which adds the sign-in. The proxy key only works on this computer, this run.
const PROXY_SECRET = crypto.randomBytes(24).toString('hex');
const oauth = require('./oauth')({
  dataDir: DATA_DIR, vault, version: VERSION, redirectUri: `http://127.0.0.1:${PORT}/oauth/callback`, openUrl,
  onUpdate: (f) => { broadcastAll({ type: 'connector-signin', flow: f }); },
});
const connectors = require('./connectors')({ dataDir: DATA_DIR, accounts, version: VERSION, vault, oauth, proxy: { base: `http://127.0.0.1:${PORT}/mcp-proxy`, secret: PROXY_SECRET } });
const broadcastConnectors = () => broadcastAll({ type: 'connectors', connectors: connectors.list() });
const skills = require('./skills')({ dataDir: DATA_DIR, accounts });
const worktrees = require('./worktrees')({ dataDir: DATA_DIR });
const conversations = require('./conversations')({ accounts });
const usage = require('./usage')({ accounts });
const health = require('./health')({ accounts });
const models = require('./models')({ accounts });
// Open a link in your browser (the sign-in pages).
function openUrl(url) {
  if (!/^https:\/\//.test(url)) return;
  try { const { shell } = require('electron'); if (shell && shell.openExternal) return void shell.openExternal(url); } catch { /* not in the desktop app */ }
  const cmd = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try { spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch { /* the app shows the link */ }
}
const signin = require('./signin')({ accounts, openUrl, onUpdate: (f) => broadcastAll({ type: 'signin', flow: f }) });
const github = require('./github')({ settings: appSettings });
const siteIcons = require('./site-icons')({ dataDir: DATA_DIR });
const agentById = (id) => accounts.get(id);
const agentsPayload = () => accounts.list().map(accounts.publicAgent);
const broadcastAgents = () => { broadcastAll({ type: 'agents', agents: agentsPayload() }); broadcastConnectors(); };
accounts.refreshAll().then(broadcastAgents).then(() => setTimeout(checkAccountsInBackground, 4000));
// On start, check accounts that were never checked, last failed, or weren't checked for a day,
// one at a time, so a signed-out account shows up in Settings and on its chip before you need it.
async function checkAccountsInBackground() {
  if (process.env.AGENTSCIRCLE_NO_STARTUP_CHECK) return;
  const day = 24 * 3600 * 1000;
  for (const a of accounts.list()) {
    const t = accounts.tool(a);
    if (!t.installed || !['claude', 'codex'].includes(t.id) || a.apiKeyLocked) continue;
    const h = a.health;
    if (h && h.state === 'ok' && Date.now() - new Date(h.checkedAt).getTime() < day) continue;
    try { accounts.setHealth(a, await health.verify(a)); broadcastAgents(); } catch { /* next one */ }
  }
}

// Check for signed agent-settings fixes now and every 6 hours.
async function checkToolFixes() {
  const r = await remoteTools.check(accounts.toolsInfo().revision);
  if (r.result === 'updated') { accounts.load(); await accounts.refreshAll().catch(() => {}); broadcastAgents(); console.log(`Agent settings updated to revision ${r.revision}.`); }
  return r;
}
setTimeout(() => checkToolFixes().catch(() => {}), 3000);
setInterval(() => checkToolFixes().catch(() => {}), 6 * 60 * 60 * 1000).unref();

// ---------- sessions ----------
const sessions = new Map();
const sessionFile = (id) => path.join(SESSIONS_DIR, `${id}.json`);

function loadSessions() {
  for (const f of fs.readdirSync(SESSIONS_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
      s.queue = []; s.runs = new Map(); s.summarizing = false;
      delete s.running; delete s.pumping; delete s.stopRequested;
      // A turn that was running when AgentsCircle closed can't finish now.
      for (const m of s.messages || []) if (m.pending) { m.pending = false; m.waiting = false; m.status = 'stopped'; m.text = (m.text || '') + '\n\n_(AgentsCircle was closed while this agent was working)_'; }
      sessions.set(s.id, s);
    } catch { /* skip broken file */ }
  }
}
loadSessions();

function saveSession(s) {
  const { queue, running, pumping, stopRequested, runs, summarizing, ...persist } = s;
  fs.writeFileSync(sessionFile(s.id), JSON.stringify(persist, null, 2));
}

const summary = (s) => ({ id: s.id, name: s.name, folder: s.folder, members: s.members, updatedAt: s.updatedAt, busy: busy(s), waiting: s.messages.some((m) => m.pending && m.waiting), running: runningIds(s), handoffs: s.handoffs !== false, summarized: s.summary ? s.summary.count : 0, context: contextInfo(s), agentModels: s.agentModels || {}, mode: s.mode === 'parallel' ? 'parallel' : 'shared' });

// ---------- websocket broadcast ----------
const subscribers = new Map(); // sessionId -> Set<ws>
function broadcast(sessionId, event) {
  const set = subscribers.get(sessionId);
  if (!set) return;
  const data = JSON.stringify(event);
  for (const ws of set) if (ws.readyState === 1) ws.send(data);
}

function broadcastAll(event) {
  const data = JSON.stringify(event);
  for (const set of subscribers.values()) for (const ws of set) if (ws.readyState === 1) ws.send(data);
  for (const ws of idleClients) if (ws.readyState === 1) ws.send(data);
}
const idleClients = new Set();

function addMessage(s, msg) {
  const m = { id: uid(), at: now(), ...msg };
  s.messages.push(m);
  s.updatedAt = m.at;
  saveSession(s);
  broadcast(s.id, { type: 'message', message: m });
  return m;
}

// ---------- session context (text, files and images the user gives the whole session) ----------
const CONTEXT_TEXT_CAP = 40000;
const ctxOf = (s) => (s.context ||= { text: '', files: [] });
const contextInfo = (s) => { const c = s.context || {}; return { files: (c.files || []).length, text: !!(c.text || '').trim() }; };
const contextDir = (s) => path.join(s.folder, '.agentscircle', 'context', s.id);

function updateMessage(s, m, patch, persist = false) {
  const wasWaiting = !!m.waiting;
  Object.assign(m, patch);
  if (persist) saveSession(s);
  broadcast(s.id, { type: 'update', id: m.id, patch });
  if ('waiting' in patch && !!patch.waiting !== wasWaiting) broadcastAttention();
}

// ---------- needs you: everything waiting for the user, across all sessions ----------
function attention() {
  const items = [];
  for (const s of sessions.values()) {
    for (const m of s.messages) {
      if (!m.pending || !m.waiting) continue;
      const q = (m.questions || []).find((x) => x.status === 'pending');
      const a = (m.approvals || []).find((x) => x.status === 'pending');
      items.push({ sessionId: s.id, sessionName: s.name, messageId: m.id, agent: m.agent, kind: q ? 'question' : 'approval', text: q ? q.question : a ? a.summary : '', at: (q || a || m).at });
    }
  }
  return items.sort((x, y) => String(x.at).localeCompare(String(y.at)));
}
function broadcastAttention() { broadcastAll({ type: 'attention', items: attention() }); }
// A moment worth telling the user about (the page decides whether to show a notification).
function notifyUser(s, ev) { broadcastAll({ type: 'notify', sessionId: s.id, sessionName: s.name, ...ev }); }

// ---------- context ----------
function projectState(folder) {
  if (!run('git', ['rev-parse', '--is-inside-work-tree'], folder)) return '(not a git repository)';
  const branch = run('git', ['branch', '--show-current'], folder) || '?';
  const status = run('git', ['status', '--short'], folder) || '(clean)';
  const log = run('git', ['log', '--oneline', '-5'], folder) || '';
  return `branch: ${branch}\nuncommitted changes:\n${status.slice(0, 3000)}\nrecent commits:\n${log}`;
}

function speaker(m) {
  if (m.role === 'user') return 'USER';
  if (m.role === 'agent') return `@${m.agent}`;
  if (m.role === 'handoff') return `@${m.agent} → @${m.to}`;
  if (m.role === 'external') return m.from === 'user' ? `USER (earlier, in ${m.tool})` : m.from === 'summary' ? `SUMMARY OF AN EARLIER PART (from ${m.tool})` : `${m.tool.toUpperCase()} (earlier, before this circle)`;
  return 'SYSTEM';
}

const HOP_LIMIT = 4;
// What Claude Code, Codex, Cursor and OpenCode print when their saved sign-in no longer works.
const SIGNIN_RE = /failed to authenticate|oauth (session|token)[^\n]*(expired|invalid|revoked)|session expired|not (logged|signed) in|please (log|sign) ?in|(run|use) [`'"]?\S*\s*(\/)?login|invalid (api key|x-api-key|bearer token)|authentication (failed|required|error)|401 unauthorized|token (has )?expired/i;          // agent-to-agent hand-offs per message from you
const RECENT_KEEP = 25000;    // characters of recent chat kept word for word when summarizing

const attachLine = (m) => (m.attachments && m.attachments.length ? `\n(attached: ${m.attachments.map((a) => a.path).join(', ')})` : '');
function blockFor(m) {
  let text = (m.text || '').trim();
  if (text.length > PER_MESSAGE_CAP) text = text.slice(0, PER_MESSAGE_CAP) + '\n…(truncated)';
  return `[${speaker(m)}]\n${text}${attachLine(m)}${m.changes ? `\n(files changed: ${m.changes})` : ''}${m.undone ? '\n(this turn was later undone by the user)' : ''}`;
}
// Messages that still count as conversation (after the last summary).
function liveMessages(s) {
  const start = s.summary ? s.messages.findIndex((m) => m.id === s.summary.upTo) + 1 : 0;
  return s.messages.slice(Math.max(0, start)).filter((m) => !m.pending && m.kind !== 'summary' && (m.text || '').trim());
}

function buildPrompt(s, agent, triggerMsg, wt, circleTools = false) {
  const others = s.members.filter((id) => id !== agent.id).map((id) => `@${id}`).join(', ') || 'none';
  const history = [];
  let used = 0;
  const live = liveMessages(s);
  for (let i = live.length - 1; i >= 0; i--) {
    const m = live[i];
    if (m.id === triggerMsg.id) continue;
    const block = blockFor(m);
    if (used + block.length > CONTEXT_BUDGET) { history.unshift('…(older messages omitted)'); break; }
    history.unshift(block);
    used += block.length;
  }

  const tool = accounts.tool(agent);
  const sharedSkills = skills.shared(s.folder);
  const handoffsOn = s.handoffs !== false && s.members.length > 1;
  return [
    `You are @${agent.id} (${tool.name}), one AI coding agent in a shared group chat with a human developer and other agents (${others}).`,
    ...(wt ? [
      `You work in your own copy of the project (a git worktree) at ${wt.dir}, on branch ${wt.branch}. Other agents work at the same time on their own branches; the user compares the results and applies the ones they want to the main folder (${s.folder}).`,
      `Your copy started from a snapshot of the user's folder. Ignored folders (node_modules, build output) aren't copied; install dependencies in your copy if you need to run things. Commit if you like; don't push.`,
    ] : [
      `Everyone works in the same project folder: ${s.folder}`,
      `Other agents may have edited files since your last turn, so check the actual files instead of relying on memory.`,
    ]),
    `Use your own skills, tools and connectors when the task calls for them.`,
    `Your permission level in AgentsCircle: ${safety.LEVELS[agent.permission || 'risky']}.${tool.approvals === 'prompt-tool' && (agent.permission || 'risky') !== 'full' ? ' Some actions wait for the user to approve them in the chat; if one is denied, don\'t retry it, explain and continue.' : ''}`,
    ...(() => {
      const shared = connectors.supports(tool) ? connectors.forAgent(agent).map((c) => c.name) : [];
      return shared.length ? [`Connectors shared through AgentsCircle (MCP servers) available to you: ${shared.join(', ')}.`] : [];
    })(),
    ...(circleTools ? [`You have AgentsCircle tools (the "agentscircle" connector): read_thread for older messages, list_agents to see who is here and what they can do, ask_user to ask the user a question with options when you truly can't decide, commit and push to commit and push changes with git when the user asks (use them instead of running git commit or git push yourself; your sandbox may block .git or the network)${handoffsOn ? ', and mention to hand a task to another agent' : ''}.`] : []),
    ...(handoffsOn ? [circleTools
      ? `To hand part of the work to another agent, call the mention tool. Only hand off when another agent is clearly better placed or the user asked for it. Don't hand back and forth.`
      : `To hand part of the work to another agent, end your reply with one line per hand-off, exactly like: "@codex: write tests for the login form". Only hand off when another agent is clearly better placed or the user asked for it. Don't hand back and forth.`] : []),
    '', '### FILES YOU MAKE FOR THE USER',
    'When the user asks for something to keep, share or look at (a document, report, list, table, chart, comparison, plan), save it as a file inside the project folder, not only in the chat, and pick the format that fits. The user sees it in the AgentsCircle panel, which previews HTML, Markdown, Word, Excel, CSV, PDF and images, and can export to Word, PDF and Excel:',
    '- Anything with a chart, dashboard, comparison or interaction: one self-contained .html file (inline CSS and JS; charts with Chart.js from https://cdn.jsdelivr.net/npm/chart.js), polished and readable, with the data in a table too.',
    '- Data the user will sort, filter or calculate with: .xlsx (headers in row 1, real numbers, not text). Use .csv only if you can\'t write .xlsx.',
    '- Documents to send, print or edit (reports, letters, proposals, briefs): .docx. If you can\'t write .docx, write clean Markdown; the user can export it to Word or PDF from the panel.',
    '- Markdown (.md) only for notes, READMEs and docs that live with the code.',
    'If the user names a format, use it. For example, "a list of companies with a chart" is an .html page with the table and the chart (plus an .xlsx of the data when that helps). For .docx and .xlsx you can use python-docx/openpyxl or the docx/exceljs npm packages. Say the file name in your reply.',
    ...(sharedSkills.length ? ['', '### SHARED SKILLS', 'Before a task that matches one of these, read its SKILL.md and follow it:', ...sharedSkills.map((k) => `- ${k.name}: ${k.description} (${k.file})`)] : []),
    ...contextBlock(s, wt),
    '',
    '### PROJECT STATE',
    projectState(wt ? wt.dir : s.folder),
    ...(s.summary ? ['', '### SUMMARY OF THE EARLIER CONVERSATION', s.summary.text] : []),
    '',
    '### CONVERSATION SO FAR',
    history.length ? history.join('\n\n') : '(this is the first message)',
    '',
    '### NEW MESSAGE FOR YOU',
    `[${speaker(triggerMsg)}]`,
    triggerMsg.text,
    ...(triggerMsg.attachments && triggerMsg.attachments.length ? ['', wt ? 'Attached files (open them):' : 'Attached files (paths inside the project folder; open them):', ...triggerMsg.attachments.map((a) => `- ${wt ? path.join(s.folder, a.path) : a.path}${a.kind === 'image' ? ' (image)' : ''}`)] : []),
    '',
    'Do what the new message asks. When you finish, reply briefly: what you did, which files you changed, and anything the other agents should know.',
    'End your reply with one last line exactly like "Status: <where things stand, in under 12 words>".',
  ].join('\n');
}

function contextBlock(s, wt) {
  const c = s.context || {};
  const text = (c.text || '').trim();
  const files = c.files || [];
  if (!text && !files.length) return [];
  return ['', '### SESSION CONTEXT (from the user, for the whole session)',
    'The user attached this to the session so every agent works with it. Treat it as background for every task here.',
    ...(text ? ['', text] : []),
    ...(files.length ? ['', 'Context files (open the ones that matter for your task; images are screenshots or designs):',
      ...files.map((f) => `- ${wt ? path.join(s.folder, f.path) : f.path}${f.kind === 'image' ? ' (image)' : ''}${f.name && f.name !== path.basename(f.path) ? ` "${f.name}"` : ''}`)] : [])];
}

// Which files did this agent touch? Compare git state before and after its turn.
function gitSnapshot(folder) {
  const r = spawn.sync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: folder, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return null;
  const files = new Map();
  for (const line of (r.stdout || '').split(/\r?\n/)) {
    if (line.length < 4) continue;
    let file = line.slice(3);
    if (file.includes(' -> ')) file = file.split(' -> ')[1];
    file = file.replace(/^"|"$/g, '');
    const code = line.slice(0, 2);
    let mtime = null;
    try { mtime = fs.statSync(path.join(folder, file)).mtimeMs; } catch { /* deleted */ }
    files.set(file, { sig: `${code}:${mtime}`, code, mtime });
  }
  return { head: run('git', ['rev-parse', 'HEAD'], folder), files };
}

// Folders without git: compare file times and sizes instead (skipping dependency and build folders).
const SKIP_DIRS = new Set(['.git', 'node_modules', '.agentscircle', '.next', '.nuxt', 'dist', 'build', 'out', '.venv', 'venv', '__pycache__', '.cache', '.turbo', 'target', 'Pods', 'DerivedData', '.gradle', '.idea', '.vscode']);
function fsSnapshot(folder) {
  const files = new Map();
  const walk = (dir, rel, depth) => {
    if (files.size > 20000 || depth > 8) return;
    let list; try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of list) {
      if (files.size > 20000) return;
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) { if (!SKIP_DIRS.has(d.name) && !d.name.startsWith('.Trash')) walk(path.join(dir, d.name), r, depth + 1); }
      else if (d.isFile()) { try { const st = fs.statSync(path.join(dir, d.name)); files.set(r, { sig: `F:${st.mtimeMs}:${st.size}`, code: '??', mtime: st.mtimeMs }); } catch { /* gone */ } }
    }
  };
  walk(folder, '', 0);
  return { head: null, files, fs: true };
}
const changeSnapshot = (folder) => gitSnapshot(folder) || fsSnapshot(folder);

// Files the agent said it wrote (Write/Edit tools, Codex file changes) that the snapshots missed,
// for example files git ignores. Only files inside the folder.
function writtenByTools(folder, tools, known, startedMs) {
  const out = [];
  for (const t of tools || []) {
    if (!/^(Write|Edit|MultiEdit|NotebookEdit|str_replace_based_edit_tool|create_file|write_file|edit_file|apply_patch|file_change)$/i.test(t.name || '') || !t.hint) continue;
    for (const raw of String(t.hint).split(/[\n,]+/).map((x) => x.trim()).filter(Boolean)) {
      const abs = path.resolve(folder, raw);
      const rel = path.relative(folder, abs).split(path.sep).join('/');
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || known.has(rel)) continue;
      let st; try { st = fs.statSync(abs); } catch { continue; }
      if (!st.isFile()) continue;
      known.add(rel);
      out.push({ path: rel, status: (st.birthtimeMs || st.ctimeMs) >= startedMs - 2000 ? 'added' : 'modified' });
    }
  }
  return out;
}

function describeChanges(folder, before, after) {
  if (!before || !after) return { summary: null, files: [] };
  const touched = new Map();
  const exists = (f) => fs.existsSync(path.join(folder, f));
  for (const [file, cur] of after.files) {
    const prev = before.files.get(file);
    if (prev && prev.sig === cur.sig) continue;
    const isNew = cur.code.includes('?') || cur.code.includes('A');
    touched.set(file, !exists(file) ? 'deleted' : isNew && !prev ? 'added' : 'modified');
  }
  for (const [file, prev] of before.files) {
    if (after.files.has(file) || touched.has(file)) continue;
    // Gone from git status: either committed as-is (not this agent's edit), changed then committed, reverted, or deleted.
    let mtime = null;
    try { mtime = fs.statSync(path.join(folder, file)).mtimeMs; } catch { /* deleted */ }
    if (mtime === null) touched.set(file, 'deleted');
    else if (mtime !== prev.mtime) touched.set(file, 'modified');
  }
  let commits = [];
  if (before.head && after.head && before.head !== after.head) {
    const ns = run('git', ['diff', '--name-status', before.head, after.head], folder) || '';
    for (const line of ns.split('\n')) {
      const [st, ...rest] = line.split('\t');
      if (!st || !rest.length) continue;
      const file = rest.at(-1);
      if (!touched.has(file) && !before.files.has(file)) touched.set(file, st.startsWith('A') ? 'added' : st.startsWith('D') ? 'deleted' : 'modified');
    }
    commits = (run('git', ['log', '--format=%h %s', `${before.head}..${after.head}`], folder) || '').split('\n').filter(Boolean).slice(0, 10);
  }
  const files = [...touched].map(([p, status]) => ({ path: p, status }));
  if (!files.length && !commits.length) return { summary: null, files: [], commits };
  const shown = files.slice(0, 8).map((f) => f.path).join(', ');
  const summary = files.length ? `${files.length} file${files.length > 1 ? 's' : ''}: ${shown}${files.length > 8 ? ', …' : ''}` : null;
  return { summary, files, commits };
}

// ---------- output parsers ----------
// Turns each tool's output into: reply text, live activity lines, and structured events
// (tools, skills, connectors, task lists, token usage) for the session panel.
function classifyTool(name, input = {}) {
  const hint = String(input.file_path || input.path || input.command || input.pattern || input.url || input.query || input.description || '').slice(0, 160);
  const ev = { name, hint };
  if (name === 'Skill') ev.skill = input.skill || input.command || input.name || 'skill';
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  if (mcp) { ev.connector = mcp[1]; ev.connectorTool = mcp[2]; }
  if (/^(Task|Agent)$/.test(name)) ev.subagent = input.subagent_type || input.description || 'subagent';
  if (/^(WebSearch|WebFetch)$/.test(name)) ev.web = true;
  return ev;
}

// Codex `exec --json`: one JSON event per line (thread/turn/item events).
function makeCodexParser(onText, onActivity, onEvent) {
  let buf = '';
  const seen = new Set();
  const todos = (items) => {
    let firstOpen = true;
    return items.map((x) => {
      let status = x.completed ? 'completed' : 'pending';
      if (!x.completed && firstOpen) { status = 'in_progress'; firstOpen = false; }
      return { content: x.text, status };
    });
  };
  const handle = (line) => {
    if (!line.trim()) return;
    let ev;
    try { ev = JSON.parse(line); } catch { return onActivity(line); }
    const it = ev.item || {};
    if (ev.type === 'item.started' || ev.type === 'item.updated' || ev.type === 'item.completed') {
      if (it.type === 'todo_list' && Array.isArray(it.items)) onEvent({ type: 'todos', todos: todos(it.items) });
      if (ev.type === 'item.completed' && it.type === 'agent_message' && it.text) onText(it.text + '\n');
      if (seen.has(it.id)) return;
      if (it.type === 'command_execution' && it.command) {
        seen.add(it.id);
        onEvent({ type: 'tool', ...classifyTool('Bash', { command: it.command }) });
        onActivity(`$ ${String(it.command).slice(0, 140)}`);
      } else if (it.type === 'file_change' && Array.isArray(it.changes) && ev.type === 'item.completed') {
        seen.add(it.id);
        for (const c of it.changes) {
          onEvent({ type: 'tool', ...classifyTool(c.kind === 'add' ? 'Write' : 'Edit', { file_path: c.path }) });
          onActivity(`${c.kind === 'add' ? 'Write' : c.kind === 'delete' ? 'Delete' : 'Edit'}: ${c.path}`);
        }
      } else if (it.type === 'mcp_tool_call' && it.tool) {
        seen.add(it.id);
        onEvent({ type: 'tool', name: `mcp__${it.server}__${it.tool}`, hint: '', connector: it.server, connectorTool: it.tool });
        onActivity(`${it.server} › ${it.tool}`);
      } else if (it.type === 'web_search' && it.query) {
        seen.add(it.id);
        onEvent({ type: 'tool', ...classifyTool('WebSearch', { query: it.query }) });
        onActivity(`WebSearch: ${it.query}`);
      } else if (it.type === 'error' && it.message) {
        seen.add(it.id);
        onActivity(`error: ${it.message}`);
      }
    } else if (ev.type === 'turn.completed' && ev.usage) {
      const u = ev.usage;
      onEvent({ type: 'usage', usage: { input: (u.input_tokens || 0), output: u.output_tokens || 0, cachedInput: u.cached_input_tokens || 0, costUsd: null, turns: null } });
    } else if (ev.type === 'turn.failed' || ev.type === 'error') {
      onActivity(`error: ${(ev.error && ev.error.message) || ev.message || 'turn failed'}`);
    } else if (ev.type === 'thread.started' && ev.model) {
      onEvent({ type: 'init', model: ev.model, mcpServers: [] });
    }
  };
  return {
    feed(chunk) { buf += chunk; let i; while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); } },
    end() { if (buf) handle(buf); },
  };
}

// OpenCode `run --format json`: one JSON event per line. Parsed tolerantly, since its
// event shapes have changed between versions.
function makeOpenCodeParser(onText, onActivity, onEvent) {
  let buf = '';
  const seen = new Set();
  const usage = { input: 0, output: 0, costUsd: 0, turns: 0 };
  const NAMES = { bash: 'Bash', edit: 'Edit', write: 'Write', read: 'Read', grep: 'Grep', glob: 'Glob', list: 'LS', webfetch: 'WebFetch', websearch: 'WebSearch', todowrite: 'TodoWrite', task: 'Task', patch: 'Edit', multiedit: 'MultiEdit' };
  const handle = (line) => {
    if (!line.trim()) return;
    let ev;
    try { ev = JSON.parse(line); } catch { return onActivity(line); }
    const part = ev.part || (ev.properties && ev.properties.part) || ev;
    const type = String(ev.type || part.type || '').toLowerCase().replace(/_/g, '-');
    if (type === 'text' || part.type === 'text') {
      if (part.text && !part.synthetic) onText(part.text + '\n');
    } else if (type.startsWith('tool') || part.type === 'tool') {
      const raw = String(part.tool || part.toolName || ev.toolName || 'tool');
      const id = part.callID || part.id || ev.id || `${raw}-${seen.size}`;
      if (seen.has(id)) return;
      seen.add(id);
      const input = (part.state && part.state.input) || part.args || part.input || {};
      const mapped = { ...input, file_path: input.filePath || input.file_path || input.path, command: input.command };
      const name = NAMES[raw.toLowerCase()] || raw;
      if (name === 'TodoWrite' && Array.isArray(input.todos)) onEvent({ type: 'todos', todos: input.todos.map((t) => ({ content: t.content, status: t.status })) });
      const t = classifyTool(name, mapped);
      onEvent({ type: 'tool', ...t });
      if (name !== 'TodoWrite') onActivity(`${name}${t.hint ? ': ' + t.hint.slice(0, 120) : ''}`);
    } else if (type === 'step-finish' || part.type === 'step-finish') {
      const tk = part.tokens || {};
      usage.input += (tk.input || 0) + ((tk.cache && tk.cache.read) || 0);
      usage.output += tk.output || 0;
      usage.costUsd += typeof part.cost === 'number' ? part.cost : 0;
      usage.turns += 1;
      onEvent({ type: 'usage', usage: { ...usage, costUsd: usage.costUsd || null } });
    } else if (type === 'error') {
      const e = ev.error || part.error || {};
      onActivity(`error: ${(e.data && e.data.message) || e.message || 'error'}`);
    }
  };
  return {
    feed(chunk) { buf += chunk; let i; while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); } },
    end() { if (buf) handle(buf); },
  };
}

function makeParser(kind, onText, onActivity, onEvent) {
  if (kind === 'opencode-json') return makeOpenCodeParser(onText, onActivity, onEvent);
  if (kind === 'codex-json') return makeCodexParser(onText, onActivity, onEvent);
  if (kind !== 'claude-stream') return { feed: (chunk) => onText(chunk), end: () => {} };
  let buf = '';
  let gotText = false;
  let lastResult = '';
  const handle = (line) => {
    if (!line.trim()) return;
    let ev;
    try { ev = JSON.parse(line); } catch { return onActivity(line); }
    if (ev.type === 'system' && ev.subtype === 'init') {
      onEvent({ type: 'init', model: ev.model || null, mcpServers: (ev.mcp_servers || []).map((m) => ({ name: m.name, status: m.status })), skills: ev.skills || null });
    } else if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
      for (const block of ev.message.content) {
        if (block.type === 'text' && block.text) { gotText = true; onText(block.text + '\n'); }
        if (block.type === 'tool_use') {
          const t = classifyTool(block.name, block.input || {});
          if (block.name === 'TodoWrite' && Array.isArray((block.input || {}).todos)) {
            onEvent({ type: 'todos', todos: block.input.todos.map((x) => ({ content: x.content, status: x.status })) });
          }
          onEvent({ type: 'tool', ...t });
          if (block.name === 'TodoWrite') continue; // shown as the task list, not as a step
          onActivity(`${t.skill ? `skill ${t.skill}` : t.connector ? `${t.connector} › ${t.connectorTool}` : block.name}${t.hint ? ': ' + t.hint.slice(0, 120) : ''}`);
        }
      }
    } else if (ev.type === 'tool_call' && ev.subtype === 'started') {
      // Cursor: { tool_call: { readToolCall: { args: { path } } } }
      const key = Object.keys(ev.tool_call || {})[0] || 'tool';
      const name = key.replace(/ToolCall$/, '').replace(/^./, (c) => c.toUpperCase());
      const args = (ev.tool_call[key] && ev.tool_call[key].args) || {};
      const t = classifyTool(name, args);
      if (key === 'mcpToolCall' && args.name) { t.connector = args.providerIdentifier || args.server || 'mcp'; t.connectorTool = args.name; }
      onEvent({ type: 'tool', ...t });
      onActivity(`${t.connector ? `${t.connector} › ${t.connectorTool}` : name}${t.hint ? ': ' + t.hint.slice(0, 120) : ''}`);
    } else if (ev.type === 'result') {
      lastResult = ev.result || '';
      const u = ev.usage || {};
      onEvent({
        type: 'usage',
        usage: {
          input: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
          output: u.output_tokens || 0,
          costUsd: typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : null,
          turns: ev.num_turns || null,
        },
      });
      if (ev.is_error) onActivity(`error: ${lastResult}`);
    }
  };
  return {
    feed(chunk) {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); }
    },
    end() { if (buf) handle(buf); if (!gotText && lastResult) onText(lastResult); },
  };
}

// ---------- running agents ----------
function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (IS_WIN) spawn.sync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
  else { try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); } }
}

// ---------- approvals (Approve / Deny in the chat) ----------
const safety = require('./safety');
const checkpoints = require('./checkpoints');
const runs = new Map();        // runKey -> { s, agent, reply, level, token, hop }
const approvals = new Map();   // approvalId -> { s, reply, item, result }
const questions = new Map();   // questionId -> { s, reply, item, result }

// The circle connector (src/circle-mcp.js): read the chat, hand off, ask the user, approvals.
// Each run gets its own key, valid only while that run is going.
function circleServer(runKey, token, withApprove) {
  return {
    agentscircle: {
      command: process.execPath,
      args: [path.join(__dirname, 'circle-mcp.js').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)],
      env: { ELECTRON_RUN_AS_NODE: '1', AGENTSCIRCLE_URL: `http://127.0.0.1:${PORT}/api/internal`, AGENTSCIRCLE_TOKEN: token, AGENTSCIRCLE_RUN: runKey, ...(withApprove ? { AGENTSCIRCLE_APPROVALS: '1' } : {}) },
    },
  };
}

function settleApproval(id, behavior, by, message) {
  const ap = approvals.get(id);
  if (!ap || ap.item.status !== 'pending') return false;
  ap.item.status = behavior === 'allow' ? 'allowed' : 'denied';
  ap.item.by = by; ap.item.decidedAt = now();
  ap.result = { behavior, message: message || (behavior === 'allow' ? '' : 'The user denied this action.') };
  updateMessage(ap.s, ap.reply, { approvals: ap.reply.approvals, waiting: ap.reply.approvals.some((x) => x.status === 'pending') }, true);
  broadcast(ap.s.id, { type: 'approval', pending: [...approvals.values()].filter((x) => x.s === ap.s && x.item.status === 'pending').length });
  setTimeout(() => approvals.delete(id), 10 * 60 * 1000);
  return true;
}

// Keep AgentsCircle's own files (uploads, long prompts) out of git and out of checkpoints.
function ensureExcluded(folder) {
  if (!checkpoints.isRepo(folder)) return;
  const ex = run('git', ['rev-parse', '--git-path', 'info/exclude'], folder);
  if (!ex) return;
  const f = path.resolve(folder, ex);
  let cur = ''; try { cur = fs.readFileSync(f, 'utf8'); } catch { /* new */ }
  if (/^\.agentscircle\/?$/m.test(cur)) return;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, `${cur && !cur.endsWith('\n') ? '\n' : ''}.agentscircle/\n`);
}

// ---------- switching accounts when one hits its usage limit ----------
const autoSwitchOn = () => appSettings.get().autoSwitch !== false;
const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
// Another account of the same tool that can work now: one already in the circle first.
function spareFor(s, agent) {
  const ok = (a) => a.id !== agent.id && a.tool === agent.tool && !accounts.benched(a) && accounts.tool(a).installed;
  const all = accounts.list().filter(ok);
  return all.find((a) => s.members.includes(a.id)) || all[0] || null;
}
function bringIn(s, a) {
  if (s.members.includes(a.id)) return;
  s.members.push(a.id); saveSession(s);
  broadcast(s.id, { type: 'members', members: s.members });
  broadcastAll({ type: 'sessions' });
}

const busy = (s) => s.runs && s.runs.size > 0;
const runningIds = (s) => [...(s.runs ? s.runs.keys() : [])];
function broadcastStatus(s) { broadcast(s.id, { type: 'status', busy: busy(s), running: runningIds(s) }); }

// The model and effort an agent uses in a session: the session's choice wins, then the account's default.
function modelFor(s, agent) {
  const own = (s && s.agentModels && s.agentModels[agent.id]) || {};
  return { model: own.model || agent.model || null, effort: own.effort || agent.effort || null, fromSession: !!(own.model || own.effort) };
}

// A tool's program can move while the app is open (Claude Code updates itself, or you reinstall
// it). Before each run, check it's still there; if not, look for it again.
function freshTool(agent) {
  const t = accounts.tool(agent);
  const rc = t && t.resolvedCommand;
  if (rc && (!path.isAbsolute(rc) || fs.existsSync(rc))) return t;
  if (process.env.AGENTSCIRCLE_DESKTOP) require('./shell-path').fixPath();
  accounts.reloadTools();
  broadcastAgents();
  return accounts.tool(agent);
}

function runAgent(s, agent, triggerMsg, hop = 0) {
  return new Promise((resolve) => {
    const tool = freshTool(agent);
    const level = agent.permission || 'risky';
    // Where this agent works: your folder, or its own worktree in parallel mode.
    let wt = null;
    if (s.mode === 'parallel') {
      try { wt = worktrees.ensure(s, agent); saveSession(s); }
      catch (e) { addMessage(s, { role: 'system', text: `Couldn't give @${agent.id} its own branch: ${e.message}` }); s.runs.delete(agent.id); broadcastStatus(s); return resolve(null); }
    }
    const workdir = wt ? wt.dir : s.folder;
    const runKey = crypto.randomBytes(8).toString('hex');
    const before = changeSnapshot(workdir);
    const runStartedMs = Date.now();
    // Checkpoint before the turn (taken before AgentsCircle adds anything for the run).
    const ckBefore = checkpoints.snapshot(workdir, `refs/agentscircle/${s.id}/${runKey}-before`, `AgentsCircle: before @${agent.id}`);

    const circleTools = connectors.supports(tool) && !tool.noCircleTools;
    let prompt = buildPrompt(s, agent, triggerMsg, wt, circleTools);
    let promptFile = null;
    // Tools that take the prompt as an argument: very long prompts go through a file
    // (Windows limits command lines to about 32,000 characters).
    if (!tool.stdin && tool.longPromptViaFile && (prompt.length > (IS_WIN ? 20000 : 200000))) {
      ensureExcluded(workdir);
      const dir = path.join(workdir, '.agentscircle', 'prompts');
      fs.mkdirSync(dir, { recursive: true });
      promptFile = path.join(dir, `${runKey}.md`);
      fs.writeFileSync(promptFile, prompt);
      prompt = `Your full instructions for this turn are in the file .agentscircle/prompts/${runKey}.md in your working folder. Read the whole file first, then follow it.`;
    }
    let args = tool.args.map((a) => (a === '{PROMPT}' ? prompt : a.replace('{APP}', ROOT)));
    const permArgs = (tool.permissionArgs && tool.permissionArgs[level]) || [];
    if (permArgs.length) { const at = tool.permissionInsertAfter || 0; args = [...args.slice(0, at), ...permArgs, ...args.slice(at)]; }
    if (tool.budgetArg && agent.maxBudgetUsd) args.push(tool.budgetArg, String(agent.maxBudgetUsd));
    // Model and effort: this session's choice for the agent, else the account's, else the tool's default.
    const pick = modelFor(s, agent);
    for (const ins of models.args(tool, pick.model, pick.effort)) {
      const at = ins.at == null ? args.length : Math.min(ins.at, args.length);
      args = [...args.slice(0, at), ...ins.args, ...args.slice(at)];
    }
    const images = (triggerMsg.attachments || []).filter((x) => x.kind === 'image').map((x) => path.join(s.folder, x.path));
    if (tool.imageArg && images.length) { const at = tool.imageInsertAfter || 0; args = [...args.slice(0, at), ...images.flatMap((f) => [tool.imageArg, f]), ...args.slice(at)]; }
    const canAsk = tool.approvals === 'prompt-tool';
    const runToken = crypto.randomBytes(16).toString('hex');
    const inj = connectors.injection(agent, tool, runKey, circleTools ? circleServer(runKey, runToken, canAsk) : {}, { workdir });
    if (inj.args.length) args = [...args.slice(0, inj.insertAfter), ...inj.args, ...args.slice(inj.insertAfter)];
    if (canAsk && circleTools) args.push('--permission-prompt-tool', 'mcp__agentscircle__approve');
    // Questions and approvals can wait a long time for the user.
    const env = { ...accounts.envFor(agent), ...inj.env, ...(circleTools ? { MCP_TOOL_TIMEOUT: String(60 * 60 * 1000) } : {}) };

    const account = agent.label || (agent.identity && agent.identity.label) || '';
    const reply = addMessage(s, {
      role: 'agent', agent: agent.id, account, tool: tool.id, replyTo: triggerMsg.id, text: '', activity: [],
      tools: [], todos: null, usage: null, model: null, promptChars: (promptFile ? fs.statSync(promptFile).size : prompt.length), startedAt: now(), pending: true,
      sharedConnectors: inj.names, permission: level, approvals: [], questions: [], chosenModel: pick.model, effort: pick.effort,
      ...(wt ? { workdir, branch: wt.branch } : {}),
    });
    runs.set(runKey, { s, agent, reply, level, token: runToken, hop, mentioned: [] });
    const startedAt = Date.now();
    let text = '';
    let stderr = '';
    let timedOut = false;

    let missing = false;
    const child = spawn(tool.resolvedCommand || tool.command, args, {
      cwd: workdir, env, windowsHide: true, detached: !IS_WIN, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const run = { child, agentId: agent.id, messageId: reply.id, runKey, stopRequested: false };
    s.runs.set(agent.id, run);
    broadcastStatus(s);
    const timer = agent.timeoutMin ? setTimeout(() => { timedOut = true; killTree(child); }, agent.timeoutMin * 60000) : null;

    const parser = makeParser(
      tool.parser,
      (t) => { text += t; updateMessage(s, reply, { text }); },
      (a) => { reply.activity.push(a); broadcast(s.id, { type: 'activity', id: reply.id, line: a }); },
      (ev) => {
        if (ev.type === 'tool') { const { type, ...t } = ev; if (t.connector === 'agentscircle') return; reply.tools.push(t); broadcast(s.id, { type: 'update', id: reply.id, patch: { tools: reply.tools } }); }
        if (ev.type === 'todos') updateMessage(s, reply, { todos: ev.todos });
        if (ev.type === 'usage') updateMessage(s, reply, { usage: ev.usage });
        if (ev.type === 'init') updateMessage(s, reply, { model: ev.model, available: { mcpServers: (ev.mcpServers || []).filter((m) => m.name !== 'agentscircle'), skills: ev.skills } });
      },
    );

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let outTail = ''; // raw output, for explaining a failure when the tool printed its error outside its JSON events
    child.stdout.on('data', (d) => { parser.feed(d); outTail = (outTail + d).slice(-8000); });
    child.stderr.on('data', (d) => { stderr += d; if (stderr.length > 20000) stderr = stderr.slice(-20000); });
    child.on('error', (err) => { if (err.code === 'ENOENT') missing = true; stderr += `\n${err.message}`; });

    // Always close stdin so agents never wait for more input.
    child.stdin.on('error', () => {});
    if (tool.stdin) child.stdin.end(prompt); else child.stdin.end();

    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      parser.end();
      connectors.cleanup(inj); // puts back anything added for this run before the "after" checkpoint
      if (promptFile) fs.rm(promptFile, { force: true }, () => {});
      runs.delete(runKey);
      recentlyEnded.set(runKey, runToken); setTimeout(() => recentlyEnded.delete(runKey), 60000);
      for (const [id, ap] of approvals) if (ap.reply === reply) settleApproval(id, 'deny', 'system', 'The agent stopped.');
      for (const [id, q] of questions) if (q.reply === reply) settleQuestion(id, null, 'system');
      const stopped = run.stopRequested;
      s.runs.delete(agent.id);
      let final = text.trim();
      if (!final && code !== 0) {
        // Why it failed, from the best source: error events the parser saw, plain-text lines the tool
        // printed instead of JSON, then stderr.
        const errs = (reply.activity || []).filter((a) => /^error:/i.test(a)).map((a) => a.replace(/^error:\s*/i, ''));
        const plain = outTail.split('\n').map((l) => l.trim()).filter((l) => l && !/^[{[]/.test(l));
        const why = errs.length ? errs : plain.length ? plain : stderr.trim() ? stderr.trim().split('\n') : [];
        if (why.length) final = [...new Set(why)].slice(-12).join('\n');
      }
      if (!final && stderr.trim()) final = stderr.trim().split('\n').slice(-15).join('\n');
      if (timedOut) final = (final ? final + '\n\n' : '') + `_(stopped after ${agent.timeoutMin} minutes, the time limit for @${agent.id})_`;
      else if (stopped) final = (final ? final + '\n\n' : '') + '_(stopped by you)_';
      else if (code !== 0 && !final) final = `Exited with code ${code}${signal ? ` (${signal})` : ''}.`;
      const diff = describeChanges(workdir, before, changeSnapshot(workdir));
      const extra = writtenByTools(workdir, reply.tools, new Set(diff.files.map((f) => f.path)), runStartedMs);
      if (extra.length) { diff.files.push(...extra); diff.summary = `${diff.files.length} file${diff.files.length > 1 ? 's' : ''}: ${diff.files.slice(0, 8).map((f) => f.path).join(', ')}${diff.files.length > 8 ? ', …' : ''}`; }
      const ckAfter = ckBefore ? checkpoints.snapshot(workdir, `refs/agentscircle/${s.id}/${runKey}-after`, `AgentsCircle: after @${agent.id}`) : null;
      const wasLimited = !!agent.limitedAt;
      const limited = !stopped && !timedOut && accounts.noteOutcome(agent, { ok: code === 0, text: `${final}\n${stderr.slice(-2000)}` });
      if (limited !== wasLimited) broadcastAgents();
      if (limited) {
        final = final.replace(/(usage limit reached)\|\d{10}/i, '$1.');
        const until = agent.limitedUntil ? ` (resets around ${clock(agent.limitedUntil)})` : '';
        const next = autoSwitchOn() ? spareFor(s, agent) : null;
        const spare = accounts.list().filter((a) => a.tool === agent.tool && a.id !== agent.id && !accounts.benched(a)).map((a) => `@${a.id}`);
        final += next
          ? `\n\n_@${agent.id} hit its usage limit${until}. Switching to @${next.id}, which continues the same conversation._`
          : `\n\n_@${agent.id} looks like it hit its usage limit${until}.${spare.length ? ` Try ${spare.join(' or ')} instead, or turn on automatic switching in Settings.` : ' Add another account of the same tool to keep going when this happens.'}_`;
      }
      // Signed out: the tool's saved sign-in expired or was revoked. Say how to fix it, with a button.
      if (missing) {
        final = `AgentsCircle can't find ${tool.name} on this computer (the \`${tool.command}\` command). If you just updated, reinstalled or signed in to it, click Retry. If it keeps happening, open Terminal and run \`which ${tool.command}\` to see where it is, or reinstall it from Settings → Agents and accounts.`;
        accounts.reloadTools(); broadcastAgents();
      }
      const modelRefused = !missing && !stopped && !timedOut && !limited && code !== 0 && health.MODEL_RE.test(`${final}\n${stderr.slice(-2000)}`);
      const signin = !modelRefused && !missing && !stopped && !timedOut && !limited && code !== 0 && SIGNIN_RE.test(`${final}\n${stderr.slice(-2000)}`);
      if (signin) final = `${final || 'Sign-in failed.'}\n\n_@${agent.id}'s sign-in to ${tool.name} has expired. Sign in again, then retry._`;
      const status = timedOut ? 'timeout' : stopped ? 'stopped' : limited ? 'limited' : signin ? 'signin' : modelRefused ? 'model' : code !== 0 ? 'error' : 'done';
      // The one-line status the agent was asked to end with: shown on its own, taken out of the text.
      let statusLine = null;
      {
        const lines = final.split('\n');
        for (let k = lines.length - 1; k >= Math.max(0, lines.length - 4); k--) {
          const mm = /^\s*[*_]*status[*_]*\s*:\s*[*_]*\s*(.+?)[*_]*\s*$/i.exec(lines[k]);
          if (mm) { statusLine = mm[1].trim().slice(0, 160); lines.splice(k, 1); final = lines.join('\n').trim(); break; }
        }
      }
      let files = diff.files;
      if (ckBefore && ckAfter) { const exact = checkpoints.changedFiles(workdir, ckBefore, ckAfter); if (exact) files = [...exact, ...extra.filter((x) => !exact.some((f) => f.path === x.path))]; }
      updateMessage(s, reply, {
        text: final || '(no reply)', statusLine, pending: false, error: ['error', 'limited', 'timeout', 'signin', 'model'].includes(status), limited, status, waiting: false,
        seconds: Math.round((Date.now() - startedAt) / 1000), endedAt: now(),
        changes: files.length ? `${files.length} file${files.length > 1 ? 's' : ''}: ${files.slice(0, 8).map((f) => f.path).join(', ')}` : null,
        files, commits: diff.commits || [], log: (stderr.trim() ? stderr : code !== 0 ? outTail : '').slice(-4000),
        checkpoint: ckBefore && ckAfter ? { before: ckBefore, after: ckAfter } : null,
      }, true);
      broadcastStatus(s);
      if (wt) broadcast(s.id, { type: 'branches' });
      usage.clear();
      if (!stopped) notifyUser(s, { kind: status === 'done' ? 'done' : status, agent: agent.id, messageId: reply.id, text: statusLine || (final || '').split('\n').find((l) => l.trim()) || '' });
      resolve(reply);
    });
  });
}

// Shared mode: one agent at a time in your folder. Parallel mode: each agent works at the
// same time in its own worktree (one turn at a time per agent).
function pump(s) {
  if (!s.runs) s.runs = new Map();
  const parallel = s.mode === 'parallel';
  for (let i = 0; i < s.queue.length;) {
    const job = s.queue[i];
    if (parallel ? s.runs.has(job.agentId) : busy(s)) { if (!parallel) break; i++; continue; }
    s.queue.splice(i, 1);
    startJob(s, job);
    if (!parallel) break;
  }
  broadcast(s.id, { type: 'queue', queue: s.queue.map((q) => q.agentId) });
}
async function startJob(s, job) {
  let agent = agentById(job.agentId);
  if (!agent) return pump(s);
  // Still waiting for its limit to reset? Let another account of the same tool take this one.
  if (accounts.benched(agent) && autoSwitchOn()) {
    const spare = spareFor(s, agent);
    if (spare && !s.runs.has(spare.id)) {
      bringIn(s, spare);
      addMessage(s, { role: 'system', kind: 'switch', from: agent.id, to: spare.id, text: `@${agent.id} is waiting for its usage limit to reset${agent.limitedUntil ? ` (around ${clock(agent.limitedUntil)})` : ''}, so @${spare.id} takes this one.` });
      agent = spare;
    }
  }
  s.runs.set(agent.id, { child: null, agentId: agent.id, stopRequested: false }); // reserve the slot
  broadcastStatus(s);
  if (!s.summarizing && foldPlan(s, false)) {
    s.summarizing = true;
    await summarize(s, agent, false).catch((e) => addMessage(s, { role: 'system', text: `Couldn't summarize the earlier conversation (${e.message}). Agents get the most recent part only.` }));
    s.summarizing = false;
  }
  const slot = s.runs.get(agent.id);
  if (slot && slot.stopRequested && !slot.child) { s.runs.delete(agent.id); broadcastStatus(s); return pump(s); }
  const reply = await runAgent(s, agent, job.trigger, job.hop || 0);
  if (reply && reply.status === 'done' && s.handoffs !== false) queueHandoffs(s, agent, reply, job.hop || 0);
  if (reply && reply.status === 'done') checkCanary(s, agent);
  // The plan refused the model: find one it accepts, then run the same message again.
  if (reply && reply.status === 'model') {
    const own = s.agentModels && s.agentModels[agent.id];
    if (own && own.model) {
      const refused = own.model;
      delete own.model; saveSession(s);
      broadcast(s.id, { type: 'session', session: { ...summary(s), defaultAgent: s.defaultAgent } });
      addMessage(s, { role: 'system', kind: 'switch', text: `Your plan doesn't include **${refused}** for @${agent.id}, so this session goes back to its usual model.` });
    }
    const h = await health.verify(agent).catch(() => null);
    if (h) accounts.setHealth(agent, h);
    broadcastAgents();
    if (h && h.state === 'ok') {
      updateMessage(s, reply, { switchedModel: agent.model || null, retried: true }, true);
      addMessage(s, { role: 'system', kind: 'switch', text: `@${agent.id}'s plan doesn't include ${accounts.tool(agent).name}'s default model, so it now uses **${agent.model}**. Running your message again. You can change the model in Settings → Agents and accounts.` });
      s.queue.unshift({ agentId: agent.id, trigger: job.trigger, hop: job.hop || 0 });
    } else if (h) {
      addMessage(s, { role: 'system', text: `@${agent.id}: ${h.message}` });
    }
  }
  // Hit the limit mid-task: run the same message again on another account of the same tool.
  if (reply && reply.status === 'limited' && autoSwitchOn()) {
    const spare = spareFor(s, agent);
    if (spare) {
      bringIn(s, spare);
      updateMessage(s, reply, { switchedTo: spare.id }, true);
      s.queue.unshift({ agentId: spare.id, trigger: job.trigger, hop: job.hop || 0 });
    }
  }
  pump(s);
}

// Hand a task from one agent to another: from the mention tool during a turn, or from
// "@codex: write the tests" lines at the end of a reply (tools without the circle connector).
function handoff(s, from, reply, to, task, hop) {
  const msg = addMessage(s, { role: 'handoff', agent: from.id, to, text: task, fromReply: reply.id, hop: hop + 1 });
  s.queue.push({ agentId: to, trigger: msg, hop: hop + 1 });
  broadcast(s.id, { type: 'queue', queue: s.queue.map((q) => q.agentId) });
  return msg;
}
function handoffProblem(s, from, to, hop) {
  if (s.handoffs === false) return 'Hand-offs are turned off in this circle. Tell the user who should do it instead.';
  if (to === from.id) return 'That is you.';
  if (!s.members.includes(to) || !agentById(to)) return `There's no agent @${to} in this circle. In the circle: ${s.members.filter((m) => m !== from.id).map((m) => '@' + m).join(', ') || 'nobody else'}.`;
  if (!accounts.tool(agentById(to)).installed) return `@${to} isn't installed on this computer.`;
  if (hop + 1 > HOP_LIMIT) return `The hand-off chain reached its limit (${HOP_LIMIT} in a row). Finish your part; the user will decide who continues.`;
  return null;
}
function queueHandoffs(s, agent, reply, hop) {
  const viaTool = new Set(reply.toolHandoffs || []);
  const found = [...String(reply.text || '').matchAll(/^\s*\**@([a-z0-9_-]+)\**\s*:\s*(.+)$/gim)].map((m) => ({ to: m[1].toLowerCase(), task: m[2].trim() }));
  const valid = found.filter((h) => !viaTool.has(h.to) && h.to !== agent.id && s.members.includes(h.to) && agentById(h.to) && accounts.tool(agentById(h.to)).installed);
  if (!valid.length) return;
  if (hop + 1 > HOP_LIMIT) {
    addMessage(s, { role: 'system', text: `Paused the hand-off chain after ${HOP_LIMIT} hand-offs in a row, so agents don't keep passing work around. Mention an agent to continue.` });
    return;
  }
  for (const h of valid) handoff(s, agent, reply, h.to, h.task, hop);
  updateMessage(s, reply, { handoffs: [...(reply.handoffs || []), ...valid] }, true);
}

// ---------- losing track ----------
// Every agent is asked to end with a "Status:" line. Two replies in a row without one usually
// means it's no longer following its instructions: the context is too long or too noisy.
function checkCanary(s, agent) {
  if (accounts.tool(agent).parser === 'text') return; // test agents can't follow it
  const done = s.messages.filter((m) => m.role === 'agent' && m.agent === agent.id && m.status === 'done');
  const last = done.slice(-2);
  s.canary = s.canary || {};
  if (last.length && last[last.length - 1].statusLine) { if (s.canary[agent.id]) { delete s.canary[agent.id]; saveSession(s); } return; }
  if (last.length < 2 || last.some((m) => m.statusLine) || s.canary[agent.id]) return;
  s.canary[agent.id] = now();
  addMessage(s, { role: 'system', kind: 'canary', agent: agent.id,
    text: `@${agent.id} skipped its status line in its last two replies. That's often the first sign an agent is losing track of a long conversation. Summarizing the earlier part gives every agent a shorter, clearer context.` });
}

// ---------- auto-summary for long sessions ----------
function foldPlan(s, manual) {
  const live = liveMessages(s);
  const sizes = live.map((m) => blockFor(m).length);
  const total = sizes.reduce((a, b) => a + b, 0);
  if (!manual && total <= CONTEXT_BUDGET) return null;
  let keep = 0, i = live.length;
  while (i > 0 && keep + sizes[i - 1] <= RECENT_KEEP && (manual ? live.length - i < 6 : true)) { keep += sizes[i - 1]; i--; }
  const fold = live.slice(0, i);
  if (fold.length < (manual ? 2 : 3)) return null;
  return fold;
}
function pickSummarizer(s, prefer) {
  const ok = (a) => a && s.members.includes(a.id) && accounts.tool(a).installed && ['claude-stream', 'codex-json'].includes(accounts.tool(a).parser);
  const members = s.members.map(agentById).filter(ok);
  return members.find((a) => accounts.tool(a).id === 'claude') || (ok(prefer) ? prefer : null) || members[0] || null;
}
// Run an agent read-only, outside the chat, and return its text.
function runQuiet(agent, prompt, ms = 180000) {
  return new Promise((resolve, reject) => {
    const tool = freshTool(agent);
    let args = tool.args.map((a) => (a === '{PROMPT}' ? prompt : a.replace('{APP}', ROOT)));
    const ro = (tool.permissionArgs && tool.permissionArgs.readonly) || [];
    const at = tool.permissionInsertAfter || 0;
    args = [...args.slice(0, at), ...ro, ...args.slice(at)];
    if (tool.id === 'claude') args.push('--max-turns', '3');
    let text = '';
    const child = spawn(tool.resolvedCommand || tool.command, args, { cwd: os.tmpdir(), env: accounts.envFor(agent), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const parser = makeParser(tool.parser, (t) => { text += t; }, () => {}, () => {});
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ok */ } }, ms);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => parser.feed(d));
    child.stderr.on('data', () => {});
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', () => { clearTimeout(timer); parser.end(); text.trim() ? resolve(text.trim()) : reject(new Error('no summary came back')); });
    child.stdin.on('error', () => {});
    if (tool.stdin) child.stdin.end(prompt); else child.stdin.end();
  });
}
async function summarize(s, prefer, manual) {
  const fold = foldPlan(s, manual);
  if (!fold) return null;
  const by = pickSummarizer(s, prefer);
  if (!by) throw new Error('no agent in this session can write summaries');
  broadcast(s.id, { type: 'summarizing', by: by.id });
  const prompt = [
    'You are writing a hand-off summary of a group chat between a developer and several AI coding agents working in one project.',
    'Other agents will read ONLY this summary instead of the messages below, so keep everything they need:',
    '- the goal and what the user asked for, in their words where it matters',
    '- decisions made and why, and things the user rejected',
    '- what each agent did (by @handle) and which files changed',
    '- the current state, open tasks, known problems, and agreed next steps',
    'Write plain Markdown, at most 500 words. Don\'t invent anything. Don\'t use tools; just answer.',
    ...(s.summary ? ['', '### EARLIER SUMMARY (fold it in)', s.summary.text] : []),
    '', '### MESSAGES TO SUMMARIZE', fold.map(blockFor).join('\n\n'),
  ].join('\n');
  const text = await runQuiet(by, prompt);
  const upTo = fold.at(-1).id;
  const count = fold.length + (s.summary ? s.summary.count : 0);
  s.summary = { text, upTo, count, by: by.id, at: now() };
  addMessage(s, { role: 'system', kind: 'summary', text: `**Summary of the earlier conversation** (${count} messages, written by @${by.id}). From now on agents get this summary plus the recent messages.\n\n${text}` });
  saveSession(s);
  return s.summary;
}

function routeMentions(s, msg) {
  const found = [...msg.text.matchAll(/@([a-z0-9_-]+)/gi)].map((m) => m[1].toLowerCase());
  let targets = [];
  for (const id of found) {
    if (id === 'all' || id === 'everyone') targets.push(...s.members);
    else targets.push(id);
  }
  targets = [...new Set(targets)];
  if (!targets.length && s.defaultAgent) targets = [s.defaultAgent];

  const problems = [];
  for (const id of targets) {
    const a = agentById(id);
    if (!a) { problems.push(`There's no agent called @${id}.`); continue; }
    if (!s.members.includes(id)) { problems.push(`@${id} isn't in this session yet. Add it from the agents panel.`); continue; }
    const t = accounts.tool(a);
    if (!t.installed) { problems.push(`@${id} uses ${t.name}, which isn't installed on this computer (looked for "${t.command}").`); continue; }
    s.queue.push({ agentId: id, trigger: msg, hop: 0 });
  }
  if (problems.length) addMessage(s, { role: 'system', text: problems.join('\n') });
  if (!targets.length) addMessage(s, { role: 'system', text: 'Mention an agent to ask it something, e.g. @claude or @codex. Use @all to ask everyone in turn.' });
  const hint = capabilityHint(s, msg.text, targets.filter((id) => s.queue.some((q) => q.agentId === id && q.trigger === msg)));
  if (hint) addMessage(s, { role: 'system', kind: 'hint', text: hint });
  broadcast(s.id, { type: 'queue', queue: s.queue.map((q) => q.agentId) });
  pump(s);
}

// What each member can use: its own skills and connectors, plus what AgentsCircle shares.
function sessionCapabilities(s) {
  const sharedSkills = skills.shared(s.folder).map((k) => k.name);
  const out = {};
  for (const id of s.members) {
    const a = agentById(id); if (!a) continue;
    const tool = accounts.tool(a);
    const own = skills.capabilities(a, s.folder);
    const sharedConns = connectors.supports(tool) ? connectors.forAgent(a).map((c) => c.name) : [];
    out[id] = {
      tool: tool.name,
      skills: [...own.skills.map((k) => ({ name: k.name, description: k.description, source: 'own' })), ...sharedSkills.map((n) => ({ name: n, source: 'shared' }))],
      connectors: [...own.connectors.map((c) => ({ name: c.name, source: 'own', where: c.source })), ...sharedConns.filter((n) => !own.connectors.some((c) => c.name === n)).map((n) => ({ name: n, source: 'shared' }))],
    };
  }
  return out;
}
function capabilityHint(s, text, targets) {
  if (!targets.length) return null;
  let caps;
  try { caps = sessionCapabilities(s); } catch { return null; }
  const words = new Set(String(text).toLowerCase().match(/[a-z0-9][a-z0-9_-]{3,}/g) || []);
  const notes = [];
  const holders = (name) => Object.entries(caps).filter(([, c]) => c.connectors.some((x) => x.name.toLowerCase() === name) || c.skills.some((x) => x.name.toLowerCase() === name)).map(([id]) => id);
  const names = new Set(Object.values(caps).flatMap((c) => [...c.connectors, ...c.skills].map((x) => x.name.toLowerCase())));
  for (const name of names) {
    if (!words.has(name)) continue;
    const have = holders(name);
    for (const t of targets) {
      if (have.includes(t)) continue;
      const kind = Object.values(caps).some((c) => c.connectors.some((x) => x.name.toLowerCase() === name)) ? 'connector' : 'skill';
      notes.push(`@${t} doesn't have the "${name}" ${kind}. ${have.length ? `${have.map((h) => '@' + h).join(' and ')} ${have.length > 1 ? 'have' : 'has'} it.` : ''} ${kind === 'connector' ? 'You can share it with every agent in Settings → Connectors.' : 'You can share it with every agent in Settings → Skills.'}`.replace(/\s+/g, ' ').trim());
    }
  }
  return notes.length ? notes.join('\n') : null;
}

// ---------- HTTP API ----------
const app = express();
// Only this app's own page may call the API (blocks other websites and DNS-rebinding tricks).
app.use((req, res, next) => {
  const host = (req.headers.host || '').split(':')[0];
  if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) return res.status(403).send('Forbidden');
  const origin = req.headers.origin;
  const okOrigin = !origin || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(origin) || (origin === 'null' && req.method === 'GET' && req.path.includes('/raw/'));
  if (!okOrigin) return res.status(403).send('Forbidden');
  next();
});
// ---------- connector proxy ----------
// Agents reach connectors you signed in to through here; AgentsCircle adds the sign-in and keeps it fresh.
app.all('/mcp-proxy/:name', async (req, res) => {
  const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (given.length !== PROXY_SECRET.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(PROXY_SECRET))) return res.status(401).json({ error: 'Not allowed.' });
  const c = connectors.get(req.params.name);
  if (!c || c.type !== 'remote' || !c.enabled) return res.status(404).json({ error: 'No such connector.' });
  const chunks = [];
  if (!['GET', 'HEAD', 'DELETE'].includes(req.method)) for await (const ch of req) chunks.push(ch);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const headers = { ...(c.headers || {}) };
  for (const h of ['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id']) if (req.headers[h]) headers[h] = req.headers[h];
  const ctl = new AbortController();
  res.on('close', () => ctl.abort());
  const send = (token) => fetch(c.url, { method: req.method, headers: { ...headers, Authorization: `Bearer ${token}` }, body, signal: ctl.signal });
  let r;
  try {
    let token = await oauth.accessToken(c.name);
    if (!token) return res.status(401).json({ error: `Sign in to ${c.title || c.name} in AgentsCircle (Settings, Connectors).` });
    r = await send(token);
    if (r.status === 401) { token = await oauth.accessToken(c.name, { force: true }); if (token) r = await send(token); }
    if (r.status === 401) {
      oauth.finish(c.name, false, 'The sign-in has expired. Sign in again.');
      broadcastConnectors();
      return res.status(401).json({ error: `The ${c.title || c.name} sign-in has expired. Sign in again in AgentsCircle (Settings, Connectors).` });
    }
  } catch (e) {
    if (ctl.signal.aborted) return;
    return res.status(502).json({ error: `Couldn't reach ${c.title || c.name}: ${e.message}` });
  }
  res.status(r.status);
  for (const h of ['content-type', 'mcp-session-id', 'cache-control', 'mcp-protocol-version']) { const v = r.headers.get(h); if (v) res.setHeader(h, v); }
  if (!r.body) return res.end();
  res.flushHeaders();
  try { for await (const ch of r.body) res.write(ch); } catch { /* client or server went away */ }
  res.end();
});

const esc = (t) => String(t).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
// The browser comes back here after you sign in to a connector.
app.get('/oauth/callback', async (req, res) => {
  const r = await oauth.callback(req.query || {});
  if (r.ok) {
    const t = await connectors.test(r.name).catch((e) => ({ ok: false, message: e.message }));
    oauth.finish(r.name, t.ok && !t.needsSignIn, t.ok && !t.needsSignIn ? `Signed in. ${t.message} Every agent in your circles can use it.` : t.message);
    broadcastConnectors();
  }
  const title = r.title || 'the connector';
  const ok = r.ok;
  res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>AgentsCircle</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;background:#f6f7f8;color:#1b1d20}
@media (prefers-color-scheme:dark){body{background:#121416;color:#e9ebed}.card{background:#1c1f22!important;border-color:#31363b!important}}
.card{max-width:420px;padding:32px;border:1px solid #e3e5e8;border-radius:14px;background:#fff;text-align:center}h1{font-size:20px;margin:12px 0 6px}p{margin:0;opacity:.75}
.dot{width:44px;height:44px;border-radius:50%;margin:0 auto;display:grid;place-items:center;color:#fff;font-size:22px;background:${ok ? '#2f9e6b' : '#d64545'}}</style>
<div class="card"><div class="dot">${ok ? '✓' : '!'}</div><h1>${ok ? `Signed in to ${esc(title)}` : 'Sign-in didn\'t finish'}</h1><p>${ok ? 'You can close this tab and go back to AgentsCircle.' : esc(r.message || '')}</p></div>
${ok ? '<script>setTimeout(()=>window.close(),1500)</script>' : ''}`);
});

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(ROOT, 'public')));
// The terminal's on-page part (xterm.js), served from its npm package.
{
  const pkgDir = (name) => { try { return path.dirname(require.resolve(`${name}/package.json`)); } catch { return null; } };
  const xterm = pkgDir('@xterm/xterm'), fit = pkgDir('@xterm/addon-fit');
  if (xterm) { app.get('/vendor/xterm/xterm.js', (req, res) => res.sendFile(path.join(xterm, 'lib/xterm.js'))); app.get('/vendor/xterm/xterm.css', (req, res) => res.sendFile(path.join(xterm, 'css/xterm.css'))); }
  if (fit) app.get('/vendor/xterm/addon-fit.js', (req, res) => res.sendFile(path.join(fit, 'lib/addon-fit.js')));
}

app.get('/api/agents', (_req, res) => res.json(agentsPayload()));
app.get('/api/tools', (_req, res) => res.json(accounts.publicTools()));
app.post('/api/agents/rescan', async (_req, res) => { accounts.load(); await accounts.refreshAll(); broadcastAgents(); res.json(agentsPayload()); });

app.post('/api/agents', async (req, res) => {
  try {
    const agent = accounts.add(req.body || {});
    await accounts.detectIdentity(agent).catch(() => null);
    broadcastAgents();
    res.json(accounts.publicAgent(agent));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.patch('/api/agents/:id', (req, res) => {
  try {
    const { agent, renamed } = accounts.update(req.params.id, req.body || {});
    if (renamed) {
      for (const s of sessions.values()) {
        let touched = false;
        if (s.members.includes(renamed.from)) { s.members = s.members.map((m) => (m === renamed.from ? renamed.to : m)); touched = true; }
        if (s.defaultAgent === renamed.from) { s.defaultAgent = renamed.to; touched = true; }
        for (const m of s.messages) if (m.agent === renamed.from) { m.agent = renamed.to; touched = true; }
        if (touched) { saveSession(s); broadcast(s.id, { type: 'session', session: { ...summary(s), defaultAgent: s.defaultAgent }, reload: true }); }
      }
    }
    broadcastAgents();
    res.json(accounts.publicAgent(agent));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/agents/:id', (req, res) => {
  try {
    const agent = accounts.remove(req.params.id);
    for (const s of sessions.values()) {
      if (!s.members.includes(agent.id)) continue;
      s.members = s.members.filter((m) => m !== agent.id);
      if (s.defaultAgent === agent.id) s.defaultAgent = s.members[0] || null;
      saveSession(s);
      broadcast(s.id, { type: 'session', session: { ...summary(s), defaultAgent: s.defaultAgent } });
    }
    broadcastAgents();
    res.json({ ok: true, keptLoginFolder: agent.configDir || null });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/agents/:id/login', (req, res) => {
  const agent = agentById(req.params.id);
  if (!agent) return res.status(404).json({ error: 'No such agent.' });
  try { res.json(accounts.openLogin(agent)); } catch (e) { res.status(400).json({ error: e.message }); }
});

// A real check: run the account once, the way a turn does. Codex also gets a model its plan accepts.
const verifying = new Map();
app.post('/api/agents/:id/verify', async (req, res) => {
  const agent = accounts.get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'No such account.' });
  try {
    if (!verifying.has(agent.id)) verifying.set(agent.id, (async () => { freshTool(agent); await accounts.detectIdentity(agent).catch(() => null); const h = await health.verify(agent); accounts.setHealth(agent, h); return h; })().finally(() => verifying.delete(agent.id)));
    const h = await verifying.get(agent.id);
    broadcastAgents();
    res.json({ health: h, agent: accounts.publicAgent(agent) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Sign in from the app: the tool's own browser sign-in, then a real check.
app.post('/api/agents/:id/signin', (req, res) => {
  const agent = accounts.get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'No such account.' });
  try {
    freshTool(agent);
    const flow = signin.start(agent);
    const f = signin.flows.get(agent.id);
    f.onSignedIn = async () => {
      await accounts.detectIdentity(agent).catch(() => null);
      const h = await health.verify(agent).catch((e) => ({ state: 'error', message: e.message }));
      accounts.setHealth(agent, { ...h, checkedAt: new Date().toISOString() });
      broadcastAgents();
      signin.finish(agent.id, h.state === 'ok', h.state === 'ok' ? `@${agent.id} is signed in and working.${h.switchedModel ? ` It uses ${h.switchedModel}, because your plan doesn't include the default model.` : ''}` : `Signed in, but the check failed: ${h.message}`);
    };
    res.json(flow);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/agents/:id/signin/code', (req, res) => {
  try { res.json(signin.sendCode(req.params.id, (req.body || {}).code)); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/agents/:id/signin/cancel', (req, res) => { signin.cancel(req.params.id); res.json({ ok: true }); });

app.post('/api/agents/:id/refresh', async (req, res) => {
  const agent = agentById(req.params.id);
  if (!agent) return res.status(404).json({ error: 'No such agent.' });
  await accounts.detectIdentity(agent).catch(() => null);
  broadcastAgents();
  res.json(accounts.publicAgent(agent));
});

// ---------- app info & first-run setup ----------
const INSTALL = {
  claude: { sh: 'curl -fsSL https://claude.ai/install.sh | bash', ps: 'irm https://claude.ai/install.ps1 | iex', docs: 'https://code.claude.com/docs/en/setup' },
  codex: { sh: 'npm install -g @openai/codex', ps: 'npm install -g @openai/codex', needsNode: true, docs: 'https://developers.openai.com/codex' },
  cursor: { sh: 'curl https://cursor.com/install -fsS | bash', ps: "irm 'https://cursor.com/install?win32=true' | iex", docs: 'https://cursor.com/docs/cli/overview' },
  opencode: { sh: 'curl -fsSL https://opencode.ai/install | bash', ps: 'npm install -g opencode-ai', needsNodeOnWindows: true, docs: 'https://opencode.ai/docs/' },
};
app.get('/api/app', (_req, res) => {
  res.json({
    version: PKG.version, desktop: !!process.env.AGENTSCIRCLE_DESKTOP, platform: process.platform,
    dataDir: DATA_DIR, logsDir: path.join(DATA_DIR, 'logs'), dataVersion: platform.DATA_VERSION, migratedFrom: migration.from,
    tools: { ...accounts.toolsInfo(), remoteEnabled: remoteTools.enabled, lastCheck: remoteTools.lastCheck() },
    settings: appSettings.get(),
    secrets: vault.kind(),
  });
});
app.patch('/api/app/settings', (req, res) => {
  const allowed = {};
  for (const k of ['updateChannel', 'onboarded', 'autoSwitch', 'projectsDir']) if (k in (req.body || {})) allowed[k] = req.body[k];
  res.json(appSettings.set(allowed));
});
app.post('/api/app/check-tools', async (_req, res) => res.json(await checkToolFixes()));

function setupState() {
  const tools = accounts.tools().filter((t) => !t.hidden);
  return {
    onboarded: !!appSettings.get().onboarded,
    git: !!accounts.findOnPath('git'),
    node: !!accounts.findOnPath('node'),
    agents: tools.map((t) => {
      const mine = accounts.list().filter((a) => a.tool === t.id);
      // Ready means it really worked (a real check) where AgentsCircle can check it.
      const checkable = ['claude', 'codex'].includes(t.id);
      const ok = mine.find((a) => a.health && a.health.state === 'ok');
      const bad = mine.find((a) => a.health && a.health.state !== 'ok');
      const signedIn = checkable ? !!ok : mine.some((a) => a.identity && a.identity.signedIn);
      return { tool: t.id, name: t.name, color: t.color, installed: t.installed, agents: mine.map((a) => a.id), signedIn, checking: checkable && t.installed && !ok && !bad && mine.length > 0, problem: !ok && bad ? bad.health.message : null, problemState: !ok && bad ? bad.health.state : null, install: INSTALL[t.id] || null };
    }),
  };
}
app.get('/api/setup', (_req, res) => res.json(setupState()));
app.post('/api/setup/rescan', async (_req, res) => {
  if (process.env.AGENTSCIRCLE_DESKTOP) require('./shell-path').fixPath();
  accounts.load();
  const added = accounts.ensureDefaults();
  await accounts.refreshAll().catch(() => {});
  // Check the agents for real (one tiny turn each), so "ready" means ready.
  await Promise.all(accounts.list().filter((a) => accounts.tool(a).installed && ['claude', 'codex'].includes(a.tool) && !a.apiKeyLocked)
    .map(async (a) => { try { accounts.setHealth(a, await health.verify(a)); } catch { /* shown as not checked */ } }));
  broadcastAgents();
  res.json({ ...setupState(), added });
});
app.post('/api/setup/install', (req, res) => {
  const id = (req.body || {}).tool;
  const what = id === 'git'
    ? { sh: process.platform === 'darwin' ? 'xcode-select --install' : 'echo "Install git with your package manager, e.g. sudo apt install git"', ps: 'winget install --id Git.Git -e', name: 'git' }
    : INSTALL[id];
  if (!what) return res.status(400).json({ error: 'Unknown tool.' });
  const name = id === 'git' ? 'git' : (accounts.tools().find((t) => t.id === id) || {}).name;
  try {
    const r = accounts.openCommand(`install-${id}`, { sh: what.sh, ps: what.ps, banner: `Installing ${name} for AgentsCircle`, hint: 'This window shows the installer. When it finishes, go back to AgentsCircle and click Check again.' });
    res.json({ ...r, docs: what.docs || null });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- shared connectors ----------
const cerr = (res, e) => res.status(400).json({ error: e.message });
app.get('/api/connectors', (_req, res) => res.json(connectors.list()));
app.get('/api/connectors/catalog', (_req, res) => res.json(connectors.catalog()));
app.get('/api/connectors/import', (_req, res) => res.json(connectors.importable()));
app.get('/api/connectors/registry', async (req, res) => {
  try { res.json(await connectors.searchRegistry(String(req.query.q || ''))); }
  catch (e) { res.status(502).json({ error: `Couldn't search the MCP Registry: ${e.message}` }); }
});
app.post('/api/connectors', (req, res) => {
  try { const c = connectors.add(req.body || {}); broadcastConnectors(); res.json(connectors.list().find((x) => x.name === c.name)); } catch (e) { cerr(res, e); }
});
app.patch('/api/connectors/:name', (req, res) => {
  try { const c = connectors.update(req.params.name, req.body || {}); broadcastConnectors(); res.json(connectors.list().find((x) => x.name === c.name)); } catch (e) { cerr(res, e); }
});
app.delete('/api/connectors/:name', (req, res) => {
  try { connectors.remove(req.params.name); broadcastConnectors(); res.json({ ok: true }); } catch (e) { cerr(res, e); }
});
app.post('/api/connectors/:name/test', async (req, res) => {
  try { const r = await connectors.test(req.params.name); broadcastConnectors(); res.json(r); } catch (e) { cerr(res, e); }
});
app.post('/api/connectors/:name/oauth', async (req, res) => {
  const c = connectors.get(req.params.name);
  if (!c) return res.status(404).json({ error: 'No such connector.' });
  try { const f = await oauth.start(c); if (f.state === 'done') broadcastConnectors(); res.json(f); } catch (e) { cerr(res, e); }
});
app.post('/api/connectors/:name/signout', (req, res) => {
  try { connectors.signOut(req.params.name); broadcastConnectors(); res.json({ ok: true }); } catch (e) { cerr(res, e); }
});
app.post('/api/connectors/:name/signin', (req, res) => {
  const agent = agentById((req.body || {}).agent);
  if (!agent) return res.status(400).json({ error: 'Pick an agent to sign in.' });
  try { res.json(connectors.signIn(req.params.name, agent)); } catch (e) { cerr(res, e); }
});

app.get('/api/sessions', (_req, res) => {
  res.json([...sessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(summary));
});

app.post('/api/sessions', (req, res) => {
  const folder = path.resolve(expandHome((req.body.folder || '').trim()));
  if (!req.body.folder || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
    return res.status(400).json({ error: `Folder not found: ${req.body.folder || '(empty)'}` });
  }
  const members = (req.body.members || []).filter((id) => agentById(id));
  const s = {
    id: uid(), name: (req.body.name || path.basename(folder)).slice(0, 80), folder, members,
    defaultAgent: members[0] || null, createdAt: now(), updatedAt: now(), messages: [], queue: [], runs: new Map(),
  };
  if (typeof req.body.context === 'string' && req.body.context.trim()) s.context = { text: req.body.context.trim().slice(0, CONTEXT_TEXT_CAP), files: [] };
  sessions.set(s.id, s);
  saveSession(s);
  if (req.body.importRef) { try { importConversation(s, String(req.body.importRef)); } catch (e) { addMessage(s, { role: 'system', text: `Couldn't bring in that conversation: ${e.message}` }); } }
  broadcastAll({ type: 'sessions' });
  res.json(summary(s));
});

// Bring a conversation from Claude Code or Codex into a circle.
function importConversation(s, ref) {
  const c = conversations.read(ref);
  const importId = uid();
  const users = c.msgs.filter((m) => m.role === 'user').length;
  const head = addMessage(s, { role: 'system', kind: 'import', importId, tool: c.tool, count: c.msgs.length,
    text: `Brought in a conversation from ${c.source} (${c.msgs.length} messages, ${users} from you). Every agent in this circle now has it as context.` });
  for (const m of c.msgs) {
    s.messages.push({ id: uid(), at: m.at || now(), role: 'external', from: m.role === 'assistant' ? 'agent' : m.role, tool: c.tool, importId, text: m.text });
  }
  s.updatedAt = now();
  saveSession(s);
  broadcast(s.id, { type: 'reload' });
  return { importId, count: c.msgs.length, head: head.id };
}
// ---------- GitHub: start a session from a repository ----------
app.get('/api/github/status', async (_req, res) => res.json(await github.status()));
app.get('/api/github/repos', async (_req, res) => { try { res.json(await github.repos()); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/github/clone', async (req, res) => {
  try { res.json(await github.clone((req.body || {}).repo, (req.body || {}).parent)); }
  catch (e) { res.status(400).json({ error: e.message, code: e.code || null }); }
});
// Sign in to GitHub from the app, no Terminal: runs the GitHub CLI's browser sign-in in the background,
// shows its one-time code in the app, and opens github.com/login/device.
let ghFlow = null;
function ghEmit() { broadcastAll({ type: 'gh-signin', flow: ghFlow && { state: ghFlow.state, code: ghFlow.code, url: ghFlow.url, message: ghFlow.message } }); }
app.post('/api/github/signin-app', async (_req, res) => {
  const st = await github.status();
  if (st.signedIn) { ghFlow = { state: 'done', message: `Signed in to GitHub as ${st.user}.` }; ghEmit(); return res.json({ state: 'done', message: ghFlow.message }); }
  if (!st.gh) {
    // Install the GitHub CLI in the background (Homebrew on macOS, winget on Windows), then sign in.
    const brew = !IS_WIN && (run('which', ['brew']) || ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'].find((b) => fs.existsSync(b)));
    if (!brew && !IS_WIN) return res.json({ state: 'needs-cli', docs: 'https://cli.github.com', message: 'GitHub sign-in uses the GitHub CLI. Install it from cli.github.com, then sign in again.' });
    if (ghFlow && ghFlow.state === 'installing') return res.json({ state: 'installing', message: ghFlow.message });
    ghFlow = { state: 'installing', message: 'Installing the GitHub CLI (one time, about a minute)…' }; ghEmit();
    const [cmd, args] = IS_WIN ? ['winget', ['install', '--id', 'GitHub.cli', '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements']] : [brew, ['install', 'gh']];
    const inst = spawn(cmd, args, { env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '1', NONINTERACTIVE: '1' }, windowsHide: true, stdio: 'ignore' });
    inst.on('error', (e) => { ghFlow = { state: 'failed', message: `Couldn't install the GitHub CLI: ${e.message}`, docs: 'https://cli.github.com' }; ghEmit(); });
    inst.on('close', async (code) => {
      if (IS_WIN) process.env.PATH = `${process.env.PATH};C:\\Program Files\\GitHub CLI`;
      else if (!run('which', ['gh'])) process.env.PATH = `${path.dirname(brew)}:${process.env.PATH}`;
      if (code !== 0 || !(await github.status()).gh) { ghFlow = { state: 'failed', message: 'Installing the GitHub CLI didn\'t work. Install it from cli.github.com, then sign in again.' }; ghEmit(); return; }
      ghFlow = null;
      fetch(`http://127.0.0.1:${PORT}/api/github/signin-app`, { method: 'POST' }).catch(() => {});
    });
    return res.json({ state: 'installing', message: ghFlow.message });
  }
  if (ghFlow && ghFlow.child && ghFlow.state === 'waiting') return res.json({ state: ghFlow.state, code: ghFlow.code, url: ghFlow.url, message: ghFlow.message });
  const child = spawn('gh', ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web', '--skip-ssh-key'], { env: { ...process.env, GH_PROMPT_DISABLED: '', BROWSER: IS_WIN ? '' : 'true' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const f = ghFlow = { child, state: 'starting', out: '', message: 'Starting GitHub sign-in…' };
  const feed = (d) => {
    f.out += d;
    const code = /code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(f.out);
    if (code && !f.code) {
      f.code = code[1]; f.url = 'https://github.com/login/device'; f.state = 'waiting';
      f.message = 'Enter this code on GitHub, then approve AgentsCircle\'s access.';
      try { child.stdin.write('\n'); } catch { /* fine */ }
      openUrl(f.url);
      ghEmit();
    }
  };
  child.stdout.on('data', (d) => feed(String(d))); child.stderr.on('data', (d) => feed(String(d)));
  child.stdin.on('error', () => {});
  const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 15 * 60000);
  child.on('error', (e) => { clearTimeout(timer); f.state = 'failed'; f.message = e.message; ghEmit(); });
  child.on('close', async (code) => {
    clearTimeout(timer);
    if (ghFlow !== f) return;
    f.child = null;
    if (code === 0) {
      spawn.sync('gh', ['auth', 'setup-git'], { windowsHide: true });
      const s2 = await github.status();
      f.state = s2.signedIn ? 'done' : 'failed';
      f.message = s2.signedIn ? `Signed in to GitHub as ${s2.user}. Push and clone now use this account.` : 'GitHub sign-in finished, but the GitHub CLI still isn\'t signed in.';
    } else if (f.state !== 'cancelled') {
      f.state = 'failed';
      f.message = f.out.split('\n').map((l) => l.trim()).filter((l) => l && !/code:|login\/device/i.test(l)).slice(-2).join(' ') || `GitHub sign-in ended (code ${code}).`;
    }
    ghEmit();
  });
  // Wait briefly for the code so the first answer can show it.
  for (let i = 0; i < 30 && !f.code && f.state === 'starting'; i++) await new Promise((r) => setTimeout(r, 200));
  res.json({ state: f.state, code: f.code, url: f.url, message: f.message });
});
app.post('/api/github/signin-app/cancel', (_req, res) => {
  if (ghFlow && ghFlow.child) { ghFlow.state = 'cancelled'; try { ghFlow.child.kill(); } catch { /* gone */ } }
  ghFlow = null; res.json({ ok: true });
});

// Opens a terminal window that signs you in to GitHub (and installs the GitHub CLI if needed).
app.post('/api/github/signin', async (_req, res) => {
  const st = await github.status();
  const login = 'gh auth login --hostname github.com --git-protocol https --web && gh auth setup-git';
  const hasBrew = !IS_WIN && !!run('which', ['brew']);
  if (!st.gh && !IS_WIN && !hasBrew) return res.json({ docs: 'https://cli.github.com', message: 'Install the GitHub CLI from cli.github.com, then click Sign in to GitHub again.' });
  const sh = st.gh ? login : `brew install gh && ${login}`;
  const ps = st.gh ? login.replace('&&', ';') : `winget install --id GitHub.cli -e --source winget; $env:Path += ';C:\\Program Files\\GitHub CLI'; ${login.replace('&&', ';')}`;
  accounts.openCommand('github-signin', { sh, ps, banner: 'Sign in to GitHub for AgentsCircle', hint: 'Follow the steps: copy the one-time code, press Enter, and approve in your browser.' });
  res.json({ opened: true });
});

// A connector's official icon (from its website, cached). SVGs are served as images only.
app.get('/api/site-icon/:site', async (req, res) => {
  const icon = await siteIcons.get(req.params.site).catch(() => null);
  if (!icon) return res.status(404).end();
  res.set({ 'Content-Type': icon.type, 'Cache-Control': 'public, max-age=86400', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'", 'X-Content-Type-Options': 'nosniff' });
  res.send(icon.buf);
});
app.get('/api/attention', (_req, res) => res.json(attention()));
app.get('/api/usage', (_req, res) => { try { res.json(usage.all()); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/conversations', (req, res) => {
  const folder = path.resolve(expandHome(String(req.query.folder || '').trim().replace(/^["']|["']$/g, '')));
  if (!req.query.folder || !fs.existsSync(folder)) return res.json([]);
  try { res.json(conversations.list(folder)); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/sessions/:id/import', (req, res) => {
  const s = getSession(req, res); if (!s) return;
  try { res.json(importConversation(s, String((req.body || {}).ref || ''))); } catch (e) { res.status(400).json({ error: e.message }); }
});

const getSession = (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) res.status(404).json({ error: 'Session not found' });
  return s;
};

app.get('/api/sessions/:id', (req, res) => {
  const s = getSession(req, res); if (!s) return;
  res.json({ ...summary(s), defaultAgent: s.defaultAgent, worktrees: Object.fromEntries(Object.keys(s.worktrees || {}).map((k) => [k, true])), isRepo: checkpoints.isRepo(s.folder), allowRules: s.allowRules || [], messages: s.messages, queue: s.queue.map((q) => q.agentId) });
});

app.patch('/api/sessions/:id', (req, res) => {
  const s = getSession(req, res); if (!s) return;
  if (Array.isArray(req.body.members)) s.members = req.body.members.filter((id) => agentById(id));
  if (req.body.name) s.name = String(req.body.name).slice(0, 80);
  if ('defaultAgent' in req.body) s.defaultAgent = req.body.defaultAgent || null;
  if ('handoffs' in req.body) s.handoffs = !!req.body.handoffs;
  if ('mode' in req.body) {
    if (busy(s)) return res.status(409).json({ error: 'Wait until the agents finish before switching mode.' });
    if (req.body.mode === 'parallel' && !checkpoints.isRepo(s.folder)) return res.status(400).json({ error: 'Parallel mode needs git in this folder. Turn it on with the banner at the top of the chat.' });
    s.mode = req.body.mode === 'parallel' ? 'parallel' : 'shared';
  }
  saveSession(s);
  broadcast(s.id, { type: 'session', session: { ...summary(s), defaultAgent: s.defaultAgent } });
  res.json(summary(s));
});

app.delete('/api/sessions/:id', (req, res) => {
  const s = getSession(req, res); if (!s) return;
  for (const r of s.runs.values()) killTree(r.child);
  terminals.kill(s.id);
  for (const id of Object.keys(s.worktrees || {})) worktrees.discard(s, id);
  sessions.delete(s.id);
  fs.rmSync(sessionFile(s.id), { force: true });
  // Our own copies of the session's context files; the rest of the project folder is never touched.
  try { fs.rmSync(contextDir(s), { recursive: true, force: true }); } catch { /* already gone */ }
  broadcastAll({ type: 'sessions', deleted: s.id });
  broadcastAttention();
  res.json({ ok: true });
});

app.post('/api/sessions/:id/messages', (req, res) => {
  const s = getSession(req, res); if (!s) return;
  const text = String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Empty message' });
  const attachments = (Array.isArray(req.body.attachments) ? req.body.attachments : []).map((a) => {
    const full = safePath(s, a && a.path);
    if (!full || !fs.existsSync(full) || !String(a.path).startsWith('.agentscircle/uploads/')) return null;
    return { path: String(a.path), name: String(a.name || path.basename(full)).slice(0, 200), size: fs.statSync(full).size, kind: kindOf(full) };
  }).filter(Boolean);
  const msg = addMessage(s, { role: 'user', text, ...(attachments.length ? { attachments } : {}) });
  routeMentions(s, msg);
  res.json({ ok: true, id: msg.id });
});

app.post('/api/sessions/:id/stop', (req, res) => {
  const s = getSession(req, res); if (!s) return;
  s.queue = [];
  for (const [id, ap] of approvals) if (ap.s === s) settleApproval(id, 'deny', 'you', 'Stopped by the user.');
  for (const r of s.runs.values()) { r.stopRequested = true; killTree(r.child); }
  res.json({ ok: true });
});

// ---------- the circle connector: approvals, questions, reading the chat, hand-offs ----------
// Every call carries the run's key; it only works while that run is going.
const recentlyEnded = new Map(); // run key -> token, so a last poll after the run ends still gets an answer
function runFor(req, res) {
  const run = req.headers['x-agentscircle-run'] || (req.body || {}).run;
  const r = runs.get(run);
  const token = r ? r.token : recentlyEnded.get(run);
  if (!run || !token || req.headers['x-agentscircle-token'] !== token) { res.status(403).json({ error: 'This run is no longer active.' }); return false; }
  return r || null;
}
const checkToken = (req, res) => runFor(req, res) !== false;
app.post('/api/internal/approval', (req, res) => {
  const r = runFor(req, res); if (r === false) return;
  const { tool_name: toolName, input } = req.body || {};
  if (!r) return res.json({ behavior: 'deny', message: 'This run is no longer active.' });
  const c = safety.classify(toolName, input || {});
  const allowRules = r.s.allowRules || [];
  let verdict = safety.decide(r.level, c);
  if (verdict === 'ask' && allowRules.includes(`${r.agent.id}|${c.key}`)) verdict = 'allow';
  const log = (line) => { r.reply.activity.push(line); broadcast(r.s.id, { type: 'activity', id: r.reply.id, line }); };
  if (verdict === 'allow') return res.json({ behavior: 'allow' });
  if (verdict === 'deny') {
    log(`blocked (read only): ${c.summary.slice(0, 120)}`);
    return res.json({ behavior: 'deny', message: `@${r.agent.id} is set to Read only in AgentsCircle, so it can't do this: ${c.summary}. Explain what you would change instead, or ask the user to change your permission level.` });
  }
  const id = uid();
  const item = { id, tool: toolName, kind: c.kind, summary: c.summary, key: c.key, input: JSON.stringify(input || {}).slice(0, 2000), status: 'pending', at: now() };
  r.reply.approvals.push(item);
  approvals.set(id, { s: r.s, reply: r.reply, item, result: null });
  updateMessage(r.s, r.reply, { approvals: r.reply.approvals, waiting: true }, true);
  notifyUser(r.s, { kind: 'approval', agent: r.agent.id, messageId: r.reply.id, text: c.summary });
  broadcast(r.s.id, { type: 'approval', pending: [...approvals.values()].filter((x) => x.s === r.s && x.item.status === 'pending').length });
  // Give up after 30 minutes without an answer.
  setTimeout(() => settleApproval(id, 'deny', 'system', 'No answer from the user within 30 minutes.'), 30 * 60 * 1000);
  res.json({ pending: true, id });
});
app.get('/api/internal/approval/:id', (req, res) => {
  if (!checkToken(req, res)) return;
  const ap = approvals.get(req.params.id);
  if (!ap) return res.json({ behavior: 'deny', message: 'This request expired.' });
  if (!ap.result) return res.json({ pending: true, id: req.params.id });
  res.json(ap.result);
});

function settleQuestion(id, answer, by) {
  const q = questions.get(id);
  if (!q || q.item.status !== 'pending') return false;
  q.item.status = answer ? 'answered' : 'expired';
  q.item.answer = answer || null; q.item.by = by; q.item.answeredAt = now();
  q.result = { answer: answer || null };
  updateMessage(q.s, q.reply, { questions: q.reply.questions, waiting: q.reply.questions.some((x) => x.status === 'pending') || (q.reply.approvals || []).some((x) => x.status === 'pending') }, true);
  broadcast(q.s.id, { type: 'approval', pending: 0 });
  setTimeout(() => questions.delete(id), 10 * 60 * 1000);
  return true;
}
const circleLog = (r, line) => { r.reply.activity.push(line); broadcast(r.s.id, { type: 'activity', id: r.reply.id, line }); };

app.post('/api/internal/circle/thread', (req, res) => {
  const r = runFor(req, res); if (!r) return r === false ? undefined : res.json({ text: 'This run ended.' });
  const { last, search, from } = req.body || {};
  let list = r.s.messages.filter((m) => !m.pending && (m.text || '').trim() && m.id !== r.reply.id);
  if (search) { const q = String(search).toLowerCase(); list = list.filter((m) => m.text.toLowerCase().includes(q)); }
  if (from) { const f = String(from).toLowerCase().replace(/^@/, ''); list = list.filter((m) => (f === 'user' || f === 'you' ? m.role === 'user' : m.agent === f)); }
  const n = Math.min(Math.max(Number(last) || 20, 1), 100);
  list = list.slice(-n);
  circleLog(r, `read the chat${search ? ` (search: ${String(search).slice(0, 40)})` : ''}`);
  let text = list.map((m) => `${new Date(m.at).toISOString().slice(0, 16).replace('T', ' ')} ${blockFor(m)}`).join('\n\n');
  if (text.length > 60000) text = '…(older part cut)\n' + text.slice(-60000);
  res.json({ text: text || '(no messages match)' });
});
app.post('/api/internal/circle/agents', (req, res) => {
  const r = runFor(req, res); if (!r) return r === false ? undefined : res.json({ agents: [] });
  let caps = {}; try { caps = sessionCapabilities(r.s); } catch { /* best effort */ }
  const list = r.s.members.map(agentById).filter(Boolean).map((a) => ({
    handle: '@' + a.id, you: a.id === r.agent.id, tool: accounts.tool(a).name, account: a.label || (a.identity && a.identity.label) || '',
    status: r.s.runs.has(a.id) ? 'working' : a.limitedAt ? 'hit its usage limit' : 'free',
    permission: safety.LEVELS[a.permission || 'risky'],
    skills: ((caps[a.id] || {}).skills || []).map((k) => k.name).slice(0, 40),
    connectors: ((caps[a.id] || {}).connectors || []).map((c) => c.name),
  }));
  res.json({ agents: list });
});
app.post('/api/internal/circle/mention', (req, res) => {
  const r = runFor(req, res); if (!r) return r === false ? undefined : res.json({ error: 'This run ended.' });
  const to = String((req.body || {}).agent || '').trim().replace(/^@/, '').toLowerCase();
  const task = String((req.body || {}).task || '').trim().slice(0, 4000);
  if (!task) return res.json({ error: 'Say what the agent should do (task).' });
  const problem = handoffProblem(r.s, r.agent, to, r.hop);
  if (problem) return res.json({ error: problem });
  handoff(r.s, r.agent, r.reply, to, task, r.hop);
  r.reply.toolHandoffs = [...(r.reply.toolHandoffs || []), to];
  updateMessage(r.s, r.reply, { handoffs: [...(r.reply.handoffs || []), { to, task }] }, true);
  if (r.s.mode === 'parallel') pump(r.s);
  res.json({ text: r.s.mode === 'parallel' ? `@${to} got the task and starts now on its own branch.` : `@${to} got the task and starts when your turn ends. Finish your own part, then end your turn.` });
});
// An agent asks AgentsCircle to commit (its own sandbox may block writing to .git).
app.post('/api/internal/circle/commit', (req, res) => {
  const r = runFor(req, res); if (!r) return r === false ? undefined : res.json({ error: 'This run ended.' });
  const b = req.body || {};
  const message = String(b.message || '').trim().slice(0, 2000);
  if (!message) return res.json({ error: 'Write a commit message (message).' });
  if (r.reply.workdir) return res.json({ error: 'You work on your own branch in parallel mode; commit there with git, or the user applies your branch.' });
  if (!checkpoints.isRepo(r.s.folder)) return res.json({ error: 'This folder isn\'t a git repository.' });
  const snap = gitSnapshot(r.s.folder);
  if (!snap || !snap.files.size) return res.json({ error: 'There are no uncommitted changes.' });
  let paths;
  if (b.all) paths = [...snap.files.keys()];
  else {
    const want = (Array.isArray(b.files) ? b.files : []).map((f) => String(f).replace(/^\.\//, '').trim()).filter(Boolean);
    if (!want.length) return res.json({ error: 'List the files to commit (files), or set all: true to commit every uncommitted change.' });
    const bad = want.filter((f) => !safePath(r.s, f) || !snap.files.has(f));
    if (bad.length) return res.json({ error: `These aren't uncommitted changes in the project: ${bad.join(', ')}. Uncommitted: ${[...snap.files.keys()].slice(0, 30).join(', ')}` });
    paths = want;
  }
  try { const out = commitPaths(r.s, paths, message, { who: `@${r.agent.id}`, what: `${paths.length === 1 ? paths[0] : `${paths.length} files`} (asked through AgentsCircle)` }); res.json({ text: `Committed ${out.hash}: ${out.files.join(', ')}` }); }
  catch (e) { res.json({ error: e.message }); }
});

app.post('/api/internal/circle/push', async (req, res) => {
  const r = runFor(req, res); if (!r) return r === false ? undefined : res.json({ error: 'This run ended.' });
  if (r.reply.workdir) return res.json({ error: 'You work on your own branch in parallel mode; the user applies your branch, then pushes.' });
  try {
    const out = await gitsync.push(r.s.folder);
    syncNote(r.s, `@${r.agent.id} pushed ${out.pushed ? `${out.pushed} commit${out.pushed > 1 ? 's' : ''}` : out.branch} to ${out.web || out.url || out.remote} (asked through AgentsCircle).`);
    broadcast(r.s.id, { type: 'sync', state: gitsync.state(r.s.folder) });
    res.json({ text: `Pushed ${out.branch} to ${out.web || out.url || out.remote}.` });
  } catch (e) { res.json({ error: e.message }); }
});

app.post('/api/internal/circle/ask', (req, res) => {
  const r = runFor(req, res); if (!r) return r === false ? undefined : res.json({ error: 'This run ended.' });
  const b = req.body || {};
  const question = String(b.question || '').trim().slice(0, 2000);
  if (!question) return res.json({ error: 'Write the question.' });
  const options = (Array.isArray(b.options) ? b.options : []).map((o) => String(o).trim().slice(0, 200)).filter(Boolean).slice(0, 8);
  const id = uid();
  const item = { id, question, options, multiple: !!b.multiple, status: 'pending', at: now() };
  r.reply.questions = r.reply.questions || [];
  r.reply.questions.push(item);
  questions.set(id, { s: r.s, reply: r.reply, item, result: null });
  updateMessage(r.s, r.reply, { questions: r.reply.questions, waiting: true }, true);
  broadcast(r.s.id, { type: 'approval', pending: 1 });
  notifyUser(r.s, { kind: 'question', agent: r.agent.id, messageId: r.reply.id, text: question });
  setTimeout(() => settleQuestion(id, null, 'system'), 30 * 60 * 1000);
  res.json({ pending: true, id });
});
app.get('/api/internal/circle/ask/:qid', (req, res) => {
  if (runFor(req, res) === false) return;
  const q = questions.get(req.params.qid);
  if (!q) return res.json({ answer: null });
  if (!q.result) return res.json({ pending: true, id: req.params.qid });
  res.json(q.result);
});
app.post('/api/sessions/:id/questions/:qid', (req, res) => {
  const s = getSession(req, res); if (!s) return;
  const q = questions.get(req.params.qid);
  if (!q || q.s !== s) return res.status(404).json({ error: 'That question is no longer waiting.' });
  const answer = String((req.body || {}).answer || '').trim().slice(0, 4000);
  if (!answer) return res.status(400).json({ error: 'Pick an option or type an answer.' });
  res.json({ ok: settleQuestion(req.params.qid, answer, 'you') });
});

app.post('/api/sessions/:id/approvals/:aid', (req, res) => {
  const s = getSession(req, res); if (!s) return;
  const ap = approvals.get(req.params.aid);
  if (!ap || ap.s !== s) return res.status(404).json({ error: 'That request is no longer waiting.' });
  const d = (req.body || {}).decision;
  if (d === 'always') {
    s.allowRules = [...new Set([...(s.allowRules || []), `${ap.reply.agent}|${ap.item.key}`])];
    saveSession(s);
  }
  const note = String((req.body || {}).note || '').slice(0, 500);
  const ok = settleApproval(req.params.aid, d === 'deny' ? 'deny' : 'allow', 'you', d === 'deny' ? `The user denied this.${note ? ' They said: ' + note : ''}` : '');
  if (ok && d === 'always') { ap.item.always = true; updateMessage(s, ap.reply, { approvals: ap.reply.approvals }, true); }
  res.json({ ok });
});

// ---------- parallel mode: branches per agent ----------
app.get('/api/sessions/:id/branches', (req, res) => {
  const s = getSession(req, res); if (!s) return;
  res.json(worktrees.status(s).map(({ snap, ...b }) => ({ ...b, working: s.runs.has(b.agent) })));
});
app.get('/api/sessions/:id/branches/:agent/diff', (req, res) => {
  const s = getSession(req, res); if (!s) return;
  try { res.json({ diff: worktrees.diff(s, req.params.agent) }); } catch (e) { res.status(404).json({ error: e.message }); }
});
app.post('/api/sessions/:id/branches/:agent/apply', (req, res) => {
  const s = getSession(req, res); if (!s) return;
  if (s.runs.has(req.params.agent)) return res.status(409).json({ error: `Wait until @${req.params.agent} finishes.` });
  if (s.mode !== 'parallel' && busy(s)) return res.status(409).json({ error: 'Wait until the agents finish.' });
  // Checkpoints around the apply, so it can be reviewed and undone like an agent turn.
  const before = checkpoints.snapshot(s.folder, `refs/agentscircle/${s.id}/apply-${uid()}-before`, `AgentsCircle: before applying @${req.params.agent}`);
  let r;
  try { r = worktrees.apply(s, req.params.agent); } catch (e) { return res.status(400).json({ error: e.message }); }
  const after = checkpoints.snapshot(s.folder, `refs/agentscircle/${s.id}/apply-${uid()}-after`, `AgentsCircle: after applying @${req.params.agent}`);
  const files = before && after ? (checkpoints.changedFiles(s.folder, before, after) || []) : [];
  saveSession(s);
  const lines = [`Applied @${req.params.agent}'s branch to your folder: ${r.applied.length} file${r.applied.length === 1 ? '' : 's'} (${r.applied.slice(0, 6).map((a) => `${a.path} ${a.action}`).join(', ')}${r.applied.length > 6 ? ', …' : ''}).`];
  if (r.conflicts.length) lines.push(`**${r.conflicts.length} need${r.conflicts.length === 1 ? 's' : ''} a look:** ${r.conflicts.map((c) => `${c.path}: ${c.why}`).join('; ')}. You can ask an agent to resolve them.`);
  if (r.skipped.length) lines.push(`Skipped: ${r.skipped.map((c) => `${c.path} (${c.why})`).join('; ')}.`);
  lines.push('Agents: these changes are now in the main folder (not committed).');
  addMessage(s, { role: 'system', kind: 'apply', agent: req.params.agent, text: lines.join('\n\n'), files, checkpoint: before && after ? { before, after } : null, endedAt: now() });
  broadcast(s.id, { type: 'branches' });
  res.json(r);
});
app.post('/api/sessions/:id/branches/:agent/discard', (req, res) => {
  const s = getSession(req, res); if (!s) return;
  if (s.runs.has(req.params.agent)) return res.status(409).json({ error: `Wait until @${req.params.agent} finishes.` });
  worktrees.discard(s, req.params.agent);
  saveSession(s);
  addMessage(s, { role: 'system', text: `Discarded @${req.params.agent}'s branch. Its next turn starts fresh from your folder.` });
  broadcast(s.id, { type: 'branches' });
  res.json({ ok: true });
});

// ---------- checkpoints: review and undo a turn ----------
const turnOf = (s, mid) => s.messages.find((m) => m.id === mid && (m.role === 'agent' || m.kind === 'apply'));
app.get('/api/sessions/:id/turns/:mid/diff', (req, res) => {
  const s = getSession(req, res); if (!s) return;
  const m = turnOf(s, req.params.mid);
  if (!m || !m.checkpoint) return res.status(404).json({ error: 'No checkpoint for this turn.' });
  res.json({ diff: checkpoints.diff(s.folder, m.checkpoint.before, m.checkpoint.after, req.query.path) || '', files: checkpoints.changedFiles(s.folder, m.checkpoint.before, m.checkpoint.after) || [] });
});
app.get('/api/sessions/:id/turns/:mid/undo', (req, res) => {
  const s = getSession(req, res); if (!s) return;
  const m = turnOf(s, req.params.mid);
  if (!m || !m.checkpoint) return res.status(404).json({ error: 'No checkpoint for this turn.' });
  const files = (checkpoints.changedFiles(s.folder, m.checkpoint.before, m.checkpoint.after) || []).map((f) => f.path);
  const idx = s.messages.indexOf(m);
  const later = s.messages.slice(idx + 1).filter((x) => x.role === 'agent' && !x.undone && (x.files || []).some((f) => files.includes(f.path)))
    .map((x) => ({ id: x.id, agent: x.agent, files: x.files.filter((f) => files.includes(f.path)).map((f) => f.path) }));
  res.json({ files, later, commits: m.commits || [] });
});
// ---------- model and effort per agent, per session ----------
app.get('/api/sessions/:id/agents/:agent/model', (req, res) => {
  const s = getSession(req, res); if (!s) return;
  const agent = agentById(req.params.agent);
  if (!agent) return res.status(404).json({ error: 'No such agent.' });
  const own = (s.agentModels && s.agentModels[agent.id]) || {};
  res.json({ options: models.options(agent), session: { model: own.model || null, effort: own.effort || null }, account: { model: agent.model || null, effort: agent.effort || null }, tool: accounts.tool(agent).name, busy: s.runs && s.runs.has(agent.id) });
});
app.put('/api/sessions/:id/agents/:agent/model', (req, res) => {
  const s = getSession(req, res); if (!s) return;
  const agent = agentById(req.params.agent);
  if (!agent) return res.status(404).json({ error: 'No such agent.' });
  const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 100) : null);
  const model = clean((req.body || {}).model), effort = clean((req.body || {}).effort);
  if (model && !/^[\w.:/@\[\]-]+$/.test(model)) return res.status(400).json({ error: 'That doesn\'t look like a model name.' });
  if (effort && !/^[a-z]+$/.test(effort)) return res.status(400).json({ error: 'Unknown effort level.' });
  s.agentModels ||= {};
  const before = s.agentModels[agent.id] || {};
  if (model || effort) s.agentModels[agent.id] = { model, effort }; else delete s.agentModels[agent.id];
  if (before.model !== model || before.effort !== effort) {
    const what = model || effort ? [model || 'its usual model', effort ? `${effort} effort` : null].filter(Boolean).join(' · ') : 'its usual model and effort';
    const text = `@${agent.id} now uses ${what} in this session${s.runs && s.runs.has(agent.id) ? ', from its next turn' : ''}.`;
    // Several quick changes make one note, not one per click.
    const last = s.messages[s.messages.length - 1];
    if (last && last.kind === 'modelset' && last.modelAgent === agent.id) updateMessage(s, last, { text, at: now() }, true);
    else addMessage(s, { role: 'system', kind: 'modelset', modelAgent: agent.id, text });
  }
  saveSession(s);
  broadcast(s.id, { type: 'session', session: { ...summary(s), defaultAgent: s.defaultAgent } });
  res.json({ session: s.agentModels[agent.id] || { model: null, effort: null } });
});

// Run the same message again for the same agent (after signing in again, for example).
app.post('/api/sessions/:id/turns/:mid/retry', (req, res) => {
  const s = getSession(req, res); if (!s) return;
  const m = s.messages.find((x) => x.id === req.params.mid);
  if (!m || m.role !== 'agent' || m.pending) return res.status(400).json({ error: 'There is no finished turn to retry.' });
  const trigger = s.messages.find((x) => x.id === m.replyTo);
  if (!trigger) return res.status(400).json({ error: 'The message this turn answered is gone.' });
  if (!agentById(m.agent)) return res.status(400).json({ error: `@${m.agent} isn't one of your accounts any more.` });
  updateMessage(s, m, { retried: true }, true);
  s.queue.push({ agentId: m.agent, trigger, hop: 0 });
  broadcast(s.id, { type: 'queue', queue: s.queue.map((q) => q.agentId) });
  pump(s);
  res.json({ ok: true });
});

app.post('/api/sessions/:id/turns/:mid/undo', (req, res) => {
  const s = getSession(req, res); if (!s) return;
  if (busy(s)) return res.status(409).json({ error: 'Wait until the agents finish, or stop them first.' });
  const m = turnOf(s, req.params.mid);
  if (!m || !m.checkpoint) return res.status(404).json({ error: 'No checkpoint for this turn.' });
  if (m.undone) return res.status(400).json({ error: 'This turn was already undone.' });
  // Save the current state first, so the undo itself can be undone.
  const safetyRef = checkpoints.snapshot(m.workdir || s.folder, `refs/agentscircle/${s.id}/${m.id}-pre-undo`, `AgentsCircle: before undoing @${m.agent}`);
  const files = (checkpoints.changedFiles(s.folder, m.checkpoint.before, m.checkpoint.after) || []).map((f) => f.path);
  const done = checkpoints.restore(m.workdir || s.folder, m.checkpoint.before, files);
  updateMessage(s, m, { undone: true, undoneAt: now(), undoRef: safetyRef }, true);
  addMessage(s, { role: 'system', text: `Undid @${m.agent}'s turn: put back ${done.length} file${done.length === 1 ? '' : 's'} (${done.slice(0, 6).map((d) => d.path).join(', ')}${done.length > 6 ? ', …' : ''}).${(m.commits || []).length ? ' Commits it made stay in git history.' : ''} Agents: these files are back to how they were before that turn.` });
  res.json({ ok: true, files: done });
});
app.post('/api/sessions/:id/turns/:mid/redo', (req, res) => {
  const s = getSession(req, res); if (!s) return;
  if (busy(s)) return res.status(409).json({ error: 'Wait until the agents finish.' });
  const m = turnOf(s, req.params.mid);
  if (!m || !m.undone || !m.undoRef) return res.status(400).json({ error: 'Nothing to redo.' });
  const files = (checkpoints.changedFiles(s.folder, m.checkpoint.before, m.checkpoint.after) || []).map((f) => f.path);
  const done = checkpoints.restore(m.workdir || s.folder, m.undoRef, files);
  updateMessage(s, m, { undone: false, undoRef: null }, true);
  addMessage(s, { role: 'system', text: `Brought back @${m.agent}'s changes (${done.length} file${done.length === 1 ? '' : 's'}).` });
  res.json({ ok: true });
});
app.post('/api/sessions/:id/git-init', (req, res) => {
  const s = getSession(req, res); if (!s) return;
  res.json({ ok: checkpoints.initRepo(s.folder) });
});

// ---------- attachments ----------
app.post('/api/sessions/:id/uploads', express.raw({ type: () => true, limit: '25mb' }), (req, res) => {
  const s = getSession(req, res); if (!s) return;
  const name = decodeURIComponent(String(req.headers['x-filename'] || 'file')).replace(/[^\w.\- ]+/g, '_').slice(-120) || 'file';
  const dir = path.join(s.folder, '.agentscircle', 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  ensureExcluded(s.folder); // keep uploads out of git (and out of checkpoints)
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const file = `${stamp}-${name}`;
  fs.writeFileSync(path.join(dir, file), req.body || Buffer.alloc(0));
  res.json({ path: `.agentscircle/uploads/${file}`, name, size: (req.body || []).length, kind: kindOf(file) });
});

// ---------- session context ----------
app.get('/api/sessions/:id/context', (req, res) => {
  const s = getSession(req, res); if (!s) return;
  const c = ctxOf(s);
  res.json({ text: c.text || '', files: c.files.map((f) => { let exists = false; try { exists = fs.statSync(path.join(s.folder, f.path)).isFile(); } catch { /* removed */ } return { ...f, exists }; }) });
});

app.put('/api/sessions/:id/context', (req, res) => {
  const s = getSession(req, res); if (!s) return;
  const c = ctxOf(s);
  if (typeof req.body.text === 'string') c.text = req.body.text.slice(0, CONTEXT_TEXT_CAP);
  saveSession(s);
  broadcast(s.id, { type: 'session', session: { ...summary(s), defaultAgent: s.defaultAgent } });
  broadcastAll({ type: 'sessions' });
  res.json({ text: c.text, files: c.files });
});

app.post('/api/sessions/:id/context/files', express.raw({ type: () => true, limit: '25mb' }), (req, res) => {
  const s = getSession(req, res); if (!s) return;
  const c = ctxOf(s);
  if (c.files.length >= 40) return res.status(400).json({ error: 'A session can have up to 40 context files.' });
  const name = decodeURIComponent(String(req.headers['x-filename'] || 'file')).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim().slice(-120) || 'file';
  const dir = contextDir(s);
  fs.mkdirSync(dir, { recursive: true });
  ensureExcluded(s.folder);
  let file = name.replace(/[^\w.\- ]+/g, '_'), n = 1;
  while (fs.existsSync(path.join(dir, file))) { const i = name.lastIndexOf('.'); file = (i > 0 ? name.slice(0, i) : name).replace(/[^\w.\- ]+/g, '_') + `-${++n}` + (i > 0 ? name.slice(i).replace(/[^\w.\- ]+/g, '_') : ''); }
  fs.writeFileSync(path.join(dir, file), req.body || Buffer.alloc(0));
  const entry = { path: path.posix.join('.agentscircle', 'context', s.id, file), name, size: (req.body || []).length, kind: kindOf(file), addedAt: now() };
  c.files.push(entry);
  saveSession(s);
  broadcast(s.id, { type: 'session', session: { ...summary(s), defaultAgent: s.defaultAgent } });
  broadcastAll({ type: 'sessions' });
  res.json(entry);
});

app.delete('/api/sessions/:id/context/files', (req, res) => {
  const s = getSession(req, res); if (!s) return;
  const c = ctxOf(s);
  const p = String(req.query.path || '');
  const i = c.files.findIndex((f) => f.path === p);
  if (i < 0) return res.status(404).json({ error: 'That file isn\'t in the session context.' });
  c.files.splice(i, 1);
  // Delete it only if it's our copy inside the session's context folder.
  const full = safePath(s, p);
  if (full && path.relative(contextDir(s), full).split(path.sep)[0] !== '..') { try { fs.rmSync(full, { force: true }); } catch { /* fine */ } }
  saveSession(s);
  broadcast(s.id, { type: 'session', session: { ...summary(s), defaultAgent: s.defaultAgent } });
  broadcastAll({ type: 'sessions' });
  res.json({ ok: true });
});

// ---------- search across sessions ----------
app.get('/api/search', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (q.length < 2) return res.json([]);
  const out = [];
  for (const s of [...sessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
    for (const m of [...s.messages].reverse()) {
      const t = String(m.text || '');
      const i = t.toLowerCase().indexOf(q);
      if (i < 0) continue;
      out.push({ sessionId: s.id, sessionName: s.name, messageId: m.id, who: speaker(m), at: m.at, snippet: (i > 60 ? '…' : '') + t.slice(Math.max(0, i - 60), i + q.length + 80).replace(/\s+/g, ' ') + (i + q.length + 80 < t.length ? '…' : '') });
      if (out.length >= 60) return res.json(out);
    }
  }
  res.json(out);
});

// ---------- summary ----------
app.post('/api/sessions/:id/summarize', async (req, res) => {
  const s = getSession(req, res); if (!s) return;
  if (busy(s)) return res.status(409).json({ error: 'Wait until the agents finish.' });
  try {
    const r = await summarize(s, agentById(s.defaultAgent), true);
    if (!r) return res.status(400).json({ error: 'Not enough conversation to summarize yet.' });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: `Couldn't summarize: ${e.message}` }); }
});

// ---------- skills and capabilities ----------
app.get('/api/sessions/:id/capabilities', (req, res) => {
  const s = getSession(req, res); if (!s) return;
  res.json(sessionCapabilities(s));
});
app.get('/api/skills', (req, res) => {
  const s = req.query.session ? sessions.get(String(req.query.session)) : null;
  const sharedList = skills.shared(s ? s.folder : null).map(({ name, description, scope, file, rel }) => ({ name, description, scope, path: rel || file }));
  const fromAgents = accounts.list().map((a) => ({ agent: a.id, tool: accounts.tool(a).name, skills: skills.capabilities(a).skills.map((k) => ({ name: k.name, description: k.description, shared: sharedList.some((x) => x.name === k.name) })) })).filter((x) => x.skills.length);
  res.json({ shared: sharedList, fromAgents, folder: skills.globalDir });
});
app.post('/api/skills/upload', express.raw({ type: () => true, limit: '20mb' }), (req, res) => {
  try {
    const s = req.query.session ? sessions.get(String(req.query.session)) : null;
    const k = skills.installZip(req.body, req.query.scope === 'project' ? 'project' : 'all', s ? s.folder : null);
    res.json({ name: k.name, description: k.description });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/skills/share', (req, res) => {
  const a = agentById((req.body || {}).agent);
  if (!a) return res.status(400).json({ error: 'No such agent.' });
  try { const k = skills.shareFromAgent(a, req.body.name); res.json({ name: k.name }); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/skills/:name', (req, res) => {
  const s = req.query.session ? sessions.get(String(req.query.session)) : null;
  try { skills.remove(req.params.name, s ? s.folder : null); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- files the agents produced (the session panel) ----------
const TEXT_EXT = new Set(['txt','md','markdown','js','jsx','ts','tsx','mjs','cjs','json','css','scss','html','htm','svg','xml','yml','yaml','toml','py','rb','go','rs','java','kt','swift','c','h','cpp','cs','php','sh','bash','zsh','sql','env','ini','csv','tsv','vue','svelte','astro','lock','gitignore','dockerfile','prisma','graphql']);
const IMG_EXT = new Set(['png','jpg','jpeg','gif','webp','avif','ico','bmp','svg']);
const extOf = (p) => { const b = path.basename(p).toLowerCase(); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i + 1) : b; };
function kindOf(p) {
  const e = extOf(p);
  if (e === 'html' || e === 'htm') return 'html';
  if (e === 'md' || e === 'markdown') return 'markdown';
  if (e === 'svg') return 'image';
  if (IMG_EXT.has(e)) return 'image';
  if (e === 'pdf') return 'pdf';
  if (e === 'docx') return 'doc';
  if (e === 'xlsx' || e === 'xlsm') return 'sheet';
  if (TEXT_EXT.has(e)) return 'text';
  return 'other';
}
// Files live in your folder, or (with wt = agent id) in that agent's worktree.
const baseFor = (s, wt) => (wt && s.worktrees && s.worktrees[wt] && fs.existsSync(s.worktrees[wt].dir) ? s.worktrees[wt].dir : s.folder);
function safePath(s, rel, wt) {
  if (typeof rel !== 'string' || !rel) return null;
  const base = fs.realpathSync(baseFor(s, wt));
  const full = path.resolve(base, rel);
  const relTo = path.relative(base, full);
  if (relTo.startsWith('..') || path.isAbsolute(relTo)) return null;
  try { const real = fs.realpathSync(full); const r2 = path.relative(base, real); if (r2.startsWith('..') || path.isAbsolute(r2)) return null; } catch { /* missing file is fine */ }
  return full;
}

function sessionFiles(s) {
  const map = new Map();
  for (const m of s.messages) {
    const wt = m.workdir ? m.agent : null;
    for (const f of m.files || []) {
      const key = `${wt || ''}|${f.path}`;
      const e = map.get(key) || { path: f.path, wt, branch: m.branch || null, firstStatus: f.status, agents: [], turns: 0 };
      e.status = f.status; e.turns += 1; e.lastAt = m.endedAt || m.at; e.lastAgent = m.agent; e.lastMessageId = m.id;
      if (m.agent && !e.agents.includes(m.agent)) e.agents.push(m.agent);
      map.set(key, e);
    }
  }
  return [...map.values()].map((e) => {
    const full = safePath(s, e.path, e.wt);
    let size = null, exists = false;
    try { const st = fs.statSync(full); exists = st.isFile(); size = st.size; } catch { /* gone */ }
    return { ...e, isNew: e.firstStatus === 'added', exists, size, kind: kindOf(e.path) };
  }).sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
}

app.get('/api/sessions/:id/files', (req, res) => {
  const s = getSession(req, res); if (!s) return;
  const snap = gitSnapshot(s.folder);
  const list = sessionFiles(s);
  // Files git ignores aren't "committed"; say so.
  let ignored = new Set();
  if (snap) {
    const cand = list.filter((f) => !f.wt && f.exists && !snap.files.has(f.path)).map((f) => f.path);
    if (cand.length) { const r = spawn.sync('git', ['check-ignore', '--stdin'], { cwd: s.folder, input: cand.join('\n'), encoding: 'utf8', windowsHide: true }); ignored = new Set((r.stdout || '').split(/\r?\n/).filter(Boolean)); }
  }
  res.json(list.map((f) => ({ ...f, uncommitted: !f.wt && snap ? snap.files.has(f.path) : null, ignored: ignored.has(f.path) || undefined })));
});

// Commit only the files one agent changed in this session (shared folder).
app.post('/api/sessions/:id/commit', (req, res) => {
  const s = getSession(req, res); if (!s) return;
  if (busy(s)) return res.status(409).json({ error: 'Wait until the agents finish.' });
  if (!checkpoints.isRepo(s.folder)) return res.status(400).json({ error: 'This folder isn\'t a git repository.' });
  const agent = String((req.body || {}).agent || '');
  const message = String((req.body || {}).message || '').trim().slice(0, 2000);
  if (!message) return res.status(400).json({ error: 'Write a commit message.' });
  const snap = gitSnapshot(s.folder);
  const paths = sessionFiles(s).filter((f) => !f.wt && (agent === '' || f.agents.includes(agent)) && snap && snap.files.has(f.path)).map((f) => f.path);
  try { res.json(commitPaths(s, paths, message, { who: 'You', what: agent ? `@${agent}'s changes` : 'the session\'s changes' })); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- push / pull / put on GitHub ----------
const gitsync = require('./gitsync')();
app.get('/api/sessions/:id/sync', (req, res) => {
  const s = getSession(req, res); if (!s) return;
  res.json(gitsync.state(s.folder));
});
const syncNote = (s, text) => addMessage(s, { role: 'system', kind: 'commit', text });
app.post('/api/sessions/:id/push', async (req, res) => {
  const s = getSession(req, res); if (!s) return;
  try {
    const r = await gitsync.push(s.folder);
    syncNote(s, `You pushed ${r.pushed ? `${r.pushed} commit${r.pushed > 1 ? 's' : ''}` : r.branch} to ${r.web || r.url || r.remote}${r.upstream ? ` (${r.upstream})` : ''}.`);
    broadcast(s.id, { type: 'sync', state: gitsync.state(s.folder) });
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message, code: e.code }); }
});
app.post('/api/sessions/:id/pull', async (req, res) => {
  const s = getSession(req, res); if (!s) return;
  if (busy(s)) return res.status(409).json({ error: 'Wait until the agents finish.' });
  try {
    const before = run('git', ['rev-parse', '--short', 'HEAD'], s.folder);
    const r = await gitsync.pull(s.folder);
    const after = run('git', ['rev-parse', '--short', 'HEAD'], s.folder);
    if (before !== after) syncNote(s, `You pulled the latest from ${r.web || r.remote} (${before}..${after}).`);
    broadcast(s.id, { type: 'sync', state: gitsync.state(s.folder) });
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message, code: e.code }); }
});
app.post('/api/sessions/:id/publish', async (req, res) => {
  const s = getSession(req, res); if (!s) return;
  try {
    const r = await gitsync.publish(s.folder, { name: (req.body || {}).name, isPublic: !!(req.body || {}).public });
    syncNote(s, `You put this folder on GitHub: ${r.web || r.url}.`);
    broadcast(s.id, { type: 'sync', state: gitsync.state(s.folder) });
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message, code: e.code }); }
});

// Commit some files in the session's folder. AgentsCircle runs git itself, so this works even
// when an agent's sandbox can't write to .git (Codex's normal mode).
function commitPaths(s, paths, message, { who, what }) {
  if (!paths.length) throw new Error('Nothing left to commit.');
  const git = (args) => spawn.sync('git', args, { cwd: s.folder, encoding: 'utf8', windowsHide: true });
  const add = git(['add', '-A', '--', ...paths]);
  if (add.status !== 0) throw new Error((add.stderr || 'git add failed').trim());
  const c = git(['commit', '-m', message, '--', ...paths]);
  if (c.status !== 0) {
    const out = ((c.stderr || '') + (c.stdout || '')).trim();
    if (/tell me who you are|user\.email|user\.name/i.test(out)) throw new Error('git doesn\'t know your name and email yet. In Terminal run: git config --global user.name "Your Name" and git config --global user.email you@example.com, then commit again.');
    if (/index\.lock/i.test(out)) throw new Error('Another git command is running in this folder (or crashed and left .git/index.lock). Wait a moment, or delete .git/index.lock if nothing else is running, then try again.');
    throw new Error(out.split('\n').slice(-3).join(' ') || 'git commit failed');
  }
  const hash = run('git', ['rev-parse', '--short', 'HEAD'], s.folder);
  addMessage(s, { role: 'system', kind: 'commit', text: `${who} committed ${what}: ${hash} "${message.split('\n')[0]}" (${paths.length} file${paths.length > 1 ? 's' : ''}).` });
  return { ok: true, hash, files: paths };
}

app.get('/api/sessions/:id/file', async (req, res) => {
  const s = getSession(req, res); if (!s) return;
  const full = safePath(s, req.query.path, req.query.wt);
  if (!full) return res.status(400).json({ error: 'That file is outside the project folder.' });
  let st;
  try { st = fs.statSync(full); } catch { return res.json({ path: req.query.path, exists: false, kind: kindOf(full) }); }
  const kind = kindOf(full);
  const out = { path: req.query.path, exists: true, size: st.size, kind, modifiedAt: st.mtime.toISOString() };
  if (['text', 'markdown', 'html'].includes(kind) || (kind === 'image' && extOf(full) === 'svg')) {
    const buf = fs.readFileSync(full);
    out.truncated = buf.length > 512 * 1024;
    out.content = buf.slice(0, 512 * 1024).toString('utf8');
  }
  out.exports = documents.exportOptions(full);
  if ((kind === 'doc' || kind === 'sheet' || documents.canPreviewTable(full)) && st.size < 20 * 1024 * 1024) {
    try { Object.assign(out, await documents.preview(full)); } catch (e) { out.previewError = `Couldn't read this file: ${e.message}`; }
  }
  res.json(out);
});

// Export a file to Word, PDF, HTML, Excel or CSV. The copy is saved next to it, so it shows in Files.
const documents = require('./documents');
app.post('/api/sessions/:id/export', async (req, res) => {
  const s = getSession(req, res); if (!s) return;
  const b = req.body || {};
  const full = safePath(s, b.path, b.wt);
  if (!full || !fs.existsSync(full)) return res.status(400).json({ error: 'That file isn\'t in the project folder.' });
  try {
    const out = await documents.exportFile(full, String(b.to || ''));
    const dir = path.posix.dirname(String(b.path).replace(/\\/g, '/'));
    const rel = (dir === '.' ? '' : dir + '/') + path.basename(out);
    addMessage(s, { role: 'system', kind: 'export', ...(b.wt ? { workdir: true, agent: b.wt } : {}), files: [{ path: rel, status: 'added' }], text: `You exported ${b.path} as ${path.basename(out)}.` });
    res.json({ path: rel, name: path.basename(out) });
  } catch (e) { res.status(400).json({ error: e.message, code: e.code }); }
});

// Save your own edit to a file from the panel's editor.
const EDITABLE = new Set(['text', 'markdown', 'html']);
app.put('/api/sessions/:id/file', (req, res) => {
  const s = getSession(req, res); if (!s) return;
  const b = req.body || {};
  const full = safePath(s, b.path, b.wt);
  if (!full) return res.status(400).json({ error: 'That file is outside the project folder.' });
  if (typeof b.content !== 'string') return res.status(400).json({ error: 'Nothing to save.' });
  let st; try { st = fs.statSync(full); } catch { return res.status(404).json({ error: 'This file no longer exists.' }); }
  const kind = kindOf(full);
  if (!(EDITABLE.has(kind) || (kind === 'image' && extOf(full) === 'svg'))) return res.status(400).json({ error: 'This kind of file can\'t be edited here.' });
  if (st.size > 512 * 1024) return res.status(400).json({ error: 'Files over 512 KB can\'t be edited here. Use Open.' });
  // Someone (an agent, or you in another app) changed it after you opened it.
  if (b.baseModifiedAt && !b.force && Math.abs(st.mtime.getTime() - new Date(b.baseModifiedAt).getTime()) > 1) {
    return res.status(409).json({ error: 'This file changed since you opened it.', conflict: true, modifiedAt: st.mtime.toISOString() });
  }
  fs.writeFileSync(full, b.content);
  const after = fs.statSync(full);
  // Tell the agents, so the next one doesn't undo your edit. One note per file in a row.
  const rel = String(b.path);
  const where = b.wt ? ` on @${b.wt}'s branch` : '';
  const last = s.messages[s.messages.length - 1];
  if (last && last.kind === 'useredit' && last.editPath === rel && last.editWt === (b.wt || null)) {
    updateMessage(s, last, { text: `You edited ${rel}${where} in the panel.`, at: now() }, true);
  } else {
    addMessage(s, { role: 'system', kind: 'useredit', editPath: rel, editWt: b.wt || null, text: `You edited ${rel}${where} in the panel.` });
  }
  res.json({ ok: true, size: after.size, modifiedAt: after.mtime.toISOString() });
});

app.get(['/api/sessions/:id/raw/*path', '/api/sessions/:id/wt/:wt/raw/*path'], (req, res) => {
  const s = getSession(req, res); if (!s) return;
  const rel = [].concat(req.params.path).join('/');
  const full = safePath(s, rel, req.params.wt);
  if (!full || !fs.existsSync(full) || !fs.statSync(full).isFile()) return res.status(404).send('Not found');
  // Previews run in a sandboxed frame; this header keeps them from reaching the AgentsCircle API.
  res.set('Content-Security-Policy', "sandbox allow-scripts allow-forms allow-popups; default-src * data: blob: 'unsafe-inline' 'unsafe-eval'");
  res.sendFile(full, { dotfiles: 'allow' });
});

app.get('/api/sessions/:id/diff', (req, res) => {
  const s = getSession(req, res); if (!s) return;
  const full = safePath(s, req.query.path, req.query.wt);
  if (!full) return res.status(400).json({ error: 'That file is outside the project folder.' });
  const wtInfo = req.query.wt && s.worktrees && s.worktrees[req.query.wt];
  if (wtInfo) {
    // In a worktree: everything the agent changed since its starting point.
    const relW = path.relative(fs.realpathSync(wtInfo.dir), full);
    let d = ''; try { d = worktrees.diff(s, req.query.wt, relW); } catch { /* gone */ }
    return res.json({ diff: d, note: `Changes on @${req.query.wt}'s branch since it started (not in your folder until you apply them).` });
  }
  const rel = path.relative(fs.realpathSync(s.folder), full);
  if (!run('git', ['rev-parse', '--is-inside-work-tree'], s.folder)) return res.json({ diff: null, note: 'Not a git repository, so there is no diff. Showing the file instead.' });
  const tracked = run('git', ['ls-files', '--error-unmatch', '--', rel], s.folder) !== null;
  if (!tracked) return res.json({ diff: null, note: 'New file (not in git yet). Every line is new.' });
  let diff = run('git', ['diff', 'HEAD', '--', rel], s.folder);
  let note = 'Uncommitted changes compared with the last commit.';
  if (!diff) { diff = run('git', ['log', '-p', '-n', '1', '--format=commit %h  %s', '--', rel], s.folder); note = 'No uncommitted changes. Showing the last commit that touched this file.'; }
  res.json({ diff: diff || '', note });
});

app.post('/api/sessions/:id/reveal', (req, res) => {
  const s = getSession(req, res); if (!s) return;
  const full = safePath(s, req.body.path || '.', req.body.wt);
  if (!full) return res.status(400).json({ error: 'That file is outside the project folder.' });
  const target = fs.existsSync(full) ? full : path.dirname(full);
  const cmd = process.platform === 'darwin' ? ['open', [req.body.open ? target : '-R', ...(req.body.open ? [] : [target])]]
    : IS_WIN ? ['explorer', [req.body.open ? target : `/select,${target}`]]
    : ['xdg-open', [path.dirname(target)]];
  try { const c = spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }); c.on('error', () => {}); c.unref(); } catch { /* ok */ }
  res.json({ ok: true });
});

app.get('/api/sessions/:id/export', (req, res) => {
  const s = getSession(req, res); if (!s) return;
  const md = [`# ${s.name}`, `Folder: ${s.folder}`, '']
    .concat(s.messages.map((m) => `**${speaker(m)}** (${m.at})\n\n${m.text}\n`)).join('\n');
  res.type('text/markdown').send(md);
});

// ---------- terminal ----------
// A shell in the session's folder, shown in the panel's Terminal tab. Output goes to everyone
// watching the session; it keeps running when nobody is.
const terminals = require('./terminal')({
  onData: (sessionId, data) => broadcast(sessionId, { type: 'term:data', sessionId, data }),
  onExit: (sessionId, code) => broadcast(sessionId, { type: 'term:exit', sessionId, code }),
});
function onTermMessage(ws, msg) {
  const s = sessions.get(msg.sessionId);
  const reply = (ev) => { try { ws.send(JSON.stringify(ev)); } catch { /* closed */ } };
  if (!s) return reply({ type: 'term:error', sessionId: msg.sessionId, message: 'That session is gone.' });
  try {
    if (msg.type === 'term:open') {
      if (msg.restart) terminals.kill(s.id);
      const t = terminals.open(s.id, s.folder, { cols: msg.cols, rows: msg.rows });
      if (msg.cols && msg.rows) terminals.resize(s.id, msg.cols, msg.rows);
      reply({ type: 'term:ready', sessionId: s.id, ...t });
    } else if (msg.type === 'term:in') terminals.write(s.id, msg.data);
    else if (msg.type === 'term:resize') terminals.resize(s.id, msg.cols, msg.rows);
    else if (msg.type === 'term:kill') { terminals.kill(s.id); reply({ type: 'term:exit', sessionId: s.id, code: null, closed: true }); }
  } catch (e) { reply({ type: 'term:error', sessionId: s.id, message: e.message }); }
}
app.get('/api/sessions/:id/terminal', (req, res) => {
  const s = getSession(req, res); if (!s) return;
  const t = terminals.get(s.id);
  res.json({ ...(t ? { ...t, buffer: undefined } : { alive: false }), ...terminals.available() });
});

// ---------- start ----------
const server = http.createServer(app);
const wss = new WebSocketServer({
  server, path: '/ws',
  verifyClient: ({ origin }) => !origin || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(origin),
});
wss.on('connection', (ws) => {
  let current = null;
  idleClients.add(ws);
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type && msg.type.startsWith('term:')) { onTermMessage(ws, msg); return; }
      if (msg.type === 'subscribe') {
        idleClients.delete(ws);
        if (current) subscribers.get(current)?.delete(ws);
        current = msg.sessionId;
        if (!subscribers.has(current)) subscribers.set(current, new Set());
        subscribers.get(current).add(ws);
      }
    } catch { /* ignore */ }
  });
  ws.on('close', () => { idleClients.delete(ws); if (current) subscribers.get(current)?.delete(ws); });
});

function printBanner(url) {
  console.log(`\nAgentsCircle is running at ${url}`);
  console.log('Your agents:');
  for (const a of accounts.list()) { const t = accounts.tool(a); console.log(`  ${t.installed ? '✓' : '·'} @${a.id.padEnd(16)} ${t.name}${a.configDir ? '  (own login)' : ''}${t.installed ? '' : '  (not installed)'}`); }
  if (!accounts.list().length) console.log('  none yet. Install Claude Code, Codex or Cursor, or add one in the app.');
  console.log('');
}

// Started by the desktop app (require) or from a terminal (node src/server.js).
const ready = new Promise((resolve, reject) => {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE') console.error(`\nPort ${PORT} is already in use. Is AgentsCircle already running? Set AGENTSCIRCLE_PORT to use another port.\n`);
    reject(e);
  });
  server.listen(PORT, '127.0.0.1', () => {
    const url = `http://localhost:${PORT}`;
    printBanner(url);
    if (!process.env.AGENTSCIRCLE_NO_OPEN && !process.env.AGENTSCIRCLE_DESKTOP) {
      const opener = IS_WIN ? ['cmd', ['/c', 'start', 'AgentsCircle', url]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
      try { const c = spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }); c.on('error', () => {}); c.unref(); } catch { /* ok */ }
    }
    resolve(url);
  });
});

// Stop every running agent (used when the app quits).
function stopAll() {
  try { terminals.killAll(); } catch { /* quitting */ }
  for (const s of sessions.values()) for (const r of (s.runs || new Map()).values()) { r.stopRequested = true; killTree(r.child); }
}
module.exports = { ready, stopAll, port: PORT };

if (!process.env.AGENTSCIRCLE_DESKTOP) {
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopAll(); process.exit(0); });
  ready.catch(() => process.exit(1));
}
