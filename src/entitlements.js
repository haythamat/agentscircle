// Entitlements: one function, can(feature), decides what the signed-in plan allows.
// The free app never needs this: every local feature is in FREE and works signed out.
// A plan token comes from the server (signed with ed25519), is cached on disk, and keeps working
// offline for 14 days after it was last verified. Off by default: behind the `entitlements` setting.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DAY = 86400000;
const OFFLINE_GRACE_DAYS = 14; // the server signs expiresAt = issuedAt + this; the app never extends it
const CLOCK_SKEW = 5 * 60000; // tolerated clock difference for an issuedAt that is slightly in the future
const OK_STATUS = new Set(['active', 'trialing', 'past_due']); // anything else fails closed
const PAST_DUE_GRACE_DAYS = 7; // server side: how long a failed payment keeps full access

// Everything local stays free. Paid features are the ones that need a server or are Pro-only.
const FREE = new Set(['chat', 'handoffs', 'files', 'import', 'edit_by_prompt', 'parallel_mode', 'setup_status']);
const PRO = new Set(['scheduled_tasks', 'cloud_sync', 'phone_approvals', 'cloud_agents']);
const TEAMS = new Set(['shared_sessions', 'team_dashboard', 'audit_log', 'admin_rules']);
const ORDER = ['free', 'pro', 'teams'];

function decode(token, publicKey) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig || !publicKey) return null;
  try {
    const key = crypto.createPublicKey(publicKey);
    if (!crypto.verify(null, Buffer.from(body), key, Buffer.from(sig, 'base64url'))) return null;
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return p && typeof p === 'object' ? p : null;
  } catch { return null; }
}

module.exports = function createEntitlements({ dataDir, settings, publicKey = '', now = () => Date.now() }) {
  const file = path.join(dataDir, 'plan.json');
  let cached = null; // { token }
  try { cached = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* signed out */ }
  if (!cached || typeof cached !== 'object' || typeof cached.token !== 'string') cached = null;

  // Signed issuance and expiry are mandatory. Lifetime comes from the signed values only.
  const timed = (p) => Number.isFinite(p.issuedAt) && Number.isFinite(p.expiresAt) && p.expiresAt > p.issuedAt
    && p.expiresAt - p.issuedAt <= OFFLINE_GRACE_DAYS * DAY;

  const enabled = () => settings.get().entitlements === true;
  const save = () => { try { fs.writeFileSync(file, JSON.stringify(cached), { mode: 0o600 }); } catch { /* best effort */ } };

  // The plan the signed token grants right now, after grace rules. Anything doubtful is free.
  function status() {
    const free = { plan: 'free', reason: cached ? 'invalid' : 'signed-out', signedIn: false };
    if (!cached) return free;
    const p = decode(cached.token, publicKey);
    if (!p || !ORDER.includes(p.plan)) return free;
    const t = now();
    if (!timed(p) || !OK_STATUS.has(p.status)) return free;
    const out = { plan: p.plan, status: p.status, founding: !!p.founding, signedIn: true, verifiedAt: p.issuedAt, expiresAt: p.expiresAt };
    if (p.issuedAt > t + CLOCK_SKEW) return free;
    if (t > p.expiresAt) return { ...free, reason: 'offline-grace-over', signedIn: true };
    if (p.status === 'past_due' && t - (p.pastDueSince || 0) > PAST_DUE_GRACE_DAYS * DAY) return { ...free, reason: 'past-due-over', signedIn: true };
    if (p.status === 'past_due') out.graceEndsAt = (p.pastDueSince || t) + PAST_DUE_GRACE_DAYS * DAY;
    return out;
  }

  function can(feature) {
    if (FREE.has(feature)) return true;
    if (!enabled()) return false; // nothing paid ships until the flag is on
    const { plan } = status();
    if (PRO.has(feature)) return plan === 'pro' || plan === 'teams';
    if (TEAMS.has(feature)) return plan === 'teams';
    return false;
  }

  // Store a token from the server. Rejected unless signed, well-formed, unexpired and not older than the cached one.
  function setToken(token) {
    const p = decode(token, publicKey);
    if (!p || !ORDER.includes(p.plan) || !timed(p) || !OK_STATUS.has(p.status)) return false;
    if (now() > p.expiresAt || p.issuedAt > now() + CLOCK_SKEW) return false;
    const old = cached && decode(cached.token, publicKey);
    if (old && Number.isFinite(old.issuedAt) && p.issuedAt < old.issuedAt) return false; // never go back to an older token
    cached = { token };
    save();
    return true;
  }
  function clear() { cached = null; try { fs.unlinkSync(file); } catch { /* none */ } }

  // Local half of export / delete-my-data. The synced-cloud half arrives with the backend.
  function exportData() {
    return { exportedAt: new Date(now()).toISOString(), plan: status(), cloud: 'Nothing is synced yet; local sessions and files stay on this computer.' };
  }
  function deleteData() {
    clear();
    return { ok: true, local: 'Cached plan removed. Sessions and files on this computer were not touched.', cloud: 'Cloud deletion is not available yet (no sync backend).' };
  }

  return { can, status, setToken, clear, exportData, deleteData, enabled, features: { free: [...FREE], pro: [...PRO], teams: [...TEAMS] } };
};
