// Does this account actually work? Reading which email a tool's files mention isn't enough:
// a saved sign-in can be expired, or the tool's default model may not be allowed on the plan.
// This runs the real tool once, the way a turn does, and reports what happened in plain words.
// Codex accounts also get a model their plan accepts, picked from Codex's own model list.

const fs = require('fs');
const os = require('os');
const path = require('path');
const spawn = require('cross-spawn');

// What the tools print when their saved sign-in doesn't work.
const SIGNIN_RE = /failed to authenticate|oauth (session|token)[^\n]*(expired|invalid|revoked)|session expired|not (logged|signed) in|please (log|sign) ?in|(run|use) [`'"]?\S*\s*(\/)?login|invalid (api key|x-api-key|bearer token)|authentication (failed|required|error)|401 unauthorized|token (has )?expired|could not be refreshed/i;
// What Codex says when the plan can't use the model it asked for.
const MODEL_RE = /model_not_found|model is not supported|not supported when using codex|unsupported model|does not exist or you do not have access|model .{0,40} not (found|available)/i;

function run(cmd, args, { env, input, timeoutMs = 60000, cwd } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '', child;
    try { child = spawn(cmd, args, { env, cwd: cwd || os.tmpdir(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (e) { return resolve({ code: -1, out: '', err: e.message, missing: e.code === 'ENOENT' }); }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } err += '\n(timed out)'; }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.stdin.on('error', () => {});
    child.stdin.end(input || '');
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: err + e.message, missing: e.code === 'ENOENT' }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}
const lastLines = (s, n = 4) => String(s || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(-n).join(' ');

// Codex's model list, highest priority first (written by Codex into its home folder).
function codexModels(home) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(home, 'models_cache.json'), 'utf8'));
    return (d.models || []).filter((m) => m.slug && m.visibility !== 'hide').sort((a, b) => (a.priority || 99) - (b.priority || 99)).map((m) => m.slug);
  } catch { return []; }
}
const codexHome = (agent) => agent.configDir || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');

module.exports = function createHealth({ accounts }) {
  // One tiny real turn. Returns { state: 'ok'|'signedout'|'model'|'missing'|'error', message, text }.
  async function probe(agent, model) {
    const tool = accounts.tool(agent);
    const cmd = tool.resolvedCommand || tool.command;
    const env = accounts.envFor(agent);
    const ask = 'Reply with the single word OK.';
    let r, text = '';
    if (tool.id === 'claude') {
      r = await run(cmd, ['-p', '--output-format', 'json', '--max-turns', '1', ...(model ? ['--model', model] : [])], { env, input: ask });
      try { const j = JSON.parse(r.out.trim().split('\n').pop()); text = j.result || ''; if (j.is_error && r.code === 0) r.code = 1; } catch { text = r.out; }
    } else if (tool.id === 'codex') {
      r = await run(cmd, ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', ...(model ? ['-m', model] : []), '-'], { env, input: ask });
      const errs = [];
      for (const line of r.out.split('\n')) {
        let ev; try { ev = JSON.parse(line); } catch { if (line.trim()) errs.push(line.trim()); continue; }
        if (ev.type === 'item.completed' && ev.item && ev.item.type === 'agent_message') text += ev.item.text || '';
        if (ev.type === 'error' || ev.type === 'turn.failed') errs.push((ev.error && ev.error.message) || ev.message || '');
      }
      if (errs.length && !text) text = errs.join('\n');
      if (errs.length && r.code === 0 && !/\bok\b/i.test(text)) r.code = 1;
    } else {
      return { state: 'ok', message: 'Not checked for this tool.' };
    }
    const all = `${text}\n${r.err}`;
    if (r.missing) return { state: 'missing', message: `${tool.name} isn't installed where AgentsCircle can find it (the \`${tool.command}\` command).` };
    if (r.code === 0) return { state: 'ok', message: 'Signed in and working.', text };
    if (MODEL_RE.test(all)) return { state: 'model', message: lastLines(text || r.err, 2) };
    if (SIGNIN_RE.test(all)) return { state: 'signedout', message: `Signed out: ${lastLines(text || r.err, 2)}` };
    return { state: 'error', message: lastLines(text || r.err) || `${tool.name} exited with code ${r.code}.` };
  }

  // Check an account, and for Codex find a model the plan accepts if the default is refused.
  async function verify(agent) {
    const tool = accounts.tool(agent);
    let res = await probe(agent, agent.model || null);
    if (res.state === 'model' && tool.id === 'codex') {
      const refused = new Set([...(agent.badModels || []), ...(agent.model ? [agent.model] : [])]);
      const firstErr = res.message;
      for (const m of codexModels(codexHome(agent)).filter((x) => !refused.has(x)).slice(0, 5)) {
        const r2 = await probe(agent, m);
        if (r2.state === 'ok') { accounts.update(agent.id, { model: m, badModels: [...refused] }); res = { ...r2, message: `Signed in and working, on ${m} (your plan doesn't include the default model).`, switchedModel: m }; break; }
        if (r2.state !== 'model') { res = r2; break; }
        refused.add(m);
      }
      if (res.state === 'model') res.message = `None of Codex's models were accepted for this account. ${firstErr}`;
    }
    agent.health = { ...res, checkedAt: new Date().toISOString() };
    return agent.health;
  }

  return { verify, probe, codexModels: (agent) => codexModels(codexHome(agent)), SIGNIN_RE, MODEL_RE };
};
