// Desktop-app extras (native folder picker, updates, About) and the first-run setup.
// Works in the browser too; desktop-only parts appear when window.agentscircleDesktop exists.
// Uses globals from index.html: api, esc, $, openSettings, loadSessions, openSession.

const desk = window.agentscircleDesktop || null;
// macOS desktop app: leave room for the window buttons, which sit inside the sidebar.
if (desk && /Mac/.test(navigator.platform)) document.body.classList.add('mac-desktop');

// ---------- native folder picker ----------
function addPickButton(inputId) {
  if (!desk) return;
  const input = $(inputId);
  if (!input || input.dataset.picker) return;
  input.dataset.picker = '1';
  const wrap = document.createElement('div');
  wrap.className = 'row'; wrap.style.alignItems = 'center';
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);
  const b = document.createElement('button');
  b.type = 'button'; b.textContent = 'Choose…';
  b.onclick = async () => { const p = await desk.pickFolder(); if (p) { input.value = p; input.dispatchEvent(new Event('input')); } };
  wrap.appendChild(b);
}
addPickButton('fFolder');
if (desk) {
  const hint = $('fFolder').closest('.card').querySelector('.hint');
  if (hint && /Copy as Pathname/.test(hint.textContent)) hint.textContent = 'Click Choose… to pick the folder, or paste its full path.';
  desk.onOpenSettings((tab) => openSettings(tab));
  desk.onNewSession(() => $('newBtn').click());
  if (desk.onToggleSidebar) desk.onToggleSidebar(() => setSidebar(!look.sidebar));
  if (desk.onTogglePanel) desk.onTogglePanel(() => { if (typeof openPanel === 'function' && current) (document.body.classList.contains('panel-open') ? closePanel() : openPanel()); });
  desk.onUpdate((s) => { announceUpdate(s); if ($('setAbout') && $('setAbout').style.display !== 'none') loadAbout(); });
}

// ---------- new-release popup ----------
// Tells the user once per version when a release is found, and again when it is ready to install.
let lastUpdatePopup = '';
async function announceUpdate(s) {
  if (!s.version || !['downloading', 'ready'].includes(s.status)) return;
  const key = `${s.status}:${s.version}`;
  if (key === lastUpdatePopup) return;
  lastUpdatePopup = key;
  // Wait until the first-run setup or another dialog is closed, so the popup isn't hidden behind it.
  while ($('gate').classList.contains('open') || $('setupModal').classList.contains('open') || $('askModal').classList.contains('open')) await new Promise((ok) => setTimeout(ok, 3000));
  if (s.status === 'downloading') {
    await askConfirm({ title: `AgentsCircle ${s.version} is available`, body: 'It is downloading now. You will be asked to restart when it is ready. Your sessions, accounts and connectors are kept.', ok: 'OK' });
    return;
  }
  const restart = await askConfirm({ title: `AgentsCircle ${s.version} is ready`, body: 'Restart now to install the new version. If you don\'t, it installs the next time you quit.', ok: 'Restart now' });
  if (restart) desk.installUpdate();
}

