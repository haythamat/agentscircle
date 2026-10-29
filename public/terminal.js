// Terminal tab in the session panel: a real shell in the session's folder (xterm.js on the page,
// a shell on the server). It keeps running when you switch tabs or sessions; coming back redraws it.
// Uses globals from index.html / panel.js: $, esc, ic, current, ws, panel, openPanel, setTab.

const term = { x: null, fit: null, host: null, sessionId: null, info: null, loading: null, ro: null, exited: false, error: '' };

function loadTermLib() {
  if (window.Terminal && window.FitAddon) return Promise.resolve();
  if (term.loading) return term.loading;
  const add = (tag, attrs) => new Promise((ok, bad) => { const el = document.createElement(tag); Object.assign(el, attrs); el.onload = ok; el.onerror = () => bad(new Error('Could not load the terminal.')); document.head.appendChild(el); });
  term.loading = Promise.all([
    add('link', { rel: 'stylesheet', href: '/vendor/xterm/xterm.css' }),
    add('script', { src: '/vendor/xterm/xterm.js' }).then(() => add('script', { src: '/vendor/xterm/addon-fit.js' })),
  ]);
  return term.loading;
}

function termTheme() {
  const cs = getComputedStyle(document.documentElement), v = (n) => cs.getPropertyValue(n).trim();
  const dark = document.documentElement.dataset.scheme !== 'light';
  return {
    background: v('--code-bg') || (dark ? '#0f1113' : '#fafafa'), foreground: v('--text') || (dark ? '#e9ebed' : '#1b1d20'),
    cursor: v('--accent') || '#5cb8e4', cursorAccent: v('--code-bg') || '#0f1113', selectionBackground: v('--accent-soft') || 'rgba(92,184,228,.25)',
    ...(dark ? {} : { black: '#1b1d20', white: '#8a9198', brightWhite: '#5a6168', yellow: '#9a6700', brightYellow: '#7d5500' }),
  };
}

