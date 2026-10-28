// Collaboration features: attachments, search across sessions, hand-off toggle, Skills settings.
// Uses globals from index.html: api, esc, $, current, agents, openSession, md.

// ---------- attachments ----------
let pending = [];          // uploaded, not yet sent: { path, name, size, kind, preview }
let uploadsBusy = 0;

function rawUrl(p) { return `/api/sessions/${current.id}/raw/${p.split('/').map(encodeURIComponent).join('/')}`; }

function renderPending() {
  $('pendingAtt').innerHTML = pending.map((a, i) => `<span class="attchip">${a.kind === 'image' ? `<img src="${rawUrl(a.path)}" alt="">` : ic('file', 'sm')}${esc(a.name)}<button data-rm="${i}" data-tip="Remove">${ic('x', 'sm')}</button></span>`).join('')
    + (uploadsBusy ? `<span class="hint" style="margin:0">Uploading ${uploadsBusy}…</span>` : '');
  $('pendingAtt').querySelectorAll('[data-rm]').forEach((b) => b.onclick = () => { pending.splice(+b.dataset.rm, 1); renderPending(); });
}
async function uploadFiles(files) {
  if (!current) return;
  for (const f of files) {
    if (f.size > 25 * 1024 * 1024) { alert(`${f.name} is larger than 25 MB.`); continue; }
    uploadsBusy++; renderPending();
    try {
      const name = f.name && f.name !== 'image.png' ? f.name : `screenshot-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.png`;
      const r = await fetch(`/api/sessions/${current.id}/uploads`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'x-filename': encodeURIComponent(name) }, body: f });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Upload failed');
      pending.push(j);
    } catch (e) { alert(e.message); }
    uploadsBusy--; renderPending();
  }
}
function takeAttachments() { const a = pending.map(({ path, name }) => ({ path, name })); pending = []; renderPending(); return a; }
function clearAttachments() { pending = []; renderPending(); }

$('attachBtn').onclick = () => $('fileInput').click();
$('fileInput').onchange = () => { uploadFiles([...$('fileInput').files]); $('fileInput').value = ''; };
$('input').addEventListener('paste', (e) => {
  const files = [...(e.clipboardData && e.clipboardData.files || [])];
  if (files.length) { e.preventDefault(); uploadFiles(files); }
});
let dragDepth = 0;
document.addEventListener('dragenter', (e) => { if (current && [...(e.dataTransfer.types || [])].includes('Files')) { dragDepth++; document.body.classList.add('dragging'); } });
document.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove('dragging'); });
document.addEventListener('dragover', (e) => { if (current) e.preventDefault(); });
document.addEventListener('drop', (e) => {
  dragDepth = 0; document.body.classList.remove('dragging');
  if (!current || !e.dataTransfer.files.length) return;
  e.preventDefault(); uploadFiles([...e.dataTransfer.files]);
});

function attachmentsHtml(m) {
  if (!m.attachments || !m.attachments.length || !current) return '';
  return `<div class="atts">${m.attachments.map((a) => a.kind === 'image'
    ? `<a class="img" href="${rawUrl(a.path)}" target="_blank" title="${esc(a.name)}"><img src="${rawUrl(a.path)}" alt="${esc(a.name)}"></a>`
    : `<a href="#" data-attfile="${esc(a.path)}" title="Open in the side panel">${ic('file', 'sm')} ${esc(a.name)}</a>`).join('')}</div>`;
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-attfile]');
  if (a) { e.preventDefault(); if (typeof openPanel === 'function') { openPanel('files'); openFile(a.dataset.attfile); } }
});

// ---------- hand-offs toggle ----------
function renderHandoffBtn() {
  if (!current) return;
  const on = current.handoffs !== false;
  $('handoffBtn').innerHTML = `${ic('handoff')}<span class="lbl">Hand-offs ${on ? 'on' : 'off'}</span>`;
  $('handoffBtn').classList.toggle('on', on);
  $('handoffBtn').dataset.tip = on
    ? 'On: an agent can pass work to another by ending its reply with "@codex: task". Stops after 4 in a row. Click to turn off.'
    : 'Off: only you decide who works. Click to let agents hand work to each other.';
}
$('handoffBtn').onclick = async () => {
  const on = current.handoffs !== false;
  await api(`/api/sessions/${current.id}`, { method: 'PATCH', body: { handoffs: !on } });
  current.handoffs = !on; renderHandoffBtn();
};

// ---------- work mode: shared folder or parallel branches ----------
function renderModeBtn() {
  if (!current) return;
  const par = current.mode === 'parallel';
  $('modeBtn').innerHTML = `${ic(par ? 'branch' : 'folder')}<span class="lbl">${par ? 'Parallel branches' : 'Shared folder'}</span>`;
  $('modeBtn').classList.toggle('parallel', par);
  $('modeBtn').dataset.tip = par
    ? 'Parallel: each agent works at the same time on its own branch; you compare and apply in the Branches tab. Click to switch back to the shared folder.'
    : 'Shared folder: agents take turns in your folder. Click for Parallel: each agent works at the same time on its own branch.';
}
$('modeBtn').onclick = async () => {
  const toPar = current.mode !== 'parallel';
  if (toPar && !confirm('Switch to Parallel mode?\n\nEach agent gets its own copy of the project (a git branch, starting from your folder as it is now, including uncommitted files) and agents mentioned together work at the same time. Your folder only changes when you apply a branch in the Branches tab.')) return;
  try {
    await api(`/api/sessions/${current.id}`, { method: 'PATCH', body: { mode: toPar ? 'parallel' : 'shared' } });
    current.mode = toPar ? 'parallel' : 'shared'; renderModeBtn(); updateTabCounts();
    if (toPar && typeof openPanel === 'function') openPanel('branches');
  } catch (e) { alert(e.message); }
};

