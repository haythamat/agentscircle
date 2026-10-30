// Shared connectors (MCP servers): add once in AgentsCircle, and every agent that
// supports it gets them at launch, translated into that agent's own format.
// Your agents' own configs are never edited.

const fs = require('fs');
const os = require('os');
const path = require('path');
const spawn = require('cross-spawn');
const TOML = require('smol-toml');

const NAME_RE = /^[a-z0-9][a-z0-9_-]{1,40}$/;
const RESERVED = new Set(['agentscircle']);
const REGISTRY = 'https://registry.modelcontextprotocol.io/v0/servers';

// Popular connectors. URLs from each provider's docs; anything else can be found in the registry.
const CATALOG = [
  { name: 'lovable', title: 'Lovable', description: 'Create and edit Lovable projects, send prompts, deploy.', type: 'remote', url: 'https://mcp.lovable.dev', auth: 'oauth' },
  { name: 'github', title: 'GitHub', description: 'Repos, issues, pull requests, code search.', type: 'remote', url: 'https://api.githubcopilot.com/mcp/', auth: 'oauth', tokenHint: 'or a personal access token' },
  { name: 'supabase', title: 'Supabase', description: 'Database tables, SQL, migrations, edge functions, logs.', type: 'remote', url: 'https://mcp.supabase.com/mcp', auth: 'oauth', tokenHint: 'or a personal access token' },
  { name: 'vercel', title: 'Vercel', description: 'Projects, deployments and logs.', type: 'remote', url: 'https://mcp.vercel.com', auth: 'oauth' },
  { name: 'stripe', title: 'Stripe', description: 'Customers, products, payments, docs.', type: 'remote', url: 'https://mcp.stripe.com', auth: 'oauth', tokenHint: 'or a restricted API key' },
  { name: 'notion', title: 'Notion', description: 'Search, read and write pages and databases.', type: 'remote', url: 'https://mcp.notion.com/mcp', auth: 'oauth' },
  { name: 'linear', title: 'Linear', description: 'Issues, projects and comments.', type: 'remote', url: 'https://mcp.linear.app/mcp', auth: 'oauth' },
  { name: 'figma', title: 'Figma', description: 'Read designs, components and variables.', type: 'remote', url: 'https://mcp.figma.com/mcp', auth: 'oauth' },
  { name: 'sentry', title: 'Sentry', description: 'Errors, issues and releases.', type: 'remote', url: 'https://mcp.sentry.dev/mcp', auth: 'oauth' },
  { name: 'huggingface', title: 'Hugging Face', description: 'Models, datasets and Spaces.', type: 'remote', url: 'https://huggingface.co/mcp', auth: 'oauth' },
  { name: 'zapier', title: 'Zapier', description: 'Run actions across thousands of apps.', type: 'remote', url: 'https://mcp.zapier.com/api/mcp/mcp', auth: 'oauth' },
  { name: 'context7', title: 'Context7', description: 'Up-to-date docs for libraries and frameworks.', type: 'remote', url: 'https://mcp.context7.com/mcp', auth: 'none' },
  { name: 'deepwiki', title: 'DeepWiki', description: 'Ask questions about any public GitHub repo.', type: 'remote', url: 'https://mcp.deepwiki.com/mcp', auth: 'none' },
  { name: 'playwright', title: 'Playwright', description: 'Control a browser: open pages, click, screenshot.', type: 'local', command: 'npx', args: ['-y', '@playwright/mcp@latest'], auth: 'none' },
];

