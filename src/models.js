// Which models (and effort levels) each tool offers, so you can pick them per agent in a session.
// Claude Code: its documented aliases. Codex: its own model list (with each model's effort levels).
// Cursor and OpenCode: what their `models` command lists. Anything else can be typed in.

const fs = require('fs');
const os = require('os');
const path = require('path');
const spawn = require('cross-spawn');

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const CLAUDE_MODELS = [
  { id: 'fable', label: 'Fable', description: 'Claude Code\'s alias for the latest Fable model.' },
  { id: 'opus', label: 'Opus', description: 'The latest Opus model.' },
  { id: 'sonnet', label: 'Sonnet', description: 'The latest Sonnet model.' },
  { id: 'haiku', label: 'Haiku', description: 'The latest Haiku model; fastest.' },
];

const codexHome = (agent) => agent.configDir || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
function codexModels(agent) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(codexHome(agent), 'models_cache.json'), 'utf8'));
    return (d.models || []).filter((m) => m.slug && m.visibility !== 'hide')
      .sort((a, b) => (a.priority || 99) - (b.priority || 99))
      .map((m) => ({
        id: m.slug, label: m.display_name || m.slug, description: m.description || '',
        efforts: (m.supported_reasoning_levels || m.supported_reasoning_efforts || []).map((x) => (typeof x === 'string' ? x : x && (x.effort || x.level))).filter(Boolean),
        defaultEffort: m.default_reasoning_level || m.default_reasoning_effort || null,
      }));
  } catch { return []; }
}

// `cursor-agent models` / `opencode models`: one model per line, id first.
const listed = new Map(); // tool id -> { at, models }
function listFromCommand(tool, env) {
  const hit = listed.get(tool.id);
  if (hit && Date.now() - hit.at < 10 * 60000) return hit.models;
  let models = [];
  try {
    const r = spawn.sync(tool.resolvedCommand || tool.command, ['models'], { env, encoding: 'utf8', timeout: 15000, windowsHide: true });
    const out = `${r.stdout || ''}`.replace(/\x1b\[[0-9;]*m/g, '');
    for (const line of out.split('\n')) {
      const m = /^\s*[-*•]?\s*([A-Za-z0-9][\w.:/@-]*[\w)])(?:\s+[-–:]\s+(.*))?\s*$/.exec(line);
      if (!m || /^(available|models?|tip|usage|loading)/i.test(m[1]) || m[1].length < 2) continue;
      models.push({ id: m[1], label: (m[2] || m[1]).replace(/\s*\((current|default)\)\s*$/i, ''), description: '' });
    }
  } catch { /* not available */ }
  models = models.slice(0, 200);
  listed.set(tool.id, { at: Date.now(), models });
  return models;
}

module.exports = function createModels({ accounts }) {
  // What the picker offers for this account.
  function options(agent) {
    const tool = accounts.tool(agent);
    if (tool.id === 'claude') return { models: CLAUDE_MODELS, efforts: CLAUDE_EFFORTS, perModelEfforts: false, custom: true, effortLabel: 'Effort' };
    if (tool.id === 'codex') {
      const models = codexModels(agent);
      const all = [...new Set(models.flatMap((m) => m.efforts))];
      return { models, efforts: all.length ? all : ['low', 'medium', 'high', 'xhigh'], perModelEfforts: true, custom: true, effortLabel: 'Reasoning effort', note: models.length ? '' : 'Run Codex once to load its model list. You can still type a model name.' };
    }
    if (tool.id === 'cursor' || tool.id === 'opencode') return { models: listFromCommand(tool, accounts.envFor(agent)), efforts: [], custom: true, note: tool.id === 'opencode' ? 'OpenCode models are written as provider/model.' : '' };
    return { models: [], efforts: [], custom: !!tool.modelArg };
  }

  // Command-line arguments for a model and effort, using the tool's own flags from tools.json.
  function args(tool, model, effort) {
    const out = [];
    if (model && tool.modelArg) out.push({ at: tool.modelInsertAfter, args: [tool.modelArg, model] });
    if (effort && tool.effortArg) out.push({ at: tool.effortInsertAfter, args: tool.effortArg.map((a) => a.replace('{EFFORT}', effort)) });
    return out;
  }

  return { options, args, codexModels, CLAUDE_EFFORTS };
};
