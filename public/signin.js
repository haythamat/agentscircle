// Sign an account in from the app: AgentsCircle runs the tool's own sign-in, your browser opens
// the provider's sign-in page, and this window follows along (and takes the code if the page shows one).
// Uses globals from index.html: $, api, esc, tile, agents, agentMap, showLogin, watchSignIn, renderAccounts.

const si = { id: null, opts: {}, flow: null };

function siStep(n, text, state) {
  return `<div class="sistep ${state}"><span class="num">${state === 'done' ? ic('check', 'sm') : n}</span><span>${text}</span></div>`;
}
function drawSignin() {
  const f = si.flow || {}, a = agentMap()[si.id] || {};
  const tool = a.toolName || 'the tool';
  const site = a.tool === 'codex' ? 'OpenAI' : a.tool === 'claude' ? 'Anthropic' : tool;
  const s = f.state || 'starting';
  const opened = ['browser', 'code-sent', 'checking', 'done'].includes(s);
  const signed = ['checking', 'done'].includes(s);
  $('siTile').innerHTML = tile(si.id, a.color);
  $('siTitle').textContent = s === 'done' ? `@${si.id} is signed in` : `Sign in @${si.id}`;
  $('siSteps').innerHTML =
    siStep(1, opened ? `${site}'s sign-in page opened in your browser.${f.url ? ` <a href="${esc(f.url)}" target="_blank" rel="noopener">Open it again</a>` : ''}` : `Opening ${site}'s sign-in page in your browser…`, opened ? 'done' : 'now') +
    siStep(2, `Sign in with the account you want <b>@${esc(si.id)}</b> to use, and approve access.`, signed ? 'done' : opened ? 'now' : '') +
    siStep(3, s === 'checking' ? 'Checking that it works…' : s === 'done' ? esc(f.message || 'Signed in and working.') : 'AgentsCircle checks it works, and you\'re done.', s === 'done' ? 'done' : s === 'checking' ? 'now' : '');
  $('siCodeBox').style.display = f.wantsCode && !signed ? '' : 'none';
  $('siErr').textContent = s === 'failed' ? (f.message || 'Sign-in failed.') : '';
  $('siClose').textContent = s === 'done' ? 'Done' : s === 'failed' ? 'Close' : 'Cancel';
  $('siClose').className = s === 'done' ? 'primary' : '';
  $('siTerminal').style.display = s === 'done' ? 'none' : '';
  if (s === 'failed') $('siTerminal').textContent = 'Try with Terminal instead';
}

async function openSignin(id, opts = {}) {
  si.id = id; si.opts = opts; si.flow = { state: 'starting' };
  $('siCode').value = ''; $('siErr').textContent = '';
  drawSignin();
  $('signinModal').classList.add('open');
  try { si.flow = await api(`/api/agents/${id}/signin`, { method: 'POST' }); }
  catch (e) { si.flow = { state: 'failed', message: e.message }; }
  drawSignin();
}

function onSigninEvent(f) {
  if (!f || f.agent !== si.id) return;
  const was = si.flow && si.flow.state;
  si.flow = f;
  drawSignin();
  if (f.wantsCode && was !== f.state && !['checking', 'done'].includes(f.state)) setTimeout(() => $('siCode').focus(), 50);
  if (f.state === 'done' && was !== 'done') {
    api('/api/agents').then((l) => { agents = l; if (typeof renderAccounts === 'function') renderAccounts(); if (typeof renderChips === 'function' && current) renderChips(); }).catch(() => {});
    if (si.opts.retry && current) api(`/api/sessions/${current.id}/turns/${si.opts.retry}/retry`, { method: 'POST' }).catch(() => {});
    if (si.opts.onDone) si.opts.onDone();
  }
}

$('siSend').onclick = async () => {
  try { si.flow = await api(`/api/agents/${si.id}/signin/code`, { method: 'POST', body: { code: $('siCode').value } }); drawSignin(); }
  catch (e) { $('siErr').textContent = e.message; }
};
$('siCode').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $('siSend').click(); } };
$('siClose').onclick = () => {
  const s = si.flow && si.flow.state;
  if (!['done', 'failed'].includes(s)) api(`/api/agents/${si.id}/signin/cancel`, { method: 'POST' }).catch(() => {});
  $('signinModal').classList.remove('open');
  si.id = null;
};
$('siTerminal').onclick = async () => {
  const id = si.id;
  api(`/api/agents/${id}/signin/cancel`, { method: 'POST' }).catch(() => {});
  $('signinModal').classList.remove('open'); si.id = null;
  try { const r = await api(`/api/agents/${id}/login`, { method: 'POST' }); if (typeof showLogin === 'function') showLogin(r, id); if (typeof watchSignIn === 'function') watchSignIn(id); } catch (e) { alert(e.message); }
};
