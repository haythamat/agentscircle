// Skills and capabilities.
// - Shared skills: folders with a SKILL.md, kept in ~/.agentscircle/skills (for every project)
//   or in the project (skills/, .claude/skills/, .agentscircle/skills/). Every agent is told
//   about them in its prompt and reads the SKILL.md when a task calls for it.
// - Capabilities: what each agent already has in its own setup (its skills and connectors),
//   so AgentsCircle can show it and warn when you ask an agent for something it lacks.

const fs = require('fs');
const os = require('os');
const path = require('path');
const TOML = require('smol-toml');
const AdmZip = require('adm-zip');

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

function readSkill(dir) {
  const file = path.join(dir, 'SKILL.md');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const fm = /^---\s*\n([\s\S]*?)\n---/.exec(text);
  const meta = {};
  if (fm) for (const line of fm[1].split('\n')) { const m = /^([a-zA-Z_-]+):\s*(.*)$/.exec(line); if (m) meta[m[1].toLowerCase()] = m[2].replace(/^["']|["']$/g, '').trim(); }
  return { name: meta.name || path.basename(dir), description: (meta.description || text.replace(/^---[\s\S]*?---/, '').trim().split('\n').find((l) => l.trim() && !l.startsWith('#')) || '').slice(0, 300), dir, file };
}

function listSkills(root) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => readSkill(path.join(root, e.name))).filter(Boolean);
}

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const readToml = (f) => { try { return TOML.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

module.exports = function createSkills({ dataDir, accounts }) {
  const globalDir = path.join(dataDir, 'skills');
  fs.mkdirSync(globalDir, { recursive: true });

  const PROJECT_DIRS = ['skills', '.claude/skills', '.agentscircle/skills'];

  // Skills every agent in this project gets told about.
  function shared(folder) {
    const out = listSkills(globalDir).map((s) => ({ ...s, scope: 'all projects' }));
    if (folder) for (const d of PROJECT_DIRS) for (const s of listSkills(path.join(folder, d))) out.push({ ...s, scope: 'this project', rel: path.relative(folder, s.file) });
    const seen = new Set();
    return out.filter((s) => (seen.has(s.name) ? false : seen.add(s.name)));
  }

  // What an agent has in its own setup.
  function capabilities(agent, folder) {
    const tool = accounts.tool(agent);
    const home = os.homedir();
    const skills = [];
    const connectors = [];
    const addConn = (name, source) => { if (!connectors.some((c) => c.name === name)) connectors.push({ name, source }); };
    if (tool.id === 'claude') {
      const base = agent.configDir || path.join(home, '.claude');
      for (const s of listSkills(path.join(base, 'skills'))) skills.push({ name: s.name, description: s.description, source: 'its own skills', dir: s.dir });
      const cfg = readJson(agent.configDir ? path.join(agent.configDir, '.claude.json') : path.join(home, '.claude.json')) || {};
      for (const n of Object.keys(cfg.mcpServers || {})) addConn(n, 'its own settings');
      if (folder && cfg.projects && cfg.projects[folder]) for (const n of Object.keys(cfg.projects[folder].mcpServers || {})) addConn(n, 'its settings for this project');
      if (folder) for (const n of Object.keys((readJson(path.join(folder, '.mcp.json')) || {}).mcpServers || {})) addConn(n, 'project .mcp.json');
    } else if (tool.id === 'codex') {
      const base = agent.configDir || path.join(home, '.codex');
      for (const s of listSkills(path.join(base, 'skills'))) skills.push({ name: s.name, description: s.description, source: 'its own skills', dir: s.dir });
      for (const n of Object.keys((readToml(path.join(base, 'config.toml')) || {}).mcp_servers || {})) addConn(n, 'its own settings');
    } else if (tool.id === 'cursor') {
      for (const n of Object.keys((readJson(path.join(home, '.cursor', 'mcp.json')) || {}).mcpServers || {})) addConn(n, 'its own settings');
      if (folder) for (const n of Object.keys((readJson(path.join(folder, '.cursor', 'mcp.json')) || {}).mcpServers || {})) addConn(n, 'project .cursor/mcp.json');
    }
    return { skills, connectors };
  }

  // Copy one of an agent's own skills into the shared skills, so every agent can use it.
  function shareFromAgent(agent, name) {
    const cap = capabilities(agent);
    const s = cap.skills.find((x) => x.name === name);
    if (!s) throw new Error('Skill not found.');
    const dest = path.join(globalDir, safeName(path.basename(s.dir)));
    fs.cpSync(s.dir, dest, { recursive: true });
    return readSkill(dest);
  }

  // Install a skill from a .zip (for example one downloaded from the Claude app).
  function installZip(buf, scope, folder) {
    let zip;
    try { zip = new AdmZip(buf); } catch { throw new Error('That file is not a valid .zip.'); }
    const entries = zip.getEntries().filter((e) => !e.isDirectory && !/(^|\/)(__MACOSX|\.DS_Store)/.test(e.entryName));
    const skillMd = entries.find((e) => /(^|\/)SKILL\.md$/i.test(e.entryName));
    if (!skillMd) throw new Error('No SKILL.md found in the .zip.');
    const prefix = skillMd.entryName.replace(/SKILL\.md$/i, '');
    const meta = readSkillText(skillMd.getData().toString('utf8'));
    const name = safeName(meta.name || (prefix.split('/').filter(Boolean).pop()) || 'skill');
    const root = scope === 'project' && folder ? path.join(folder, '.agentscircle', 'skills') : globalDir;
    const dest = path.join(root, name);
    fs.mkdirSync(dest, { recursive: true });
    for (const e of entries) {
      if (!e.entryName.startsWith(prefix)) continue;
      const rel = e.entryName.slice(prefix.length);
      const out = path.resolve(dest, rel);
      if (path.relative(dest, out).startsWith('..')) continue; // zip-slip guard
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, e.getData());
    }
    return readSkill(dest);
  }

  function remove(name, folder) {
    const s = shared(folder).find((x) => x.name === name);
    if (!s) throw new Error('Skill not found.');
    if (s.scope === 'this project' && !s.dir.includes(`${path.sep}.agentscircle${path.sep}`)) throw new Error('This skill lives in your project files. Delete its folder there if you want it gone.');
    fs.rmSync(s.dir, { recursive: true, force: true });
  }

  return { shared, capabilities, shareFromAgent, installZip, remove, globalDir };
};

function readSkillText(text) {
  const fm = /^---\s*\n([\s\S]*?)\n---/.exec(text);
  const meta = {};
  if (fm) for (const line of fm[1].split('\n')) { const m = /^([a-zA-Z_-]+):\s*(.*)$/.exec(line); if (m) meta[m[1].toLowerCase()] = m[2].replace(/^["']|["']$/g, '').trim(); }
  return meta;
}
function safeName(n) {
  const s = String(n).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  if (!NAME_RE.test(s)) throw new Error('Bad skill name.');
  return s;
}