// ---------- Settings → About ----------
const UPDATE_TEXT = { idle: 'Not checked yet.', checking: 'Checking for updates…', downloading: 'Downloading the new version…', 'up-to-date': 'You have the latest version.', ready: 'The new version is ready.', error: 'Couldn\'t check for updates.', dev: 'Updates are off while running from source.' };
// Setup status, always reachable (the first-run screen only shows once). Same facts, plus the fix for each row.
function setupStatusHtml(st, list) {
  const isWin = navigator.platform.toLowerCase().startsWith('win');
  const row = (a) => {
    const cmd = a.install ? (isWin ? a.install.ps : a.install.sh) : '';
    const acct = list.find((x) => x.tool === a.tool && x.canSignIn);
    let status = '', fix = '';
    if (!a.installed) {
      status = '<span class="pill warn">not installed</span>';
      fix = cmd ? `Install: <code>${esc(cmd)}</code>${a.install.docs ? ` · <a href="${esc(a.install.docs)}" target="_blank">install guide</a>` : ''}` : 'Install it from the tool\'s website.';
    } else if (a.signedIn) {
      status = '<span class="pill ok">ready</span>';
    } else if (a.checking) {
      status = '<span class="pill">checking…</span>';
    } else {
      status = a.problemState === 'signedout' ? '<span class="pill bad">signed out</span>' : a.problem ? '<span class="pill bad">not working</span>' : '<span class="pill">installed</span>';
      fix = a.problem ? esc(a.problem) : 'Sign in once so AgentsCircle can use it.';
      if (acct) fix += ` <button data-status-login="${esc(acct.id)}" style="padding:2px 8px;font-size:12px;margin-left:6px">Sign in</button>`;
    }
    return `<div class="setuprow"><i class="dot" style="background:${a.color}"></i><div class="grow"><b>${esc(a.name)}</b> ${status}${fix ? `<div class="hint" style="margin:3px 0 0">${fix}</div>` : ''}</div></div>`;
  };
  return `<div class="psec">Setup status</div>
    <div class="upbox">
      ${st.agents.map(row).join('')}
      <div class="setuprow"><i class="dot" style="background:var(--muted)"></i><div class="grow"><b>git</b> ${st.git ? '<span class="pill ok">ready</span>' : '<span class="pill warn">not found</span>'}${st.git ? '' : '<div class="hint" style="margin:3px 0 0">Install from git-scm.com. Needed for undo, change review and parallel branches.</div>'}</div></div>
      <div style="display:flex;justify-content:flex-end;margin-top:8px"><button id="statusRescan" style="padding:4px 10px;font-size:12px">Check again</button></div>
      <div class="hint">Agent CLI updates aren't tracked here. A fix for an agent's changed behaviour arrives through the automatic fixes below; the app's own update is under Updates.</div>
    </div>`;
}

// ---------- account ----------
const PLAN_NAMES = { free: 'Free', pro: 'Pro', teams: 'Teams' };
const acctName = (a) => a.user.name || a.user.email || 'Your account';
const acctTile = (a, cls = '') => `<span class="tile ${cls}">${esc(acctName(a).slice(0, 2).toUpperCase())}</span>`;

// Opens the browser and waits for the local callback. Shared by the welcome screen and Settings → Account and plan.
let signInWait = null;
const stopSignIn = () => { clearInterval(signInWait); signInWait = null; };
async function startSignIn(onDone) {
  stopSignIn();
  const { url } = await api('/api/account/signin', { method: 'POST', body: { provider: 'github' } });
  window.open(url, '_blank');
  let n = 0;
  signInWait = setInterval(async () => {
    const a = await api('/api/account').catch(() => null);
    const timedOut = ++n > 300; // the server forgets a sign-in after 10 minutes
    if (!timedOut && !(a && (a.signedIn || a.error))) return;
    stopSignIn();
    if (a && a.signedIn && desk && desk.focusWindow) desk.focusWindow();
    syncAccountChip();
    onDone(timedOut ? { ...a, error: 'Sign-in timed out. Try again.' } : a);
  }, 2000);
  return url;
}

// Sidebar: who is signed in and on which plan, or a way to sign in. Always opens Settings → Account and plan.
async function syncAccountChip() {
  const a = await api('/api/account').catch(() => null);
  const on = !!(a && a.configured);
  $('accountFoot').style.display = on ? '' : 'none';
  document.querySelector('#setTabs [data-set="plan"]').style.display = on ? '' : 'none';
  if (!on) return;
  if (!a.signedIn) { $('accountBtn').innerHTML = `${ic('user')}<span class="acct-name">Sign in</span>`; return; }
  const p = await api('/api/plan').catch(() => ({ plan: 'free' }));
  $('accountBtn').innerHTML = `${acctTile(a, 'sm')}<span class="acct-name">${esc(acctName(a))}</span><span class="pill">${PLAN_NAMES[p.plan]}</span>`;
}
$('accountBtn').onclick = () => openSettings('plan');
window.addEventListener('focus', syncAccountChip);
syncAccountChip();

