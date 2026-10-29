// Session menu (rename, context, delete) and session context: notes, files and images every agent
// gets with each task. Uses globals from index.html: $, api, esc, ic, current, sessions, openSession,
// loadSessions, leaveSession, renderWelcome.

// ---------- a small confirm dialog (window.confirm looks foreign in the desktop app) ----------
function askConfirm({ title, body, ok = 'OK', danger = false }) {
  return new Promise((resolve) => {
    $('askTitle').textContent = title;
    $('askBody').textContent = body;
    const yes = $('askYes');
    yes.textContent = ok; yes.className = danger ? 'danger' : 'primary';
    const done = (v) => { $('askModal').classList.remove('open'); document.removeEventListener('keydown', onKey, true); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); } };
    yes.onclick = () => done(true);
    $('askNo').onclick = () => done(false);
    $('askModal').onmousedown = (e) => { if (e.target === $('askModal')) done(false); };
    document.addEventListener('keydown', onKey, true);
    $('askModal').classList.add('open');
    setTimeout(() => (danger ? $('askNo') : yes).focus(), 30);
  });
}

// ---------- session menu ----------
const smenu = document.createElement('div');
smenu.id = 'sessMenu'; smenu.className = 'cmenu'; smenu.setAttribute('role', 'menu');
document.body.appendChild(smenu);
let smenuFor = null;

function closeSessMenu() { smenu.classList.remove('open'); smenuFor = null; document.querySelectorAll('.sess.menu-on').forEach((el) => el.classList.remove('menu-on')); }
function openSessMenu(id, x, y) {
  const s = sessions.find((v) => v.id === id) || (current && current.id === id ? current : null);
  if (!s) return;
  smenuFor = id;
  smenu.innerHTML = `
    <button role="menuitem" data-m="rename">${ic('pencil', 'sm')}Rename</button>
    <button role="menuitem" data-m="context">${ic('notes', 'sm')}Session context…</button>
    <button role="menuitem" data-m="terminal">${ic('terminal', 'sm')}Open terminal<span class="kbd">⌃\`</span></button>
    <button role="menuitem" data-m="import">${ic('import', 'sm')}Bring in a chat…</button>
    <button role="menuitem" data-m="export">${ic('export', 'sm')}Export as Markdown</button>
    <div class="msep"></div>
    <button role="menuitem" data-m="delete" class="danger">${ic('trash', 'sm')}Delete session…</button>`;
  smenu.classList.add('open');
  const r = smenu.getBoundingClientRect();
  smenu.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px';
  smenu.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
  document.querySelectorAll('.sess').forEach((el) => el.classList.toggle('menu-on', el.dataset.id === id));
  smenu.querySelector('button').focus();
}
smenu.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-m]'); if (!b) return;
  const id = smenuFor; closeSessMenu();
  if (b.dataset.m === 'rename') startRename(id);
  if (b.dataset.m === 'context') { if (!current || current.id !== id) await openSession(id); openContext(); }
  if (b.dataset.m === 'import' || b.dataset.m === 'export') { if (!current || current.id !== id) await openSession(id); $(b.dataset.m === 'import' ? 'importBtn' : 'exportBtn').click(); }
  if (b.dataset.m === 'terminal') { if (!current || current.id !== id) await openSession(id); openPanel('terminal'); }
  if (b.dataset.m === 'delete') deleteSession(id);
});
smenu.addEventListener('keydown', (e) => {
  const items = [...smenu.querySelectorAll('button')];
  const i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
  if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
  if (e.key === 'Escape') { e.preventDefault(); closeSessMenu(); }
});
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-sact]');
  if (b) { e.stopPropagation(); const r = b.getBoundingClientRect(); smenuFor === b.dataset.sact ? closeSessMenu() : openSessMenu(b.dataset.sact, r.left, r.bottom + 4); return; }
  if (!e.target.closest('#sessMenu') && !e.target.closest('#sessMenuBtn')) closeSessMenu();
}, true);
document.addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.sess[data-id]'); if (!row) return;
  e.preventDefault(); openSessMenu(row.dataset.id, e.clientX, e.clientY);
});
window.addEventListener('blur', closeSessMenu);
window.addEventListener('resize', closeSessMenu);
$('sessMenuBtn').innerHTML = ic('dots');
$('sessMenuBtn').onclick = () => { if (!current) return; if (smenuFor) return closeSessMenu(); const r = $('sessMenuBtn').getBoundingClientRect(); openSessMenu(current.id, r.right - 200, r.bottom + 6); };

function startRename(id) {
  const row = document.querySelector(`.sess[data-id="${id}"]`);
  const s = sessions.find((v) => v.id === id); if (!row || !s) return;
  const name = row.querySelector('.name');
  const inp = document.createElement('input');
  inp.className = 'rename'; inp.value = s.name; inp.maxLength = 80; inp.setAttribute('aria-label', 'Session name');
  name.replaceWith(inp); inp.focus(); inp.select();
  let finished = false;
  const finish = async (save) => {
    if (finished) return; finished = true;
    const v = inp.value.trim();
    if (save && v && v !== s.name) {
      try { await api('/api/sessions/' + id, { method: 'PATCH', body: { name: v } }); if (current && current.id === id) { current.name = v; $('sTitle').textContent = v; } } catch (err) { alert(err.message); }
    }
    loadSessions();
  };
  inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } if (e.key === 'Escape') { e.preventDefault(); finish(false); } };
  inp.onblur = () => finish(true);
}

