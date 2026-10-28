// Look and feel: themes, layout options, icons on fixed controls, tooltips, keyboard shortcuts.
// Uses globals from index.html: $, api, esc, current, openSettings.

const THEMES = {
  dark: [
    { id: 'graphite', name: 'Graphite', sw: ['#0e1012', '#17191c', '#e9ebed', '#5cb8e4', '#2b3035'] },
    { id: 'midnight', name: 'Midnight', sw: ['#0a0e19', '#111829', '#e6ebf5', '#7aa7ff', '#26324f'] },
    { id: 'obsidian', name: 'Obsidian (high contrast)', sw: ['#000000', '#0c0c0d', '#ffffff', '#6fd3ff', '#3a3a40'] },
  ],
  light: [
    { id: 'daylight', name: 'Daylight', sw: ['#ebedea', '#ffffff', '#16191c', '#0e72b0', '#dcdfdb'] },
    { id: 'mist', name: 'Mist', sw: ['#e7ebf1', '#ffffff', '#121826', '#3b5bdb', '#d8dee8'] },
    { id: 'contrast', name: 'Paper (high contrast)', sw: ['#f2f2f2', '#ffffff', '#000000', '#0050a0', '#7d8186'] },
  ],
};
const LOOK_KEY = 'agentscircle:look';
const look = (() => {
  const def = { mode: 'system', dark: 'graphite', light: 'daylight', side: 'left', panel: 'right', density: 'comfortable', chat: 'readable', fontSize: 13.5, sidebar: true };
  let p = {}; try { p = JSON.parse(localStorage.getItem(LOOK_KEY) || '{}'); } catch { /* private window */ }
  let old = null; try { old = localStorage.getItem('agentscircle:theme'); } catch { /* ignore */ }
  if (!p.mode && (old === 'light' || old === 'dark')) p.mode = old;
  return { ...def, ...p };
})();
const saveLook = () => { try { localStorage.setItem(LOOK_KEY, JSON.stringify(look)); } catch { /* private window */ } };
const darkQuery = matchMedia('(prefers-color-scheme: dark)');

function applyLook() {
  const dark = look.mode === 'dark' || (look.mode === 'system' && darkQuery.matches);
  const r = document.documentElement;
  r.dataset.theme = dark ? look.dark : look.light;
  r.dataset.scheme = dark ? 'dark' : 'light';
  const b = document.body;
  b.classList.toggle('side-right', look.side === 'right');
  b.classList.toggle('panel-bottom', look.panel === 'bottom');
  b.classList.toggle('density-compact', look.density === 'compact');
  b.classList.toggle('chat-wide', look.chat === 'wide');
  b.classList.toggle('side-hidden', !look.sidebar);
  r.style.setProperty('--fs', look.fontSize + 'px');
  $('sideShow').style.display = look.sidebar ? 'none' : '';
  document.querySelectorAll('#themes button, #themes2 button').forEach((x) => { x.classList.toggle('on', x.dataset.t === look.mode); x.setAttribute('aria-checked', x.dataset.t === look.mode); });
  if (typeof updateTabCounts === 'function') updateTabCounts();
  renderAppearance();
}
// Older code calls applyTheme(mode).
function applyTheme(mode) { look.mode = mode; saveLook(); applyLook(); }
darkQuery.addEventListener('change', () => { if (look.mode === 'system') applyLook(); });

