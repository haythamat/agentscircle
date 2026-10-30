// Sign in to a remote connector once, in the browser, for every agent.
// AgentsCircle is the OAuth client (the MCP authorization spec: protected-resource metadata,
// authorization-server metadata, dynamic client registration, PKCE). The tokens stay with
// AgentsCircle (keychain when available); agents reach the connector through AgentsCircle's
// local proxy, which adds the token. So one sign-in serves Claude Code, Codex, Cursor and OpenCode,
// and no agent's own settings are touched.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const TIMEOUT = 15000;

async function getJson(url) {
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json', 'MCP-Protocol-Version': '2025-06-18' }, signal: AbortSignal.timeout(TIMEOUT) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// RFC 8414 / 9728: the well-known document sits at the root, with the path appended.
function wellKnown(base, name) {
  const u = new URL(base);
  const p = u.pathname.replace(/\/+$/, '');
  const out = [`${u.origin}/.well-known/${name}${p}`];
  if (p) out.push(`${u.origin}/.well-known/${name}`);
  return out;
}

module.exports = function createOAuth({ dataDir, vault, version, redirectUri, openUrl, onUpdate }) {
  const fileStore = path.join(dataDir, 'oauth.json'); // only when the keychain can't be used
  const clientsFile = path.join(dataDir, 'oauth-clients.json'); // registered client ids (not secret for public clients)
  const pending = new Map(); // state -> flow
  const flows = new Map(); // connector name -> public flow state
  const refreshing = new Map(); // connector name -> promise

  // ---------- storage ----------
  const key = (name) => `connector:${name}:oauth`;
  const readFile = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };
  const writeFile = (f, d) => { fs.writeFileSync(f, JSON.stringify(d, null, 2), { mode: 0o600 }); try { fs.chmodSync(f, 0o600); } catch { /* windows */ } };
  function load(name) {
    if (vault && vault.available()) { const v = vault.get(key(name)); if (v) { try { return JSON.parse(v); } catch { /* bad */ } } }
    return readFile(fileStore)[name] || null;
  }
  function store(name, data) {
    const all = readFile(fileStore);
    if (data && vault && vault.available() && vault.set(key(name), JSON.stringify(data))) { if (all[name]) { delete all[name]; writeFile(fileStore, all); } return; }
    if (data) all[name] = data; else delete all[name];
    writeFile(fileStore, all);
    if (!data && vault) try { vault.delete(key(name)); } catch { /* none */ }
  }

  // ---------- discovery ----------
  async function discover(serverUrl) {
    // 1. Ask the server: a 401 names its protected-resource metadata.
    let prmUrl = null;
    try {
      const r = await fetch(serverUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'AgentsCircle', version } } }), signal: AbortSignal.timeout(TIMEOUT) });
      const wa = r.headers.get('www-authenticate') || '';
      const m = /resource_metadata="([^"]+)"/i.exec(wa);
      if (m) prmUrl = new URL(m[1], serverUrl).toString();
      if (r.ok) return { open: true };
    } catch (e) { throw new Error(`Couldn't reach ${new URL(serverUrl).host}: ${e.name === 'TimeoutError' ? 'timed out' : e.message}`); }
    let prm = null;
    for (const u of [prmUrl, ...wellKnown(serverUrl, 'oauth-protected-resource')].filter(Boolean)) { prm = await getJson(u); if (prm) break; }
    const issuer = (prm && Array.isArray(prm.authorization_servers) && prm.authorization_servers[0]) || new URL(serverUrl).origin;
    let as = null;
    for (const u of [...wellKnown(issuer, 'oauth-authorization-server'), ...wellKnown(issuer, 'openid-configuration')]) { as = await getJson(u); if (as && as.authorization_endpoint) break; as = null; }
    if (!as) {
      // Old servers: the endpoints at their default places.
      const o = new URL(issuer).origin;
      as = { issuer: o, authorization_endpoint: `${o}/authorize`, token_endpoint: `${o}/token`, registration_endpoint: `${o}/register`, guessed: true };
    }
    return { resource: (prm && prm.resource) || serverUrl, scopes: (prm && prm.scopes_supported) || null, as };
  }

  async function client(as) {
    const all = readFile(clientsFile);
    const id = `${as.issuer || as.authorization_endpoint}|${redirectUri}`;
    if (all[id]) return all[id];
    if (!as.registration_endpoint) throw new Error('This service doesn\'t let apps sign in on their own. Add a token instead (Edit).');
    const r = await fetch(as.registration_endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT),
      body: JSON.stringify({ client_name: 'AgentsCircle', client_uri: 'https://agentscircle.lovable.app', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', software_id: 'dev.agentscircle.desktop', software_version: version }),
    }).catch((e) => { throw new Error(`Couldn't register with the sign-in server: ${e.message}`); });
    if (!r.ok) {
      const t = (await r.text().catch(() => '')).slice(0, 200);
      throw new Error(r.status === 404 || r.status === 405 ? 'This service doesn\'t let apps sign in on their own. Add a token instead (Edit).' : `The sign-in server refused AgentsCircle (${r.status}). ${t}`.trim());
    }
    const c = await r.json();
    const saved = { client_id: c.client_id, client_secret: c.client_secret || null, auth_method: c.token_endpoint_auth_method || (c.client_secret ? 'client_secret_post' : 'none') };
    all[id] = saved; writeFile(clientsFile, all);
    return saved;
  }

  const setFlow = (name, f) => { const pub = { connector: name, ...f, at: new Date().toISOString() }; flows.set(name, pub); onUpdate && onUpdate(pub); return pub; };

  // ---------- sign in ----------
  async function start(c) {
    if (c.type !== 'remote') throw new Error('Local connectors don\'t need a sign-in.');
    for (const [s, p] of pending) if (p.name === c.name) pending.delete(s);
    setFlow(c.name, { state: 'starting', message: `Opening ${c.title || c.name}'s sign-in page…` });
    let d;
    try { d = await discover(c.url); } catch (e) { setFlow(c.name, { state: 'failed', message: e.message }); throw e; }
    if (d.open) { const f = setFlow(c.name, { state: 'done', message: 'This connector works without signing in.' }); return f; }
    let cl;
    try { cl = await client(d.as); } catch (e) { setFlow(c.name, { state: 'failed', message: e.message }); throw e; }
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(18));
    const u = new URL(d.as.authorization_endpoint);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', cl.client_id);
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('code_challenge', challenge);
    u.searchParams.set('code_challenge_method', 'S256');
    u.searchParams.set('state', state);
    u.searchParams.set('resource', d.resource);
    if (d.scopes && d.scopes.length) u.searchParams.set('scope', d.scopes.join(' '));
    pending.set(state, { name: c.name, title: c.title || c.name, verifier, client: cl, as: d.as, resource: d.resource, at: Date.now() });
    setTimeout(() => { if (pending.delete(state) && flows.get(c.name)?.state === 'browser') setFlow(c.name, { state: 'failed', message: 'Sign-in timed out. Try again.' }); }, 10 * 60000);
    const url = u.toString();
    try { openUrl(url); } catch { /* the app shows the link */ }
    return setFlow(c.name, { state: 'browser', url, message: `Finish signing in to ${c.title || c.name} in your browser.` });
  }

  async function tokenRequest(as, cl, params) {
    const body = new URLSearchParams(params);
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    if (cl.client_secret && cl.auth_method === 'client_secret_basic') headers.Authorization = 'Basic ' + Buffer.from(`${encodeURIComponent(cl.client_id)}:${encodeURIComponent(cl.client_secret)}`).toString('base64');
    else { body.set('client_id', cl.client_id); if (cl.client_secret) body.set('client_secret', cl.client_secret); }
    const r = await fetch(as.token_endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(TIMEOUT) });
    const text = await r.text();
    let j = null; try { j = JSON.parse(text); } catch { j = Object.fromEntries(new URLSearchParams(text)); }
    if (!r.ok || !j.access_token) throw new Error((j && (j.error_description || j.error)) || `The sign-in server answered ${r.status}.`);
    return j;
  }

  const saveTokens = (name, flow, j, prev) => store(name, {
    access_token: j.access_token, refresh_token: j.refresh_token || (prev && prev.refresh_token) || null,
    expires_at: j.expires_in ? Date.now() + Number(j.expires_in) * 1000 : null, scope: j.scope || null,
    token_endpoint: flow.as.token_endpoint, issuer: flow.as.issuer || null, client: flow.client, resource: flow.resource, signedInAt: (prev && prev.signedInAt) || new Date().toISOString(),
  });

  // The browser comes back here with ?code&state.
  async function callback(query) {
    const p = pending.get(query.state);
    if (!p) return { ok: false, message: 'This sign-in link has expired or was already used. Start again from AgentsCircle.' };
    pending.delete(query.state);
    if (query.error) { const m = query.error === 'access_denied' ? 'Sign-in was cancelled.' : (query.error_description || query.error); setFlow(p.name, { state: 'failed', message: m }); return { ok: false, title: p.title, message: m }; }
    setFlow(p.name, { state: 'checking', message: 'Signed in. Checking that it works…' });
    try {
      const j = await tokenRequest(p.as, p.client, { grant_type: 'authorization_code', code: query.code, redirect_uri: redirectUri, code_verifier: p.verifier, resource: p.resource });
      saveTokens(p.name, p, j, null);
      return { ok: true, name: p.name, title: p.title };
    } catch (e) {
      setFlow(p.name, { state: 'failed', message: e.message });
      return { ok: false, title: p.title, message: e.message };
    }
  }

  // A fresh access token for the proxy, refreshed when it is about to run out.
  async function accessToken(name, { force } = {}) {
    const t = load(name);
    if (!t) return null;
    const fresh = t.expires_at == null || t.expires_at - Date.now() > 60000;
    if (fresh && !force) return t.access_token;
    if (!t.refresh_token) return force ? null : t.access_token;
    if (refreshing.has(name)) return refreshing.get(name);
    const job = (async () => {
      try {
        const j = await tokenRequest({ token_endpoint: t.token_endpoint }, t.client, { grant_type: 'refresh_token', refresh_token: t.refresh_token, resource: t.resource });
        saveTokens(name, { as: { token_endpoint: t.token_endpoint, issuer: t.issuer }, client: t.client, resource: t.resource }, j, t);
        return j.access_token;
      } catch {
        return force ? null : t.access_token;
      } finally { refreshing.delete(name); }
    })();
    refreshing.set(name, job);
    return job;
  }

  return {
    start, callback, accessToken,
    signedIn: (name) => !!load(name),
    info: (name) => { const t = load(name); return t ? { signedInAt: t.signedInAt, expiresAt: t.expires_at, canRefresh: !!t.refresh_token } : null; },
    signOut: (name) => { store(name, null); flows.delete(name); },
    rename: (from, to) => { const t = load(from); if (t) { store(to, t); store(from, null); } },
    flow: (name) => flows.get(name) || null,
    finish: (name, ok, message) => setFlow(name, { state: ok ? 'done' : 'failed', message }),
  };
};
