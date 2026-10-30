// Opt-in anonymous usage counts: asked once, and a switch in Settings → About.
// Uses globals from index.html: $, api, esc, ic.

const uc = { state: null };
const UC_WHAT = 'Once a day, AgentsCircle would send which features you used and how many times (for example "export_docx: 2"), plus the app version and your OS. Never your code, prompts, file or project names, emails or account details. The install id is random and isn\'t linked to you.';

async function loadUsageCounts() { try { uc.state = await api('/api/usage-counts'); } catch { uc.state = null; } return uc.state; }
async function setUsageCounts(on) { uc.state = await api('/api/usage-counts', { method: 'POST', body: { enabled: on } }); return uc.state; }

// Settings → About section.
function usageCountsHtml() {
  const s = uc.state;
  if (!s) return '';
  return `<div class="psec">Usage counts</div>
    <div class="upbox">
      <label class="ucrow"><span class="switch"><input type="checkbox" id="ucToggle" ${s.enabled ? 'checked' : ''}><span></span></span>
        <span><b>Share anonymous usage counts</b><span class="hint" style="display:block;margin:2px 0 0">Helps decide what to build next. Off unless you turn it on.</span></span></label>
      <div class="hint" style="margin:8px 0 0">${esc(s.enabled ? UC_WHAT.replace('would send', 'sends') : UC_WHAT)}${s.configured ? '' : ' (This build has nowhere to send them, so nothing leaves your computer.)'}</div>
      <details class="ucpeek"><summary>See exactly what's sent</summary><pre>${esc(JSON.stringify(s.today, null, 2))}</pre><div class="hint">Today's counts so far. Days are sent after they end; turning this off deletes anything not sent yet.</div></details>
    </div>`;
}
function wireUsageCounts(rerender) {
  const t = $('ucToggle');
  if (t) t.onchange = async () => { await setUsageCounts(t.checked); rerender && rerender(); };
}

// Asked once, after first-run setup, never again.
async function maybeAskUsageCounts() {
  const s = await loadUsageCounts();
  if (!s || s.asked || !s.configured) return;
  const m = document.createElement('div');
  m.className = 'modal open'; m.id = 'ucModal'; m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-labelledby', 'ucTitle');
  m.innerHTML = `<div class="card" style="width:min(460px,94vw)">
    <h3 id="ucTitle" style="margin:0 0 6px">Help decide what we build next?</h3>
    <p class="lead" style="margin:0 0 10px">Share anonymous usage counts so we can see which features people actually use.</p>
    <div class="hint" style="margin:0">${esc(UC_WHAT)} You can turn it off any time in Settings → About.</div>
    <div class="actions"><button id="ucNo">No thanks</button><button class="primary" id="ucYes">Share usage counts</button></div></div>`;
  document.body.appendChild(m);
  const done = async (on) => { try { await setUsageCounts(on); } catch { /* try next time */ } m.remove(); };
  $('ucYes').onclick = () => done(true);
  $('ucNo').onclick = () => done(false);
}
