// Session panel: Progress, Files and Used tabs beside the chat.
// Uses globals from index.html: current, agents, running, queue, api, esc, md, $, agentMap, acctText.

const panel = { tab: localStorage.getItem('agentscircle:tab') || 'progress', file: null, view: 'preview', timer: null, pending: false, drafts: new Map() };

const fmtDur = (sec) => sec == null ? '' : sec < 60 ? `${sec}s` : sec < 3600 ? `${Math.floor(sec / 60)}m ${sec % 60}s` : `${Math.floor(sec / 3600)}h ${Math.floor(sec / 60) % 60}m`;
const fmtNum = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n);
const fmtSize = (b) => b == null ? '' : b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`;
const baseName = (p) => p.split('/').pop();
const dirName = (p) => p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '';
const agentColor = (id) => (agentMap()[id] || {}).color || 'var(--muted)';
const KIND_ICON = { html: 'globe', markdown: 'fileText', image: 'image', pdf: 'file', text: 'fileCode', other: 'file' };
const STATUS_LABEL = { added: 'New', modified: 'Edited', deleted: 'Deleted' };

function turns() { return (current ? current.messages : []).filter((m) => m.role === 'agent'); }

// ---------- chips under each reply ----------
function filesHtml(m) {
  const files = m.files || [];
  if (!files.length && !(m.commits || []).length) return m.changes ? `<div class="changes">${esc(m.changes)}</div>` : '';
  const wt = m.workdir ? m.agent : '';
  const chips = files.slice(0, 12).map((f) => `<button class="fchip ${f.status}" data-path="${esc(f.path)}" data-wt="${esc(wt)}" title="${esc(STATUS_LABEL[f.status] + ': ' + f.path + (wt ? ` (on @${wt}'s branch)` : ''))}"><span class="dot"></span>${esc(baseName(f.path))}</button>`).join('');
  const more = files.length > 12 ? `<span class="hint" style="margin:0">+${files.length - 12} more</span>` : '';
  const commits = (m.commits || []).map((c) => `<div class="commit">${ic('commit', 'sm')} ${esc(c)}</div>`).join('');
  return `<div class="fchips">${chips}${more}</div>${commits}`;
}
document.addEventListener('click', (e) => {
  const chip = e.target.closest('.fchip[data-path]');
  if (chip) { openPanel('files'); openFile(chip.dataset.path, chip.dataset.wt || null); }
  const oe = e.target.closest('[data-openedit]');
  if (oe) { openPanel('files'); openFile(oe.dataset.openedit, oe.dataset.wt || null); return; }
  const turn = e.target.closest('[data-goto]');
  if (turn) { const el = $('m-' + turn.dataset.goto); if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1200); } }
});

// ---------- panel shell ----------
function openPanel(tab) {
  document.body.classList.add('panel-open');
  localStorage.setItem('agentscircle:panel', '1');
  if (tab) setTab(tab); else panelRefresh(true);
}
function closePanel() { document.body.classList.remove('panel-open'); localStorage.setItem('agentscircle:panel', '0'); }
function setTab(tab) {
  panel.tab = tab; localStorage.setItem('agentscircle:tab', tab);
  document.querySelectorAll('#panelTabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  if (tab !== 'files') panel.file = null;
  panelRefresh(true);
}
function panelReset() { panel.file = null; panelRefresh(true); }

let refreshQueued = false;
function panelRefresh(now) {
  if (!document.body.classList.contains('panel-open') || !current) return updateTabCounts();
  if (now) return renderPanel();
  if (refreshQueued) return;
  refreshQueued = true;
  setTimeout(() => { refreshQueued = false; renderPanel(); }, 250);
}

function updateTabCounts() {
  if (!current) return;
  const files = new Set(turns().flatMap((m) => (m.files || []).map((f) => f.path)));
  const fb = document.querySelector('#panelTabs [data-tab=files] .n');
  if (fb) fb.textContent = files.size ? files.size : '';
  const pb = document.querySelector('#panelTabs [data-tab=progress] .n');
  if (pb) pb.innerHTML = running.length ? '<span class="live"></span>' : '';
  const toggle = $('panelBtn');
  if (toggle) { toggle.innerHTML = ic(document.body.classList.contains('panel-bottom') ? 'panelBottom' : 'panel') + (running.length ? '<span class="live" style="position:absolute;top:5px;right:5px;width:6px;height:6px"></span>' : ''); toggle.style.position = 'relative'; toggle.classList.toggle('on', document.body.classList.contains('panel-open')); }
  const bt = document.querySelector('#panelTabs [data-tab=branches]');
  if (bt) bt.style.display = current.mode === 'parallel' || (current.worktrees && Object.keys(current.worktrees).length) ? '' : 'none';
}

function renderPanel() {
  updateTabCounts();
  const body = $('panelBody');
  if (panel.tab === 'progress') {
    flipBoard(() => { body.innerHTML = progressHtml(); });
    const b = $('sumNow');
    if (b) b.onclick = async () => { b.disabled = true; b.textContent = 'Summarizing…'; try { await api(`/api/sessions/${current.id}/summarize`, { method: 'POST' }); const s2 = await api(`/api/sessions/${current.id}`); current.summarized = s2.summarized; } catch (e) { alert(e.message); } renderPanel(); };
  }
  else if (panel.tab === 'files') {
    if (panel.turn) { const t = current.messages.find((x) => x.id === panel.turn); if (t && !!t.undone !== panel.turnUndone) openTurnReview(panel.turn); return; }
    if (panel.file) { if (panel.view === 'edit' && $('edText')) return; return renderFile(); } filesListHtml().then((h) => { if (panel.tab === 'files' && !panel.file) body.innerHTML = h; }); }
  else if (panel.tab === 'branches') { renderBranches(); }
  else {
    const meters = current.members.filter((id) => ['claude', 'codex'].includes((agents.find((a) => a.id === id) || {}).tool));
    body.innerHTML = (meters.length ? `<div class="psec" style="margin-top:0">Account usage</div><div class="pcard">${meters.map((id) => `<div style="margin-bottom:10px"><div style="display:flex;gap:7px;align-items:center;margin-bottom:4px">${tile(id, agentColor(id), 'sm')}<span class="handle">@${esc(id)}</span></div><div class="usage" data-usage="${esc(id)}"><span class="hint">…</span></div></div>`).join('')}</div>` : '') + usedHtml();
    fillCaps(); if (typeof fillUsage === 'function') fillUsage(body);
  }
  tickTimer();
}

// What each agent can use: its own skills/connectors plus what AgentsCircle shares.
let capCache = { id: null, at: 0, data: null };
async function fillCaps() {
  const box = $('capBox'); if (!box || !current) return;
  if (capCache.id !== current.id || Date.now() - capCache.at > 15000) {
    try { capCache = { id: current.id, at: Date.now(), data: await api(`/api/sessions/${current.id}/capabilities`) }; } catch { return; }
  }
  const box2 = $('capBox'); if (!box2) return;
  const tag = (x) => `<span class="tag" title="${x.source === 'shared' ? 'shared through AgentsCircle' : 'from its own setup' + (x.where ? ': ' + esc(x.where) : '')}">${esc(x.name)}${x.source === 'shared' ? ' <span style="color:var(--accent)">·shared</span>' : ''}</span>`;
  box2.innerHTML = Object.entries(capCache.data).map(([id, c]) => `<div class="urow" style="align-items:flex-start">${tile(id, agentColor(id), 'sm')}<div class="tmain"><span class="handle">@${esc(id)}</span> <span class="hint" style="margin:0">${esc(c.tool)}</span>
    <div class="hint" style="margin:4px 0 0">Connectors: ${c.connectors.length ? c.connectors.map(tag).join(' ') : 'none found'}</div>
    <div class="hint" style="margin:4px 0 0">Skills: ${c.skills.length ? c.skills.map(tag).join(' ') : 'none found'}</div></div></div>`).join('')
    + '<div class="hint">"shared" = given to every agent through AgentsCircle. Share more in Settings → Connectors and Skills.</div>';
}

// ---------- reviewing one turn's changes ----------
async function openTurnReview(mid) {
  openPanel('files');
  panel.file = null; panel.turn = mid;
  const m = current.messages.find((x) => x.id === mid);
  panel.turnUndone = !!m.undone;
  $('panelBody').innerHTML = '<div class="hint">Loading…</div>';
  try {
    const d = await api(`/api/sessions/${current.id}/turns/${mid}/diff`);
    const blocks = d.diff.split(/^(?=diff --git )/m).filter(Boolean);
    $('panelBody').innerHTML = `<div class="fhead"><button class="ghost ib" id="tBack" data-tip="All files">${ic('back')}</button><div class="fmain"><div class="fname" style="display:flex;gap:7px;align-items:center">${tile(m.agent, agentColor(m.agent), 'sm')}Changes by <span class="handle">@${esc(m.agent)}</span></div><div class="hint" style="margin:0">${esc(requestFor(m))}</div></div></div>
      <div class="hint" style="margin:10px 0">${d.files.length} file${d.files.length === 1 ? '' : 's'} · exactly what this turn changed, from its checkpoints${m.undone ? ' · <b style="color:var(--warn)">undone</b>' : ''}</div>
      ${d.files.map((f) => `<div class="frow" data-jump="${esc(f.path)}"><span class="fstat ${f.status}">${STATUS_LABEL[f.status]}</span><div class="fmain"><div class="fname">${esc(f.path)}</div></div></div>`).join('')}
      ${blocks.map((b) => { const name = (/^diff --git a\/(.+?) b\//.exec(b) || [])[1] || ''; return `<div class="psec" id="tf-${esc(name)}">${esc(name)}</div><div class="diff">${b.split('\n').map((l) => `<div class="dl ${l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : l.startsWith('@@') ? 'hunk' : ''}">${esc(l) || ' '}</div>`).join('')}</div>`; }).join('')}
      <div class="turnacts" style="margin-top:14px">${m.undone ? `<button data-redo="${m.id}">Bring back</button>` : `<button data-undo="${m.id}">Undo this turn</button>`}</div>`;
    $('tBack').onclick = () => { panel.turn = null; renderPanel(); };
    $('panelBody').querySelectorAll('[data-jump]').forEach((r) => r.onclick = (e) => { e.stopPropagation(); const el = document.getElementById('tf-' + r.dataset.jump); if (el) el.scrollIntoView({ behavior: 'smooth' }); });
  } catch (e) { $('panelBody').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}

// ---------- Progress ----------
function todoList(todos) {
  if (!todos || !todos.length) return '';
  const done = todos.filter((t) => t.status === 'completed').length;
  return `<div class="todos"><div class="todohead">Task list <span class="hint" style="margin:0">${done} of ${todos.length} done</span></div>
    <div class="bar"><i style="width:${Math.round((done / todos.length) * 100)}%"></i></div>
    ${todos.map((t) => `<div class="todo ${t.status}"><span class="box">${t.status === 'completed' ? ic('check') : ''}</span>${esc(t.content)}</div>`).join('')}</div>`;
}
function requestFor(m) {
  const u = current.messages.find((x) => x.id === m.replyTo);
  return u ? u.text.replace(/(^|\s)@[a-z0-9_-]+/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 90) : '';
}
// The board: every turn is a strip in a bay (Needs you, Working, Up next, Done).
function stripHtml(m, opts = {}) {
  const live = m.pending;
  const st = live ? (m.waiting ? 'waiting' : 'working') : m.undone ? 'undone' : m.status || (m.error ? 'error' : 'done');
  const nf = (m.files || []).length;
  const tools = (m.tools || []).filter((t) => t.name !== 'TodoWrite').length;
  const right = live
    ? `<span class="elapsed" data-start="${esc(m.startedAt || m.at)}"></span>${m.waiting ? `<span class="st waiting">${(m.questions || []).some((q) => q.status === 'pending') ? 'Question' : 'Approve'}</span>` : '<span class="st working">Working</span>'}`
    : `<span>${fmtDur(m.seconds)}</span><span>${[nf ? `${nf} file${nf > 1 ? 's' : ''}` : '', m.usage && m.usage.costUsd != null ? '$' + m.usage.costUsd.toFixed(2) : ''].filter(Boolean).join(' · ') || (st === 'done' ? '' : `<span class="st ${['signin', 'model'].includes(st) ? 'error' : st}">${{ signin: 'Signed out', model: 'Model refused', limited: 'Limit hit', timeout: 'Timed out', error: 'Error', stopped: 'Stopped', undone: 'Undone' }[st] || st}</span>`)}</span>`;
  const last = (m.activity || []).at(-1);
  return `<div class="strip${m.waiting ? ' needs' : ''}" data-key="${m.id}" data-goto="${m.id}" title="Jump to this reply">
    ${tile(m.agent, agentColor(m.agent))}
    <div class="s1"><span class="handle">@${esc(m.agent)}</span><span class="acct">${esc(m.account || '')}${m.model ? ' · ' + esc(m.model) : ''}${m.branch ? ' · own branch' : ''}</span></div>
    <div class="right">${right}</div>
    <div class="s2">${esc(requestFor(m) || (m.statusLine || ''))}</div>
    ${live && !m.waiting ? `<div class="step"><span class="spin"></span>${esc(last || 'Starting…')}${tools ? ` <span style="margin-left:auto">${tools} tools</span>` : ''}</div>` : ''}
    ${!live && m.statusLine ? `<div class="sline"><b>Status</b><span>${esc(m.statusLine)}</span></div>` : ''}
  </div>${live && opts.todos ? todoList(m.todos) : ''}`;
}
function progressHtml() {
  const ts = turns();
  const needs = ts.filter((m) => m.pending && m.waiting);
  const working = ts.filter((m) => m.pending && !m.waiting);
  const done = ts.filter((m) => !m.pending).slice(-6).reverse();
  const bay = (cls, title, iconName, items, emptyText) => `<div class="bay ${cls}"><div class="bayhead">${ic(iconName, 'sm')}${title}<span class="count">${items.length}</span></div>${items.length ? items.join('') : `<div class="emptybay">${emptyText}</div>`}</div>`;
  const queued = queue.map((id, i) => `<div class="strip" data-key="q-${esc(id)}-${i}">${tile(id, agentColor(id))}<div class="s1"><span class="handle">@${esc(id)}</span><span class="acct">${esc(acctText(agentMap()[id]) || '')}</span></div><div class="right"><span class="st">Next</span></div><div class="s2">Starts when the current turn ends</div></div>`);
  const parts = [];
  if (needs.length) parts.push(bay('needs', 'Needs you', 'bell', needs.map((m) => stripHtml(m)), ''));
  parts.push(bay('working', 'Working', 'play', working.map((m) => stripHtml(m, { todos: true })), ts.length ? 'Nobody is working right now.' : 'Mention an agent to start the first turn.'));
  if (queued.length) parts.push(bay('queued', 'Up next', 'clock', queued, ''));
  parts.push(bay('done', 'Done', 'check', done.map((m) => stripHtml(m)), 'Finished turns land here.'));
  const summed = current.summarized || 0;
  const sumBox = ts.length > 2 ? `<div class="psec">Memory</div><div class="pcard"><div class="hint" style="margin:0">${summed ? `The first ${summed} messages are summarized; agents get that summary plus the recent chat.` : 'Long sessions are summarized automatically so every agent keeps the full story.'}</div><button id="sumNow" style="margin-top:10px;min-height:26px;font-size:12px">Summarize now</button></div>` : '';
  const older = ts.length > 6 ? `<div class="psec">Earlier turns</div>${ts.slice(0, -6).reverse().map((m) => `<div class="trow" data-goto="${m.id}">${tile(m.agent, agentColor(m.agent), 'sm')}<div class="tmain"><span class="hint" style="margin:0">${esc(requestFor(m))}</span></div><span class="hint" style="margin:0">${fmtDur(m.seconds)}</span></div>`).join('')}` : '';
  return `<div class="board">${parts.join('')}</div>${sumBox}${older}`;
}
// Strips glide to their new bay instead of jumping (FLIP with the Web Animations API).
function flipBoard(update) {
  const body = $('panelBody');
  const before = new Map([...body.querySelectorAll('.strip[data-key]')].map((el) => [el.dataset.key, el.getBoundingClientRect()]));
  update();
  if (!before.size || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  body.querySelectorAll('.strip[data-key]').forEach((el) => {
    const b = before.get(el.dataset.key);
    const a = el.getBoundingClientRect();
    if (!b) { el.animate([{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' }); return; }
    const dy = b.top - a.top;
    if (Math.abs(dy) > 2) el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 280, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
  });
}
function tickTimer() {
  clearInterval(panel.timer);
  const els = document.querySelectorAll('.elapsed[data-start]');
  if (!els.length) return;
  const tick = () => els.forEach((el) => { el.textContent = fmtDur(Math.max(0, Math.round((Date.now() - Date.parse(el.dataset.start)) / 1000))); });
  tick(); panel.timer = setInterval(tick, 1000);
}

// ---------- Files ----------
async function filesListHtml() {
  const files = await api(`/api/sessions/${current.id}/files`);
  if (!files.length) return '<div class="pcard"><div class="hint" style="margin:0">Files that agents create or change in this session show up here, with a live preview.</div></div>';
  const commits = turns().flatMap((m) => (m.commits || []).map((c) => ({ c, agent: m.agent })));
  const created = files.filter((f) => f.isNew && f.exists);
  const section = (title, list) => !list.length ? '' : `<div class="psec">${title} <span class="hint" style="margin:0">${list.length}</span></div>` + list.map((f) => `
    <div class="frow ${f.exists ? '' : 'gone'}" data-open="${esc(f.path)}" data-wt="${esc(f.wt || '')}">
      <span class="ficon k-${f.kind}">${ic(KIND_ICON[f.kind] || 'file')}</span>
      <div class="fmain"><div class="fname">${esc(baseName(f.path))}</div><div class="hint" style="margin:0">${f.wt ? `on @${esc(f.wt)}'s branch · ` : ''}${esc(dirName(f.path))}${f.exists ? fmtSize(f.size) : 'deleted'}</div></div>
      <div class="fmeta"><span class="fstat ${f.isNew ? 'added' : f.status}">${f.isNew && f.exists ? 'New' : STATUS_LABEL[f.status]}</span>${f.uncommitted === false && !f.wt && f.exists ? '<span class="hint" style="margin:0;font-size:11px">committed</span>' : ''}
      <span class="adots">${f.agents.map((a) => `<i title="@${esc(a)}" style="background:${agentColor(a)}"></i>`).join('')}</span></div></div>`).join('');
  // Filter by agent and commit one agent's work (shared folder only).
  const shared = files.filter((f) => !f.wt);
  const byAgent = [...new Set(shared.flatMap((f) => f.agents))];
  const pick = panel.fileAgent && byAgent.includes(panel.fileAgent) ? panel.fileAgent : '';
  const visible = (f) => !pick || (!f.wt && f.agents.includes(pick));
  const filterBar = byAgent.length > 1 || pick ? `<div class="afilter"><button data-fagent="" class="${pick ? '' : 'on'}">All</button>${byAgent.map((a) => `<button data-fagent="${esc(a)}" class="${pick === a ? 'on' : ''}"><i style="background:${agentColor(a)}"></i>@${esc(a)} <span class="hint" style="margin:0">${shared.filter((f) => f.agents.includes(a)).length}</span></button>`).join('')}</div>` : '';
  const toCommit = shared.filter((f) => f.uncommitted && (!pick || f.agents.includes(pick)));
  const shareWarn = pick ? toCommit.filter((f) => f.agents.length > 1) : [];
  const commitBar = toCommit.length && current.isRepo !== false ? `<div class="pcard commitbar"><div class="hint" style="margin:0 0 6px">${toCommit.length} uncommitted file${toCommit.length > 1 ? 's' : ''}${pick ? ` changed by @${esc(pick)}` : ' changed in this session'}${shareWarn.length ? ` · ${shareWarn.length} also changed by another agent (the whole file is committed)` : ''}</div><button class="primary" data-commit="${esc(pick)}">Commit ${pick ? `@${esc(pick)}'s changes` : 'these changes'}</button></div>` : '';
  const others = files.filter((f) => !(f.isNew && f.exists));
  return filterBar + commitBar + section('Created', created.filter(visible)) + section('Changed', others.filter(visible))
    + (commits.length ? `<div class="psec">Commits</div>${commits.map((x) => `<div class="commit"><i style="background:${agentColor(x.agent)}"></i>${esc(x.c)}</div>`).join('')}` : '');
}
$('panelBody').addEventListener('click', async (e) => {
  const fa = e.target.closest('[data-fagent]');
  if (fa) { panel.fileAgent = fa.dataset.fagent; renderPanel(); return; }
  const cb = e.target.closest('[data-commit]');
  if (cb) {
    const who = cb.dataset.commit;
    const last = [...current.messages].reverse().find((m) => m.role === 'agent' && (!who || m.agent === who) && m.status === 'done');
    const suggestion = last ? (last.statusLine || (last.text || '').split('\n').find((l) => l.trim()) || '').replace(/^[#*\s-]+/, '').slice(0, 72) : '';
    const message = prompt(`Commit message${who ? ` for @${who}'s changes` : ''}:`, suggestion);
    if (!message) return;
    cb.disabled = true;
    try { const r = await api(`/api/sessions/${current.id}/commit`, { method: 'POST', body: { agent: who, message } }); renderPanel(); }
    catch (err) { alert(err.message); cb.disabled = false; }
    return;
  }
  if (e.target.closest('[data-jump]')) return;
  const row = e.target.closest('[data-open]');
  if (row) openFile(row.dataset.open, row.dataset.wt || null);
});

async function openFile(p, wt) {
  panel.file = p; panel.wt = wt || null;
  if (panel.tab !== 'files') { panel.tab = 'files'; document.querySelectorAll('#panelTabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === 'files')); }
  const info = await api(`/api/sessions/${current.id}/file?path=${encodeURIComponent(p)}${panel.wt ? `&wt=${panel.wt}` : ''}`);
  panel.info = info;
  const preview = ['html', 'image', 'markdown', 'pdf'].includes(info.kind);
  panel.view = panel.drafts.has(draftKey()) ? 'edit' : preview ? 'preview' : editable(info) ? 'edit' : 'source';
  renderFile();
}

// ---------- editing ----------
// Unsaved edits live per file (and per agent branch) until you save or revert them, so moving
// around the panel never loses your typing.
const draftKey = () => `${current ? current.id : ''}|${panel.wt || ''}|${panel.file}`;
const editable = (info) => info && info.exists && info.content != null && !info.truncated && (['text', 'markdown', 'html'].includes(info.kind) || (info.kind === 'image' && /\.svg$/i.test(info.path || '')));
function hasDrafts() { return [...panel.drafts.values()].some((d) => d.text !== d.orig); }
window.addEventListener('beforeunload', (e) => { if (hasDrafts()) { e.preventDefault(); e.returnValue = ''; } });

function indentUnit(text) {
  const m = text.match(/^(\t+| {2,})\S/m);
  return m && m[1][0] === '\t' ? '\t' : m && m[1].length >= 4 && !/^ {2}\S/m.test(text) ? '    ' : '  ';
}
function editorHtml() {
  return `<div class="editor"><pre class="gut" id="edGut" aria-hidden="true"></pre><textarea id="edText" spellcheck="false" autocapitalize="off" autocomplete="off" autocorrect="off" wrap="off" aria-label="Edit ${esc(baseName(panel.file))}"></textarea></div>
    <div class="edbar"><span class="edstate" id="edState" aria-live="polite"></span><span style="flex:1"></span><button id="edRevert" disabled>Revert</button><button class="primary" id="edSave" disabled>Save <kbd>${/Mac/.test(navigator.platform) ? '⌘' : 'Ctrl+'}S</kbd></button></div>`;
}
function mountEditor() {
  const info = panel.info, key = draftKey();
  const ta = $('edText'), gut = $('edGut');
  const d = panel.drafts.get(key);
  ta.value = d ? d.text : info.content;
  const unit = indentUnit(ta.value);
  let lines = 0;
  const gutter = () => { const n = ta.value.split('\n').length; if (n !== lines) { lines = n; gut.textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n'); } gut.scrollTop = ta.scrollTop; };
  const state = () => {
    const cur = panel.drafts.get(key);
    const dirty = !!cur && cur.text !== cur.orig;
    $('edSave').disabled = !dirty; $('edRevert').disabled = !dirty;
    if (!panel.conflict && (dirty || !panel.justSaved)) $('edState').innerHTML = dirty ? '<span class="dirty"></span>Unsaved changes' : '';
    if (dirty) panel.justSaved = false;
    document.querySelectorAll('.ftabs [data-v="edit"]').forEach((b) => b.classList.toggle('dirty', dirty));
  };
  panel.justSaved = false;
  gutter(); state();
  ta.addEventListener('scroll', () => { gut.scrollTop = ta.scrollTop; });
  ta.addEventListener('input', () => {
    const cur = panel.drafts.get(key) || { orig: panel.info.content, base: panel.info.modifiedAt };
    cur.text = ta.value;
    if (cur.text === cur.orig) panel.drafts.delete(key); else panel.drafts.set(key, cur);
    gutter(); state();
  });
  ta.addEventListener('keydown', (e) => {
    const mod = /Mac/.test(navigator.platform) ? e.metaKey : e.ctrlKey;
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveDraft(); return; }
    if (e.key === 'Tab' && !mod && !e.altKey) {
      e.preventDefault();
      const { selectionStart: a, selectionEnd: b, value: v } = ta;
      const ls = v.lastIndexOf('\n', a - 1) + 1;
      if (!e.shiftKey && a === b) { document.execCommand('insertText', false, unit); return; }
      const le = b > a && v[b - 1] === '\n' ? b - 1 : (v.indexOf('\n', b) < 0 ? v.length : v.indexOf('\n', b));
      const block = v.slice(ls, le).split('\n');
      const out = block.map((l) => e.shiftKey ? l.replace(new RegExp(`^(\\t| {1,${unit.length}})`), '') : unit + l).join('\n');
      ta.setSelectionRange(ls, le); document.execCommand('insertText', false, out);
      ta.setSelectionRange(ls, ls + out.length);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !mod && !e.altKey && ta.selectionStart === ta.selectionEnd) {
      const v = ta.value, a = ta.selectionStart;
      const ls = v.lastIndexOf('\n', a - 1) + 1;
      const lead = (v.slice(ls, a).match(/^[\t ]*/) || [''])[0];
      const extra = /[{[(:]\s*$/.test(v.slice(ls, a)) ? unit : '';
      if (lead || extra) { e.preventDefault(); document.execCommand('insertText', false, '\n' + lead + extra); }
    }
  });
  $('edSave').onclick = () => saveDraft();
  $('edRevert').onclick = async () => {
    const ok = await askConfirm({ title: `Revert ${baseName(panel.file)}?`, body: 'Your unsaved changes to this file are thrown away.', ok: 'Revert', danger: true });
    if (!ok) return;
    panel.conflict = null; ta.value = panel.info.content; ta.dispatchEvent(new Event('input'));
  };
  if (panel.conflict) showConflict();
  if (panel.edCaret) { ta.setSelectionRange(panel.edCaret[0], panel.edCaret[1]); ta.scrollTop = panel.edCaret[2]; panel.edCaret = null; }
  ta.focus({ preventScroll: true });
}
async function saveDraft(force = false) {
  const key = draftKey(), d = panel.drafts.get(key);
  if (!d || d.text === d.orig) return;
  $('edSave').disabled = true; $('edState').textContent = 'Saving…';
  try {
    const r = await api(`/api/sessions/${current.id}/file`, { method: 'PUT', body: { path: panel.file, wt: panel.wt, content: d.text, baseModifiedAt: d.base, force } });
    panel.info = { ...panel.info, content: d.text, size: r.size, modifiedAt: r.modifiedAt };
    panel.drafts.delete(key); panel.conflict = null; panel.justSaved = true;
    $('edText').dispatchEvent(new Event('input'));
    $('edState').innerHTML = `${ic('check', 'sm')}Saved · agents are told you edited it`;
  } catch (e) {
    if (/changed since you opened it/i.test(e.message)) { panel.conflict = true; showConflict(); }
    else { $('edState').innerHTML = `<span class="err" style="margin:0">${esc(e.message)}</span>`; $('edSave').disabled = false; }
  }
}
function showConflict() {
  $('edState').innerHTML = `<span class="conflict">${ic('alert', 'sm')}Changed on disk since you opened it.</span><button class="linkbtn" id="edTheirs">Load the new version</button><button class="linkbtn" id="edMine">Save mine anyway</button>`;
  $('edTheirs').onclick = async () => { panel.drafts.delete(draftKey()); panel.conflict = null; await refreshOpenFile(true); };
  $('edMine').onclick = () => { panel.conflict = null; saveDraft(true); };
}

async function renderFile() {
  const info = panel.info; if (!info) return;
  const p = panel.file;
  const touches = turns().filter((m) => (m.workdir ? m.agent : null) === panel.wt && (m.files || []).some((f) => f.path === p));
  const canPreview = ['html', 'image', 'markdown', 'pdf'].includes(info.kind);
  const canEdit = editable(info);
  if (panel.view === 'edit' && !canEdit) panel.view = info.content != null ? 'source' : canPreview ? 'preview' : 'changes';
  if (panel.view === 'source' && canEdit) panel.view = 'edit';
  const dirty = panel.drafts.has(draftKey()) && panel.drafts.get(draftKey()).text !== panel.drafts.get(draftKey()).orig;
  const raw = `/api/sessions/${current.id}${panel.wt ? `/wt/${panel.wt}` : ''}/raw/${p.split('/').map(encodeURIComponent).join('/')}`;
  let view = '';
  if (!info.exists) view = '<div class="pcard"><div class="hint" style="margin:0">This file was deleted.</div></div>';
  else if (panel.view === 'preview' && info.kind === 'html') view = `<iframe class="preview" sandbox="allow-scripts allow-forms allow-popups" src="${raw}?t=${Date.now()}"></iframe>`;
  else if (panel.view === 'preview' && info.kind === 'pdf') view = `<iframe class="preview" src="${raw}"></iframe>`;
  else if (panel.view === 'preview' && info.kind === 'image') view = `<div class="imgwrap"><img src="${raw}?t=${Date.now()}" alt="${esc(baseName(p))}"></div>`;
  else if (panel.view === 'preview' && info.kind === 'markdown') view = `<div class="mdview body">${md(dirty ? panel.drafts.get(draftKey()).text : info.content || '')}</div>`;
  else if (panel.view === 'edit') view = editorHtml();
  else if (panel.view === 'changes') {
    view = '<div class="hint">Loading…</div>';
    api(`/api/sessions/${current.id}/diff?path=${encodeURIComponent(p)}${panel.wt ? `&wt=${panel.wt}` : ''}`).then((d) => {
      if (panel.file !== p || panel.view !== 'changes') return;
      const lines = (d.diff || '').split('\n').map((l) => `<div class="dl ${l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : l.startsWith('@@') ? 'hunk' : ''}">${esc(l) || ' '}</div>`).join('');
      $('fileView').innerHTML = `<div class="hint">${esc(d.note || '')}${dirty ? ' Your unsaved edits aren\'t included until you save.' : ''}</div>${d.diff ? `<div class="diff">${lines}</div>` : info.content != null ? `<pre class="src">${esc(info.content)}</pre>` : ''}`;
    }).catch((e) => { $('fileView').innerHTML = `<div class="err">${esc(e.message)}</div>`; });
  } else if (info.content != null) view = `<pre class="src">${esc(info.content)}${info.truncated ? '\n… (file is larger than 512 KB, showing the start; open it in its app to edit)' : ''}</pre>`;
  else view = `<div class="pcard"><div class="hint" style="margin:0">No preview for this kind of file. Use Open to view it in its app.</div></div>`;

  const body = $('panelBody');
  body.classList.toggle('editing', panel.view === 'edit');
  body.innerHTML = `<div class="fhead"><button class="ghost ib" id="fBack" data-tip="All files">${ic('back')}</button><div class="fmain"><div class="fname">${esc(baseName(p))}</div><div class="hint" style="margin:0">${panel.wt ? `on @${esc(panel.wt)}'s branch · ` : ''}${esc(dirName(p))}${info.exists ? fmtSize(info.size) : ''}</div></div></div>
    <div class="ftabs">${canPreview ? `<button data-v="preview" class="${panel.view === 'preview' ? 'on' : ''}">Preview</button>` : ''}<button data-v="changes" class="${panel.view === 'changes' ? 'on' : ''}">Changes</button>${canEdit ? `<button data-v="edit" class="${panel.view === 'edit' ? 'on' : ''}${dirty ? ' dirty' : ''}">${ic('pencil', 'sm')}Edit</button>` : info.content != null ? `<button data-v="source" class="${panel.view === 'source' ? 'on' : ''}">Source</button>` : ''}
      <span style="flex:1"></span><button data-act="reveal" title="Show in Finder / Explorer">Reveal</button><button data-act="open" title="Open in its default app">Open</button></div>
    <div id="fileView">${view}</div>
    ${panel.view === 'edit' ? '' : `<div class="psec">History</div>${touches.slice().reverse().map((m) => { const f = m.files.find((x) => x.path === p); return `<div class="trow" data-goto="${m.id}"><span class="sdot ${f.status === 'deleted' ? 'error' : 'done'}"></span><div class="tmain"><b style="color:${agentColor(m.agent)}">@${esc(m.agent)}</b> <span class="hint" style="margin:0">${esc(STATUS_LABEL[f.status].toLowerCase())} · ${new Date(m.endedAt || m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span><div class="hint" style="margin:2px 0 0">${esc(requestFor(m))}</div></div></div>`; }).join('') || '<div class="hint">No agent has changed this file in this session.</div>'}`}`;
  if (panel.view === 'edit') mountEditor();
  $('fBack').onclick = () => { panel.file = null; panel.conflict = null; body.classList.remove('editing'); renderPanel(); };
  document.querySelectorAll('.ftabs [data-v]').forEach((b) => b.onclick = () => { panel.view = b.dataset.v; renderFile(); });
  document.querySelectorAll('.ftabs [data-act]').forEach((b) => b.onclick = () => api(`/api/sessions/${current.id}/reveal`, { method: 'POST', body: { path: p, open: b.dataset.act === 'open', wt: panel.wt } }));
}
// After an agent's turn: reload the open file, unless you're in the middle of editing it.
async function refreshOpenFile(force) {
  if (panel.tab !== 'files' || !panel.file || !current) return;
  const info = await api(`/api/sessions/${current.id}/file?path=${encodeURIComponent(panel.file)}${panel.wt ? `&wt=${panel.wt}` : ''}`);
  const d = panel.drafts.get(draftKey());
  if (!force && d && d.text !== d.orig) {
    if (info.modifiedAt !== d.base && $('edState')) { panel.conflict = true; showConflict(); }
    return;
  }
  const ta = $('edText');
  if (ta && panel.view === 'edit') panel.edCaret = [ta.selectionStart, ta.selectionEnd, ta.scrollTop];
  panel.info = info;
  renderFile();
}
document.addEventListener('click', (e) => { if (e.target.closest('#fBack, #panelTabs button')) { const ta = $('edText'); if (ta) panel.edCaret = null; } }, true);

// ---------- Used ----------
function usedHtml() {
  const ts = turns().filter((m) => !m.pending || (m.tools || []).length);
  if (!ts.length) return '<div class="pcard"><div class="hint" style="margin:0">Once agents work, this shows who did what: tools, skills, connectors, tokens and cost.</div></div><div class="psec">What each agent can use</div><div id="capBox" class="capgrid"><div class="hint">Checking…</div></div>';
  const by = {};
  let secs = 0, tin = 0, tout = 0, cost = 0, costKnown = false, noUsage = new Set();
  const skills = {}, conns = {}, toolsCount = {}, subagents = {}, web = { n: 0 };
  for (const m of ts) {
    const a = by[m.agent] ||= { turns: 0, secs: 0, tin: 0, tout: 0, cost: 0, costKnown: false, account: m.account, model: m.model, promptChars: 0, files: new Set(), available: null };
    a.turns++; a.secs += m.seconds || 0; secs += m.seconds || 0;
    if (m.model) a.model = m.model;
    if (m.available) a.available = m.available;
    a.promptChars = m.promptChars || a.promptChars;
    (m.files || []).forEach((f) => a.files.add(f.path));
    if (m.usage) {
      a.tin += m.usage.input; a.tout += m.usage.output; tin += m.usage.input; tout += m.usage.output;
      if (m.usage.costUsd != null) { a.cost += m.usage.costUsd; cost += m.usage.costUsd; a.costKnown = costKnown = true; }
    } else if (!m.pending) noUsage.add(m.agent);
    for (const t of m.tools || []) {
      if (t.skill) { const k = t.skill; (skills[k] ||= { n: 0, agents: new Set() }).n++; skills[k].agents.add(m.agent); }
      else if (t.connector) { const c = conns[t.connector] ||= { n: 0, tools: {}, agents: new Set() }; c.n++; c.tools[t.connectorTool] = (c.tools[t.connectorTool] || 0) + 1; c.agents.add(m.agent); }
      else if (t.name !== 'TodoWrite') { toolsCount[t.name] = (toolsCount[t.name] || 0) + 1; }
      if (t.subagent) subagents[t.subagent] = (subagents[t.subagent] || 0) + 1;
      if (t.web) web.n++;
    }
  }
  const files = new Set(ts.flatMap((m) => (m.files || []).map((f) => f.path)));
  const capSection = '<div class="psec">What each agent can use</div><div id="capBox" class="capgrid"><div class="hint">Checking…</div></div>';
  const stat = (v, l) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`;
  const dots = (set) => [...set].map((a) => `<i title="@${esc(a)}" style="background:${agentColor(a)}"></i>`).join('');
  const toolRows = Object.entries(toolsCount).sort((a, b) => b[1] - a[1]);
  const maxT = toolRows.length ? toolRows[0][1] : 1;

  return `<div class="stats">${stat(ts.length, 'turns')}${stat(Object.keys(by).length, 'agents')}${stat(fmtDur(secs) || '0s', 'agent time')}${stat(files.size, 'files')}${stat(tin + tout ? fmtNum(tin + tout) : '–', 'tokens')}${stat(costKnown ? '$' + cost.toFixed(2) : '–', 'cost')}</div>
    ${sharedNames.length ? `<div class="hint">"shared" marks connectors given to every agent through AgentsCircle (Settings → Connectors).</div>` : ''}
    ${noUsage.size ? `<div class="hint">Token and cost numbers come from agents that report them (Claude Code, Codex, Cursor; cost only from Claude Code). ${[...noUsage].map((a) => '@' + esc(a)).join(', ')} didn't.</div>` : ''}
    <div class="psec">Agents</div>${Object.entries(by).map(([id, a]) => `<div class="urow" style="align-items:flex-start">${tile(id, agentColor(id), 'sm')}<div class="tmain"><span class="handle">@${esc(id)}</span> <span class="hint" style="margin:0">${esc(a.account || '')}${a.model ? ' · ' + esc(a.model) : ''}</span>
      <div class="hint" style="margin:2px 0 0">${[`${a.turns} turn${a.turns > 1 ? 's' : ''}`, fmtDur(a.secs), a.files.size ? `${a.files.size} files` : '', a.tin + a.tout ? `${fmtNum(a.tin)} in / ${fmtNum(a.tout)} out` : '', a.costKnown ? '$' + a.cost.toFixed(3) : '', a.promptChars ? `last context ${fmtNum(a.promptChars)} chars` : ''].filter(Boolean).join(' · ')}</div>
      ${a.available && a.available.mcpServers && a.available.mcpServers.length ? `<div class="hint" style="margin:4px 0 0">Connectors available: ${a.available.mcpServers.map((s) => `<span class="tag ${s.status === 'connected' ? '' : 'off'}" title="${s.status}${sharedNames.includes(s.name) ? ' · shared through AgentsCircle' : ''}">${esc(s.name)}${sharedNames.includes(s.name) ? ' <span style="color:var(--accent)">·shared</span>' : ''}</span>`).join(' ')}</div>` : ''}</div></div>`).join('')}
    <div class="psec">Skills used</div>${Object.keys(skills).length ? Object.entries(skills).map(([k, v]) => `<div class="urow"><span class="tag">${esc(k)}</span><span class="hint" style="margin:0">×${v.n}</span><span class="adots">${dots(v.agents)}</span></div>`).join('') : '<div class="hint">None yet.</div>'}
    <div class="psec">Connectors used</div>${Object.keys(conns).length ? Object.entries(conns).map(([k, v]) => `<div class="urow" style="align-items:flex-start"><span class="tag">${esc(k)}</span><div class="tmain hint" style="margin:0">${Object.entries(v.tools).map(([t, n]) => `${esc(t)} ×${n}`).join(', ')}</div><span class="adots">${dots(v.agents)}</span></div>`).join('') : '<div class="hint">None yet.</div>'}
    ${Object.keys(subagents).length ? `<div class="psec">Sub-agents</div>${Object.entries(subagents).map(([k, n]) => `<div class="urow"><span class="tag">${esc(k)}</span><span class="hint" style="margin:0">×${n}</span></div>`).join('')}` : ''}
    <div class="psec">Tools</div>${toolRows.length ? toolRows.map(([k, n]) => `<div class="tbar"><span>${esc(k)}</span><div><i style="width:${Math.max(6, Math.round((n / maxT) * 100))}%"></i></div><b>${n}</b></div>`).join('') : '<div class="hint">No tool calls reported. Plain-text agents (like Codex here) don\'t report their tool use.</div>'}
    ${web.n ? `<div class="hint">Web searches and page fetches: ${web.n}</div>` : ''}
    ${capSection}`;
}

// ---------- wiring ----------
document.querySelectorAll('#panelTabs button').forEach((b) => b.onclick = () => { panel.file = null; panel.turn = null; setTab(b.dataset.tab); });
$('panelClose').onclick = closePanel;
$('panelBtn').onclick = () => document.body.classList.contains('panel-open') ? closePanel() : openPanel();
setTab(panel.tab);
if (localStorage.getItem('agentscircle:panel') !== '0' && window.innerWidth > 1100) document.body.classList.add('panel-open');

// ---------- Branches (parallel mode) ----------
let branchCache = null;
async function refreshBranches() {
  if (!current) return;
  try { branchCache = await api(`/api/sessions/${current.id}/branches`); } catch { branchCache = []; }
  current.worktrees = Object.fromEntries(branchCache.map((b) => [b.agent, true]));
  updateTabCounts();
  if (document.body.classList.contains('panel-open') && panel.tab === 'branches' && !panel.branchDiff) renderBranches(true);
}
async function renderBranches(cached) {
  const body = $('panelBody');
  if (panel.branchDiff) return showBranchDiff(panel.branchDiff);
  if (!cached || !branchCache) { body.innerHTML = '<div class="hint">Loading…</div>'; try { branchCache = await api(`/api/sessions/${current.id}/branches`); } catch (e) { body.innerHTML = `<div class="err">${esc(e.message)}</div>`; return; } }
  const list = branchCache;
  const intro = current.mode === 'parallel'
    ? '<div class="hint" style="margin:0 0 10px">Parallel mode: each agent works at the same time on its own branch, starting from a copy of your folder. Your folder only changes when you apply a branch.</div>'
    : '<div class="hint" style="margin:0 0 10px">Shared-folder mode is on, but these branches from parallel work are still here.</div>';
  if (!list.length) { body.innerHTML = intro + '<div class="pcard"><div class="hint" style="margin:0">No branches yet. Mention two agents in one message (for example "@claude @codex both try this") and each gets its own branch.</div></div>'; return; }
  // Compare: which files each agent changed, overlaps highlighted.
  const allFiles = [...new Set(list.flatMap((b) => b.files.map((f) => f.path)))].sort();
  const cmp = allFiles.length ? `<div class="psec">Compare</div><table class="cmp"><tr><th>File</th>${list.map((b) => `<th style="color:${agentColor(b.agent)}">@${esc(b.agent)}</th>`).join('')}</tr>${allFiles.map((f) => {
    const cells = list.map((b) => { const x = b.files.find((y) => y.path === f); return x ? (x.status === 'added' ? 'new' : x.status === 'deleted' ? 'deleted' : 'edited') : ''; });
    return `<tr class="${cells.filter(Boolean).length > 1 ? 'overlap' : ''}"><td title="${cells.filter(Boolean).length > 1 ? 'Changed by more than one agent: applying both may need a merge' : ''}">${esc(f)}</td>${cells.map((c) => `<td class="c">${c}</td>`).join('')}</tr>`;
  }).join('')}</table><div class="hint">Files in amber were changed by more than one agent; applying both merges them line by line and marks any clash.</div>` : '';
  body.innerHTML = intro + list.map((b) => `<div class="brow">
      <div class="h">${tile(b.agent, agentColor(b.agent), 'sm')}<span class="handle">@${esc(b.agent)}</span>${b.working ? '<span class="pill warn">working</span>' : ''}${b.appliedAt ? '<span class="pill ok">applied</span>' : ''}<span class="hint" style="margin:0"><code>${esc(b.branch)}</code></span></div>
      <div class="hint" style="margin:4px 0 0">${b.files.length} file${b.files.length === 1 ? '' : 's'} changed${b.commits.length ? ` · ${b.commits.length} commit${b.commits.length === 1 ? '' : 's'}` : ''}${b.files.length ? ': ' + esc(b.files.slice(0, 5).map((f) => f.path).join(', ')) + (b.files.length > 5 ? ', …' : '') : ''}</div>
      <div class="btns"><button data-bdiff="${esc(b.agent)}" ${b.files.length ? '' : 'disabled'}>Review</button><button class="${b.appliedAt ? '' : 'primary'}" data-bapply="${esc(b.agent)}" ${b.files.length && !b.working ? '' : 'disabled'}>${b.appliedAt ? 'Apply again' : 'Apply to my folder'}</button><button data-bdiscard="${esc(b.agent)}" ${b.working ? 'disabled' : ''}>Discard</button></div>
    </div>`).join('') + cmp + (list.filter((b) => b.files.length).length > 1 ? `<div class="psec">Combine</div><div class="pcard"><div class="hint" style="margin:0">Want the best of each? Ask one agent to merge the branches for you.</div><button id="bCombine" style="margin-top:8px;padding:4px 10px;font-size:12px">Ask an agent to combine them</button></div>` : '');
  body.querySelectorAll('[data-bdiff]').forEach((b) => b.onclick = () => showBranchDiff(b.dataset.bdiff));
  body.querySelectorAll('[data-bapply]').forEach((b) => b.onclick = async () => {
    if (!confirm(`Apply @${b.dataset.bapply}'s changes to your folder? Files you also changed are merged line by line; clashes are marked for you to fix. You can undo it from the chat.`)) return;
    b.disabled = true;
    try { await api(`/api/sessions/${current.id}/branches/${b.dataset.bapply}/apply`, { method: 'POST' }); } catch (e) { alert(e.message); }
    refreshBranches();
  });
  body.querySelectorAll('[data-bdiscard]').forEach((b) => b.onclick = async () => {
    if (!confirm(`Discard @${b.dataset.bdiscard}'s branch and its copy? Anything not applied is lost.`)) return;
    try { await api(`/api/sessions/${current.id}/branches/${b.dataset.bdiscard}/discard`, { method: 'POST' }); } catch (e) { alert(e.message); }
    refreshBranches();
  });
  const comb = $('bCombine');
  if (comb) comb.onclick = () => {
    const names = list.filter((b) => b.files.length);
    const who = current.defaultAgent || names[0].agent;
    $('input').value = `@${who} Compare these branches and combine the best parts into the main folder (${current.folder}): ${names.map((b) => `${b.branch} (by @${b.agent})`).join(', ')}. Use git diff to read them; don't push.`;
    $('input').focus(); $('input').dispatchEvent(new Event('input'));
  };
}
async function showBranchDiff(agent) {
  panel.branchDiff = agent;
  const body = $('panelBody');
  body.innerHTML = '<div class="hint">Loading…</div>';
  try {
    const d = await api(`/api/sessions/${current.id}/branches/${agent}/diff`);
    const blocks = (d.diff || '').split(/^(?=diff --git )/m).filter(Boolean);
    body.innerHTML = `<div class="fhead"><button class="ghost ib" id="bBack" data-tip="All branches">${ic('back')}</button><div class="fmain"><div class="fname">@${esc(agent)}'s branch</div><div class="hint" style="margin:0">Everything it changed since it started</div></div></div>
      ${blocks.map((bk) => { const name = (/^diff --git a\/(.+?) b\//.exec(bk) || [])[1] || ''; return `<div class="psec">${esc(name)}</div><div class="diff">${bk.split('\n').map((l) => `<div class="dl ${l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : l.startsWith('@@') ? 'hunk' : ''}">${esc(l) || ' '}</div>`).join('')}</div>`; }).join('') || '<div class="hint">No changes.</div>'}`;
    $('bBack').onclick = () => { panel.branchDiff = null; renderBranches(); };
  } catch (e) { body.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}
document.querySelectorAll('#panelTabs [data-tab=branches]').forEach((b) => b.addEventListener('click', () => { panel.branchDiff = null; }));

// ---------- resizing (drag the edge, like the Claude desktop app) ----------
const PANEL_MIN_W = 320, PANEL_MIN_H = 180, CHAT_MIN_W = 380, CHAT_MIN_H = 200;
const psize = (() => {
  const n = (k, d) => { try { const v = parseFloat(localStorage.getItem(k)); return Number.isFinite(v) ? v : d; } catch { return d; } };
  return { w: n('agentscircle:panelW', 400), h: n('agentscircle:panelH', Math.round(innerHeight * 0.4)), max: (() => { try { return localStorage.getItem('agentscircle:panelMax') === '1'; } catch { return false; } })() };
})();
const savePsize = () => { try { localStorage.setItem('agentscircle:panelW', String(Math.round(psize.w))); localStorage.setItem('agentscircle:panelH', String(Math.round(psize.h))); localStorage.setItem('agentscircle:panelMax', psize.max ? '1' : '0'); } catch { /* private window */ } };
const bottomLayout = () => document.body.classList.contains('panel-bottom');
function panelLimits() {
  const side = document.querySelector('aside');
  const sideW = side && getComputedStyle(side).display !== 'none' ? side.getBoundingClientRect().width : 0;
  return { maxW: Math.max(PANEL_MIN_W, innerWidth - sideW - CHAT_MIN_W), maxH: Math.max(PANEL_MIN_H, innerHeight - CHAT_MIN_H) };
}
function applyPanelSize() {
  const { maxW, maxH } = panelLimits();
  const root = document.documentElement.style;
  if (bottomLayout()) root.setProperty('--panel-h', (psize.max ? maxH : Math.min(maxH, Math.max(PANEL_MIN_H, psize.h))) + 'px');
  else root.setProperty('--panel-w', (psize.max ? maxW : Math.min(maxW, Math.max(PANEL_MIN_W, psize.w))) + 'px');
  const b = $('panelExpand');
  if (b) { b.innerHTML = ic(psize.max ? 'contract' : 'expand'); b.dataset.tip = psize.max ? 'Restore panel size' : 'Expand panel'; b.setAttribute('aria-label', b.dataset.tip); b.setAttribute('aria-pressed', psize.max ? 'true' : 'false'); }
  const grip = $('panelGrip');
  if (grip) {
    grip.setAttribute('aria-orientation', bottomLayout() ? 'horizontal' : 'vertical');
    const p = $('panel').getBoundingClientRect(), m = document.querySelector('main').getBoundingClientRect();
    grip.classList.toggle('far', !bottomLayout() && p.left < m.left); // panel on the left of the chat: grip on its right edge
  }
}
// Expanding animates once; dragging follows the pointer with no easing.
function setPanelMax(on) {
  psize.max = on; savePsize();
  const pnl = $('panel');
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) { pnl.classList.add('sizing'); setTimeout(() => pnl.classList.remove('sizing'), 260); }
  applyPanelSize();
}
$('panelExpand').onclick = () => setPanelMax(!psize.max);
(() => {
  const grip = $('panelGrip');
  let drag = null;
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); grip.setPointerCapture(e.pointerId);
    const r = $('panel').getBoundingClientRect();
    drag = { r, far: grip.classList.contains('far') };
    document.body.classList.add('panel-resizing', bottomLayout() ? 'rs-row' : 'rs-col');
  });
  grip.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (bottomLayout()) psize.h = drag.r.bottom - e.clientY;
    else psize.w = drag.far ? e.clientX - drag.r.left : drag.r.right - e.clientX;
    psize.max = false;
    applyPanelSize();
  });
  const end = () => {
    if (!drag) return; drag = null;
    document.body.classList.remove('panel-resizing', 'rs-row', 'rs-col');
    // Store what you actually see (the limits may have clamped it).
    const r = $('panel').getBoundingClientRect(); if (bottomLayout()) psize.h = r.height; else psize.w = r.width;
    savePsize();
  };
  grip.addEventListener('pointerup', end); grip.addEventListener('pointercancel', end);
  grip.addEventListener('dblclick', () => setPanelMax(!psize.max));
  grip.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 80 : 24, bottom = bottomLayout(), far = grip.classList.contains('far');
    const grow = bottom ? { ArrowUp: 1, ArrowDown: -1 }[e.key] : { ArrowLeft: far ? -1 : 1, ArrowRight: far ? 1 : -1 }[e.key];
    if (e.key === 'Enter') { e.preventDefault(); setPanelMax(!psize.max); return; }
    if (!grow) return;
    e.preventDefault();
    const r = $('panel').getBoundingClientRect();
    if (bottom) psize.h = r.height + grow * step; else psize.w = r.width + grow * step;
    psize.max = false; applyPanelSize(); savePsize();
  });
})();
window.addEventListener('resize', () => applyPanelSize());
new MutationObserver(() => applyPanelSize()).observe(document.body, { attributes: true, attributeFilter: ['class'] });
applyPanelSize();
