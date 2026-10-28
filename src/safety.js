// Decides what an agent may do on its own and what needs your OK.
// Levels: readonly · risky (ask before risky actions, the default) · all (ask before every
// command or connector action) · full (never ask).

const LEVELS = {
  readonly: 'Read only',
  risky: 'Ask before risky actions',
  all: 'Ask before every command',
  full: 'Full auto',
};

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebSearch', 'WebFetch', 'TodoWrite', 'Task', 'Agent', 'NotebookRead', 'BashOutput', 'ListMcpResourcesTool', 'ReadMcpResourceTool', 'ExitPlanMode', 'Skill']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SAFE_CMDS = /^(ls|ll|pwd|cat|head|tail|less|wc|grep|rg|ag|fd|tree|echo|printf|which|whoami|date|env|printenv|file|stat|du|df|diff|sort|uniq|cut|jq|node -v|node --version|npm -v|npm ls|npm view|npm outdated|python3? --version|git (status|log|diff|show|branch|remote -v|rev-parse|ls-files|blame|describe|tag$|tag -l|stash list))\b/;
const RISKY_CMD = /(\bgit\s+push\b|\bgit\s+reset\s+--hard\b|\bgit\s+clean\b|\bgit\s+checkout\s+--\s|\bgit\s+branch\s+-D\b|\brm\s|\brm$|\brmdir\b|\bsudo\b|\bchmod\b|\bchown\b|\bmkfs\b|\bdd\s+if=|\bkill(all)?\b|curl[^|]*\|\s*(ba|z)?sh|wget[^|]*\|\s*(ba|z)?sh|\b(npm|yarn|pnpm|bun)\s+publish\b|\bdeploy\b|\bvercel\b[^\n]*--prod|\bnetlify\s+deploy\b|\bsupabase\s+db\s+(push|reset)\b|\bdrop\s+(table|database)\b|\btruncate\s+table\b|\bterraform\s+(apply|destroy)\b|\bkubectl\s+(delete|apply)\b|\bdocker\s+(rm|rmi|system\s+prune)\b|>\s*\/dev\/sd|\bfind\b[^\n]*-delete\b|\bgh\s+(pr\s+merge|release\s+create|repo\s+delete)\b)/i;
const MCP_READ = /^(get|list|search|read|fetch|find|describe|view|show|lookup|retrieve|check|status|preview|count|resolve|query_docs|ask)/i;
const MCP_RISKY = /(delete|drop|remove|destroy|deploy|publish|send|post_|_post|merge|execute|apply|migrat|pay|charge|refund|transfer|invite|share|create_project|reset|revoke|purge|archive)/i;

function classify(toolName, input = {}) {
  const name = String(toolName || '');
  if (READ_TOOLS.has(name)) return { kind: 'read', key: name, summary: summarize(name, input) };
  if (EDIT_TOOLS.has(name)) return { kind: 'write', key: name, summary: summarize(name, input) };
  if (name === 'Bash') {
    const cmd = String(input.command || '').trim();
    const parts = cmd.split(/&&|\|\||;|\|/).map((p) => p.trim()).filter(Boolean);
    const key = `Bash:${cmd.split(/\s+/).slice(0, 2).join(' ')}`;
    if (RISKY_CMD.test(cmd)) return { kind: 'risky', key, summary: cmd };
    if (parts.length && parts.every((p) => SAFE_CMDS.test(p) && !/[>]/.test(p))) return { kind: 'read', key, summary: cmd };
    return { kind: 'write', key, summary: cmd };
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) {
    const tool = mcp[2];
    const kind = MCP_READ.test(tool) && !MCP_RISKY.test(tool) ? 'read' : MCP_RISKY.test(tool) ? 'risky' : 'write';
    return { kind, key: name, summary: `${mcp[1]} › ${tool}${briefInput(input)}`, connector: mcp[1] };
  }
  return { kind: 'write', key: name, summary: `${name}${briefInput(input)}` };
}

function summarize(name, input) {
  const v = input.file_path || input.path || input.pattern || input.url || input.query || input.description || '';
  return `${name}${v ? ': ' + String(v).slice(0, 200) : ''}`;
}
function briefInput(input) {
  try {
    const s = JSON.stringify(input);
    return s && s !== '{}' ? ` ${s.length > 160 ? s.slice(0, 157) + '…' : s}` : '';
  } catch { return ''; }
}

// What happens without asking: 'allow' | 'deny' | 'ask'.
function decide(level, c) {
  if (c.kind === 'read') return 'allow';
  if (level === 'readonly') return 'deny';
  if (level === 'full') return 'allow';
  if (level === 'all') return 'ask';
  return c.kind === 'risky' ? 'ask' : 'allow'; // 'risky' (default)
}

module.exports = { LEVELS, classify, decide };