// Welcome screen before the app. Asked until the user chooses to continue without an account; never blocks the free app.
function openGate() {
  return new Promise((resolve) => {
    const g = $('gate');
    const close = () => { stopSignIn(); g.classList.remove('open'); g.innerHTML = ''; resolve(); };
    const shell = (inner) => { g.innerHTML = `<div class="gate-in"><div class="gate-brand">${logoMark()}AgentsCircle</div>${inner}</div>`; };
    const item = (t) => `<li>${ic('check')}<span>${t}</span></li>`;
    const choose = (error) => {
      shell(`<h1 id="gateTitle">Welcome to AgentsCircle</h1>
        <p class="lead">One chat for all your coding agents. Sign in if you want paid features, or start right away.</p>
        <div class="gate-opts">
          <div class="gate-opt"><h2>Use an account</h2>
            <ul>${item('Everything in the free app')}${item('Paid features when they launch: scheduled tasks, session sync and phone approvals')}${item('Your plan follows you to your other computers')}</ul>
            <button class="primary" id="gateIn">Sign in with GitHub</button></div>
          <div class="gate-opt"><h2>Stay without an account</h2>
            <ul>${item('Group chat, all your agents, approvals, undo and search')}${item('Free, with no time limit')}${item('Sign in later from the sidebar if you change your mind')}</ul>
            <button id="gateSkip">Continue without an account</button></div>
        </div>
        ${error ? `<div class="err" role="alert">${esc(error)}</div>` : ''}
        <p class="gate-foot">Either way, AgentsCircle doesn't receive your code, chats or agent logins. An account stores your email, name and plan.</p>`);
      $('gateIn').onclick = async () => {
        $('gateIn').disabled = true;
        try { waiting(await startSignIn((a) => (a && a.signedIn ? signedIn(a) : choose((a && a.error) || 'Sign-in did not finish. Try again.')))); }
        catch (e) { choose(e.message); }
      };
      $('gateSkip').onclick = () => { api('/api/app/settings', { method: 'PATCH', body: { accountSkipped: true } }).catch(() => {}); close(); };
      $('gateIn').focus();
    };
    const waiting = (url) => {
      shell(`<h1 id="gateTitle">Finish signing in in your browser</h1>
        <p class="lead">GitHub opened in your browser. This screen moves on by itself when you're done.</p>
        <div class="gate-actions"><button id="gateAgain">Open the browser again</button><button class="ghost" id="gateBack">Back</button></div>`);
      $('gateAgain').onclick = () => window.open(url, '_blank');
      $('gateBack').onclick = () => { stopSignIn(); choose(); };
      $('gateAgain').focus();
    };
    const signedIn = async (a) => {
      const p = await api('/api/plan').catch(() => ({ plan: 'free' }));
      shell(`<h1 id="gateTitle">You're signed in as ${esc(acctName(a))}</h1>
        <p class="lead">You're on the ${PLAN_NAMES[p.plan]} plan. The app works the same as it does without an account. Your plan and the paid features as they launch are in Settings → Account and plan.</p>
        ${a.error ? `<div class="err" role="alert">${esc(a.error)}</div>` : ''}
        <div class="gate-actions"><button class="primary" id="gateGo">Continue</button></div>`);
      $('gateGo').onclick = close;
      $('gateGo').focus();
    };
    choose();
    g.classList.add('open');
  });
}

