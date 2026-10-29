// Tools (what AgentsCircle can run) and accounts (your @handles for them).
// Each account can point a tool at its own login folder, so @claude-work and
// @claude-personal run as two different Claude accounts side by side.

const fs = require('fs');
const os = require('os');
const path = require('path');
const spawn = require('cross-spawn');

const IS_WIN = process.platform === 'win32';
const RESERVED = new Set(['all', 'everyone', 'here', 'you', 'user', 'system']);
const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{1,30}$/;

module.exports = function createAccounts({ root, dataDir, remote, vault }) {
  const userFile = path.join(dataDir, 'agents.json');
  const accountsDir = path.join(dataDir, 'accounts');
  fs.mkdirSync(accountsDir, { recursive: true });

  let TOOLS = [];
  let AGENTS = [];

  // The full path of a command, so a run uses exactly the program found (and a missing one is
  // noticed before it runs). Windows keeps the bare name; cross-spawn resolves .cmd shims there.
  const findOnPath = (cmd) => {
    const probe = spawn.sync(IS_WIN ? 'where' : 'which', [cmd], { encoding: 'utf8' });
    const hit = probe.status === 0 && (probe.stdout || '').trim().split(/\r?\n/)[0];
    if (!hit) return null;
    return IS_WIN || !path.isAbsolute(hit) ? cmd : hit;
  };

  let toolsInfo = { revision: 0, source: 'bundled' };
  function loadTools() {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'tools.json'), 'utf8'));
    // Signed fixes downloaded from the AgentsCircle repo override safe fields of the bundled file.
    const ov = remote ? remote.overrides(cfg.revision || 0) : null;
    toolsInfo = ov ? { revision: ov.revision, source: 'update' } : { revision: cfg.revision || 0, source: 'bundled' };
    TOOLS = cfg.tools.map((base) => {
      const t = ov && ov.tools[base.id] ? { ...base, ...ov.tools[base.id] } : base;
      let resolved = null;
      for (const c of [t.command, ...(t.altCommands || [])]) if ((resolved = findOnPath(c))) break;
      return { ...t, resolvedCommand: resolved, installed: !!resolved };
    });
  }
  const toolById = (id) => TOOLS.find((t) => t.id === id);

  // API keys go to the keychain when the app can reach it; the file then only says where they are.
  const keyName = (id) => `agent:${id}:apiKey`;
  function save() {
    const data = AGENTS.map(({ id, tool, label, color, configDir, apiKey, apiKeyRef, limitedAt, limitedUntil, permission, timeoutMin, maxBudgetUsd, model, effort, badModels, health }) => {
      let key = apiKey, ref = apiKeyRef;
      if (apiKey && vault && vault.available() && vault.set(keyName(id), apiKey)) { key = undefined; ref = 'keychain'; const live = AGENTS.find((x) => x.id === id); if (live) live.apiKeyRef = 'keychain'; }
      else if (apiKey) ref = undefined;
      return { id, tool, label, color, configDir, apiKey: key, apiKeyRef: ref, limitedAt, limitedUntil, permission, timeoutMin, maxBudgetUsd, model, effort, badModels, health };
    });
    fs.writeFileSync(userFile, JSON.stringify({ agents: data }, null, 2), { mode: 0o600 });
    try { fs.chmodSync(userFile, 0o600); } catch { /* windows */ }
  }

  function load() {
    loadTools();
    let saved = null;
    try { saved = JSON.parse(fs.readFileSync(userFile, 'utf8')).agents; } catch { /* first run */ }
    if (!saved) {
      // First run: one default account per installed tool, using its normal login.
      saved = TOOLS.filter((t) => t.installed && !t.hidden)
        .map((t) => ({ id: t.id, tool: t.id, label: '', color: t.color, configDir: null }));
      AGENTS = saved.map((a) => ({ ...a, identity: null }));
      save();
    }
    const prevIdentity = new Map(AGENTS.map((a) => [a.id, a.identity]));
    AGENTS = saved.filter((a) => toolById(a.tool)).map((a) => ({ permission: 'risky', timeoutMin: 30, maxBudgetUsd: null, ...a, identity: prevIdentity.get(a.id) || null }));
    let move = false;
    for (const a of AGENTS) {
      if (a.apiKeyRef === 'keychain') {
        a.apiKey = (vault && vault.get(keyName(a.id))) || undefined;
        a.apiKeyLocked = !a.apiKey; // in the keychain but can't be read here (e.g. npm start outside the app)
      } else if (a.apiKey && vault && vault.available()) move = true; // an older plain-text key: move it
    }
    if (move) save();
  }

  // ---- identity: which account is this handle logged into? ----
  const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
  const jwtPayload = (tok) => {
    try { return JSON.parse(Buffer.from(tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); } catch { return null; }
  };
  const runAsync = (cmd, args, env, timeoutMs = 8000) => new Promise((resolve) => {
    let out = '';
    let child;
    try { child = spawn(cmd, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); } catch { return resolve(''); }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ok */ } }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', () => { clearTimeout(timer); resolve(out); });
    child.on('close', () => { clearTimeout(timer); resolve(out); });
  });
  const firstEmail = (s) => ((s || '').match(/[\w.+-]+@[\w-]+\.[\w.-]+/) || [])[0];

  async function detectIdentity(agent) {
    const tool = toolById(agent.tool);
    const dir = agent.configDir;
    let label = null;
    let detail = null;
    if (tool.id === 'claude') {
      const cfg = readJson(dir ? path.join(dir, '.claude.json') : path.join(os.homedir(), '.claude.json'));
      const acc = cfg && cfg.oauthAccount;
      if (acc && acc.emailAddress) { label = acc.emailAddress; detail = acc.organizationName || null; }
      else if (!dir && process.env.ANTHROPIC_API_KEY) label = 'API key';
    } else if (tool.id === 'codex') {
      const auth = readJson(path.join(dir || path.join(os.homedir(), '.codex'), 'auth.json'));
      if (auth) {
        const p = auth.tokens && auth.tokens.id_token && jwtPayload(auth.tokens.id_token);
        if (p && p.email) {
          label = p.email;
          const plan = p['https://api.openai.com/auth'] && p['https://api.openai.com/auth'].chatgpt_plan_type;
          if (plan) detail = `ChatGPT ${plan}`;
        } else if (auth.OPENAI_API_KEY) label = 'API key';
      }
    } else if (tool.id === 'cursor') {
      if (agent.apiKey) label = `API key …${agent.apiKey.slice(-4)}`;
      else if (tool.installed) label = firstEmail(await runAsync(tool.resolvedCommand, tool.statusArgs || ['status'], envFor(agent)));
    } else if (tool.id === 'mock') {
      if (dir && fs.existsSync(dir)) label = `mock@${agent.id}`;
    } else if (tool.installed && tool.statusArgs) {
      label = firstEmail(await runAsync(tool.resolvedCommand, tool.statusArgs, envFor(agent)));
    }
    agent.identity = { label, detail, signedIn: !!label, checkedAt: new Date().toISOString() };
    return agent.identity;
  }

  async function refreshAll() { await Promise.all(AGENTS.map((a) => detectIdentity(a).catch(() => null))); }

  // ---- running ----
  function envFor(agent, base = process.env) {
    const tool = toolById(agent.tool);
    const env = { ...base };
    if (agent.configDir && tool.configEnv) env[tool.configEnv] = agent.configDir;
    if (agent.apiKey && tool.apiKeyEnv) env[tool.apiKeyEnv] = agent.apiKey;
    return env;
  }

  const LIMIT_RE = /(usage limit|rate limit|limit reached|reached your limit|hit your (usage )?limit|quota exceeded|exceeded your|too many requests|\b429\b)/i;
  // When does the limit reset? Read it from the error when the tool says so, else guess an hour.
  //   Claude Code: "Claude AI usage limit reached|1761660000"  or  "... resets 3pm (Europe/Paris)"
  //   Codex: "You've hit your usage limit. ... try again in 2 hours 13 minutes" or "at 3:04 PM"
  function resetTime(text, from = Date.now()) {
    const t = String(text || '');
    let m = /\|(\d{10})\b/.exec(t);
    if (m) return new Date(Number(m[1]) * 1000);
    m = /try again in\s+(?:(\d+)\s*d(?:ays?)?\s*)?(?:(\d+)\s*h(?:ours?|rs?)?\s*)?(?:(\d+)\s*m(?:in(?:ute)?s?)?)?/i.exec(t);
    if (m && (m[1] || m[2] || m[3])) return new Date(from + ((+m[1] || 0) * 1440 + (+m[2] || 0) * 60 + (+m[3] || 0)) * 60000);
    m = /(?:resets?|try again)\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(t) || /(?:resets?|try again)\s+at\s+(\d{1,2}):(\d{2})()/i.exec(t);
    if (m) {
      let h = Number(m[1]) % 12 + (m[3] && m[3].toLowerCase() === 'pm' ? 12 : 0);
      if (!m[3]) h = Number(m[1]);
      const d = new Date(from); d.setHours(h, Number(m[2] || 0), 0, 0);
      if (d.getTime() <= from) d.setDate(d.getDate() + 1);
      return d;
    }
    return new Date(from + 60 * 60000);
  }
  function noteOutcome(agent, { ok, text }) {
    const limited = LIMIT_RE.test((text || '').slice(0, 2000)) && (!ok || (text || '').length < 600);
    const was = !!agent.limitedAt;
    agent.limitedAt = limited ? new Date().toISOString() : null;
    agent.limitedUntil = limited ? resetTime(text).toISOString() : null;
    if (was !== limited || limited) save();
    return limited;
  }
  // Still waiting for its limit to reset? (An account whose reset time passed is usable again.)
  function benched(agent) {
    if (!agent.limitedAt) return false;
    if (agent.limitedUntil && Date.parse(agent.limitedUntil) <= Date.now()) return false;
    return true;
  }

  // ---- account management ----
  function validateHandle(id, exceptId) {
    if (!HANDLE_RE.test(id || '')) return 'Handles use 2–31 lowercase letters, numbers, - or _ (for example claude-work).';
    if (RESERVED.has(id)) return `@${id} is reserved.`;
    if (AGENTS.some((a) => a.id === id && a.id !== exceptId)) return `@${id} already exists.`;
    return null;
  }

  function add({ tool: toolId, id, label, color, separateLogin = true, apiKey }) {
    const tool = toolById(toolId);
    if (!tool) throw new Error('Pick a tool.');
    id = String(id || '').trim().toLowerCase().replace(/^@/, '');
    const bad = validateHandle(id);
    if (bad) throw new Error(bad);
    let configDir = null;
    if (separateLogin && tool.configEnv) {
      configDir = path.join(accountsDir, id);
      fs.mkdirSync(configDir, { recursive: true });
    }
    const agent = { id, tool: tool.id, label: String(label || '').slice(0, 60), color: color || tool.color, configDir, apiKey: apiKey ? String(apiKey).trim() : undefined, limitedAt: null, identity: null, permission: 'risky', timeoutMin: 30, maxBudgetUsd: null };
    AGENTS.push(agent);
    save();
    return agent;
  }

  function update(id, patch) {
    const agent = AGENTS.find((a) => a.id === id);
    if (!agent) throw new Error('No such agent.');
    if (patch.label !== undefined) agent.label = String(patch.label).slice(0, 60);
    if (patch.model !== undefined) agent.model = patch.model ? String(patch.model).trim().slice(0, 80) : undefined;
    if (patch.effort !== undefined) agent.effort = /^[a-z]+$/.test(String(patch.effort || '')) ? String(patch.effort) : undefined;
    if (Array.isArray(patch.badModels)) agent.badModels = patch.badModels.map(String).slice(0, 20);
    if (patch.color) agent.color = patch.color;
    if (patch.apiKey !== undefined) {
      agent.apiKey = patch.apiKey ? String(patch.apiKey).trim() : undefined;
      agent.apiKeyLocked = false;
      if (!agent.apiKey) { agent.apiKeyRef = undefined; if (vault) vault.delete(keyName(agent.id)); }
    }
    if (patch.permission && ['readonly', 'risky', 'all', 'full'].includes(patch.permission)) agent.permission = patch.permission;
    if (patch.timeoutMin !== undefined) { const n = Number(patch.timeoutMin); agent.timeoutMin = n > 0 ? Math.min(n, 600) : null; }
    if (patch.maxBudgetUsd !== undefined) { const n = Number(patch.maxBudgetUsd); agent.maxBudgetUsd = n > 0 ? n : null; }
    let renamed = null;
    if (patch.id && patch.id !== id) {
      const next = String(patch.id).trim().toLowerCase().replace(/^@/, '');
      const bad = validateHandle(next, id);
      if (bad) throw new Error(bad);
      renamed = { from: id, to: next };
      agent.id = next;
    }
    save();
    return { agent, renamed };
  }

  function remove(id) {
    const i = AGENTS.findIndex((a) => a.id === id);
    if (i < 0) throw new Error('No such agent.');
    const [agent] = AGENTS.splice(i, 1);
    if (vault) vault.delete(keyName(agent.id));
    save();
    return agent; // its login folder is kept, so re-adding the account doesn't need a new login
  }

  // ---- login: open a terminal already pointed at this account ----
  const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  function loginCommandText(agent) {
    const tool = toolById(agent.tool);
    const cmd = [tool.resolvedCommand || tool.command, ...(tool.loginArgs || [])].join(' ');
    if (IS_WIN) {
      const set = agent.configDir && tool.configEnv ? `set "${tool.configEnv}=${agent.configDir}" && ` : '';
      return `${set}${cmd}`;
    }
    const exp = agent.configDir && tool.configEnv ? `${tool.configEnv}=${shQuote(agent.configDir)} ` : '';
    return `${exp}${cmd}`;
  }

  const launch = (cmd, args, opts) => {
    try { const c = spawn(cmd, args, { detached: true, stdio: 'ignore', ...opts }); c.on('error', () => {}); c.unref(); } catch { /* no terminal app */ }
  };
  function openLogin(agent) {
    const tool = toolById(agent.tool);
    if (!tool.installed) throw new Error(`${tool.name} isn't installed on this computer.`);
    const text = loginCommandText(agent);
    const banner = `Signing in @${agent.id} (${tool.name})${agent.configDir ? ` — login folder: ${agent.configDir}` : ''}`;
    const dir = path.join(dataDir, 'login');
    fs.mkdirSync(dir, { recursive: true });
    if (process.platform === 'darwin') {
      const file = path.join(dir, `login-${agent.id}.command`);
      fs.writeFileSync(file, `#!/bin/bash\nclear\necho ${shQuote(banner)}\necho ${shQuote(tool.loginHint || '')}\necho\ncd ~\n${text}\n`, { mode: 0o755 });
      launch('open', ['-a', 'Terminal', file]);
    } else if (IS_WIN) {
      const file = path.join(dir, `login-${agent.id}.bat`);
      fs.writeFileSync(file, `@echo off\r\necho ${banner}\r\necho ${tool.loginHint || ''}\r\necho.\r\ncd /d "%USERPROFILE%"\r\n${text}\r\n`);
      launch('cmd', ['/c', 'start', 'AgentsCircle login', 'cmd', '/k', file], { windowsHide: false });
    } else {
      const file = path.join(dir, `login-${agent.id}.sh`);
      fs.writeFileSync(file, `#!/bin/bash\necho ${shQuote(banner)}\ncd ~\n${text}\nexec bash\n`, { mode: 0o755 });
      launch('x-terminal-emulator', ['-e', 'bash', file]);
    }
    return { command: text, hint: tool.loginHint || '' };
  }

  // Make sure every installed tool has at least one agent (after installing a new tool).
  function ensureDefaults() {
    const added = [];
    for (const t of TOOLS) {
      if (!t.installed || t.hidden || AGENTS.some((a) => a.tool === t.id)) continue;
      if (AGENTS.some((a) => a.id === t.id)) continue;
      AGENTS.push({ id: t.id, tool: t.id, label: '', color: t.color, configDir: null, permission: 'risky', timeoutMin: 30, maxBudgetUsd: null, identity: null });
      added.push(t.id);
    }
    if (added.length) save();
    return added;
  }

  // Open a terminal running a setup command (installing an agent, for example).
  function openCommand(name, { sh, ps, banner, hint }) {
    const dir = path.join(dataDir, 'login');
    fs.mkdirSync(dir, { recursive: true });
    const safe = String(name).replace(/[^a-z0-9_-]/gi, '-');
    if (IS_WIN) {
      const file = path.join(dir, `${safe}.ps1`);
      fs.writeFileSync(file, `Write-Host ${JSON.stringify(banner)}\r\nWrite-Host ${JSON.stringify(hint || '')}\r\nWrite-Host ''\r\n${ps}\r\n`);
      launch('cmd', ['/c', 'start', 'AgentsCircle setup', 'powershell', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', file], { windowsHide: false });
      return { command: ps };
    }
    const ext = process.platform === 'darwin' ? 'command' : 'sh';
    const file = path.join(dir, `${safe}.${ext}`);
    fs.writeFileSync(file, `#!/bin/bash\nclear\necho ${shQuote(banner)}\necho ${shQuote(hint || '')}\necho\ncd ~\n${sh}\necho\necho 'Done. You can close this window and click Check again in AgentsCircle.'\n`, { mode: 0o700 });
    if (process.platform === 'darwin') launch('open', ['-a', 'Terminal', file]);
    else launch('x-terminal-emulator', ['-e', 'bash', file]);
    return { command: sh };
  }

  // Open a terminal for this account with extra env and a command (used by connector sign-in).
  function openInTerminal(agent, { name, cmd, env = {}, banner, hint }) {
    const tool = toolById(agent.tool);
    const vars = { ...env };
    if (agent.configDir && tool.configEnv) vars[tool.configEnv] = agent.configDir;
    const dir = path.join(dataDir, 'login');
    fs.mkdirSync(dir, { recursive: true });
    const safe = `${agent.id}-${name}`.replace(/[^a-z0-9_-]/gi, '-');
    let text;
    if (IS_WIN) {
      const q = (a) => (/[\s"&|<>^]/.test(a) ? `"${String(a).replace(/"/g, '""')}"` : a);
      const sets = Object.entries(vars).map(([k, v]) => `set "${k}=${v}"`).join('\r\n');
      text = cmd.map(q).join(' ');
      const file = path.join(dir, `${safe}.bat`);
      fs.writeFileSync(file, `@echo off\r\n${sets}\r\necho ${banner}\r\necho ${hint || ''}\r\necho.\r\ncd /d "%USERPROFILE%"\r\n${text}\r\n`);
      launch('cmd', ['/c', 'start', 'AgentsCircle', 'cmd', '/k', file], { windowsHide: false });
      return { command: text };
    }
    const exports = Object.entries(vars).map(([k, v]) => `export ${k}=${shQuote(v)}`).join('\n');
    text = cmd.map(shQuote).join(' ');
    const ext = process.platform === 'darwin' ? 'command' : 'sh';
    const file = path.join(dir, `${safe}.${ext}`);
    fs.writeFileSync(file, `#!/bin/bash\nclear\n${exports}\necho ${shQuote(banner)}\necho ${shQuote(hint || '')}\necho\ncd ~\n${text}\n`, { mode: 0o700 });
    if (process.platform === 'darwin') launch('open', ['-a', 'Terminal', file]);
    else launch('x-terminal-emulator', ['-e', 'bash', file]);
    // Show the command without secrets.
    return { command: `${Object.keys(vars).filter((k) => !/TOKEN|KEY|SECRET/i.test(k)).map((k) => `${k}=${shQuote(vars[k])} `).join('')}${text}` };
  }

  // ---- views ----
  function publicAgent(a) {
    const tool = toolById(a.tool);
    return {
      id: a.id, tool: a.tool, toolName: tool.name, label: a.label, color: a.color,
      installed: tool.installed, separateLogin: !!a.configDir, configDir: a.configDir,
      hasApiKey: !!a.apiKey || !!a.apiKeyLocked, apiKeyLocked: !!a.apiKeyLocked, apiKeyStore: a.apiKeyRef === 'keychain' ? 'keychain' : a.apiKey ? 'file' : null, apiKeyEnv: tool.apiKeyEnv || null, limited: benched(a), limitedAt: a.limitedAt, limitedUntil: a.limitedUntil || null,
      identity: a.identity, loginHint: tool.loginHint || '', loginCommand: loginCommandText(a),
      permission: a.permission || 'risky', canAsk: tool.approvals === 'prompt-tool', hasLevels: !!tool.permissionArgs,
      timeoutMin: a.timeoutMin, maxBudgetUsd: a.maxBudgetUsd, canBudget: !!tool.budgetArg,
      model: a.model || null, effort: a.effort || null, health: a.health || null, canCheck: ['claude', 'codex'].includes(tool.id), canSignIn: !!tool.signinArgs,
    };
  }
  const publicTools = () => TOOLS.filter((t) => !t.hidden || process.env.AGENTSCIRCLE_DEV)
    .map((t) => ({ id: t.id, name: t.name, color: t.color, installed: t.installed, canSeparate: !!t.configEnv, apiKeyEnv: t.apiKeyEnv || null }));

  load();

  function setHealth(agent, h) { agent.health = h; save(); }

  return {
    setHealth, load, refreshAll, detectIdentity, envFor, noteOutcome, benched, resetTime, add, update, remove, openLogin, openInTerminal, openCommand, ensureDefaults,
    tools: () => TOOLS, toolsInfo: () => toolsInfo, findOnPath, reloadTools: () => loadTools(),
    list: () => AGENTS,
    get: (id) => AGENTS.find((a) => a.id === id),
    tool: (agent) => toolById(agent.tool),
    publicAgent, publicTools,
  };
};
