// Opt-in, anonymous usage counts. Off unless you turn it on (the app asks once).
// Only counts of which features were used, per day, plus app version and OS, are sent, once a day.
// Never code, prompts, file or project names, emails or account details. The install id is random
// and made here; it isn't linked to you. Turning it off deletes what hasn't been sent yet.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// The only names that can ever be counted.
const KEYS = new Set([
  'app_started', 'session_created', 'session_deleted', 'message_sent', 'handoff', 'mode_parallel', 'branch_applied',
  'agent_claude', 'agent_codex', 'agent_cursor', 'agent_opencode', 'agent_other', 'agent_limit_switch',
  'model_changed', 'context_set', 'chat_imported', 'account_added', 'account_signin',
  'preview_html', 'preview_markdown', 'preview_pdf', 'preview_image', 'preview_doc', 'preview_sheet', 'preview_slides', 'preview_video', 'preview_audio', 'preview_text',
  'file_edited', 'export_docx', 'export_pdf', 'export_html', 'export_xlsx', 'export_csv', 'open_in_editor',
  'commit', 'commit_by_agent', 'push', 'push_by_agent', 'pull', 'publish_github', 'github_signin',
  'terminal_opened', 'connector_added', 'connector_signin', 'skill_added', 'undo', 'approval_answered', 'question_answered',
]);
const DAY = () => new Date().toISOString().slice(0, 10);

module.exports = function createUsageCounts({ dataDir, settings, version, url }) {
  const file = path.join(dataDir, 'usage-counts.json');
  let store = { days: {} };
  try { store = JSON.parse(fs.readFileSync(file, 'utf8')); if (!store.days) store = { days: {} }; } catch { /* first run */ }
  let dirty = false;
  const save = () => { if (!dirty) return; dirty = false; try { fs.writeFileSync(file, JSON.stringify(store)); } catch { /* best effort */ } };
  let timer = null;
  const later = () => { if (!timer) timer = setTimeout(() => { timer = null; save(); }, 2000); if (timer.unref) timer.unref(); };
  process.on('exit', save);

  const enabled = () => settings.get().usageCounts === true;

  function count(key, n = 1) {
    if (!enabled() || !KEYS.has(key)) return;
    const d = DAY();
    const day = (store.days[d] ||= {});
    day[key] = Math.min(100000, (day[key] || 0) + n);
    dirty = true; later();
  }

  function installId() {
    let id = settings.get().usageInstallId;
    if (!id) { id = crypto.randomUUID(); settings.set({ usageInstallId: id }); }
    return id;
  }

  // The exact report for a day: what Settings shows under "See what's sent".
  function report(day, preview) {
    return { install: preview && !settings.get().usageInstallId ? '(made when you turn this on)' : installId(), version, os: process.platform, arch: os.arch() === 'arm64' ? 'arm64' : 'x64', day, counts: { ...(store.days[day] || {}) } };
  }

  // Send finished days (not today) that haven't been sent; keep a week at most.
  async function flush() {
    save();
    if (!enabled() || !url) return;
    const today = DAY();
    const days = Object.keys(store.days).sort();
    for (const d of days) {
      if (d >= today) continue;
      if (Date.now() - Date.parse(d) > 8 * 86400000) { delete store.days[d]; dirty = true; continue; }
      if (!Object.keys(store.days[d]).length) { delete store.days[d]; dirty = true; continue; }
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report(d)), signal: AbortSignal.timeout(15000) });
        if (r.ok || (r.status >= 400 && r.status < 500 && r.status !== 429)) { delete store.days[d]; dirty = true; } // sent, or refused for good
      } catch { /* offline; try again later */ }
    }
    save();
  }
  setTimeout(() => flush().catch(() => {}), 60000).unref();
  setInterval(() => flush().catch(() => {}), 6 * 3600000).unref();

  function setEnabled(on) {
    settings.set({ usageCounts: !!on });
    if (!on) { store = { days: {} }; dirty = true; save(); }
    else count('app_started');
  }

  return {
    count, flush, setEnabled, enabled, keys: [...KEYS],
    state: () => ({ enabled: enabled(), asked: settings.get().usageCounts !== undefined && settings.get().usageCounts !== null, configured: !!url, today: report(DAY(), !enabled()) }),
  };
};
