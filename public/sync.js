// Push to GitHub from the Files tab: what's waiting to be pushed, Push / Pull, and putting a folder
// on GitHub the first time. Plus GitHub sign-in in the app (no Terminal).
// Uses globals from index.html / panel.js: $, api, esc, ic, current, renderPanel, panel.

const sync = { state: null, busy: '', err: '', errCode: '', publishOpen: false };

async function loadSync() {
  if (!current) return null;
  try { sync.state = await api(`/api/sessions/${current.id}/sync`); } catch { sync.state = null; }
  return sync.state;
}

function syncCardHtml() {
  const st = sync.state;
  if (!st || !st.repo) return '';
  const short = (u) => { const parts = String(u || '').replace(/\.git$/, '').split(/[/:]/).filter(Boolean); return parts.slice(-2).join('/') || u; };
  const where = st.web ? `<a href="${esc(st.web)}" target="_blank" rel="noopener">${esc(st.web.replace('https://github.com/', ''))}</a>` : `<span title="${esc(st.url || '')}">${esc(st.remote === 'origin' ? short(st.url) : st.remote || '')}</span>`;
  const err = sync.err ? `<div class="err" style="margin-top:6px">${esc(sync.err)}${sync.errCode === 'auth' ? ' <button class="linkbtn" data-sync="ghsignin">Sign in to GitHub</button>' : ''}${sync.errCode === 'behind' ? ' <button class="linkbtn" data-sync="pull">Pull now</button>' : ''}</div>` : '';
  const b = (act, label, primary) => `<button data-sync="${act}" class="${primary ? 'primary' : ''}" ${sync.busy ? 'disabled' : ''}>${sync.busy === act ? { push: 'Pushing…', pull: 'Pulling…', publish: 'Creating…' }[act] || '…' : label}</button>`;
  if (!st.remote) {
    if (!st.hasCommits) return `<div class="pcard syncbar"><div class="synch">${ic('branch', 'sm')}<span>Not on GitHub yet. Commit first, then you can put it on GitHub.</span></div></div>`;
    const name = (current.folder.split(/[\\/]/).filter(Boolean).pop() || 'project').replace(/[^A-Za-z0-9._-]+/g, '-');
    return `<div class="pcard syncbar"><div class="synch">${ic('branch', 'sm')}<span>This folder isn't on GitHub yet.</span><span style="flex:1"></span>${sync.publishOpen ? '' : b('openpublish', 'Put on GitHub')}</div>
      ${sync.publishOpen ? `<div class="pubform"><label for="pubName">Repository name</label><input id="pubName" value="${esc(name)}" spellcheck="false" autocomplete="off">
        <div class="seg pubvis"><button data-vis="private" class="on">Private</button><button data-vis="public">Public</button></div>
        <div class="cfbtns"><span class="hint" style="margin:0">Creates it on your GitHub account and pushes ${st.branch ? esc(st.branch) : 'this branch'}.</span><span style="flex:1"></span><button data-sync="closepublish">Cancel</button>${b('publish', 'Create and push', true)}</div></div>` : ''}${err}</div>`;
  }
  const pending = st.upstream ? st.ahead : st.ahead || 1;
  const line = !st.upstream
    ? `<b>${esc(st.branch)}</b> isn't on ${where} yet.`
    : st.ahead && st.behind ? `<b>${st.ahead}</b> to push and <b>${st.behind}</b> to pull · ${esc(st.branch)} ↔ ${where}`
    : st.ahead ? `<b>${st.ahead} commit${st.ahead > 1 ? 's' : ''}</b> to push · ${esc(st.branch)} → ${where}`
    : st.behind ? `<b>${st.behind} new commit${st.behind > 1 ? 's' : ''}</b> on ${where} · pull to get ${st.behind > 1 ? 'them' : 'it'}`
    : `${esc(st.branch)} is up to date with ${where}`;
  return `<div class="pcard syncbar"><div class="synch">${ic('branch', 'sm')}<span class="syncline">${line}</span><span style="flex:1"></span>
    ${st.behind ? b('pull', 'Pull', !pending) : ''}${pending ? b('push', 'Push', true) : ''}</div>${err}</div>`;
}

