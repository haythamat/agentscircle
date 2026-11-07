// Optional account sign-in through Supabase Auth (GitHub). PKCE flow: the browser does the sign-in,
// Supabase redirects to http://127.0.0.1:<port>/auth/callback, and the app swaps the code for a session.
// The session is kept in the OS keychain when available (otherwise only in memory). The free app never needs it.

const crypto = require('crypto');

const b64u = (b) => Buffer.from(b).toString('base64url');
const PROVIDERS = new Set(['github', 'google']);
const PENDING_MS = 10 * 60000;
// The refresh token itself was refused. Anything else (rate limit, outage, bad config) is retryable and keeps the session.
const REFRESH_REJECTED = new Set(['invalid_grant', 'refresh_token_not_found', 'refresh_token_already_used', 'session_not_found', 'session_expired', 'user_not_found', 'user_banned']);

module.exports = function createAccount({ url, anonKey, port, vault, entitlements, fetchImpl = fetch, now = () => Date.now() }) {
  const configured = !!(url && anonKey);
  const redirectTo = `http://127.0.0.1:${port}/auth/callback`;
  let session = null; // { access_token, refresh_token, expires_at, user: { id, email, name } }
  let pending = null; // { state, verifier, at }
  let lastError = '';
  let generation = 0; // bumped when a session ends or a new login starts; older in-flight requests must not touch state
  try { const raw = vault && vault.get('account-session'); if (raw) session = JSON.parse(raw); } catch { session = null; }
  entitlements.bindAccount(() => (session ? session.user.id : null));

  const headers = (token) => ({ apikey: anonKey, Authorization: `Bearer ${token || anonKey}`, 'Content-Type': 'application/json' });
  const persist = () => { if (!vault) return; if (session) vault.set('account-session', JSON.stringify(session)); else vault.delete('account-session'); };
  const slim = (s) => ({
    access_token: s.access_token, refresh_token: s.refresh_token,
    expires_at: s.expires_at ? s.expires_at * 1000 : now() + (s.expires_in || 3600) * 1000,
    user: { id: s.user.id, email: s.user.email || '', name: (s.user.user_metadata && (s.user.user_metadata.user_name || s.user.user_metadata.full_name)) || '' },
  });
  const endSession = () => { generation++; session = null; persist(); entitlements.clear(); };
  const stillCurrent = (g) => { if (g !== generation) throw new Error('Sign-in was cancelled.'); };

  function begin(provider) {
    if (!configured) throw new Error('Account sign-in is not set up in this build.');
    if (!PROVIDERS.has(provider)) throw new Error('Unknown sign-in provider.');
    const verifier = b64u(crypto.randomBytes(48));
    const challenge = b64u(crypto.createHash('sha256').update(verifier).digest());
    generation++;
    pending = { state: b64u(crypto.randomBytes(16)), verifier, at: now() };
    lastError = '';
    const q = new URLSearchParams({ provider, redirect_to: `${redirectTo}?state=${pending.state}`, code_challenge: challenge, code_challenge_method: 's256' });
    return `${url}/auth/v1/authorize?${q}`;
  }

  async function callback({ code, state }) {
    const p = pending;
    if (!p || now() - p.at > PENDING_MS || !state || state !== p.state) throw new Error('This sign-in link is not valid or has expired. Start again from the app.'); // a stray callback must not cancel the real one
    pending = null;
    if (!code) throw new Error('Sign-in was cancelled or failed.');
    const g = generation;
    const r = await fetchImpl(`${url}/auth/v1/token?grant_type=pkce`, { method: 'POST', headers: headers(), body: JSON.stringify({ auth_code: code, code_verifier: p.verifier }) });
    const j = await r.json().catch(() => ({}));
    stillCurrent(g);
    if (!r.ok || !j.access_token || !j.user) throw new Error(j.error_description || j.msg || 'Could not complete sign-in.');
    session = slim(j); persist();
    await refreshPlan().catch(() => {}); // the failure is in lastError; the sign-in itself worked
    return publicState();
  }

  async function fresh(g) {
    if (!session) return null;
    if (session.expires_at - now() > 60000) return session.access_token;
    const r = await fetchImpl(`${url}/auth/v1/token?grant_type=refresh_token`, { method: 'POST', headers: headers(), body: JSON.stringify({ refresh_token: session.refresh_token }) });
    const j = await r.json().catch(() => ({}));
    stillCurrent(g);
    if (!r.ok || !j.access_token || !j.user) {
      if (REFRESH_REJECTED.has(j.error_code) || REFRESH_REJECTED.has(j.error)) {
        endSession();
        lastError = 'Your sign-in expired. Sign in again.';
        throw new Error(lastError);
      }
      throw new Error('Could not renew your sign-in right now. Try again in a moment.');
    }
    session = slim(j); persist();
    return session.access_token;
  }

  // Ask the plan-token function for a signed plan and cache it if it is for this account.
  async function refreshPlan() {
    const g = generation;
    try {
      const token = await fresh(g);
      if (!token) throw new Error('Not signed in.');
      const r = await fetchImpl(`${url}/functions/v1/plan-token`, { method: 'POST', headers: headers(token), body: '{}' });
      const j = await r.json().catch(() => ({}));
      stillCurrent(g);
      if (!r.ok || !j.token) throw new Error(j.error || `Plan check failed (${r.status}).`);
      const sub = (() => { try { return JSON.parse(Buffer.from(String(j.token).split('.')[0], 'base64url').toString()).sub; } catch { return null; } })();
      if (sub !== session.user.id) throw new Error('That plan belongs to a different account.');
      if (!entitlements.setToken(j.token)) throw new Error('The plan token was not accepted.');
      lastError = '';
      return entitlements.status();
    } catch (e) {
      if (g === generation) lastError = e.message;
      throw e;
    }
  }

  function signOut() { pending = null; lastError = ''; endSession(); }
  function publicState() {
    return {
      configured, providers: [...PROVIDERS], signedIn: !!session, user: session ? { email: session.user.email, name: session.user.name } : null,
      keychain: !!(vault && vault.available()), redirectTo, error: lastError,
    };
  }
  return { begin, callback, refreshPlan, signOut, state: publicState, redirectTo };
};