// ---------- search across sessions ----------
let searchTimer = null;
$('searchQ').addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = $('searchQ').value.trim();
  if (q.length < 2) { $('searchResults').style.display = 'none'; $('sessions').style.display = ''; return; }
  searchTimer = setTimeout(async () => {
    const res = await api('/api/search?q=' + encodeURIComponent(q));
    const hi = (t) => esc(t).replace(new RegExp(esc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), (m) => `<mark>${m}</mark>`);
    $('searchResults').innerHTML = res.length ? res.map((r) => `<div class="sres" data-s="${r.sessionId}" data-m="${r.messageId}"><div class="n">${esc(r.sessionName)} · ${esc(r.who)}</div><div class="hint" style="margin:2px 0 0">${hi(r.snippet)}</div></div>`).join('') : '<div class="hint" style="padding:8px">Nothing found.</div>';
    $('searchResults').style.display = ''; $('sessions').style.display = 'none';
    $('searchResults').querySelectorAll('.sres').forEach((el) => el.onclick = async () => {
      await openSession(el.dataset.s);
      const m = document.getElementById('m-' + el.dataset.m);
      if (m) { m.scrollIntoView({ block: 'center' }); m.classList.add('flash'); setTimeout(() => m.classList.remove('flash'), 1500); }
    });
  }, 200);
});
$('searchQ').addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('searchQ').value = ''; $('searchQ').dispatchEvent(new Event('input')); } });

// ---------- Settings → Skills ----------
async function loadSkills() {
  const pane = $('setSkills');
  pane.innerHTML = '<div class="hint">Loading…</div>';
  const d = await api('/api/skills' + (current ? `?session=${current.id}` : ''));
  const row = (k, extra) => `<div class="acctrow" style="grid-template-columns:1fr auto"><div style="min-width:0"><div class="h">${esc(k.name)} <span class="hint" style="margin:0;font-weight:400">${esc(k.scope || '')}</span></div><div class="sub">${esc(k.description || '')}</div>${k.path ? `<div class="sub"><code>${esc(k.path)}</code></div>` : ''}</div><div class="btns">${extra || ''}</div></div>`;
  pane.innerHTML = `
    <h4>Skills</h4><p class="lead">Shared skills are told to every agent, which reads the skill's SKILL.md when a task matches. That lets Codex or Cursor use a skill you made for Claude.</p>
    <div class="psec" style="margin-top:0">Shared with every agent</div>
    ${d.shared.length ? d.shared.map((k) => row(k, k.scope === 'all projects' || (k.path || '').startsWith('.agentscircle') ? `<button class="danger" data-rmskill="${esc(k.name)}">Remove</button>` : '')).join('') : '<div class="hint">None yet. Add one below, or put skill folders in your project\'s <code>skills/</code> folder.</div>'}
    <div class="notice" id="skillNotice"></div>
    <section class="addacct">
      <h3 style="margin:10px 0 8px;font-size:15px">Add a skill</h3>
      <div class="row" style="align-items:center;flex-wrap:wrap;gap:8px">
        <button id="skZip">Upload a skill .zip</button>
        <select id="skScope" class="sel" style="width:auto"><option value="all">for all projects</option>${current ? '<option value="project">for this project only</option>' : ''}</select>
        <input type="file" id="skFile" accept=".zip" style="display:none">
      </div>
      <div class="hint">A skill .zip is a folder with a SKILL.md inside, the same format Claude uses. You can download skills from the Claude app and upload them here.</div>
      ${d.fromAgents.map((g) => `<div class="psec">From @${esc(g.agent)}'s own skills (${esc(g.tool)})</div>${g.skills.map((k) => row(k, k.shared ? '<span class="pill ok">shared</span>' : `<button data-share="${esc(g.agent)}|${esc(k.name)}">Share with all agents</button>`)).join('')}`).join('')}
      <div class="hint" style="margin-top:12px">Shared skills for all projects live in <code>${esc(d.folder)}</code>.</div>
    </section>`;
  const note = (h) => { const n = $('skillNotice'); n.innerHTML = h; n.style.display = 'block'; };
  $('skZip').onclick = () => $('skFile').click();
  $('skFile').onchange = async () => {
    const f = $('skFile').files[0]; if (!f) return;
    const r = await fetch(`/api/skills/upload?scope=${$('skScope').value}${current ? `&session=${current.id}` : ''}`, { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: f });
    const j = await r.json();
    await loadSkills();
    note(r.ok ? `Added <b>${esc(j.name)}</b>. Every agent will see it from its next turn.` : `<span class="err">${esc(j.error)}</span>`);
  };
  pane.querySelectorAll('[data-share]').forEach((b) => b.onclick = async () => {
    const [agent, name] = b.dataset.share.split('|');
    try { await api('/api/skills/share', { method: 'POST', body: { agent, name } }); await loadSkills(); note(`Shared <b>${esc(name)}</b> with every agent.`); } catch (e) { note(`<span class="err">${esc(e.message)}</span>`); }
  });
  pane.querySelectorAll('[data-rmskill]').forEach((b) => b.onclick = async () => {
    if (!confirm(`Remove the shared skill "${b.dataset.rmskill}"?`)) return;
    try { await api(`/api/skills/${encodeURIComponent(b.dataset.rmskill)}${current ? `?session=${current.id}` : ''}`, { method: 'DELETE' }); await loadSkills(); } catch (e) { note(`<span class="err">${esc(e.message)}</span>`); }
  });
}
