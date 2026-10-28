// "Needs you": every agent waiting for an answer or an OK, across all sessions, plus
// notifications, a sound and the Dock badge. Uses globals from index.html: api, esc, $, current,
// openSession, agentMap, loadSessions.

const NOTIFY_KEY = 'agentscircle:notify';
const notifyPrefs = (() => {
  const def = { needs: true, done: true, sound: true };
  try { return { ...def, ...JSON.parse(localStorage.getItem(NOTIFY_KEY) || '{}') }; } catch { return def; }
})();
const saveNotifyPrefs = () => { try { localStorage.setItem(NOTIFY_KEY, JSON.stringify(notifyPrefs)); } catch { /* private window */ } };

let needItems = [];
const deskApi = window.agentscircleDesktop || null;

function renderNeeds() {
  const n = needItems.length;
  const btn = $('needsBtn');
  btn.style.display = n ? '' : 'none';
  btn.innerHTML = `${ic('bell', 'sm')}Needs you <b>${n}</b>`;
  if (deskApi && deskApi.setBadge) deskApi.setBadge(n);
  if (!n) $('needsList').classList.remove('open');
  $('needsList').innerHTML = needItems.map((it) => {
    const a = agentMap()[it.agent];
    return `<div class="need" data-s="${it.sessionId}" data-m="${it.messageId}">${tile(it.agent, a ? a.color : '')}
      <div class="nh"><span class="handle">@${esc(it.agent)}</span> ${it.kind === 'question' ? 'asks' : 'wants your OK'} <span class="hint" style="margin:0">· ${esc(it.sessionName)}</span></div>
      <div class="nt">${esc(String(it.text || '').slice(0, 140))}</div></div>`;
  }).join('');
  $('needsList').querySelectorAll('.need').forEach((el) => el.onclick = () => { $('needsList').classList.remove('open'); goToMessage(el.dataset.s, el.dataset.m); });
}
async function goToMessage(sessionId, messageId) {
  if (!current || current.id !== sessionId) await openSession(sessionId);
  const el = document.getElementById('m-' + messageId);
  if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1500); }
}
$('needsBtn').onclick = (e) => { e.stopPropagation(); $('needsList').classList.toggle('open'); };
document.addEventListener('click', (e) => { if (!e.target.closest('#needsList')) $('needsList').classList.remove('open'); });

// A short two-note chime (no sound file needed).
let audioCtx = null;
function chime(kind) {
  if (!notifyPrefs.sound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const notes = kind === 'done' ? [660, 880] : [880, 660, 880];
    notes.forEach((f, i) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = f; o.type = 'sine';
      const t = audioCtx.currentTime + i * 0.13;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.15, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
      o.connect(g).connect(audioCtx.destination); o.start(t); o.stop(t + 0.13);
    });
  } catch { /* no audio */ }
}

const LABEL = { question: 'has a question', approval: 'wants your OK', done: 'finished', error: 'ran into an error', limited: 'hit its usage limit', timeout: 'ran out of time' };
function onNotify(ev) {
  const needs = ev.kind === 'question' || ev.kind === 'approval';
  if (needs ? !notifyPrefs.needs : !notifyPrefs.done) return;
  // Finished turns only interrupt you when you're looking elsewhere.
  const looking = document.hasFocus() && current && current.id === ev.sessionId;
  if (!needs && looking) return;
  chime(needs ? 'needs' : 'done');
  if (looking) return;
  if (!('Notification' in window)) return;
  const show = () => {
    const n = new Notification(`@${ev.agent} ${LABEL[ev.kind] || ev.kind}`, { body: `${ev.sessionName}${ev.text ? ' · ' + String(ev.text).slice(0, 160) : ''}`, tag: `${ev.sessionId}:${ev.messageId}:${ev.kind}`, silent: true });
    n.onclick = () => { window.focus(); goToMessage(ev.sessionId, ev.messageId); n.close(); };
  };
  if (Notification.permission === 'granted') show();
  else if (Notification.permission !== 'denied') Notification.requestPermission().then((p) => { if (p === 'granted') show(); });
}

// Called from the websocket handler in index.html.
function handleAttentionEvent(ev) {
  if (ev.type === 'attention') { needItems = ev.items || []; renderNeeds(); loadSessions(); return true; }
  if (ev.type === 'notify') { onNotify(ev); return true; }
  return false;
}
api('/api/attention').then((items) => { needItems = items; renderNeeds(); }).catch(() => {});

// Settings → Appearance → Notifications
function renderNotifyPrefs() {
  const box = $('notifyPrefs'); if (!box) return;
  const row = (k, title, sub) => `<div class="row-s" style="padding:10px 0"><div class="txt"><b>${title}</b><span>${sub}</span></div><label class="switch ctl"><input type="checkbox" data-np="${k}" ${notifyPrefs[k] ? 'checked' : ''}><span></span></label></div>`;
  box.innerHTML = row('needs', 'When an agent needs you', 'A question or an action waiting for your OK.')
    + row('done', 'When an agent finishes', 'Only when you\'re in another app or another session.')
    + row('sound', 'Play a sound', 'A short chime with each notification.');
  box.querySelectorAll('[data-np]').forEach((c) => c.onchange = () => {
    notifyPrefs[c.dataset.np] = c.checked; saveNotifyPrefs();
    if (c.checked && c.dataset.np !== 'sound' && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  });
}
renderNotifyPrefs();