function sendTerm(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

function ensureXterm() {
  if (term.x) return;
  term.host = document.createElement('div');
  term.host.id = 'termHost';
  term.x = new window.Terminal({ fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono').trim() || 'Menlo, monospace', fontSize: 12.5, lineHeight: 1.15, cursorBlink: true, scrollback: 5000, theme: termTheme(), allowProposedApi: false, macOptionIsMeta: true });
  term.fit = new window.FitAddon.FitAddon();
  term.x.loadAddon(term.fit);
  term.x.onData((d) => { if (term.sessionId && !term.exited) sendTerm({ type: 'term:in', sessionId: term.sessionId, data: d }); });
  term.x.onResize(({ cols, rows }) => { if (term.sessionId && !term.exited) sendTerm({ type: 'term:resize', sessionId: term.sessionId, cols, rows }); });
  // Copy with ⌘C when text is selected; otherwise the key goes to the shell.
  term.x.attachCustomKeyEventHandler((e) => {
    if (e.type === 'keydown' && (e.metaKey || (e.ctrlKey && e.shiftKey)) && e.key.toLowerCase() === 'c' && term.x.hasSelection()) { navigator.clipboard.writeText(term.x.getSelection()).catch(() => {}); return false; }
    if (e.type === 'keydown' && e.metaKey && e.key.toLowerCase() === 'k') { term.x.clear(); return false; }
    if (e.type === 'keydown' && e.metaKey && ['j', 'w', 'n', ','].includes(e.key.toLowerCase())) return false; // app shortcuts
    return true;
  });
  term.ro = new ResizeObserver(() => fitTerm());
  new MutationObserver(() => { if (term.x) term.x.options.theme = termTheme(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-scheme'] });
}

function fitTerm() {
  if (!term.x || !term.host || !term.host.isConnected || !term.host.offsetWidth) return;
  try { term.fit.fit(); } catch { /* not visible */ }
}

async function renderTerminal() {
  const body = $('panelBody');
  body.classList.add('term-on');
  if (!term.x) body.innerHTML = '<div class="hint" style="padding:6px 2px">Starting the terminal…</div>';
  try { await loadTermLib(); } catch (e) { body.innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
  if (panel.tab !== 'terminal' || !current) return;
  ensureXterm();
  body.innerHTML = `<div class="termbar"><span class="termwhere">${ic('terminal', 'sm')}<span id="termTitle"></span></span>
    <span class="termacts"><button class="ghost ib sm" id="termClear" data-tip="Clear  ⌘K" aria-label="Clear">${ic('eraser', 'sm')}</button><button class="ghost ib sm" id="termRestart" data-tip="Restart the shell" aria-label="Restart">${ic('refresh', 'sm')}</button><button class="ghost ib sm" id="termKill" data-tip="End the shell" aria-label="End the shell">${ic('trash', 'sm')}</button></span></div>
    <div id="termNote" class="hint"></div>`;
  body.appendChild(term.host);
  if (!term.x.element) term.x.open(term.host);
  term.ro.observe(term.host);
  $('termClear').onclick = () => { term.x.clear(); term.x.focus(); };
  $('termRestart').onclick = () => startTerm(true);
  $('termKill').onclick = () => { sendTerm({ type: 'term:kill', sessionId: term.sessionId }); };
  drawTermBar();
  if (term.sessionId !== current.id || term.exited === 'switched') startTerm(false);
  requestAnimationFrame(() => { fitTerm(); term.x.refresh(0, term.x.rows - 1); term.x.focus(); });
}

function startTerm(restart) {
  if (!current || !term.x) return;
  term.sessionId = current.id; term.exited = false; term.error = ''; term.info = null;
  term.x.reset();
  fitTerm();
  sendTerm({ type: 'term:open', sessionId: current.id, cols: term.x.cols, rows: term.x.rows, restart: !!restart });
  drawTermBar();
  term.x.focus();
}

function drawTermBar() {
  const t = $('termTitle'), note = $('termNote');
  if (!t) return;
  const i = term.info;
  t.textContent = i ? `${i.shell} · ${current ? current.folder.replace(/^\/(Users|home)\/[^/]+/, '~') : ''}` : 'Starting…';
  t.title = i ? i.cwd : '';
  note.innerHTML = term.error ? `<span class="err">${esc(term.error)}</span>`
    : term.exited ? `The shell has ended. <button class="linkbtn" id="termAgain">Start a new one</button>`
    : i && i.mode !== 'pty' ? 'Basic mode: full-screen programs may not draw correctly.' : '';
  note.style.display = note.innerHTML ? '' : 'none';
  if ($('termAgain')) $('termAgain').onclick = () => startTerm(false);
  const k = $('termKill'); if (k) k.disabled = !!term.exited;
}

function onTermEvent(ev) {
  if (!term.x || ev.sessionId !== term.sessionId) return;
  if (ev.type === 'term:ready') { term.info = ev; term.x.reset(); if (ev.buffer) term.x.write(ev.buffer); term.exited = ev.alive === false; drawTermBar(); fitTerm(); }
  else if (ev.type === 'term:data') term.x.write(ev.data);
  else if (ev.type === 'term:exit') { term.exited = true; if (ev.closed) term.x.write('\r\n\x1b[2m[Shell ended]\x1b[0m\r\n'); drawTermBar(); }
  else if (ev.type === 'term:error') { term.error = ev.message; drawTermBar(); }
}

// Leaving the tab keeps the shell running; the xterm element is just taken off the page.
function leaveTerminal() { $('panelBody').classList.remove('term-on'); if (term.ro && term.host) term.ro.unobserve(term.host); }

// Switching sessions: the next visit to the tab attaches to that session's own shell.
function termSessionChanged() { if (term.x && current && term.sessionId !== current.id) { term.exited = 'switched'; if (panel.tab === 'terminal' && document.body.classList.contains('panel-open')) renderTerminal(); } }
// After the connection drops and comes back, ask for the shell again (it kept running).
function termReconnected() { if (term.x && term.sessionId && panel.tab === 'terminal' && document.body.classList.contains('panel-open') && current && current.id === term.sessionId) { term.x.reset(); sendTerm({ type: 'term:open', sessionId: term.sessionId, cols: term.x.cols, rows: term.x.rows }); } }

function toggleTerminal() {
  const open = document.body.classList.contains('panel-open');
  if (open && panel.tab === 'terminal') { closePanel(); return; }
  openPanel('terminal');
}
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === '`' || e.code === 'Backquote')) { e.preventDefault(); if (current) toggleTerminal(); }
});