async function syncAct(act) {
  if (!current) return;
  if (act === 'ghsignin') return openGhSignin({ onDone: () => syncAct('push') });
  if (act === 'openpublish' || act === 'closepublish') { sync.publishOpen = act === 'openpublish'; sync.err = ''; renderPanel(true); if (sync.publishOpen) setTimeout(() => $('pubName') && $('pubName').select(), 30); return; }
  const body = act === 'publish' ? { name: $('pubName').value, public: !!document.querySelector('.pubvis [data-vis=public].on') } : undefined;
  sync.busy = act; sync.err = ''; sync.errCode = ''; renderPanel(true);
  try { sync.state = await api(`/api/sessions/${current.id}/${act}`, { method: 'POST', body }); sync.publishOpen = false; }
  catch (e) { sync.err = e.message; sync.errCode = e.code || (/sign in/i.test(e.message) ? 'auth' : ''); }
  sync.busy = '';
  await loadSync(); renderPanel(true);
}
document.addEventListener('click', (e) => {
  const s = e.target.closest('[data-sync]'); if (s) { e.preventDefault(); syncAct(s.dataset.sync); return; }
  const v = e.target.closest('.pubvis [data-vis]'); if (v) { document.querySelectorAll('.pubvis [data-vis]').forEach((x) => x.classList.toggle('on', x === v)); const go = document.querySelector('[data-sync=publish]'); if (go) go.textContent = 'Create and push'; }
});
function onSyncEvent(st) { sync.state = st; if (panel.tab === 'files' && !panel.file && document.body.classList.contains('panel-open') && !sync.busy) renderPanel(true); }

// ---------- GitHub sign-in in the app ----------
const gh = { opts: {}, flow: null };
const ghm = document.createElement('div');
ghm.className = 'modal'; ghm.id = 'ghModal'; ghm.setAttribute('role', 'dialog'); ghm.setAttribute('aria-modal', 'true');
ghm.innerHTML = `<div class="card" style="width:min(420px,94vw)"><h3 style="margin:0 0 4px;display:flex;gap:8px;align-items:center">${ic('branch')}Sign in to GitHub</h3><div id="ghBody"></div>
  <div class="actions"><button id="ghClose">Cancel</button><button id="ghOpen" class="primary" style="display:none">Open GitHub</button></div></div>`;
document.body.appendChild(ghm);
function drawGh() {
  const f = gh.flow || { state: 'starting' };
  const body = $('ghBody');
  if (f.state === 'waiting' && f.code) {
    body.innerHTML = `<p class="hint" style="margin:6px 0 12px">GitHub opened in your browser. Enter this code there, then approve access.</p>
      <div class="ghcode"><span id="ghCodeTxt">${esc(f.code)}</span><button class="ghost ib" id="ghCopy" data-tip="Copy code" aria-label="Copy code">${ic('copy', 'sm')}</button></div>
      <p class="hint" style="margin:10px 0 0">This window updates by itself when you're done.</p>`;
    $('ghCopy').onclick = () => copyText(f.code, $('ghCopy'));
  } else if (f.state === 'done') body.innerHTML = `<p style="margin:8px 0">${ic('check', 'sm')} ${esc(f.message || 'Signed in.')}</p>`;
  else if (f.state === 'failed' || f.state === 'needs-cli') body.innerHTML = `<p class="err" style="margin:8px 0">${esc(f.message || 'Sign-in failed.')}${f.docs ? ` <a href="${esc(f.docs)}" target="_blank" rel="noopener">cli.github.com</a>` : ''}</p>`;
  else body.innerHTML = `<p class="hint" style="margin:8px 0"><span class="working mini" style="margin:0 6px 0 0"><i></i></span>${esc(f.message || 'Starting…')}</p>`;
  $('ghOpen').style.display = f.state === 'waiting' ? '' : 'none';
  $('ghClose').textContent = ['done', 'failed', 'needs-cli'].includes(f.state) ? 'Close' : 'Cancel';
  $('ghClose').className = f.state === 'done' ? 'primary' : '';
}
async function openGhSignin(opts = {}) {
  gh.opts = opts; gh.flow = { state: 'starting', message: 'Starting GitHub sign-in…' };
  ghm.classList.add('open'); drawGh();
  try { gh.flow = await api('/api/github/signin-app', { method: 'POST' }); } catch (e) { gh.flow = { state: 'failed', message: e.message }; }
  if (gh.flow.state === 'waiting' && gh.flow.code) navigator.clipboard.writeText(gh.flow.code).catch(() => {});
  drawGh();
  if (gh.flow.state === 'done') ghDone();
}
function ghDone() { const cb = gh.opts.onDone; gh.opts = {}; if (cb) setTimeout(cb, 300); setTimeout(() => ghm.classList.remove('open'), 1200); }
function onGhSigninEvent(f) {
  if (!ghm.classList.contains('open') || !f) return;
  const was = gh.flow && gh.flow.state;
  gh.flow = f; drawGh();
  if (f.state === 'waiting' && was !== 'waiting' && f.code) navigator.clipboard.writeText(f.code).catch(() => {});
  if (f.state === 'done' && was !== 'done') ghDone();
}
$('ghOpen').onclick = () => { if (gh.flow && gh.flow.url) window.open(gh.flow.url, '_blank', 'noopener'); };
$('ghClose').onclick = () => { if (gh.flow && !['done', 'failed', 'needs-cli'].includes(gh.flow.state)) api('/api/github/signin-app/cancel', { method: 'POST' }).catch(() => {}); ghm.classList.remove('open'); gh.opts = {}; };
