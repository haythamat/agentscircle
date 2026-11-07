// Entitlements: one function, can(feature), decides what the signed-in plan allows.
// The free app never needs this: every local feature is in FREE and works signed out.
// A plan token comes from the server (signed with ed25519), is cached on disk, and keeps working
// offline for 14 days after it was last verified. Off by default: behind the `entitlements` setting.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DAY = 86400000;
const OFFLINE_GRACE_DAYS = 14; // app side: how long a cached token is trusted without reaching the server
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
  let cached = null; // { token, verifiedAt }
  try { cached = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* signed out */ }

  const enabled = () => settings.get().entitlements === true;
  const save = () => { try { fs.writeFileSync(file, JSON.stringify(cached), { mode: 0o600 }); } catch { /* best effort */ } };

  // The plan the signed token grants right now, after grace rules. Anything doubtful is free.
  function status() {
    const free = { plan: 'free', reason: cached ? 'invalid' : 'signed-out', signedIn: false };
    if (!cached) return free;
    const p = decode(cached.token, publicKey);
    if (!p || !ORDER.includes(p.plan)) return free;
    const t = now();
    const out = { plan: p.plan, status: p.status || 'active', founding: !!p.founding, signedIn: true, verifiedAt: cached.verifiedAt };
    if (typeof p.expiresAt === 'number' && t > p.expiresAt) return { ...free, reason: 'expired', signedIn: true };
    if (t - cached.verifiedAt > OFFLINE_GRACE_DAYS * DAY) return { ...free, reason: 'offline-grace-over', signedIn: true };
    if (p.status === 'canceled') return { ...free, reason: 'canceled', signedIn: true };
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

  // Store a token from the server. Rejected unless the signature checks out.
  function setToken(token) {
    if (!decode(token, publicKey)) return false;
    cached = { token, verifiedAt: now() };
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
