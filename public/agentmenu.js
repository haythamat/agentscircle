// Per-agent menu on the member chips: model and effort for this session (changeable any time),
// make default, remove from the session. Uses globals from index.html: $, api, esc, ic, tile,
// current, agentMap, renderChips.

const amenu = document.createElement('div');
amenu.id = 'agentMenu'; amenu.className = 'cmenu amenu'; amenu.setAttribute('role', 'dialog');
document.body.appendChild(amenu);
let amFor = null, amData = null;

// Short text for the chip: "sonnet · high".
function modelChipText(id) {
  const own = (current && current.agentModels && current.agentModels[id]) || {};
  const a = agentMap()[id] || {};
  const model = own.model || a.model || '';
  const effort = own.effort || a.effort || '';
  return [model, effort].filter(Boolean).join(' · ');
}

function closeAgentMenu() { amenu.classList.remove('open'); amFor = null; document.querySelectorAll('.chip.menu-on').forEach((c) => c.classList.remove('menu-on')); }

async function openAgentMenu(id, anchor) {
  if (!current) return;
  amFor = id;
  document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('menu-on', c.dataset.id === id));
  amenu.innerHTML = '<div class="hint" style="padding:10px">Loading models…</div>';
  place(anchor);
  amenu.classList.add('open');
  try { amData = await api(`/api/sessions/${current.id}/agents/${id}/model`); } catch (e) { amenu.innerHTML = `<div class="err" style="padding:10px">${esc(e.message)}</div>`; return; }
  if (amFor !== id) return;
  draw(anchor);
}

function place(anchor) {
  // The chips are redrawn after each change, so find the current one for this agent.
  const live = (amFor && document.querySelector(`.chip[data-id="${amFor}"]`)) || anchor;
  const r = live.getBoundingClientRect();
  amenu.style.left = Math.max(8, Math.min(r.left, innerWidth - 348)) + 'px';
  amenu.style.top = (r.bottom + 6) + 'px';
  amenu.style.maxHeight = Math.max(240, innerHeight - r.bottom - 20) + 'px';
}

function draw(anchor) {
  const id = amFor, a = agentMap()[id] || {}, d = amData, o = d.options;
  const sel = { model: d.session.model, effort: d.session.effort };
  const acctModel = d.account.model, acctEffort = d.account.effort;
  const known = o.models.some((m) => m.id === sel.model);
  const modelInfo = o.models.find((m) => m.id === (sel.model || acctModel));
  const efforts = o.perModelEfforts && modelInfo && modelInfo.efforts.length ? modelInfo.efforts : o.efforts;
  const isDefault = current.defaultAgent === id;
  const row = (val, label, desc) => `<button class="mrow${(sel.model || '') === val ? ' on' : ''}" data-model="${esc(val)}" role="menuitemradio" aria-checked="${(sel.model || '') === val}"><span class="mcheck">${(sel.model || '') === val ? ic('check', 'sm') : ''}</span><span class="mtext"><b>${esc(label)}</b>${desc ? `<span>${esc(desc)}</span>` : ''}</span></button>`;
  amenu.innerHTML = `
    <div class="amhead">${tile(id, a.color)}<span class="handle">@${esc(id)}</span><span class="hint" style="margin:0">${esc(d.tool)}${a.label ? ' · ' + esc(a.label) : ''}</span></div>
    <div class="amsec">Model <span class="hint" style="margin:0;font-weight:400">in this session</span></div>
    <div class="mlist">
      ${row('', `Usual model${acctModel ? ` (${acctModel})` : ''}`, acctModel ? 'The account\'s default in Settings.' : `Whatever ${d.tool} uses by default.`)}
      ${o.models.map((m) => row(m.id, m.label && m.label !== m.id ? `${m.label}` : m.id, [m.label && m.label !== m.id ? m.id : '', m.description].filter(Boolean).join(' · '))).join('')}
      ${sel.model && !known ? row(sel.model, sel.model, 'Typed in') : ''}
    </div>
    ${o.custom ? `<div class="mcustom"><input id="amCustom" placeholder="Other model name…" spellcheck="false" autocomplete="off"><button id="amCustomGo">Use</button></div>` : ''}
    ${o.note ? `<div class="hint" style="margin:4px 12px 0">${esc(o.note)}</div>` : ''}
    ${efforts.length ? `<div class="amsec">${esc(o.effortLabel || 'Effort')}</div>
    <div class="seg aeff" role="radiogroup">${['', ...efforts].map((e) => `<button data-effort="${e}" class="${(sel.effort || '') === e ? 'on' : ''}" role="radio" aria-checked="${(sel.effort || '') === e}" title="${e ? '' : `Usual${acctEffort ? ` (${acctEffort})` : modelInfo && modelInfo.defaultEffort ? ` (${modelInfo.defaultEffort})` : ''}`}">${e || 'Usual'}</button>`).join('')}</div>` : ''}
    <div class="hint amnote">${d.busy ? 'It\'s working now; this applies from its next turn.' : 'Applies from its next turn. Other sessions keep their own choice.'}</div>
    <div class="msep"></div>
    ${isDefault ? '' : `<button class="mact" data-act="default">${ic('star', 'sm')}Make default agent</button>`}
    <button class="mact danger" data-act="remove">${ic('x', 'sm')}Remove from this session</button>`;
  place(anchor);

  const save = async (patch) => {
    const body = { model: sel.model, effort: sel.effort, ...patch };
    // An effort the new model doesn't support goes back to the usual one.
    const m2 = o.models.find((m) => m.id === (body.model || acctModel));
    if (body.effort && o.perModelEfforts && m2 && m2.efforts.length && !m2.efforts.includes(body.effort)) body.effort = null;
    try {
      const r = await api(`/api/sessions/${current.id}/agents/${id}/model`, { method: 'PUT', body });
      d.session = { model: r.session.model || null, effort: r.session.effort || null };
      current.agentModels = { ...(current.agentModels || {}), [id]: d.session };
      draw(anchor); renderChips();
    } catch (e) { alert(e.message); }
  };
  amenu.querySelectorAll('[data-model]').forEach((b) => b.onclick = () => save({ model: b.dataset.model || null }));
  amenu.querySelectorAll('[data-effort]').forEach((b) => b.onclick = () => save({ effort: b.dataset.effort || null }));
  if ($('amCustomGo')) {
    const go = () => { const v = $('amCustom').value.trim(); if (v) save({ model: v }); };
    $('amCustomGo').onclick = go;
    $('amCustom').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } };
  }
  amenu.querySelectorAll('[data-act]').forEach((b) => b.onclick = async () => {
    const act = b.dataset.act; closeAgentMenu();
    if (act === 'default') await api('/api/sessions/' + current.id, { method: 'PATCH', body: { defaultAgent: id } });
    if (act === 'remove') await api('/api/sessions/' + current.id, { method: 'PATCH', body: { members: current.members.filter((m) => m !== id) } });
  });
}

document.addEventListener('mousedown', (e) => { if (amFor && !e.target.closest('#agentMenu') && !e.target.closest('.chip[data-id]')) closeAgentMenu(); });
document.addEventListener('keydown', (e) => { if (amFor && e.key === 'Escape') { e.stopPropagation(); closeAgentMenu(); } }, true);
window.addEventListener('resize', closeAgentMenu);
