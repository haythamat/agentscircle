// Review regressions: uses fake HTTP, an ephemeral signing key, and temporary files only.
// Run: node --test docs/reviews/account-signin-review.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const createAccount = require('../../src/account');
const createEntitlements = require('../../src/entitlements');
const DAY = 86400000;
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-account-review-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = 1800000000000;
  const now = () => clock;
  const entitlements = createEntitlements({ dataDir: dir, settings: { get: () => ({ entitlements: true }) }, publicKey: publicKey.export({ type: 'spki', format: 'pem' }), now });
  const token = (sub = 'alice', plan = 'pro') => {
    const body = Buffer.from(JSON.stringify({ sub, plan, status: 'active', issuedAt: now(), expiresAt: now() + 14 * DAY })).toString('base64url');
    return `${body}.${crypto.sign(null, Buffer.from(body), privateKey).toString('base64url')}`;
  };
  const session = (id = 'alice') => ({ access_token: 'fake-access', refresh_token: 'fake-refresh', expires_in: 3600, user: { id, email: `${id}@example.invalid` } });
  const make = (fetchImpl) => createAccount({ url: 'https://example.invalid', anonKey: 'fake-key', port: 4317, entitlements, fetchImpl, now });
  const state = (a) => new URL(new URL(a.begin('github')).searchParams.get('redirect_to')).searchParams.get('state');
  return { entitlements, token, session, make, state, now, advance: (ms) => { clock += ms; } };
}

test('PKCE challenge matches verifier; successful callback cannot be reused', async (t) => {
  const f = fixture(t);
  let request;
  const a = f.make(async (url, options) => {
    if (url.includes('/token?')) { request = JSON.parse(options.body); return reply(f.session()); }
    return reply({ token: f.token() });
  });
  const auth = new URL(a.begin('github'));
  const state = new URL(auth.searchParams.get('redirect_to')).searchParams.get('state');
  await a.callback({ code: 'fake-code', state });
  assert.equal(auth.searchParams.get('code_challenge'), crypto.createHash('sha256').update(request.code_verifier).digest('base64url'));
  assert.equal(f.entitlements.can('scheduled_tasks'), true);
  await assert.rejects(a.callback({ code: 'fake-code', state }));
});

test('a wrong-subject plan is rejected for a fresh account', async (t) => {
  const f = fixture(t);
  const a = f.make(async (url) => url.includes('/token?') ? reply(f.session()) : reply({ token: f.token('bob') }));
  await a.callback({ code: 'fake-code', state: f.state(a) });
  assert.match(a.state().error, /different account/);
  assert.equal(f.entitlements.can('scheduled_tasks'), false);
});

test('invalid state must not consume the legitimate pending login', async (t) => {
  const f = fixture(t);
  const a = f.make(async (url) => url.includes('/token?') ? reply(f.session()) : reply({ token: f.token() }));
  const state = f.state(a);
  await assert.rejects(a.callback({ code: 'bad-code', state: 'wrong-state' }));
  await a.callback({ code: 'fake-code', state });
  assert.equal(a.state().signedIn, true);
});

test('sign-out must cancel an in-flight code exchange', async (t) => {
  const f = fixture(t);
  let release;
  const a = f.make(async (url) => url.includes('/token?') ? new Promise((resolve) => { release = resolve; }) : reply({ token: f.token() }));
  const completing = a.callback({ code: 'fake-code', state: f.state(a) });
  a.signOut();
  release(reply(f.session()));
  await completing.catch(() => {});
  assert.equal(a.state().signedIn, false);
  assert.equal(f.entitlements.can('scheduled_tasks'), false);
});

test('a cached plan must not grant access without its account session', (t) => {
  const f = fixture(t);
  assert.equal(f.entitlements.setToken(f.token()), true);
  const a = f.make(async () => { throw new Error('Offline'); });
  assert.equal(a.state().signedIn, false);
  assert.equal(f.entitlements.can('scheduled_tasks'), false);
});

