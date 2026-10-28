// Settings → Connectors: shared MCP servers every agent can use.
// Uses globals from index.html: api, esc, $, agents.

const conn = { list: [], catalog: [], addTab: 'popular', form: null, editing: null, results: null, importable: null, busy: {} };

const AUTH_LABEL = { oauth: 'Sign-in (OAuth)', token: 'Token', none: 'No sign-in' };
const initials = (t) => (t || '?').replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase();
const linesToMap = (text, sep) => Object.fromEntries(String(text || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const i = l.indexOf(sep); return i < 0 ? [l, ''] : [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const mapToLines = (m, sep) => Object.entries(m || {}).map(([k, v]) => `${k}${sep}${v}`).join('\n');

async function loadConnectors() {
  [conn.list, conn.catalog] = await Promise.all([api('/api/connectors'), api('/api/connectors/catalog')]);
  renderConnectors();
}

function connStatus(c) {
  if (!c.enabled) return '<span class="pill">off</span>';
  const t = c.lastTest;
  if (!t) return '<span class="pill">not tested</span>';
  if (t.ok && t.needsSignIn) return '<span class="pill warn" title="' + esc(t.message) + '">needs sign-in per agent</span>';
  if (t.ok) return '<span class="pill ok" title="' + esc(t.message) + '">working</span>';
  return '<span class="pill bad" title="' + esc(t.message) + '">problem</span>';
}

function scopeText(c) {
  const gets = c.agents.filter((a) => a.gets).map((a) => '@' + a.id);
  const unsupported = c.agents.filter((a) => !a.supported).map((a) => '@' + a.id);
  return `${c.scope === 'all' ? 'All agents' : 'Only ' + (c.scope.map((x) => '@' + x).join(', ') || 'nobody')}`
    + (gets.length ? ` · used by ${gets.join(', ')}` : '')
    + (unsupported.length ? ` · not yet for ${unsupported.join(', ')}` : '');
}

function renderConnectors() {
  const pane = $('setConnectors'); if (!pane) return;
  // Keep whatever is typed in an open form across re-renders.
  if ($('cfName')) { try { conn.form = { ...(conn.form || {}), ...readForm() }; } catch { /* ignore */ } }
  const signable = (c) => c.type === 'remote' && c.auth === 'oauth';
  const rows = conn.list.map((c) => `<div class="acctrow crow ${c.enabled ? '' : 'disabled'}" data-name="${esc(c.name)}">
    <div style="display:flex;gap:10px;min-width:0"><span class="cicon">${esc(initials(c.title || c.name))}</span>
      <div style="min-width:0"><div class="h">${esc(c.title || c.name)} <span class="hint" style="margin:0;font-weight:400">${esc(c.name)} · ${c.type === 'remote' ? 'remote' : 'runs on this computer'} · ${AUTH_LABEL[c.auth]}${c.tokenLocked ? ' (token in the keychain; open the AgentsCircle app to use it)' : c.hasToken ? (c.tokenStore === 'keychain' ? ' (saved in your keychain)' : ' (saved)') : ''}</span>${connStatus(c)}</div>
      <div class="sub"><code>${esc(c.type === 'remote' ? c.url : [c.command, ...(c.args || [])].join(' '))}</code></div>
      <div class="sub">${esc(scopeText(c))}</div>
      ${c.lastTest && !c.lastTest.ok ? `<div class="sub" style="color:var(--danger)">${esc(c.lastTest.message)}</div>` : c.lastTest && c.lastTest.tools ? `<div class="sub">${c.lastTest.tools.slice(0, 8).map((t) => `<span class="tag">${esc(t)}</span>`).join(' ')}${c.lastTest.tools.length > 8 ? ` +${c.lastTest.tools.length - 8}` : ''}</div>` : ''}</div></div>
    <div class="btns">
      <label class="switch" title="${c.enabled ? 'On: agents get this connector' : 'Off'}"><input type="checkbox" data-act="toggle" ${c.enabled ? 'checked' : ''}><span></span></label>
      <button data-act="test">${conn.busy[c.name] ? 'Testing…' : 'Test'}</button>
      ${signable(c) ? '<button data-act="signin">Sign in</button>' : ''}
      <button data-act="edit">Edit</button><button data-act="remove" class="danger">Remove</button></div>
    ${signable(c) ? `<div class="signin" style="grid-column:1/-1;display:none"><span class="hint" style="margin:0">Sign in once for each agent that uses it:</span> ${c.agents.filter((a) => a.gets).map((a) => `<button data-signin="${esc(a.id)}">@${esc(a.id)}</button>`).join(' ') || '<span class="hint" style="margin:0">No agent uses it yet.</span>'}</div>` : ''}
  </div>`).join('');

  pane.innerHTML = `
    <h4>Connectors</h4><p class="lead">Connectors (MCP servers) you add here are shared: AgentsCircle hands them to every agent in the format it understands (Claude Code, Codex, Cursor and OpenCode). Your agents' own settings aren't changed.</p>
    ${rows || '<div class="pcard" style="margin-bottom:8px"><div class="hint" style="margin:0">No shared connectors yet. Add one below.</div></div>'}
    <div class="notice" id="connNotice"></div>
    <section class="addacct">
      <h3 style="margin:10px 0 8px;font-size:15px">${conn.editing ? `Edit ${esc(conn.editing)}` : 'Add a connector'}</h3>
      ${conn.editing ? '' : `<div class="ftabs" id="connAddTabs" style="margin-top:0">${[['popular', 'Popular'], ['registry', 'Search registry'], ['import', 'From my agents'], ['custom', 'Custom']].map(([k, l]) => `<button data-add="${k}" class="${conn.addTab === k ? 'on' : ''}">${l}</button>`).join('')}</div>`}
      <div id="connAddBody">${conn.form ? formHtml(conn.form) : addBodyHtml()}</div>
    </section>`;
  wireConnectors();
}

function addBodyHtml() {
  if (conn.addTab === 'popular') {
    return `<div class="cgrid">${conn.catalog.map((x, i) => `<div class="ccard"><div class="h"><span class="cicon sm">${esc(initials(x.title))}</span><span class="t">${esc(x.title)}</span>${x.added ? '<span class="pill ok">added</span>' : `<button data-cat="${i}">Add</button>`}</div>
      <div class="hint d">${esc(x.description)}</div>
      <div class="hint a">${AUTH_LABEL[x.auth]}${x.tokenHint ? ', ' + esc(x.tokenHint) : ''}</div></div>`).join('')}</div>`;
  }
  if (conn.addTab === 'registry') {
    const r = conn.results;
    return `<div class="row" style="align-items:center"><input id="regQ" placeholder="Search the official MCP Registry, e.g. postgres, slack, shopify" value="${esc(conn.lastQ || '')}"><button id="regGo">Search</button></div>
      <div class="hint">The registry lists thousands of connectors published by their makers. Check who publishes one before adding it.</div>
      <div id="regResults">${!r ? '' : r.error ? `<div class="err">${esc(r.error)}</div>` : !r.length ? '<div class="hint">Nothing found.</div>' : r.map((x, i) => `<div class="acctrow" style="grid-template-columns:1fr auto"><div style="min-width:0"><div class="h">${esc(x.title)} <span class="hint" style="margin:0;font-weight:400">${esc(x.registryName)}${x.version ? ' · v' + esc(x.version) : ''}</span></div><div class="sub">${esc(x.description)}</div><div class="sub"><code>${esc(x.type === 'remote' ? x.url : [x.command, ...x.args].join(' '))}</code>${x.repository ? ` · <a href="${esc(x.repository)}" target="_blank" rel="noopener">source</a>` : ''}</div></div><div class="btns"><button data-reg="${i}">Add</button></div></div>`).join('')}</div>`;
  }
  if (conn.addTab === 'import') {
    const list = conn.importable;
    if (!list) { api('/api/connectors/import').then((l) => { conn.importable = l; renderConnectors(); }); return '<div class="hint">Looking at your agents\' settings…</div>'; }
    if (!list.length) return '<div class="hint">No connectors found in your agents\' settings that aren\'t shared already.</div>';
    return `<div class="hint" style="margin:0 0 8px">Found in your agents' own settings. Import to share them with every agent.</div>${list.map((x, i) => `<label class="acctrow" style="grid-template-columns:auto 1fr;cursor:pointer"><input type="checkbox" data-imp="${i}" checked style="width:auto"><div style="min-width:0"><div class="h">${esc(x.name)} <span class="hint" style="margin:0;font-weight:400">from ${esc(x.from.join(', '))} · ${x.type === 'remote' ? 'remote' : 'runs on this computer'}</span></div><div class="sub"><code>${esc(x.type === 'remote' ? x.url : [x.command, ...(x.args || [])].join(' '))}</code></div>${x.tokenFromEnv ? `<div class="sub">Uses the token in $${esc(x.tokenFromEnv)}; add it as a token after importing.</div>` : ''}</div></label>`).join('')}
      <div class="actions"><button class="primary" id="impGo">Import selected</button></div>`;
  }
  return formHtml({ type: 'remote', auth: 'oauth', scope: 'all' });
}

function formHtml(f) {
  const scopeAll = f.scope === 'all' || !Array.isArray(f.scope);
  const needs = [...(f.needEnv || []), ...(f.needHeaders || [])];
  return `<div class="two">
      <div><label>Name (how agents see it)</label><input id="cfName" value="${esc(f.name || '')}" placeholder="supabase" ${conn.editing ? '' : ''}></div>
      <div><label>Type</label><select id="cfType" class="sel"><option value="remote" ${f.type !== 'local' ? 'selected' : ''}>Remote (URL)</option><option value="local" ${f.type === 'local' ? 'selected' : ''}>Runs on this computer (command)</option></select></div>
    </div>
    <div id="cfRemote" style="${f.type === 'local' ? 'display:none' : ''}">
      <label>URL</label><input id="cfUrl" value="${esc(f.url || '')}" placeholder="https://mcp.example.com/mcp">
      <div class="two">
        <div><label>Sign-in</label><select id="cfAuth" class="sel">${['oauth', 'token', 'none'].map((a) => `<option value="${a}" ${f.auth === a ? 'selected' : ''}>${AUTH_LABEL[a]}</option>`).join('')}</select></div>
        <div id="cfTokWrap" style="${f.auth === 'token' ? '' : 'display:none'}"><label>Token or API key</label><input id="cfToken" type="password" autocomplete="off" placeholder="${conn.editing && f.hasToken ? '•••• saved (leave empty to keep)' : 'Sent as: Authorization: Bearer …'}"></div>
      </div>
      <label>Extra headers (optional, one per line: Name: value)</label><textarea id="cfHeaders" rows="2" placeholder="X-Project: my-app">${esc(mapToLines(f.headers, ': '))}</textarea>
    </div>
    <div id="cfLocal" style="${f.type === 'local' ? '' : 'display:none'}">
      <div class="two"><div><label>Command</label><input id="cfCmd" value="${esc(f.command || '')}" placeholder="npx"></div>
      <div><label>Arguments (one per line)</label><textarea id="cfArgs" rows="2" placeholder="-y&#10;@example/mcp-server">${esc((f.args || []).join('\n'))}</textarea></div></div>
      <label>Environment variables (one per line: NAME=value)</label><textarea id="cfEnv" rows="2" placeholder="API_KEY=...">${esc(mapToLines(f.env, '='))}</textarea>
    </div>
    ${needs.length ? `<div class="hint">This connector needs: ${needs.map((n) => `<code>${esc(n.name)}</code>${n.description ? ' (' + esc(n.description) + ')' : ''}`).join(', ')}</div>` : ''}
    <label>Which agents get it</label>
    <div class="agentpick" id="cfScope">
      <label><input type="radio" name="cfScopeMode" value="all" ${scopeAll ? 'checked' : ''}> All agents</label>
      <label><input type="radio" name="cfScopeMode" value="some" ${scopeAll ? '' : 'checked'}> Only some</label>
    </div>
    <div class="agentpick" id="cfScopeList" style="margin-top:6px;${scopeAll ? 'display:none' : ''}">${agents.map((a) => `<label><input type="checkbox" value="${esc(a.id)}" ${!scopeAll && f.scope.includes(a.id) ? 'checked' : ''}><i style="width:8px;height:8px;border-radius:50%;background:${a.color};display:inline-block"></i>@${esc(a.id)}</label>`).join('')}</div>
    <div class="err" id="cfErr"></div>
    <div class="actions">${conn.form ? '<button id="cfCancel">Cancel</button>' : ''}<button class="primary" id="cfSave">${conn.editing ? 'Save' : 'Add connector'}</button></div>`;
}

function readForm() {
  const type = $('cfType').value;
  const mode = document.querySelector('input[name=cfScopeMode]:checked').value;
  const body = {
    ...(conn.form || {}),
    name: $('cfName').value, type,
    url: $('cfUrl').value.trim(), auth: type === 'local' ? 'none' : $('cfAuth').value,
    headers: linesToMap($('cfHeaders').value, ':'),
    command: $('cfCmd').value.trim(), args: $('cfArgs').value.split('\n'), env: linesToMap($('cfEnv').value, '='),
    scope: mode === 'all' ? 'all' : [...document.querySelectorAll('#cfScopeList input:checked')].map((i) => i.value),
  };
  const tok = $('cfToken') && $('cfToken').value.trim();
  if (tok) body.token = tok;
  delete body.agents; delete body.lastTest; delete body.hasToken; delete body.tokenLocked; delete body.tokenStore; delete body.added; delete body.needEnv; delete body.needHeaders; delete body.from;
  return body;
}

function note(html) { const n = $('connNotice'); if (n) { n.innerHTML = html; n.style.display = 'block'; } }

function wireConnectors() {
  const pane = $('setConnectors');
  pane.querySelectorAll('[data-add]').forEach((b) => b.onclick = () => {
    conn.addTab = b.dataset.add;
    conn.form = b.dataset.add === 'custom' ? { type: 'remote', auth: 'oauth', scope: 'all', source: 'custom' } : null;
    if ($('cfName')) $('cfName').id = 'cfNameOld'; // don't carry the old form over
    renderConnectors();
  });
  pane.querySelectorAll('[data-cat]').forEach((b) => b.onclick = () => { const x = conn.catalog[+b.dataset.cat]; conn.form = { ...x, scope: 'all', source: 'catalog' }; renderConnectors(); $('cfName').scrollIntoView({ behavior: 'smooth', block: 'center' }); });
  pane.querySelectorAll('[data-reg]').forEach((b) => b.onclick = () => { const x = conn.results[+b.dataset.reg]; conn.form = { ...x, scope: 'all', source: 'registry' }; renderConnectors(); $('cfName').scrollIntoView({ behavior: 'smooth', block: 'center' }); });
  const go = $('regGo');
  if (go) {
    const run = async () => {
      conn.lastQ = $('regQ').value; $('regResults').innerHTML = '<div class="hint">Searching…</div>';
      try { conn.results = await api('/api/connectors/registry?q=' + encodeURIComponent(conn.lastQ)); } catch (e) { conn.results = { error: e.message }; }
      renderConnectors();
    };
    go.onclick = run; $('regQ').onkeydown = (e) => { if (e.key === 'Enter') run(); };
  }
  const imp = $('impGo');
  if (imp) imp.onclick = async () => {
    const picks = [...pane.querySelectorAll('[data-imp]:checked')].map((i) => conn.importable[+i.dataset.imp]);
    const done = [];
    for (const x of picks) {
      try { await api('/api/connectors', { method: 'POST', body: { ...x, scope: 'all', source: 'import', from: undefined } }); done.push(x.name); }
      catch (e) { note(`<span class="err">${esc(x.name)}: ${esc(e.message)}</span>`); }
    }
    conn.importable = null; await loadConnectors();
    if (done.length) note(`Imported ${done.map(esc).join(', ')}. Every agent now gets ${done.length > 1 ? 'them' : 'it'}. Testing…`);
    for (const n of done) await testConnector(n, true);
  };
  // form
  if ($('cfType')) {
    $('cfType').onchange = () => { const l = $('cfType').value === 'local'; $('cfRemote').style.display = l ? 'none' : ''; $('cfLocal').style.display = l ? '' : 'none'; };
    $('cfAuth').onchange = () => { $('cfTokWrap').style.display = $('cfAuth').value === 'token' ? '' : 'none'; };
    pane.querySelectorAll('input[name=cfScopeMode]').forEach((r) => r.onchange = () => { $('cfScopeList').style.display = r.value === 'some' && r.checked ? '' : 'none'; });
    if ($('cfCancel')) $('cfCancel').onclick = () => { conn.form = null; conn.editing = null; if (conn.addTab === 'custom') conn.addTab = 'popular'; $('cfName').id = 'cfNameOld'; renderConnectors(); };
    $('cfSave').onclick = async () => {
      $('cfErr').textContent = '';
      try {
        const body = readForm();
        const c = conn.editing
          ? await api('/api/connectors/' + encodeURIComponent(conn.editing), { method: 'PATCH', body })
          : await api('/api/connectors', { method: 'POST', body });
        conn.form = null; conn.editing = null; if (conn.addTab === 'custom') conn.addTab = 'popular';
        $('cfName').id = 'cfNameOld';
        await loadConnectors();
        testConnector(c.name, true);
      } catch (e) { $('cfErr').textContent = e.message; }
    };
  }
  // rows
  pane.querySelectorAll('.crow').forEach((row) => {
    const name = row.dataset.name;
    const c = conn.list.find((x) => x.name === name);
    row.querySelectorAll('[data-act]').forEach((el) => {
      const act = el.dataset.act;
      const handler = async () => {
        try {
          if (act === 'toggle') { await api('/api/connectors/' + encodeURIComponent(name), { method: 'PATCH', body: { enabled: el.checked } }); await loadConnectors(); }
          if (act === 'test') testConnector(name);
          if (act === 'signin') { const s = row.querySelector('.signin'); s.style.display = s.style.display === 'none' ? 'flex' : 'none'; }
          if (act === 'edit') { if ($('cfName')) $('cfName').id = 'cfNameOld'; conn.editing = name; conn.form = { ...c }; renderConnectors(); $('cfName').scrollIntoView({ behavior: 'smooth', block: 'center' }); }
          if (act === 'remove' && confirm(`Remove ${c.title || name}? Agents stop getting it from AgentsCircle. Their own settings aren't touched.`)) { await api('/api/connectors/' + encodeURIComponent(name), { method: 'DELETE' }); await loadConnectors(); }
        } catch (e) { alert(e.message); }
      };
      if (act === 'toggle') el.onchange = handler; else el.onclick = handler;
    });
    row.querySelectorAll('[data-signin]').forEach((b) => b.onclick = async () => {
      try {
        const r = await api(`/api/connectors/${encodeURIComponent(name)}/signin`, { method: 'POST', body: { agent: b.dataset.signin } });
        note(`<b>A terminal window opened to sign @${esc(b.dataset.signin)} in to ${esc(c.title || name)}.</b> ${esc(r.hint || '')}<div class="hint" style="margin-top:6px">No window? Run this in Terminal: <code>${esc(r.command)}</code></div>`);
      } catch (e) { note(`<span class="err">${esc(e.message)}</span>`); }
    });
  });
}

async function testConnector(name, quiet) {
  conn.busy[name] = true; renderConnectors();
  try { const r = await api(`/api/connectors/${encodeURIComponent(name)}/test`, { method: 'POST' }); if (!quiet || !r.ok) note(esc(r.message)); }
  catch (e) { note(`<span class="err">${esc(e.message)}</span>`); }
  conn.busy[name] = false; await loadConnectors();
}