// ---------- Settings → Appearance ----------
function themeCard(t, kind) {
  const on = look[kind] === t.id;
  const [rail, panel, text, accent, line] = t.sw;
  return `<button class="themecard${on ? ' on' : ''}" data-theme-pick="${kind}:${t.id}" aria-pressed="${on}">
    <div class="sw" style="background:${panel}"><div class="r" style="background:${rail}"><i style="background:${text}"></i><i style="background:${text};width:70%"></i><i style="background:${accent};opacity:.9"></i></div>
    <div class="c"><i style="background:${text};width:62%;opacity:.85"></i><i style="background:${line};width:90%"></i><i style="background:${line};width:74%"></i><i style="background:${accent};width:34%"></i></div></div>
    <div class="nm">${esc(t.name)}${ic('check', 'sm')}</div></button>`;
}
function seg(key, options) {
  return `<div class="seg ctl">${options.map(([v, label]) => `<button data-look="${key}:${v}" class="${String(look[key]) === String(v) ? 'on' : ''}">${label}</button>`).join('')}</div>`;
}
function renderAppearance() {
  const dt = $('darkThemes'); if (!dt) return;
  dt.innerHTML = THEMES.dark.map((t) => themeCard(t, 'dark')).join('');
  $('lightThemes').innerHTML = THEMES.light.map((t) => themeCard(t, 'light')).join('');
  const row = (title, sub, ctl) => `<div class="row-s"><div class="txt"><b>${title}</b><span>${sub}</span></div>${ctl}</div>`;
  $('layoutPrefs').innerHTML =
    row('Sidebar', 'Which side the sessions list sits on. ⌘B hides it.', seg('side', [['left', 'Left'], ['right', 'Right']]))
    + row('Session panel', 'Beside the chat, or below it like a terminal panel. ⌘J toggles it.', seg('panel', [['right', 'Beside'], ['bottom', 'Below']]))
    + row('Density', 'Compact fits more messages on screen.', seg('density', [['comfortable', 'Comfortable'], ['compact', 'Compact']]))
    + row('Chat width', 'Readable keeps lines short; Wide uses the whole window.', seg('chat', [['readable', 'Readable'], ['wide', 'Wide']]))
    + row('Text size', 'Size of the interface and messages.', seg('fontSize', [[12.5, 'Small'], [13.5, 'Default'], [14.5, 'Large'], [15.5, 'Larger']]));
  const mod = /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl+';
  $('kbdList').innerHTML = [
    ['New session', `${mod}N`], ['Toggle sidebar', `${mod}B`], ['Toggle session panel', `${mod}J`], ['Settings', `${mod},`],
    ['Focus the message box', '/'], ['Pick an agent', '@'], ['Send', '↵'], ['New line', '⇧↵'], ['Close a dialog', 'Esc'],
  ].map(([a, k]) => `<span>${a}</span><span>${k.split(/(?<=⌘|Ctrl\+)/).map((x) => `<kbd>${x.replace('+', '')}</kbd>`).join(' ')}</span>`).join('');
}
document.addEventListener('click', (e) => {
  const tp = e.target.closest('[data-theme-pick]');
  if (tp) {
    const [kind, id] = tp.dataset.themePick.split(':');
    look[kind] = id;
    // Picking a dark theme while in light mode (or the reverse) switches to it, like VS Code.
    const dark = look.mode === 'dark' || (look.mode === 'system' && darkQuery.matches);
    if ((kind === 'dark') !== dark) look.mode = kind;
    saveLook(); applyLook(); return;
  }
  const lk = e.target.closest('[data-look]');
  if (lk) {
    const [key, v] = lk.dataset.look.split(':');
    look[key] = key === 'fontSize' ? Number(v) : v;
    saveLook(); applyLook();
  }
});
document.querySelectorAll('#themes button, #themes2 button').forEach((b) => b.onclick = () => applyTheme(b.dataset.t));

// ---------- icons on fixed controls ----------
function paintIcons() {
  $('brandMark').outerHTML = logoMark();
  $('sideHide').innerHTML = ic('sidebar');
  $('sideShow').innerHTML = ic('sidebar');
  $('newBtn').innerHTML = `${ic('plus')}New session<kbd>${/Mac/.test(navigator.platform) ? '⌘N' : 'Ctrl N'}</kbd>`;
  $('searchIc').outerHTML = ic('search', 'sm');
  $('acctBtn').innerHTML = `${ic('settings')}Settings`;
  const tb = $('themes').querySelectorAll('button');
  tb[0].innerHTML = ic('sun', 'sm'); tb[1].innerHTML = ic('monitor', 'sm'); tb[2].innerHTML = ic('moon', 'sm');
  $('importBtn').innerHTML = ic('import');
  $('exportBtn').innerHTML = ic('export');
  $('attachBtn').innerHTML = ic('attach');
  $('sendBtn').innerHTML = ic('send');
  $('panelClose').innerHTML = ic('x');
  document.querySelectorAll('[data-ic]').forEach((el) => { el.outerHTML = ic(el.dataset.ic); });
  const tabs = { progress: 'layout', files: 'file', used: 'sparkle', branches: 'branch' };
  document.querySelectorAll('#panelTabs button').forEach((b) => { if (!b.querySelector('.ic')) b.insertAdjacentHTML('afterbegin', ic(tabs[b.dataset.tab], 'sm')); });
}
paintIcons();

