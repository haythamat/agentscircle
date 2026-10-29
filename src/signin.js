// Sign an account in from the app, without a Terminal: run the tool's own browser sign-in
// (`claude auth login`, `codex login`) in the background, open its sign-in page in the browser,
// and pass on the code if the page shows one. It runs with the account's own settings, exactly as
// the agent's turns do, so the saved sign-in is the one AgentsCircle uses.

const os = require('os');
const spawn = require('cross-spawn');

const URL_RE = /https:\/\/[^\s"'<>]+/g;
const CODE_PROMPT_RE = /paste (the )?(code|authorization code)|enter (the )?code|code here/i;

module.exports = function createSignin({ accounts, openUrl, onUpdate }) {
  const flows = new Map(); // agent id -> flow

  function publicFlow(f) {
    return f && { agent: f.agent, state: f.state, url: f.url, wantsCode: f.wantsCode, message: f.message, startedAt: f.startedAt };
  }
  const emit = (f) => onUpdate && onUpdate(publicFlow(f));

  function start(agent) {
    const tool = accounts.tool(agent);
    if (!tool.signinArgs) throw new Error(`${tool.name} can't be signed in from the app yet. Use Log in with Terminal.`);
    cancel(agent.id);
    const env = { ...accounts.envFor(agent), BROWSER: process.env.BROWSER || '' };
    let child;
    try { child = spawn(tool.resolvedCommand || tool.command, tool.signinArgs, { env, cwd: os.homedir(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (e) { throw new Error(`Couldn't start ${tool.name}: ${e.message}`); }
    const f = { agent: agent.id, child, state: 'starting', url: null, wantsCode: false, message: `Starting ${tool.name} sign-in…`, out: '', startedAt: new Date().toISOString(), opened: false };
    flows.set(agent.id, f);
    const timer = setTimeout(() => { if (flows.get(agent.id) === f) { f.state = 'failed'; f.message = 'Sign-in timed out after 10 minutes.'; try { child.kill(); } catch { /* gone */ } emit(f); } }, 10 * 60000);
    const feed = (d) => {
      f.out = (f.out + d).slice(-20000);
      const urls = f.out.match(URL_RE) || [];
      const url = urls.find((u) => /oauth|authorize|login|auth\./i.test(u)) || null;
      if (url && !f.url) {
        f.url = url.replace(/[).,]+$/, '');
        f.state = 'browser';
        f.message = 'Finish signing in in your browser.';
        // Open it ourselves too: the tool can't always reach the browser from a background process.
        if (!f.opened) { f.opened = true; try { openUrl(f.url); } catch { /* the link is shown in the app */ } }
      }
      if (CODE_PROMPT_RE.test(f.out) && !f.wantsCode) f.wantsCode = true;
      emit(f);
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', feed); child.stderr.on('data', feed);
    child.stdin.on('error', () => {});
    child.on('error', (e) => { f.state = 'failed'; f.message = e.code === 'ENOENT' ? `${tool.name} isn't installed where AgentsCircle can find it.` : e.message; emit(f); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (flows.get(agent.id) !== f || f.state === 'failed' || f.state === 'cancelled') return;
      if (code === 0) { f.state = 'checking'; f.message = 'Signed in. Checking that it works…'; }
      else { f.state = 'failed'; f.message = (f.out.split('\n').map((l) => l.trim()).filter((l) => l && !URL_RE.test(l)).slice(-2).join(' ') || `Sign-in ended with code ${code}.`).slice(0, 300); }
      emit(f);
      if (code === 0 && f.onSignedIn) f.onSignedIn();
    });
    return publicFlow(f);
  }

  function sendCode(id, code) {
    const f = flows.get(id);
    if (!f || !f.child || f.state === 'failed') throw new Error('No sign-in is waiting for a code. Start again.');
    const clean = String(code || '').trim();
    if (!clean) throw new Error('Paste the code from the sign-in page.');
    f.child.stdin.write(clean + '\n');
    f.state = 'code-sent'; f.message = 'Code sent. Finishing sign-in…';
    emit(f);
    return publicFlow(f);
  }

  function cancel(id) {
    const f = flows.get(id);
    if (!f) return;
    f.state = 'cancelled';
    try { f.child.kill(); } catch { /* gone */ }
    flows.delete(id);
  }

  function finish(id, ok, message) {
    const f = flows.get(id);
    if (!f) return;
    f.state = ok ? 'done' : 'failed';
    f.message = message;
    emit(f);
    flows.delete(id);
  }

  return { start, sendCode, cancel, finish, get: (id) => publicFlow(flows.get(id)), flows };
};
