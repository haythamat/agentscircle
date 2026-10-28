// New session from a GitHub repository: pick one of your repos (or paste a link), choose where
// to keep the copy, and AgentsCircle clones it before creating the session.
// Uses globals from index.html: $, api, esc, ic (icons.js), addPickButton (desktop.js).

let fSrc = 'local';
let ghRepos = null, ghState = null, ghPoll = null;
const ghIcon = (n) => (typeof ic === 'function' ? ic(n) : '');

function setSource(src) {
  fSrc = src;
  $('fSource').querySelectorAll('button').forEach((b) => { b.classList.toggle('on', b.dataset.src === src); b.setAttribute('aria-selected', b.dataset.src === src); });
  $('fLocal').style.display = src === 'local' ? '' : 'none';
  $('fGit').style.display = src === 'github' ? '' : 'none';
  $('fCreate').textContent = src === 'github' ? 'Download and create' : 'Create session';
  if (src === 'github') { loadGithub(); setTimeout(() => $('ghRepo').focus(), 50); }
}
$('fSource').querySelectorAll('button').forEach((b) => b.onclick = () => setSource(b.dataset.src));

function renderGhStatus() {
  const s = ghState;
  if (!s) return;
  if (s.signedIn) {
    $('ghStat').innerHTML = `${ghIcon('check')}<span>Signed in to GitHub as <b>${esc(s.user)}</b>. Your private repositories work too.</span>`;
  } else {
    $('ghStat').innerHTML = `<span class="sp">${s.gh ? 'Not signed in to GitHub.' : 'GitHub sign-in isn\'t set up on this computer.'} Public repositories work without it; private ones need it.</span><button id="ghSignin">Sign in to GitHub</button>`;
    $('ghSignin').onclick = signIn;
  }
}
async function loadGithub(force) {
  if (ghState && !force) { renderGhStatus(); return; }
  try { ghState = await api('/api/github/status'); } catch { ghState = { gh: false, signedIn: false }; }
  if (!$('ghParent').value) $('ghParent').value = ghState.projectsDir || '';
  renderGhStatus();
  if (ghState.signedIn && (!ghRepos || force)) {
    $('ghList').style.display = ''; $('ghList').innerHTML = '<div class="hint" style="padding:10px;margin:0">Loading your repositories…</div>';
    try { ghRepos = await api('/api/github/repos'); } catch (e) { ghRepos = []; }
    drawRepos();
  }
}
function drawRepos() {
  const list = $('ghList');
  if (!ghRepos || !ghRepos.length) { list.style.display = 'none'; return; }
  const q = $('ghRepo').value.trim().toLowerCase().replace(/^https?:\/\/(www\.)?github\.com\//, '');
  const shown = ghRepos.filter((r) => !q || r.full.toLowerCase().includes(q)).slice(0, 40);
  list.style.display = shown.length ? '' : 'none';
  list.innerHTML = shown.map((r) => `<div class="conv repo${$('ghRepo').value.trim() === r.full ? ' sel' : ''}" data-repo="${esc(r.full)}" style="grid-template-columns:1fr auto">
    <span class="t"><b>${esc(r.full)}</b>${r.private ? '<span class="lk">private</span>' : ''}${r.description ? `<span class="hint" style="margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(r.description)}</span>` : ''}</span>
    <span class="m">${typeof ago === 'function' ? ago(r.updatedAt) : ''}</span></div>`).join('');
  list.querySelectorAll('[data-repo]').forEach((el) => el.onclick = () => { $('ghRepo').value = el.dataset.repo; drawRepos(); });
}
$('ghRepo').addEventListener('input', drawRepos);

async function signIn() {
  try {
    const r = await api('/api/github/signin', { method: 'POST' });
    if (r.docs) { $('fErr').innerHTML = `${esc(r.message)} <a href="${esc(r.docs)}" target="_blank" rel="noopener">cli.github.com</a>`; return; }
    $('ghStat').innerHTML = '<span class="working mini" style="margin:0"><i></i></span><span>A Terminal window opened. Follow its steps to sign in; this updates by itself when you\'re done.</span>';
    clearInterval(ghPoll);
    let tries = 0;
    ghPoll = setInterval(async () => {
      tries++;
      let s; try { s = await api('/api/github/status'); } catch { return; }
      if (s.signedIn || tries > 60) { clearInterval(ghPoll); ghState = s; ghRepos = null; loadGithub(true); }
    }, 3000);
  } catch (e) { $('fErr').textContent = e.message; }
}

// Create: in GitHub mode, download first, then create the session in that folder.
const createLocal = $('fCreate').onclick;
$('fCreate').onclick = async () => {
  if (fSrc !== 'github') return createLocal();
  const repo = $('ghRepo').value.trim();
  if (!repo) { $('fErr').textContent = 'Choose a repository or paste its link.'; return; }
  $('fErr').textContent = '';
  const btn = $('fCreate'); btn.disabled = true; btn.textContent = 'Downloading…';
  try {
    const r = await api('/api/github/clone', { method: 'POST', body: { repo, parent: $('ghParent').value.trim() } });
    if (ghState && $('ghParent').value.trim() && $('ghParent').value.trim() !== ghState.projectsDir) {
      api('/api/app/settings', { method: 'PATCH', body: { projectsDir: $('ghParent').value.trim() } }).catch(() => {});
    }
    $('fFolder').value = r.folder;
    if (!$('fName').value.trim()) $('fName').value = r.repo.split('/')[1];
    await createLocal();
  } catch (e) {
    $('fErr').innerHTML = esc(e.message) + (/sign in/i.test(e.message) ? ' <button class="linkbtn" id="ghErrSignin">Sign in to GitHub</button>' : '');
    if ($('ghErrSignin')) $('ghErrSignin').onclick = signIn;
  } finally { btn.disabled = false; btn.textContent = fSrc === 'github' ? 'Download and create' : 'Create session'; }
};

// Each time the dialog opens, start on "Folder on this computer".
const openNewLocal = $('newBtn').onclick;
$('newBtn').onclick = () => { openNewLocal(); setSource('local'); $('ghRepo').value = ''; drawRepos(); };
if (typeof addPickButton === 'function') addPickButton('ghParent');