// The service's own website, used to show its official icon.
const SITES = { lovable: 'lovable.dev', github: 'github.com', supabase: 'supabase.com', vercel: 'vercel.com', stripe: 'stripe.com', notion: 'notion.so', linear: 'linear.app', figma: 'figma.com', sentry: 'sentry.io', huggingface: 'huggingface.co', zapier: 'zapier.com', context7: 'context7.com', deepwiki: 'deepwiki.com', playwright: 'playwright.dev' };
const TWO_PART = /\.(co|com|org|net|gov|ac|edu)\.[a-z]{2}$/i;
function siteOf(c) {
  if (!c) return null;
  if (c.site) return c.site;
  if (SITES[c.name]) return SITES[c.name];
  let host = null;
  try { host = new URL(c.url || c.repository || '').hostname.toLowerCase(); } catch { return null; }
  if (!host || /^[\d.]+$/.test(host) || !host.includes('.') || host === 'localhost') return null;
  if (host === 'github.com' && c.repository) return null; // a repo link says nothing about the service
  const parts = host.split('.');
  return parts.slice(TWO_PART.test(host) ? -3 : -2).join('.');
}

module.exports = function createConnectors({ dataDir, accounts, version, vault, oauth, proxy }) {
  const file = path.join(dataDir, 'connectors.json');
  const runDir = path.join(dataDir, 'mcp');
  fs.mkdirSync(runDir, { recursive: true });
  let LIST = [];

  // Tokens go to the keychain when the app can reach it; the file then only says where they are.
  const tokenName = (c) => `connector:${c.name}:token`;
  const load = () => {
    try { LIST = JSON.parse(fs.readFileSync(file, 'utf8')).connectors || []; } catch { LIST = []; }
    let move = false;
    for (const c of LIST) {
      if (c.tokenRef === 'keychain') { c.token = (vault && vault.get(tokenName(c))) || undefined; c.tokenLocked = !c.token; }
      else if (c.token && vault && vault.available()) move = true;
    }
    if (move) save();
  };
  const save = () => {
    const out = LIST.map(({ tokenLocked, ...c }) => {
      if (c.token && vault && vault.available() && vault.set(tokenName(c), c.token)) { const live = LIST.find((x) => x.name === c.name); if (live) live.tokenRef = 'keychain'; return { ...c, token: undefined, tokenRef: 'keychain' }; }
      if (c.token) return { ...c, tokenRef: undefined };
      if (!tokenLocked && c.tokenRef) { if (vault) vault.delete(tokenName(c)); return { ...c, tokenRef: undefined }; }
      return c;
    });
    fs.writeFileSync(file, JSON.stringify({ connectors: out }, null, 2), { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* windows */ }
  };
  load();

  const envName = (c) => `AGENTSCIRCLE_MCP_${c.name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_TOKEN`;
  const support = (tool) => tool.mcp || null; // 'claude' | 'codex' | null

  // ---------- validation ----------
  function clean(input, existingName) {
    const c = {};
    c.name = String(input.name || '').trim().toLowerCase().replace(/\s+/g, '-');
    if (!NAME_RE.test(c.name)) throw new Error('Name: 2–41 lowercase letters, numbers, - or _ (for example supabase).');
    if (RESERVED.has(c.name)) throw new Error(`"${c.name}" is reserved by AgentsCircle. Pick another name.`);
    if (LIST.some((x) => x.name === c.name && x.name !== existingName)) throw new Error(`A connector named "${c.name}" already exists.`);
    c.title = String(input.title || c.name).slice(0, 60);
    c.description = String(input.description || '').slice(0, 300);
    c.type = input.type === 'local' ? 'local' : 'remote';
    c.auth = ['oauth', 'token', 'none'].includes(input.auth) ? input.auth : 'none';
    if (c.type === 'remote') {
      try { const u = new URL(String(input.url || '')); if (!/^https?:$/.test(u.protocol)) throw 0; c.url = u.toString(); } catch { throw new Error('Enter the connector URL (https://…).'); }
      c.transport = input.transport === 'sse' ? 'sse' : 'http';
      c.headers = cleanMap(input.headers);
    } else {
      c.command = String(input.command || '').trim();
      if (!c.command) throw new Error('Enter the command that starts the connector (for example npx).');
      c.args = (Array.isArray(input.args) ? input.args : String(input.args || '').split('\n')).map((a) => String(a).trim()).filter(Boolean);
      c.env = cleanMap(input.env);
    }
    c.scope = input.scope === 'all' || !Array.isArray(input.scope) ? 'all' : input.scope.filter((x) => typeof x === 'string');
    c.enabled = input.enabled !== false;
    return c;
  }
  function cleanMap(m) {
    const out = {};
    if (m && typeof m === 'object') for (const [k, v] of Object.entries(m)) { const key = String(k).trim(); if (key) out[key] = String(v ?? ''); }
    return out;
  }

  // ---------- CRUD ----------
  function add(input) {
    const c = clean(input);
    c.token = input.token ? String(input.token).trim() : undefined;
    if (c.token && c.auth === 'none') c.auth = 'token';
    c.source = input.source || 'custom';
    c.createdAt = new Date().toISOString();
    c.lastTest = null;
    LIST.push(c);
    save();
    return c;
  }
  function update(name, input) {
    const i = LIST.findIndex((x) => x.name === name);
    if (i < 0) throw new Error('No such connector.');
    const prev = LIST[i];
    if (Object.keys(input).length === 1 && 'enabled' in input) { prev.enabled = !!input.enabled; save(); return prev; }
    if (Object.keys(input).length === 1 && 'scope' in input) { prev.scope = clean({ ...prev, scope: input.scope }, name).scope; save(); return prev; }
    const c = clean({ ...prev, ...input }, name);
    c.token = input.token === undefined || input.token === '' ? prev.token : String(input.token).trim();
    if (input.clearToken) c.token = undefined;
    // A token kept in the keychain that can't be read here (outside the app) stays where it is.
    if (!c.token && !input.clearToken && prev.tokenLocked && c.name === prev.name) { c.tokenRef = prev.tokenRef; c.tokenLocked = true; }
    if (vault && (c.name !== prev.name || input.clearToken)) vault.delete(tokenName(prev));
    if (oauth && c.name !== prev.name) oauth.rename(prev.name, c.name);
    if (oauth && c.url !== prev.url) oauth.signOut(c.name); // a different server needs its own sign-in
    c.source = prev.source; c.createdAt = prev.createdAt; c.lastTest = null;
    LIST[i] = c;
    save();
    return c;
  }
  function remove(name) {
    const i = LIST.findIndex((x) => x.name === name);
    if (i < 0) throw new Error('No such connector.');
    const [gone] = LIST.splice(i, 1);
    if (vault) vault.delete(tokenName(gone));
    if (oauth) oauth.signOut(gone.name);
    save();
  }

  // ---------- which connectors does this agent get? ----------
  const forAgent = (agent) => LIST.filter((c) => c.enabled && (c.scope === 'all' || c.scope.includes(agent.id)));

  // Signed in through AgentsCircle: the agent talks to AgentsCircle's local proxy, which adds the
  // sign-in. The agent only ever sees a key that works on this computer while AgentsCircle runs.
  const signedIn = (c) => !!(oauth && c.type === 'remote' && !c.token && oauth.signedIn(c.name));
  const viaProxy = (c) => (signedIn(c) && proxy ? { ...c, url: `${proxy.base}/${c.name}`, transport: 'http', headers: {}, token: proxy.secret, proxied: true } : c);

  // Translate shared connectors into launch arguments + environment for one run.
  function injection(agent, tool, runId, extraServers = {}, opts = {}) {
    const kind = support(tool);
    const shared = kind ? forAgent(agent).map(viaProxy) : [];
    // AgentsCircle's own servers (the circle tools) go to every tool that can take MCP servers.
    const extras = kind ? Object.entries(extraServers).map(([name, v]) => ({ name, type: 'local', command: v.command, args: v.args || [], env: v.env || {}, headers: {}, extra: true })) : [];
    const list = [...shared, ...extras];
    const out = { args: [], env: {}, files: [], restore: null, names: shared.map((c) => c.name), insertAfter: 0 };
    if (!list.length) return out;
    for (const c of shared) if (c.token) out.env[envName(c)] = c.token;

    if (kind === 'claude') {
      const servers = { ...extraServers };
      for (const c of shared) {
        if (c.type === 'remote') {
          const headers = { ...c.headers };
          if (c.token) headers.Authorization = `Bearer \${${envName(c)}}`; // expanded by Claude from the env, so the token never sits in the file
          servers[c.name] = { type: c.transport === 'sse' ? 'sse' : 'http', url: c.url, ...(Object.keys(headers).length ? { headers } : {}) };
        } else {
          servers[c.name] = { command: c.command, args: c.args, ...(Object.keys(c.env).length ? { env: c.env } : {}) };
        }
      }
      const f = path.join(runDir, `run-${runId}.json`);
      fs.writeFileSync(f, JSON.stringify({ mcpServers: servers }, null, 2), { mode: 0o600 });
      out.files.push(f);
      // Headless runs can't show "allow this tool?" prompts, so shared connectors are pre-approved.
      out.args.push('--mcp-config', f);
      // Under "Full auto" shared connectors are pre-approved; otherwise AgentsCircle's approval step decides.
      // AgentsCircle's own tools never need asking; under "Full auto" shared connectors are pre-approved too,
      // otherwise AgentsCircle's approval step decides.
      const allowed = [...extras.map((c) => `mcp__${c.name}`), ...(agent.permission === 'full' || !extras.length ? shared.map((c) => `mcp__${c.name}`) : [])];
      if (allowed.length) out.args.push('--allowedTools', allowed.join(','));
    } else if (kind === 'codex') {
      const q = (s) => JSON.stringify(String(s));
      const table = (m) => `{${Object.entries(m).map(([k, v]) => `${q(k)}=${q(v)}`).join(',')}}`;
      for (const c of list) {
        const k = `mcp_servers.${c.name}`;
        if (c.type === 'remote') {
          out.args.push('-c', `${k}.url=${q(c.url)}`);
          if (c.token) out.args.push('-c', `${k}.bearer_token_env_var=${q(envName(c))}`);
          if (Object.keys(c.headers).length) out.args.push('-c', `${k}.http_headers=${table(c.headers)}`);
        } else {
          out.args.push('-c', `${k}.command=${q(c.command)}`, '-c', `${k}.args=${JSON.stringify(c.args)}`);
          if (Object.keys(c.env).length) out.args.push('-c', `${k}.env=${table(c.env)}`);
        }
      }
      out.insertAfter = 1; // right after "exec"
    } else if (kind === 'opencode') {
      // OpenCode merges an inline config layer from this variable on top of its own config.
      const mcp = {};
      for (const c of list) {
        if (c.type === 'remote') {
          const headers = { ...c.headers };
          if (c.token) headers.Authorization = `Bearer ${c.token}`;
          mcp[c.name] = { type: 'remote', url: c.url, enabled: true, ...(Object.keys(headers).length ? { headers } : {}) };
        } else {
          mcp[c.name] = { type: 'local', command: [c.command, ...c.args], enabled: true, ...(Object.keys(c.env).length ? { environment: c.env } : {}) };
        }
      }
      out.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ mcp });
    } else if (kind === 'cursor' && opts.workdir) {
      // Cursor only reads mcp.json files, so we add ours to the project's .cursor/mcp.json for
      // this run and put the file back exactly as it was afterwards. Tokens stay in env vars.
      const dir = path.join(opts.workdir, '.cursor');
      const file = path.join(dir, 'mcp.json');
      let original = null;
      try { original = fs.readFileSync(file, 'utf8'); } catch { /* none */ }
      let cfg = {};
      try { cfg = original ? JSON.parse(original) : {}; } catch { cfg = {}; }
      cfg.mcpServers = { ...(cfg.mcpServers || {}) };
      for (const c of list) {
        if (cfg.mcpServers[c.name]) continue; // the project's own entry wins
        if (c.type === 'remote') {
          const headers = { ...c.headers };
          if (c.token) headers.Authorization = `Bearer \${env:${envName(c)}}`;
          cfg.mcpServers[c.name] = { url: c.url, ...(Object.keys(headers).length ? { headers } : {}) };
        } else {
          cfg.mcpServers[c.name] = { command: c.command, args: c.args, ...(Object.keys(c.env).length ? { env: c.env } : {}) };
        }
      }
      const dirExisted = fs.existsSync(dir);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
      out.restore = { file, original, dir, dirExisted };
      out.args.push('--approve-mcps');
    }
    return out;
  }
  const cleanup = (inj) => {
    for (const f of inj.files) fs.rm(f, { force: true }, () => {});
    const r = inj.restore;
    if (r) {
      try {
        if (r.original !== null) fs.writeFileSync(r.file, r.original);
        else { fs.rmSync(r.file, { force: true }); if (!r.dirExisted) fs.rmdirSync(r.dir); }
      } catch { /* best effort */ }
      inj.restore = null;
    }
  };

  // ---------- sign in (OAuth) for one agent ----------
  function signIn(name, agent) {
    const c = LIST.find((x) => x.name === name);
    if (!c) throw new Error('No such connector.');
    const tool = accounts.tool(agent);
    const kind = support(tool);
    if (!kind) throw new Error(`${tool.name} doesn't support shared connectors yet. Add ${c.title} in ${tool.name}'s own settings.`);
    if (c.type !== 'remote') throw new Error('Local connectors don\'t need a sign-in.');
    // A sign-in session that loads only this connector.
    const saved = LIST;
    LIST = [{ ...c, scope: 'all', enabled: true }];
    let one;
    try { one = injection(agent, tool, `signin-${c.name}-${agent.id}`); } finally { LIST = saved; }
    let cmd; let hint;
    if (kind === 'cursor' || kind === 'opencode') {
      throw new Error(kind === 'cursor'
        ? `Cursor signs in to connectors itself: in your project folder run "agent mcp login ${c.name}" once (AgentsCircle adds ${c.name} to the project while Cursor works).`
        : `OpenCode signs in to connectors itself: run "opencode mcp auth ${c.name}" once.`);
    }
    if (kind === 'claude') {
      cmd = [tool.resolvedCommand || tool.command, '--mcp-config', one.files[0]];
      hint = `Claude Code opens. Type /mcp, pick "${c.name}" and choose Authenticate. Sign in in the browser, then close this window.`;
    } else {
      cmd = [tool.resolvedCommand || tool.command, ...one.args, 'mcp', 'login', c.name];
      hint = 'Sign in in the browser window that opens, then close this terminal.';
    }
    const res = accounts.openInTerminal(agent, { name: `mcp-${c.name}`, cmd, env: one.env, banner: `Signing @${agent.id} in to ${c.title}`, hint });
    return { ...res, hint };
  }

  // ---------- test a connection ----------
  async function test(name) {
    const c = LIST.find((x) => x.name === name);
    if (!c) throw new Error('No such connector.');
    const r = c.type === 'remote' ? await testRemote(c) : await testLocal(c);
    c.lastTest = { ...r, at: new Date().toISOString() };
    save();
    return c.lastTest;
  }

  const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });
  const initParams = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'AgentsCircle', version } };
  function parseBody(text, type) {
    if ((type || '').includes('event-stream')) {
      const datas = text.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
      for (const d of datas) { try { const j = JSON.parse(d); if (j.result || j.error) return j; } catch { /* skip */ } }
      return null;
    }
    try { return JSON.parse(text); } catch { return null; }
  }

  async function testRemote(c) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...c.headers };
    if (c.token) headers.Authorization = `Bearer ${c.token}`;
    else if (signedIn(c)) { const t = await oauth.accessToken(c.name); if (t) headers.Authorization = `Bearer ${t}`; }
    try {
      let r1 = await fetch(c.url, { method: 'POST', headers, body: JSON.stringify(rpc(1, 'initialize', initParams)), signal: AbortSignal.timeout(10000) });
      if (r1.status === 401 && !c.token && signedIn(c)) {
        const t = await oauth.accessToken(c.name, { force: true });
        if (t) { headers.Authorization = `Bearer ${t}`; r1 = await fetch(c.url, { method: 'POST', headers, body: JSON.stringify(rpc(1, 'initialize', initParams)), signal: AbortSignal.timeout(10000) }); }
      }
      if (r1.status === 401 || r1.status === 403) {
        return c.auth === 'oauth'
          ? (signedIn(c)
            ? { ok: false, reachable: true, needsSignIn: true, message: 'The sign-in has expired. Sign in again.' }
            : { ok: true, reachable: true, needsSignIn: true, message: 'Reachable. Sign in once and every agent can use it.' })
          : { ok: false, reachable: true, message: c.token ? 'The server rejected the token.' : 'The server wants you to sign in or add a token.' };
      }
      if (!r1.ok) return { ok: false, reachable: true, message: `Server answered ${r1.status}.` };
      const j1 = parseBody(await r1.text(), r1.headers.get('content-type'));
      if (!j1 || !j1.result) return { ok: false, reachable: true, message: 'Reached the URL, but it did not answer like an MCP server.' };
      const sid = r1.headers.get('mcp-session-id');
      const h2 = { ...headers, ...(sid ? { 'Mcp-Session-Id': sid } : {}), 'MCP-Protocol-Version': j1.result.protocolVersion || initParams.protocolVersion };
      await fetch(c.url, { method: 'POST', headers: h2, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), signal: AbortSignal.timeout(5000) }).catch(() => {});
      let tools = null;
      try {
        const r2 = await fetch(c.url, { method: 'POST', headers: h2, body: JSON.stringify(rpc(2, 'tools/list', {})), signal: AbortSignal.timeout(10000) });
        const j2 = parseBody(await r2.text(), r2.headers.get('content-type'));
        if (j2 && j2.result && Array.isArray(j2.result.tools)) tools = j2.result.tools.map((t) => t.name);
      } catch { /* tools are optional */ }
      const server = j1.result.serverInfo ? `${j1.result.serverInfo.name || ''} ${j1.result.serverInfo.version || ''}`.trim() : '';
      return { ok: true, reachable: true, server, tools, message: `Connected${server ? ` to ${server}` : ''}${tools ? ` · ${tools.length} tool${tools.length === 1 ? '' : 's'}` : ''}.` };
    } catch (e) {
      return { ok: false, reachable: false, message: `Couldn't reach it: ${e.name === 'TimeoutError' ? 'timed out' : e.message}` };
    }
  }

  function testLocal(c) {
    return new Promise((resolve) => {
      let child;
      try { child = spawn(c.command, c.args, { env: { ...process.env, ...c.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); }
      catch (e) { return resolve({ ok: false, message: `Couldn't start "${c.command}": ${e.message}` }); }
      let buf = ''; let err = ''; let done = false; let server = '';
      const finish = (r) => { if (done) return; done = true; clearTimeout(timer); try { child.kill(); } catch { /* ok */ } resolve(r); };
      const timer = setTimeout(() => finish({ ok: false, message: 'No answer after 30 seconds. The first run can be slow while it downloads; try Test again.' }), 30000);
      child.on('error', (e) => finish({ ok: false, message: e.code === 'ENOENT' ? `"${c.command}" isn't installed on this computer.` : e.message }));
      child.on('exit', (code) => setTimeout(() => finish({ ok: false, message: `It stopped (code ${code}). ${err.trim().split('\n').slice(-2).join(' ')}`.trim() }), 50));
      child.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
      child.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          let j; try { j = JSON.parse(line); } catch { continue; }
          if (j.id === 1 && j.result) {
            server = j.result.serverInfo ? `${j.result.serverInfo.name || ''} ${j.result.serverInfo.version || ''}`.trim() : '';
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
            child.stdin.write(JSON.stringify(rpc(2, 'tools/list', {})) + '\n');
          } else if (j.id === 2) {
            const tools = j.result && Array.isArray(j.result.tools) ? j.result.tools.map((t) => t.name) : null;
            finish({ ok: true, server, tools, message: `Works${server ? ` (${server})` : ''}${tools ? ` · ${tools.length} tool${tools.length === 1 ? '' : 's'}` : ''}.` });
          } else if (j.error) finish({ ok: false, message: j.error.message || 'The connector returned an error.' });
        }
      });
      child.stdin.on('error', () => {});
      child.stdin.write(JSON.stringify(rpc(1, 'initialize', initParams)) + '\n');
    });
  }

  // ---------- the official MCP Registry ----------
  async function searchRegistry(q) {
    const url = `${REGISTRY}?search=${encodeURIComponent(q || '')}&limit=40`;
    const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`The registry answered ${r.status}.`);
    const j = await r.json();
    const seen = new Map();
    for (const item of j.servers || []) {
      const s = item.server || item;
      const meta = (item._meta && item._meta['io.modelcontextprotocol.registry/official']) || {};
      if (meta.isLatest === false) continue;
      const cand = fromRegistry(s);
      if (cand && !seen.has(s.name)) seen.set(s.name, cand);
    }
    return [...seen.values()];
  }
  function fromRegistry(s) {
    const base = { registryName: s.name, title: s.title || s.name.split('/').pop(), description: s.description || '', version: s.version, repository: s.repository && s.repository.url, site: s.websiteUrl ? siteOf({ url: s.websiteUrl }) : null };
    const name = s.name.split('/').pop().toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+/, '').slice(0, 40) || 'connector';
    const remote = (s.remotes || []).find((r) => r.url) || (s.packages || []).map((p) => p.transport).find((t) => t && t.url);
    if (remote) {
      const headers = (remote.headers || []).filter((h) => h.isRequired).map((h) => ({ name: h.name, description: h.description, secret: !!h.isSecret }));
      return { ...base, site: base.site || siteOf({ url: remote.url }), name, type: 'remote', url: remote.url, transport: remote.type === 'sse' ? 'sse' : 'http', auth: headers.length ? 'token' : 'oauth', needHeaders: headers };
    }
    const pkg = (s.packages || []).find((p) => ['npm', 'pypi', 'oci', 'docker'].includes(p.registryType || p.registry_type));
    if (!pkg) return null;
    const type = pkg.registryType || pkg.registry_type;
    const id = pkg.identifier || pkg.name;
    const ver = pkg.version ? `@${pkg.version}` : '';
    const command = type === 'npm' ? 'npx' : type === 'pypi' ? 'uvx' : 'docker';
    const args = type === 'npm' ? ['-y', `${id}${ver}`] : type === 'pypi' ? [id] : ['run', '-i', '--rm', id];
    for (const a of pkg.packageArguments || []) if (a.value || a.default) args.push(...(a.type === 'named' ? [a.name, a.value || a.default] : [a.value || a.default]));
    const needEnv = (pkg.environmentVariables || []).filter((e) => e.isRequired).map((e) => ({ name: e.name, description: e.description, secret: !!e.isSecret }));
    return { ...base, name, type: 'local', command, args, auth: 'none', needEnv };
  }

  // ---------- import what your agents already have ----------
  function importable() {
    const found = new Map();
    const note = (name, from, entry) => {
      const key = name.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
      if (!NAME_RE.test(key) || LIST.some((c) => c.name === key)) return;
      const cur = found.get(key) || { ...entry, name: key, from: [] };
      if (!cur.from.includes(from)) cur.from.push(from);
      found.set(key, cur);
    };
    for (const agent of accounts.list()) {
      const tool = accounts.tool(agent);
      try {
        if (tool.id === 'claude') {
          const p = agent.configDir ? path.join(agent.configDir, '.claude.json') : path.join(os.homedir(), '.claude.json');
          const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
          for (const [n, s] of Object.entries(cfg.mcpServers || {})) {
            if (s.url) note(n, `@${agent.id}`, { type: 'remote', url: s.url, transport: s.type === 'sse' ? 'sse' : 'http', headers: s.headers || {}, auth: s.headers && Object.keys(s.headers).length ? 'token' : 'oauth' });
            else if (s.command) note(n, `@${agent.id}`, { type: 'local', command: s.command, args: s.args || [], env: s.env || {}, auth: 'none' });
          }
        } else if (tool.id === 'codex') {
          const p = path.join(agent.configDir || path.join(os.homedir(), '.codex'), 'config.toml');
          const cfg = TOML.parse(fs.readFileSync(p, 'utf8'));
          for (const [n, s] of Object.entries(cfg.mcp_servers || {})) {
            if (s.url) note(n, `@${agent.id}`, { type: 'remote', url: s.url, transport: 'http', headers: s.http_headers || {}, auth: s.bearer_token_env_var ? 'token' : 'oauth', tokenFromEnv: s.bearer_token_env_var || null });
            else if (s.command) note(n, `@${agent.id}`, { type: 'local', command: s.command, args: s.args || [], env: s.env || {}, auth: 'none' });
          }
        } else if (tool.id === 'cursor') {
          const p = path.join(os.homedir(), '.cursor', 'mcp.json');
          const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
          for (const [n, s] of Object.entries(cfg.mcpServers || {})) {
            if (s.url) note(n, `@${agent.id}`, { type: 'remote', url: s.url, transport: 'http', headers: s.headers || {}, auth: s.headers && Object.keys(s.headers).length ? 'token' : 'oauth' });
            else if (s.command) note(n, `@${agent.id}`, { type: 'local', command: s.command, args: s.args || [], env: s.env || {}, auth: 'none' });
          }
        }
      } catch { /* that agent has no config file */ }
    }
    return [...found.values()];
  }

  // ---------- views ----------
  function publicConnector(c) {
    const agents = accounts.list().map((a) => {
      const t = accounts.tool(a);
      return { id: a.id, gets: !!support(t) && c.enabled && (c.scope === 'all' || c.scope.includes(a.id)), supported: !!support(t) };
    });
    const { token, tokenLocked, tokenRef, ...rest } = c;
    return { ...rest, site: siteOf(c), signedIn: signedIn(c), signin: oauth && signedIn(c) ? oauth.info(c.name) : null, signinFlow: oauth ? oauth.flow(c.name) : null, hasToken: !!token || !!tokenLocked, tokenLocked: !!tokenLocked, tokenStore: tokenRef === 'keychain' ? 'keychain' : token ? 'file' : null, agents };
  }

  return {
    list: () => LIST.map(publicConnector),
    names: () => LIST.map((c) => c.name),
    catalog: () => CATALOG.map((x) => ({ ...x, site: siteOf(x), added: LIST.some((c) => c.name === x.name || (x.url && c.url === x.url)) })),
    get: (name) => LIST.find((c) => c.name === name) || null,
    signOut: (name) => { if (oauth) oauth.signOut(name); const c = LIST.find((x) => x.name === name); if (c) { c.lastTest = null; save(); } },
    add, update, remove, test, signIn, searchRegistry, importable, injection, cleanup, forAgent,
    supports: (tool) => !!support(tool),
  };
};