// Settings → Account and plan.
const PLAN_ROWS = [
  ['Group chat, all agents, approvals, undo and local search', 'free'],
  ['Scheduled and recurring tasks', 'pro'], ['Sync sessions between computers', 'pro'], ['Approve from your phone', 'pro'], ['Agents that run in the cloud', 'pro'],
  ['Shared live sessions', 'teams'], ['Shared connector and skill library', 'teams'], ['Team usage and cost dashboard', 'teams'], ['Admin rules, roles and audit log', 'teams'],
];
function planTableHtml(current) {
  const levels = ['free', 'pro', 'teams'];
  const here = (l) => (l === current ? ' here' : '');
  const price = { free: '$0', pro: '$8 / month', teams: '$13 / seat / month' };
  return `<table class="plantable">
    <thead><tr><th></th>${levels.map((l) => `<th class="col${here(l)}"><b>${PLAN_NAMES[l]}</b><span>${price[l]}</span></th>`).join('')}</tr></thead>
    <tbody>${PLAN_ROWS.map(([label, min]) => `<tr><td>${label}</td>${levels.map((l) => (levels.indexOf(l) >= levels.indexOf(min) ? `<td class="col${here(l)}">${ic('check')}</td>` : `<td class="col none${here(l)}">–</td>`)).join('')}</tr>`).join('')}</tbody>
  </table>`;
}
function planStatusText(p) {
  if (p.reason === 'offline-grace-over') return 'Your plan could not be checked for 14 days, so the app is on Free until it can reconnect.';
  if (p.reason === 'past-due-over') return 'The last payment failed and the grace period is over, so the app is on Free. Nothing was deleted.';
  if (p.status === 'past_due') return `The last payment failed. Paid features stay on until ${new Date(p.graceEndsAt).toLocaleDateString()}.`;
  return p.verifiedAt ? `Last checked ${new Date(p.verifiedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}. AgentsCircle checks by itself once a day.` : 'Not checked yet.';
}
async function loadPlanPane() {
  const pane = $('setPlan');
  const [a, p] = await Promise.all([api('/api/account'), api('/api/plan')]);
  const plan = a.signedIn ? p.plan : 'free';
  const who = a.signedIn
    ? `<div class="upbox"><div class="acct-who">${acctTile(a, 'lg')}<div class="grow"><b>${esc(acctName(a))}</b>${a.user.name && a.user.email ? `<span class="hint">${esc(a.user.email)}</span>` : ''}</div><button id="acctOut">Sign out</button></div>
        ${a.keychain ? '' : '<div class="hint">The sign-in is kept for this run only.</div>'}${a.error ? `<div class="err">${esc(a.error)}</div>` : ''}</div>
       <div class="psec">Your plan</div>
       <div class="upbox"><div class="plan-now">${PLAN_NAMES[plan]}${p.founding ? '<span class="pill ok">Founding</span>' : ''}</div>
        <div class="hint">${esc(planStatusText(p))}</div>
        <div style="margin-top:8px"><button id="acctRefresh" style="padding:4px 10px;font-size:12px">Check now</button></div></div>`
    : `<div class="upbox"><div>You're using AgentsCircle without an account. Nothing in the free app needs one.</div>
        <div class="hint">Sign in to use paid features when they launch. AgentsCircle doesn't receive your code, chats or agent logins; an account stores your email, name and plan.</div>
        <div style="display:flex;gap:6px;margin-top:10px"><button class="primary" id="acctGithub">Sign in with GitHub</button><button id="acctAgain" style="display:none">Open the browser again</button></div>
        <div id="acctMsg" class="hint" role="status"></div>${a.error ? `<div class="err">${esc(a.error)}</div>` : ''}</div>`;
  pane.innerHTML = `<h4>Account and plan</h4><p class="lead">Everything is managed here in the app. There's no web account yet.</p>
    ${who}
    <div class="psec">Plans</div>
    <div class="hint" style="margin:0 0 8px">Paid plans aren't on sale yet, and the Pro and Teams features are still being built. Founding prices are shown: Pro is limited to the first 100 accounts and locked for life while active; Teams needs at least 3 seats. Regular price after launch: Pro $15 / month, Teams $25 / seat / month. <a href="https://agentscircle.dev/roadmap" target="_blank">See the roadmap</a></div>
    <div class="upbox" style="padding:6px">${planTableHtml(plan)}</div>
    <div class="psec">Usage</div>
    <div class="upbox"><div>Agent usage belongs to each agent's own plan, so it's shown per account. Each session's turns, tokens and cost are in its Used tab.</div>
      <div style="margin-top:8px"><button id="acctUsage" style="padding:4px 10px;font-size:12px">See usage per account</button></div></div>`;
  $('acctUsage').onclick = () => setSettingsTab('accounts');
  if ($('acctOut')) $('acctOut').onclick = async () => { await api('/api/account/signout', { method: 'POST' }); syncAccountChip(); loadPlanPane(); };
  if ($('acctRefresh')) $('acctRefresh').onclick = async () => { $('acctRefresh').disabled = true; await api('/api/account/refresh', { method: 'POST' }).catch(() => {}); syncAccountChip(); loadPlanPane(); };
  if ($('acctGithub')) $('acctGithub').onclick = async () => {
    try {
      const url = await startSignIn(() => loadPlanPane());
      $('acctMsg').textContent = 'Finish signing in in your browser. This updates when you are done.';
      $('acctAgain').style.display = '';
      $('acctAgain').onclick = () => window.open(url, '_blank');
    } catch (e) { $('acctMsg').textContent = e.message; }
  };
}
async function loadAbout() {
  const pane = $('setAbout');
  const info = await api('/api/app');
  if (typeof loadUsageCounts === 'function') await loadUsageCounts();
  const d = desk ? await desk.appInfo() : null;
  const u = d ? d.update : null;
  const statusHtml = setupStatusHtml(await api('/api/setup'), await api('/api/agents'));
  pane.innerHTML = `
    <h4>About</h4><p class="lead">Version, updates and where your data lives.</p>
    <div class="upbox"><div class="h" style="font-size:16px;font-weight:650;display:flex;align-items:center;gap:10px">${logoMark()}<span style="font:600 19px/1 var(--font-cond)">AgentsCircle</span><span class="pill">${esc(info.version)}</span></div>
      <div class="hint" style="margin:4px 0 0">${info.desktop ? 'Desktop app' : 'Running in your browser (from a terminal)'} · ${esc(info.platform)}</div></div>
    ${d ? `<div class="psec">Updates</div>
      <div class="upbox">
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <span>${esc(UPDATE_TEXT[u.status] || u.status)}${u.status === 'downloading' && u.progress != null ? ` ${u.progress}%` : ''}${u.version && ['downloading', 'ready'].includes(u.status) ? ` (version ${esc(u.version)})` : ''}</span>
          <span style="flex:1"></span>
          ${u.status === 'ready' ? '<button class="primary" id="upInstall">Restart to update</button>' : `<button id="upCheck" ${d.packaged ? '' : 'disabled'}>Check now</button>`}
        </div>
        ${u.error ? `<div class="err">${esc(u.error)}</div>` : ''}
        <label>Update channel</label>
        <select id="upChannel" class="sel" style="width:auto"><option value="stable" ${d.channel === 'stable' ? 'selected' : ''}>Stable (recommended)</option><option value="beta" ${d.channel === 'beta' ? 'selected' : ''}>Beta: new features first, may have rough edges</option></select>
        <div class="hint">Updates download in the background and install when you restart AgentsCircle. Your sessions, accounts and connectors are kept.</div>
      </div>` : '<div class="hint">Automatic updates are part of the desktop app. Running from a terminal, update by downloading the latest version.</div>'}
    ${statusHtml}
    <div class="psec">Agent settings</div>
    <div class="upbox">
      <div>How AgentsCircle runs each agent: revision ${info.tools.revision} (${info.tools.source === 'update' ? 'updated fix' : 'built in'}).</div>
      <div class="hint">${info.tools.remoteEnabled ? `If an agent changes how it works, AgentsCircle downloads a signed fix automatically. ${info.tools.lastCheck ? `Last check: ${esc(info.tools.lastCheck.result)}${info.tools.lastCheck.error ? ' (' + esc(info.tools.lastCheck.error) + ')' : ''}.` : ''}` : 'Automatic fixes aren\'t set up in this build.'}</div>
      ${info.tools.remoteEnabled ? '<button id="toolsCheck" style="margin-top:8px;padding:4px 10px;font-size:12px">Check for fixes</button>' : ''}
    </div>
    ${typeof usageCountsHtml === 'function' ? usageCountsHtml() : ''}
    <div class="psec">Your data</div>
    <div class="upbox"><div class="hint" style="margin:0">Sessions, accounts, connectors and skills are in <code>${esc(info.dataDir)}</code> (data format ${info.dataVersion}). Updates never delete them; a backup is made before any format upgrade. ${info.secrets && info.secrets !== 'file' ? `API keys and connector tokens are encrypted with your ${esc(info.secrets)}.` : 'API keys and connector tokens are in files only you can read (the desktop app keeps them in your keychain instead).'}</div>
      ${d ? '<div style="display:flex;gap:6px;margin-top:8px"><button id="openData" style="padding:4px 10px;font-size:12px">Open data folder</button><button id="openLogs" style="padding:4px 10px;font-size:12px">Open logs folder</button></div>' : ''}</div>
    <div style="margin-top:10px"><button id="rerunSetup" style="padding:4px 10px;font-size:12px">Run first-time setup again</button></div>`;
  if ($('upCheck')) $('upCheck').onclick = async () => { $('upCheck').disabled = true; await desk.checkUpdates(); loadAbout(); };
  if ($('upInstall')) $('upInstall').onclick = () => desk.installUpdate();
  if ($('upChannel')) $('upChannel').onchange = async () => { await desk.setChannel($('upChannel').value); api('/api/app/settings', { method: 'PATCH', body: { updateChannel: $('upChannel').value } }).catch(() => {}); loadAbout(); };
  if ($('toolsCheck')) $('toolsCheck').onclick = async () => { $('toolsCheck').disabled = true; await api('/api/app/check-tools', { method: 'POST' }); loadAbout(); };
  if ($('statusRescan')) $('statusRescan').onclick = async () => { $('statusRescan').disabled = true; await api('/api/setup/rescan', { method: 'POST' }); agents = await api('/api/agents'); loadAbout(); };
  pane.querySelectorAll('[data-status-login]').forEach((b) => { b.onclick = () => openSignin(b.dataset.statusLogin, { onDone: loadAbout }); });
  if ($('openData')) $('openData').onclick = () => desk.openPath('data');
  if ($('openLogs')) $('openLogs').onclick = () => desk.openPath('logs');
  if (typeof wireUsageCounts === 'function') wireUsageCounts(loadAbout);
  $('rerunSetup').onclick = () => { $('acctModal').classList.remove('open'); openSetup(); };
}

