// Optional account sign-in through Supabase Auth (GitHub, or a link sent by email). PKCE flow: the browser does the sign-in,
// Supabase redirects to http://127.0.0.1:<port>/auth/callback, and the app swaps the code for a session.
// The session is kept in the OS keychain when available (otherwise only in memory). The free app never needs it.

const crypto = require('crypto');

const b64u = (b) => Buffer.from(b).toString('base64url');
const PROVIDERS = new Set(['github', 'google']);
const PENDING_MS = 10 * 60000;
const PLAN_REFRESH_MS = 24 * 3600000; // a changed plan reaches the app within a day; well inside the token's 14-day lifetime
// The refresh token itself was refused (error_code from Supabase Auth, checked against its source and the live API).
// Anything else (conflict, rate limit, outage, bad config) is retryable and keeps the session.
const REFRESH_REJECTED = new Set(['refresh_token_not_found', 'refresh_token_already_used', 'session_not_found', 'session_expired', 'validation_failed', 'user_not_found', 'user_banned']);

module.exports = function createAccount({ url, anonKey, port, vault, entitlements, fetchImpl = fetch, now = () => Date.now() }) {
  const configured = !!(url && anonKey);
  const redirectTo = `http://127.0.0.1:${port}/auth/callback`;
  let session = null; // { access_token, refresh_token, expires_at, user: { id, email, name } }
  let pending = null; // { state, verifier, at }
  let lastError = '';
  let generation = 0; // bumped when a session ends or a new login starts; older in-flight requests must not touch state
  let planAt = 0; // when this run last got a plan; 0 means due now
  let inflight = null; // { g, promise }: a timer and a click share one request, so the refresh token is not spent twice
  try { const raw = vault && vault.get('account-session'); if (raw) session = JSON.parse(raw); } catch { session = null; }
  entitlements.bindAccount(() => (session ? session.user.id : null));

  const headers = (token) => ({ apikey: anonKey, Authorization: `Bearer ${token || anonKey}`, 'Content-Type': 'application/json' });
  const persist = () => { if (!vault) return; if (session) vault.set('account-session', JSON.stringify(session)); else vault.delete('account-session'); };
  const slim = (s) => ({
    access_token: s.access_token, refresh_token: s.refresh_token,
    expires_at: s.expires_at ? s.expires_at * 1000 : now() + (s.expires_in || 3600) * 1000,
    user: { id: s.user.id, email: s.user.email || '', name: (s.user.user_metadata && (s.user.user_metadata.user_name || s.user.user_metadata.full_name)) || '' },
  });
  const endSession = () => { generation++; planAt = 0; session = null; persist(); entitlements.clear(); };
  const stillCurrent = (g) => { if (g !== generation) throw new Error('Sign-in was cancelled.'); };

  // A new attempt: its PKCE pair and the state the callback must bring back.
  function start() {
    if (!configured) throw new Error('Account sign-in is not set up in this build.');
    const verifier = b64u(crypto.randomBytes(48));
    const challenge = b64u(crypto.createHash('sha256').update(verifier).digest());
    generation++;
    pending = { state: b64u(crypto.randomBytes(16)), verifier, at: now() };
    lastError = '';
    return { challenge, back: `${redirectTo}?state=${pending.state}` };
  }

  function begin(provider) {
    if (!configured) throw new Error('Account sign-in is not set up in this build.');
    if (!PROVIDERS.has(provider)) throw new Error('Unknown sign-in provider.');
    const { challenge, back } = start();
    const q = new URLSearchParams({ provider, redirect_to: back, code_challenge: challenge, code_challenge_method: 's256' });
    return `${url}/auth/v1/authorize?${q}`;
  }

  // Email: Supabase sends a one-time link. Opened on this computer, it lands on the same /auth/callback as GitHub.
  async function beginEmail(email) {
    email = String(email || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address.');
    const { challenge, back } = start();
    const p = pending;
    const r = await fetchImpl(`${url}/auth/v1/otp?redirect_to=${encodeURIComponent(back)}`, {
      method: 'POST', headers: headers(), body: JSON.stringify({ email, create_user: true, code_challenge: challenge, code_challenge_method: 's256' }),
    });
    if (r.ok) return { sent: true };
    const j = await r.json().catch(() => ({}));
    if (pending === p) pending = null;
    if (j.error_code === 'over_email_send_rate_limit' || r.status === 429) throw new Error('Too many sign-in emails were sent. Wait a few minutes and try again.');
    if (j.error_code === 'email_provider_disabled') throw new Error('Email sign-in is not turned on yet. Use GitHub for now.');
    throw new Error(j.msg || j.error_description || 'Could not send the sign-in email. Try again.');
  }

  async function callback({ code, state }) {
    const p = pending;
    if (!p || now() - p.at > PENDING_MS || !state || state !== p.state) throw new Error('This sign-in link is not valid or has expired. Start again from the app.'); // a stray callback must not cancel the real one
    pending = null;
    const g = generation;
    let j;
    try {
      if (!code) throw new Error('Sign-in was cancelled or failed. Try again.');
      const r = await fetchImpl(`${url}/auth/v1/token?grant_type=pkce`, { method: 'POST', headers: headers(), body: JSON.stringify({ auth_code: code, code_verifier: p.verifier }) });
      j = await r.json().catch(() => ({}));
      stillCurrent(g);
      if (!r.ok || !j.access_token || !j.user) throw new Error(j.error_description || j.msg || 'Could not complete sign-in.');
    } catch (e) {
      if (g === generation) lastError = e.message; // the app is polling for this attempt's result
      throw e;
    }
    generation++; // the new account replaces the old one: refreshes started for it must not write back
    planAt = 0;
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
      if (REFRESH_REJECTED.has(j.error_code)) {
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
  // quiet: a background check stays silent while the cached plan still works; the user has nothing to do yet.
  // A click that joins a background request makes its failure visible too.
  function refreshPlan(quiet = false) {
    if (inflight && inflight.g === generation) { if (!quiet) inflight.quiet = false; return inflight.promise; }
    const req = { g: generation, quiet };
    req.promise = fetchPlan(req).finally(() => { if (inflight === req) inflight = null; });
    inflight = req;
    return req.promise;
  }
  async function fetchPlan(req) {
    const { g } = req;
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
      planAt = now();
      lastError = '';
      return entitlements.status();
    } catch (e) {
      if (g === generation && !(req.quiet && entitlements.status().expiresAt)) lastError = e.message;
      throw e;
    }
  }

  // Called on a timer. A failure is retried on the next call, so a paid user who stays online never has to click.
  async function refreshIfDue() {
    if (!session || now() - planAt < PLAN_REFRESH_MS) return;
    await refreshPlan(true).catch(() => {});
  }

  function signOut() { pending = null; lastError = ''; endSession(); }
  function publicState() {
    return {
      configured, providers: [...PROVIDERS, 'email'], signedIn: !!session, user: session ? { email: session.user.email, name: session.user.name } : null,
      keychain: !!(vault && vault.available()), redirectTo, error: lastError,
    };
  }
  return { begin, beginEmail, callback, refreshPlan, refreshIfDue, signOut, state: publicState, redirectTo };
};