async function deleteSession(id) {
  const s = sessions.find((v) => v.id === id); if (!s) return;
  const working = s.busy ? ' Agents working in it are stopped.' : '';
  const ok = await askConfirm({
    title: `Delete "${s.name}"?`,
    body: `The conversation and its context files are removed from AgentsCircle.${working} Your project folder and its files aren't touched. This can't be undone.`,
    ok: 'Delete session', danger: true,
  });
  if (!ok) return;
  try {
    await api('/api/sessions/' + id, { method: 'DELETE' });
    if (current && current.id === id) leaveSession();
    await loadSessions();
  } catch (e) { alert(e.message); }
}
// Delete from the keyboard: focus a session in the sidebar and press Delete or Backspace with ⌘/Ctrl.
document.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey) || (e.key !== 'Backspace' && e.key !== 'Delete')) return;
  if (e.target.closest('input, textarea, [contenteditable]')) return;
  if (current) { e.preventDefault(); deleteSession(current.id); }
});

// ---------- session context ----------
const ctx = { text: '', files: [], busy: 0, savedText: '' };
const CTX_MAX = 25 * 1024 * 1024;
const ctxSize = (b) => b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1048576).toFixed(1)} MB`;
const ctxRaw = (p) => `/api/sessions/${current.id}/raw/${p.split('/').map(encodeURIComponent).join('/')}`;
const ctxPasteName = (f) => (f.name && f.name !== 'image.png' ? f.name : `screenshot-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.png`);

function renderCtxBtn() {
  const b = $('ctxBtn'); if (!b) return;
  const c = (current && current.context) || { files: 0, text: false };
  const n = c.files + (c.text ? 1 : 0);
  b.innerHTML = `${ic('notes', 'sm')}<span class="lbl">Context</span>${n ? `<span class="n">${n}</span>` : ''}`;
  b.classList.toggle('has', n > 0);
}
$('ctxBtn').onclick = () => openContext();
$('ctxAdd').innerHTML = `${ic('attach', 'sm')}Add files or images`;
$('fCtxAdd').innerHTML = `${ic('attach', 'sm')}Add files or images`;

function ctxFileHtml(f, i, local) {
  const thumb = f.kind === 'image' && (local ? f.url : f.path) ? `<img src="${esc(local ? f.url : ctxRaw(f.path))}" alt="">` : ic(f.kind === 'image' ? 'image' : 'file', 'sm');
  return `<div class="ctxf${f.exists === false ? ' gone' : ''}" title="${esc(f.path || f.name)}"><span class="th">${thumb}</span><span class="nm">${esc(f.name)}</span><span class="sz">${f.exists === false ? 'missing' : f.size != null ? ctxSize(f.size) : ''}</span><button type="button" data-ctxrm="${i}" aria-label="Remove ${esc(f.name)}">${ic('x', 'sm')}</button></div>`;
}
function renderCtxFiles() {
  $('ctxFiles').innerHTML = ctx.files.map((f, i) => ctxFileHtml(f, i)).join('') + (ctx.busy ? `<div class="ctxf up"><span class="th"><span class="working mini" style="margin:0"><i></i></span></span><span class="nm">Adding ${ctx.busy} file${ctx.busy > 1 ? 's' : ''}…</span></div>` : '');
  $('ctxFiles').querySelectorAll('[data-ctxrm]').forEach((b) => b.onclick = async () => {
    const f = ctx.files[+b.dataset.ctxrm]; if (!f) return;
    try { await api(`/api/sessions/${current.id}/context/files?path=${encodeURIComponent(f.path)}`, { method: 'DELETE' }); ctx.files.splice(+b.dataset.ctxrm, 1); renderCtxFiles(); flashSaved('Removed'); }
    catch (e) { $('ctxErr').textContent = e.message; }
  });
}
function flashSaved(t) { $('ctxSaved').textContent = t; clearTimeout(flashSaved.t); flashSaved.t = setTimeout(() => { $('ctxSaved').textContent = ''; }, 1600); }

async function openContext() {
  if (!current) return;
  $('ctxErr').textContent = ''; $('ctxSaved').textContent = '';
  $('ctxTitle').textContent = `Context for ${current.name}`;
  try { const c = await api(`/api/sessions/${current.id}/context`); ctx.text = c.text; ctx.files = c.files; } catch (e) { ctx.text = ''; ctx.files = []; $('ctxErr').textContent = e.message; }
  ctx.savedText = ctx.text;
  $('ctxText').value = ctx.text;
  renderCtxFiles();
  $('ctxModal').classList.add('open');
  setTimeout(() => $('ctxText').focus(), 40);
}
async function ctxUpload(files) {
  for (const f of files) {
    if (f.size > CTX_MAX) { $('ctxErr').textContent = `${f.name} is larger than 25 MB.`; continue; }
    ctx.busy++; renderCtxFiles();
    try {
      const r = await fetch(`/api/sessions/${current.id}/context/files`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'x-filename': encodeURIComponent(ctxPasteName(f)) }, body: f });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Could not add that file.');
      ctx.files.push({ ...j, exists: true }); flashSaved('Added');
    } catch (e) { $('ctxErr').textContent = e.message; }
    ctx.busy--; renderCtxFiles();
  }
}
async function closeContext(save) {
  if (ctx.busy) { $('ctxErr').textContent = 'Wait a moment, files are still being added.'; return; }
  if (save && $('ctxText').value !== ctx.savedText) {
    try { await api(`/api/sessions/${current.id}/context`, { method: 'PUT', body: { text: $('ctxText').value } }); }
    catch (e) { $('ctxErr').textContent = e.message; return; }
  } else if (!save && $('ctxText').value !== ctx.savedText) {
    const ok = await askConfirm({ title: 'Discard your changes to the notes?', body: 'Files you added are already saved. Only the text changes are lost.', ok: 'Discard', danger: true });
    if (!ok) return;
  }
  $('ctxModal').classList.remove('open');
}
$('ctxSave').onclick = () => closeContext(true);
$('ctxModal').addEventListener('mousedown', (e) => { if (e.target === $('ctxModal')) closeContext(false); });
$('ctxCancel').onclick = () => closeContext(false);
$('ctxModal').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeContext(false); }
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); closeContext(true); }
});
$('ctxAdd').onclick = () => $('ctxInput').click();
$('ctxInput').onchange = () => { ctxUpload([...$('ctxInput').files]); $('ctxInput').value = ''; };
$('ctxText').addEventListener('paste', (e) => { const f = [...(e.clipboardData && e.clipboardData.files || [])]; if (f.length) { e.preventDefault(); ctxUpload(f); } });

// ---------- context in the New session dialog (files are added once the session exists) ----------
let newCtx = [];
function renderNewCtx() {
  $('fCtxFiles').innerHTML = newCtx.map((f, i) => ctxFileHtml({ name: f.file.name || 'image', size: f.file.size, kind: f.kind, url: f.url }, i, true)).join('');
  $('fCtxFiles').querySelectorAll('[data-ctxrm]').forEach((b) => b.onclick = () => { const [x] = newCtx.splice(+b.dataset.ctxrm, 1); if (x && x.url) URL.revokeObjectURL(x.url); renderNewCtx(); });
}
function addNewCtx(files) {
  for (const f of files) {
    if (f.size > CTX_MAX) { $('fErr').textContent = `${f.name} is larger than 25 MB.`; continue; }
    const image = (f.type || '').startsWith('image/');
    const named = f.name && f.name !== 'image.png' ? f : new File([f], ctxPasteName(f), { type: f.type });
    newCtx.push({ file: named, kind: image ? 'image' : 'file', url: image ? URL.createObjectURL(f) : null });
  }
  renderNewCtx();
}
async function uploadNewSessionContext(id) {
  const list = newCtx; newCtx = [];
  for (const x of list) {
    try { await fetch(`/api/sessions/${id}/context/files`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'x-filename': encodeURIComponent(x.file.name) }, body: x.file }); } catch { /* the session still opens; the file can be added again */ }
    if (x.url) URL.revokeObjectURL(x.url);
  }
  renderNewCtx();
}
$('fCtxAdd').onclick = () => $('fCtxInput').click();
$('fCtxInput').onchange = () => { addNewCtx([...$('fCtxInput').files]); $('fCtxInput').value = ''; };
$('fContext').addEventListener('paste', (e) => { const f = [...(e.clipboardData && e.clipboardData.files || [])]; if (f.length) { e.preventDefault(); addNewCtx(f); } });
const openNewWithCtx = $('newBtn').onclick;
$('newBtn').onclick = () => { newCtx.forEach((x) => x.url && URL.revokeObjectURL(x.url)); newCtx = []; renderNewCtx(); openNewWithCtx(); };

// Dropping files: into the open dialog's context, otherwise the chat attachments (collab.js).
function ctxDropTarget() {
  if ($('ctxModal').classList.contains('open')) return 'session';
  if ($('modal').classList.contains('open')) return 'new';
  return null;
}
document.addEventListener('dragover', (e) => { if (ctxDropTarget()) e.preventDefault(); }, true);
document.addEventListener('drop', (e) => {
  const t = ctxDropTarget(); if (!t) return;
  e.preventDefault(); e.stopImmediatePropagation();
  document.body.classList.remove('dragging');
  const files = [...(e.dataTransfer.files || [])]; if (!files.length) return;
  t === 'session' ? ctxUpload(files) : addNewCtx(files);
}, true);

// Keep the header button in step with the session.
const _openSessionCtx = openSession;
openSession = async function (id) { const r = await _openSessionCtx(id); renderCtxBtn(); return r; };
renderCtxBtn();