// ---------- first-run setup ----------
async function openSetup(state) {
  state = state || await api('/api/setup');
  const card = $('setupCard');
  const isWin = navigator.platform.toLowerCase().startsWith('win');
  const anyInstalled = state.agents.some((a) => a.installed);
  const agentRow = (a) => {
    const cmd = a.install ? (isWin ? a.install.ps : a.install.sh) : '';
    const status = !a.installed ? '<span class="pill warn">not installed</span>' : a.signedIn ? '<span class="pill ok">ready</span>' : a.checking ? '<span class="pill">checking…</span>' : a.problemState === 'signedout' ? '<span class="pill bad">signed out</span>' : a.problem ? '<span class="pill bad">not working</span>' : '<span class="pill">installed</span>';
    return `<div class="setuprow"><i class="dot" style="background:${a.color}"></i><div class="grow"><b>${esc(a.name)}</b> ${status}
      ${!a.installed && cmd ? `<div class="hint" style="margin:3px 0 0"><code>${esc(cmd)}</code>${(a.install.needsNode || (a.install.needsNodeOnWindows && isWin)) && !state.node ? ' · needs Node.js first (nodejs.org)' : ''}</div>` : a.installed ? `<div class="hint" style="margin:3px 0 0">${a.agents.map((x) => '@' + esc(x)).join(', ') || 'No agent yet'}${a.signedIn ? ' · signed in and working' : a.problem ? ' · ' + esc(a.problem) : a.checking ? '' : ' · sign in once so AgentsCircle can use it'}</div>` : ''}</div>
      <div class="btns">${!a.installed && cmd ? `<button data-install="${a.tool}">Install</button>` : ''}${a.installed && !a.signedIn && a.agents[0] ? `<button data-login="${esc(a.agents[0])}">Sign in</button>` : ''}</div></div>`;
  };
  card.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">${logoMark()}<h3 style="margin:0">Welcome to AgentsCircle</h3></div>
    <div class="hint" style="margin:0 0 14px">One chat for all your coding agents. Two quick steps and you're in.</div>
    <div class="psec" style="margin-top:0"><span class="stepnum">1</span>Your agents</div>
    <div class="hint" style="margin:-4px 0 8px">Install the ones you use and sign in once. Installing opens a terminal window with the official installer.</div>
    ${state.agents.map(agentRow).join('')}
    <div class="setuprow"><i class="dot" style="background:var(--muted)"></i><div class="grow"><b>git</b> ${state.git ? '<span class="pill ok">ready</span>' : '<span class="pill warn">not found</span>'}<div class="hint" style="margin:3px 0 0">Needed for undo, change review and parallel branches.</div></div><div class="btns">${state.git ? '' : '<button data-install="git">Install</button>'}</div></div>
    <div style="display:flex;justify-content:flex-end;margin-bottom:6px"><button id="setupRescan">Check again</button></div>
    <div class="notice" id="setupNotice"></div>
    <div class="psec"><span class="stepnum">2</span>Your first project</div>
    <label style="margin-top:0">Project folder</label><input id="setupFolder" placeholder="/Users/you/projects/my-app">
    <div class="err" id="setupErr"></div>
    <div class="actions"><button id="setupSkip">Skip for now</button><button class="primary" id="setupGo" ${anyInstalled ? '' : 'disabled title="Install at least one agent first"'}>Start</button></div>`;
  addPickButton('setupFolder');
  $('setupModal').classList.add('open');
  if (state.agents.some((a) => a.checking) && !openSetup.checked) {
    openSetup.checked = true;
    api('/api/setup/rescan', { method: 'POST' }).then(async (st) => { if (!$('setupModal').classList.contains('open')) return; const folder = $('setupFolder').value; agents = await api('/api/agents'); await openSetup(st); $('setupFolder').value = folder; }).catch(() => {});
  }
  const note = (h) => { $('setupNotice').innerHTML = h; $('setupNotice').style.display = 'block'; };
  card.querySelectorAll('[data-install]').forEach((b) => b.onclick = async () => {
    try { const r = await api('/api/setup/install', { method: 'POST', body: { tool: b.dataset.install } }); note(`A terminal window opened with the installer. When it finishes, click <b>Check again</b>.<div class="hint" style="margin-top:6px">No window? Run this yourself: <code>${esc(r.command)}</code>${r.docs ? ` · <a href="${esc(r.docs)}" target="_blank">install guide</a>` : ''}</div>`); }
    catch (e) { note(`<span class="err">${esc(e.message)}</span>`); }
  });
  card.querySelectorAll('[data-login]').forEach((b) => b.onclick = async () => {
    try {
      const id = b.dataset.login;
      const ag = (await api('/api/agents')).find((x) => x.id === id);
      if (ag && ag.canSignIn) { openSignin(id, { onDone: async () => { const folder = $('setupFolder') ? $('setupFolder').value : ''; await openSetup(); if ($('setupFolder')) $('setupFolder').value = folder; } }); return; }
      const r = await api(`/api/agents/${id}/login`, { method: 'POST' });
      note(`A Terminal window opened to sign in. ${esc(r.hint || '')} AgentsCircle checks every few seconds and marks it ready when it works.`);
      // Keep checking until the sign-in works, then refresh this screen.
      let tries = 0;
      const t = setInterval(async () => {
        tries++;
        let h; try { h = (await api(`/api/agents/${id}/verify`, { method: 'POST' })).health; } catch { return; }
        if (h.state === 'ok' || tries >= 16 || !['signedout', 'missing'].includes(h.state)) {
          clearInterval(t);
          const folder = $('setupFolder') ? $('setupFolder').value : '';
          await openSetup(); if ($('setupFolder')) $('setupFolder').value = folder;
          note(h.state === 'ok' ? `<b>@${esc(id)} is signed in and working.</b>` : `<b>@${esc(id)} still isn't working:</b> ${esc(h.message)}`);
        }
      }, 12000);
    }
    catch (e) { note(`<span class="err">${esc(e.message)}</span>`); }
  });
  $('setupRescan').onclick = async () => { $('setupRescan').textContent = 'Checking…'; const folder = $('setupFolder').value; const st = await api('/api/setup/rescan', { method: 'POST' }); agents = await api('/api/agents'); await openSetup(st); $('setupFolder').value = folder; };
  $('setupSkip').onclick = async () => { await api('/api/app/settings', { method: 'PATCH', body: { onboarded: true } }); $('setupModal').classList.remove('open'); if (typeof maybeAskUsageCounts === 'function') setTimeout(maybeAskUsageCounts, 3000); };
  $('setupGo').onclick = async () => {
    $('setupErr').textContent = '';
    const folder = $('setupFolder').value.trim().replace(/^["']|["']$/g, '');
    if (!folder) { $('setupErr').textContent = 'Choose the folder of a project you want the agents to work on.'; return; }
    try {
      const members = (await api('/api/agents')).filter((a) => a.installed && !a.separateLogin).map((a) => a.id);
      const s = await api('/api/sessions', { method: 'POST', body: { folder, members } });
      await api('/api/app/settings', { method: 'PATCH', body: { onboarded: true } });
      $('setupModal').classList.remove('open');
      await loadSessions(); openSession(s.id);
    } catch (e) { $('setupErr').textContent = e.message; }
  };
}

// On launch: the account choice, then setup if it hasn't run.
(async () => {
  try {
    const a = await api('/api/account').catch(() => null);
    if (a && a.configured && !a.signedIn && !a.skipped) await openGate();
    const st = await api('/api/setup');
    if (!st.onboarded) openSetup(st);
    else if (typeof maybeAskUsageCounts === 'function') setTimeout(maybeAskUsageCounts, 4000);
  } catch { /* server not ready */ }
})();