// ---------- sidebar show / hide ----------
function setSidebar(on) { look.sidebar = on; saveLook(); applyLook(); }
$('sideHide').onclick = () => setSidebar(false);
$('sideShow').onclick = () => setSidebar(true);

// ---------- tooltips: delay the first, then instant while moving between controls ----------
const tip = document.createElement('div'); tip.className = 'tipbox'; document.body.appendChild(tip);
let tipTimer = null, tipWarm = false, tipCool = null, tipFor = null;
function showTip(el) {
  const text = el.dataset.tip; if (!text) return;
  tip.textContent = text; tip.classList.toggle('instant', tipWarm);
  const r = el.getBoundingClientRect();
  tip.style.left = '0px'; tip.style.top = '0px'; tip.classList.add('show');
  const w = tip.offsetWidth, h = tip.offsetHeight;
  let top = r.bottom + 6; if (top + h > innerHeight - 6) top = r.top - h - 6;
  const left = Math.max(6, Math.min(innerWidth - w - 6, r.left + r.width / 2 - w / 2));
  tip.style.left = left + 'px'; tip.style.top = top + 'px';
  tipWarm = true; clearTimeout(tipCool);
}
function hideTip() { clearTimeout(tipTimer); tip.classList.remove('show'); tipFor = null; tipCool = setTimeout(() => { tipWarm = false; }, 400); }
document.addEventListener('pointerover', (e) => {
  if (e.pointerType !== 'mouse') return;
  const el = e.target.closest('[data-tip]');
  if (el === tipFor) return;
  if (!el) return hideTip();
  tipFor = el; clearTimeout(tipTimer);
  if (tipWarm) showTip(el); else tipTimer = setTimeout(() => showTip(el), 550);
});
document.addEventListener('pointerdown', hideTip, true);
addEventListener('scroll', hideTip, true);

// ---------- Needs-you list follows its button ----------
const needsObserver = new MutationObserver(() => {
  const list = $('needsList');
  if (!list.classList.contains('open')) return;
  const r = $('needsBtn').getBoundingClientRect();
  list.style.top = (r.bottom + 6) + 'px';
  list.style.left = Math.min(r.left, innerWidth - 346) + 'px';
});
needsObserver.observe($('needsList'), { attributes: true, attributeFilter: ['class'] });

// ---------- keyboard ----------
const isMod = (e) => (/Mac/.test(navigator.platform) ? e.metaKey : e.ctrlKey) && !e.altKey;
document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '') || (e.target && e.target.isContentEditable);
  if (e.key === 'Escape') {
    const open = [...document.querySelectorAll('.modal.open')].pop();
    if (open) { open.classList.remove('open'); e.preventDefault(); return; }
    if ($('needsList').classList.contains('open')) { $('needsList').classList.remove('open'); return; }
  }
  if (isMod(e) && e.key.toLowerCase() === 'b') { e.preventDefault(); setSidebar(!look.sidebar); return; }
  if (isMod(e) && e.key.toLowerCase() === 'j') { e.preventDefault(); if (typeof openPanel === 'function') (document.body.classList.contains('panel-open') ? closePanel() : openPanel()); return; }
  if (isMod(e) && e.key.toLowerCase() === 'n' && !e.shiftKey) { e.preventDefault(); $('newBtn').click(); return; }
  if (isMod(e) && e.key === ',') { e.preventDefault(); openSettings('accounts'); return; }
  if (!typing && e.key === '/' && current) { e.preventDefault(); $('input').focus(); }
});
// Clicking the dimmed area around a dialog closes it.
document.querySelectorAll('.modal').forEach((m) => m.addEventListener('mousedown', (e) => { if (e.target === m && m.id !== 'setupModal') m.classList.remove('open'); }));

applyLook();