test('a rejected refresh token must clear account entitlements', async (t) => {
  const f = fixture(t);
  let expired = false;
  const a = f.make(async (url) => {
    if (url.includes('grant_type=refresh_token') && expired) return reply({ code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token: Refresh Token Not Found' }, 400); // the live API's body
    return url.includes('/token?') ? reply(f.session()) : reply({ token: f.token() });
  });
  await a.callback({ code: 'fake-code', state: f.state(a) });
  expired = true;
  f.advance(3600000);
  await assert.rejects(a.refreshPlan());
  assert.equal(a.state().signedIn, false);
  assert.equal(f.entitlements.can('scheduled_tasks'), false);
});

test('sign-out must cancel an in-flight session refresh', async (t) => {
  const f = fixture(t);
  let release;
  const a = f.make(async (url) => {
    if (url.includes('grant_type=refresh_token')) return new Promise((resolve) => { release = resolve; });
    return url.includes('/token?') ? reply(f.session()) : reply({ token: f.token() });
  });
  await a.callback({ code: 'fake-code', state: f.state(a) });
  f.advance(3600000);
  const refreshing = a.refreshPlan();
  a.signOut();
  release(reply(f.session()));
  await assert.rejects(refreshing);
  assert.equal(a.state().signedIn, false);
  assert.equal(a.state().error, '');
  assert.equal(f.entitlements.can('scheduled_tasks'), false);
});

test('sign-out must cancel an in-flight plan fetch', async (t) => {
  const f = fixture(t);
  let release;
  let holding = false;
  const a = f.make(async (url) => {
    if (url.includes('/token?')) return reply(f.session());
    return holding ? new Promise((resolve) => { release = resolve; }) : reply({ token: f.token() });
  });
  await a.callback({ code: 'fake-code', state: f.state(a) });
  holding = true;
  f.advance(1000);
  const refreshing = a.refreshPlan();
  await new Promise(setImmediate);
  a.signOut();
  release(reply({ token: f.token() }));
  await assert.rejects(refreshing);
  assert.equal(f.entitlements.can('scheduled_tasks'), false);
});

test('direct token installs must match the signed-in account', async (t) => {
  const f = fixture(t);
  const a = f.make(async (url) => url.includes('/token?') ? reply(f.session()) : reply({ error: 'unavailable' }, 503));
  assert.equal(f.entitlements.setToken(f.token()), false, 'signed out');
  await a.callback({ code: 'fake-code', state: f.state(a) });
  assert.equal(f.entitlements.setToken(f.token('bob')), false, 'another account');
  assert.equal(f.entitlements.can('scheduled_tasks'), false);
  assert.equal(f.entitlements.setToken(f.token()), true, 'this account');
  assert.equal(f.entitlements.can('scheduled_tasks'), true);
});

test('a saved session for the same user keeps the cached plan working offline', async (t) => {
  const f = fixture(t);
  const store = new Map();
  const vault = { get: (k) => store.get(k), set: (k, v) => store.set(k, v), delete: (k) => store.delete(k), available: () => true };
  const online = createAccount({ url: 'https://example.invalid', anonKey: 'fake-key', port: 4317, vault, entitlements: f.entitlements, now: f.now, fetchImpl: async (url) => url.includes('/token?') ? reply(f.session()) : reply({ token: f.token() }) });
  await online.callback({ code: 'fake-code', state: f.state(online) });
  const offline = createAccount({ url: 'https://example.invalid', anonKey: 'fake-key', port: 4317, vault, entitlements: f.entitlements, now: f.now, fetchImpl: async () => { throw new Error('Offline'); } });
  assert.equal(offline.state().signedIn, true);
  assert.equal(f.entitlements.can('scheduled_tasks'), true);
});

test('rate limiting during refresh must preserve the plan and report a retryable error', async (t) => {
  const f = fixture(t);
  const a = f.make(async (url) => {
    if (url.includes('grant_type=refresh_token')) return reply({ error_code: 'over_request_rate_limit' }, 429);
    return url.includes('/token?') ? reply(f.session()) : reply({ token: f.token() });
  });
  await a.callback({ code: 'fake-code', state: f.state(a) });
  f.advance(3600000);
  await assert.rejects(a.refreshPlan());
  assert.equal(f.entitlements.can('scheduled_tasks'), true);
  assert.match(a.state().error, /Try again/);
});

test('rate limiting during refresh must preserve the session for retry', async (t) => {
  const f = fixture(t);
  const a = f.make(async (url) => {
    if (url.includes('grant_type=refresh_token')) return reply({ error: 'over_request_rate_limit' }, 429);
    return url.includes('/token?') ? reply(f.session()) : reply({ token: f.token() });
  });
  await a.callback({ code: 'fake-code', state: f.state(a) });
  f.advance(3600000);
  await assert.rejects(a.refreshPlan());
  assert.equal(a.state().signedIn, true);
});

// Each code the Supabase Auth refresh grant returns for a dead token, and the ones it returns for a passing problem.
const signedInAndExpired = async (f, body, status) => {
  const a = f.make(async (url) => {
    if (url.includes('grant_type=refresh_token')) return reply(body, status);
    return url.includes('/token?') ? reply(f.session()) : reply({ token: f.token() });
  });
  await a.callback({ code: 'fake-code', state: f.state(a) });
  f.advance(3600000);
  await assert.rejects(a.refreshPlan());
  return a;
};

for (const code of ['refresh_token_not_found', 'refresh_token_already_used', 'session_not_found', 'session_expired', 'validation_failed', 'user_not_found', 'user_banned']) {
  test(`refresh refused with ${code} ends the session`, async (t) => {
    const f = fixture(t);
    const a = await signedInAndExpired(f, { code: 400, error_code: code, msg: 'refused' }, 400);
    assert.equal(a.state().signedIn, false);
    assert.equal(f.entitlements.can('scheduled_tasks'), false);
    assert.match(a.state().error, /Sign in again/);
  });
}

for (const [code, status] of [['conflict', 409], ['over_request_rate_limit', 429], ['unexpected_failure', 500], ['request_timeout', 504]]) {
  test(`refresh failing with ${code} keeps the session and plan`, async (t) => {
    const f = fixture(t);
    const a = await signedInAndExpired(f, { code: status, error_code: code, msg: 'later' }, status);
    assert.equal(a.state().signedIn, true);
    assert.equal(f.entitlements.can('scheduled_tasks'), true);
    assert.match(a.state().error, /Try again/);
  });
}

test('a body with no error_code (bad API key, gateway error) keeps the session', async (t) => {
  const f = fixture(t);
  const a = await signedInAndExpired(f, { message: 'Invalid API key' }, 401);
  assert.equal(a.state().signedIn, true);
});

test('automatic refresh: signed out makes no request', async (t) => {
  const f = fixture(t);
  let calls = 0;
  const a = f.make(async () => { calls++; return reply({}); });
  await a.refreshIfDue();
  assert.equal(calls, 0);
});

test('automatic refresh: a paid user who never clicks stays paid past 14 days', async (t) => {
  const f = fixture(t);
  const a = f.make(async (url) => url.includes('/token?') ? reply(f.session()) : reply({ token: f.token() }));
  await a.callback({ code: 'fake-code', state: f.state(a) });
  for (let hour = 0; hour < 40 * 24; hour++) {
    f.advance(3600000);
    await a.refreshIfDue();
    assert.equal(f.entitlements.can('scheduled_tasks'), true, `hour ${hour}`);
  }
});

test('automatic refresh: asks once a day, not on every timer tick', async (t) => {
  const f = fixture(t);
  let plans = 0;
  const a = f.make(async (url) => { if (url.includes('/token?')) return reply(f.session()); plans++; return reply({ token: f.token() }); });
  await a.callback({ code: 'fake-code', state: f.state(a) });
  assert.equal(plans, 1);
  f.advance(23 * 3600000);
  await a.refreshIfDue();
  assert.equal(plans, 1);
  f.advance(3600000);
  await a.refreshIfDue();
  assert.equal(plans, 2);
});

test('automatic refresh: runs on the first tick after a restart', async (t) => {
  const f = fixture(t);
  const store = new Map();
  const vault = { get: (k) => store.get(k), set: (k, v) => store.set(k, v), delete: (k) => store.delete(k), available: () => true };
  let plans = 0;
  const fetchImpl = async (url) => { if (url.includes('/token?')) return reply(f.session()); plans++; return reply({ token: f.token() }); };
  const before = createAccount({ url: 'https://example.invalid', anonKey: 'fake-key', port: 4317, vault, entitlements: f.entitlements, now: f.now, fetchImpl });
  await before.callback({ code: 'fake-code', state: f.state(before) });
  const after = createAccount({ url: 'https://example.invalid', anonKey: 'fake-key', port: 4317, vault, entitlements: f.entitlements, now: f.now, fetchImpl });
  plans = 0;
  await after.refreshIfDue();
  assert.equal(plans, 1);
});

test('automatic refresh: a canceled plan reaches the app within a day', async (t) => {
  const f = fixture(t);
  let plan = 'pro';
  const a = f.make(async (url) => url.includes('/token?') ? reply(f.session()) : reply({ token: f.token('alice', plan) }));
  await a.callback({ code: 'fake-code', state: f.state(a) });
  assert.equal(f.entitlements.can('scheduled_tasks'), true);
  plan = 'free';
  f.advance(24 * 3600000);
  await a.refreshIfDue();
  assert.equal(f.entitlements.can('scheduled_tasks'), false);
  assert.equal(a.state().signedIn, true);
});

test('automatic refresh: offline is silent while the plan works, shows once it lapses, recovers when back', async (t) => {
  const f = fixture(t);
  let online = true;
  const a = f.make(async (url) => {
    if (!online) throw new Error('Offline');
    return url.includes('/token?') ? reply(f.session()) : reply({ token: f.token() });
  });
  await a.callback({ code: 'fake-code', state: f.state(a) });
  online = false;
  f.advance(13 * DAY);
  await a.refreshIfDue();
  assert.equal(a.state().error, '');
  assert.equal(f.entitlements.can('scheduled_tasks'), true);
  f.advance(2 * DAY);
  await a.refreshIfDue();
  assert.equal(f.entitlements.can('scheduled_tasks'), false);
  assert.notEqual(a.state().error, '');
  assert.equal(a.state().signedIn, true);
  online = true;
  f.advance(3600000);
  await a.refreshIfDue();
  assert.equal(f.entitlements.can('scheduled_tasks'), true);
  assert.equal(a.state().error, '');
});

test('automatic refresh: a refused token during a background check still tells the user', async (t) => {
  const f = fixture(t);
  let refused = false;
  const a = f.make(async (url) => {
    if (url.includes('grant_type=refresh_token') && refused) return reply({ code: 400, error_code: 'session_expired', msg: 'x' }, 400);
    return url.includes('/token?') ? reply(f.session()) : reply({ token: f.token() });
  });
  await a.callback({ code: 'fake-code', state: f.state(a) });
  refused = true;
  f.advance(24 * 3600000);
  await a.refreshIfDue();
  assert.equal(a.state().signedIn, false);
  assert.match(a.state().error, /Sign in again/);
});

test('a timer and a click at the same moment spend the refresh token once', async (t) => {
  const f = fixture(t);
  let refreshes = 0;
  const a = f.make(async (url) => {
    if (url.includes('grant_type=refresh_token')) { refreshes++; await new Promise(setImmediate); return reply(f.session()); }
    return url.includes('/token?') ? reply(f.session()) : reply({ token: f.token() });
  });
  await a.callback({ code: 'fake-code', state: f.state(a) });
  f.advance(24 * 3600000);
  await Promise.all([a.refreshIfDue(), a.refreshPlan()]);
  assert.equal(refreshes, 1);
});

test('a background check stopped by sign-out does not block the next sign-in plan', async (t) => {
  const f = fixture(t);
  let hold = false; let release;
  const a = f.make(async (url) => {
    if (url.includes('/token?')) return reply(f.session());
    if (hold) { hold = false; return new Promise((resolve) => { release = resolve; }); }
    return reply({ token: f.token() });
  });
  await a.callback({ code: 'fake-code', state: f.state(a) });
  hold = true;
  f.advance(24 * 3600000);
  const background = a.refreshIfDue();
  await new Promise(setImmediate);
  assert.equal(typeof release, 'function', 'the background check should be in flight');
  a.signOut();
  await a.callback({ code: 'fake-code', state: f.state(a) });
  assert.equal(f.entitlements.can('scheduled_tasks'), true);
  release(reply({ token: f.token() }));
  await background;
  assert.equal(a.state().signedIn, true);
  assert.equal(a.state().error, '');
});
