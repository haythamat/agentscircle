#!/usr/bin/env node
// AgentsCircle's own connector, given to every agent it runs (an MCP server over stdio).
// Tools: read the chat, see who is in the circle, hand work to another agent, ask the user
// a question, and (Claude Code only) ask permission for an action.
// It talks to the AgentsCircle app on this computer only (127.0.0.1), with a key for this run.

const http = require('http');
const readline = require('readline');

const URL_BASE = process.env.AGENTSCIRCLE_URL;          // http://127.0.0.1:<port>/api/internal
const TOKEN = process.env.AGENTSCIRCLE_TOKEN;
const RUN = process.env.AGENTSCIRCLE_RUN;
const WITH_APPROVE = process.env.AGENTSCIRCLE_APPROVALS === '1';

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function call(method, path, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(URL_BASE + path);
    const data = body ? JSON.stringify({ run: RUN, ...body }) : null;
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: { 'content-type': 'application/json', 'x-agentscircle-token': TOKEN, 'x-agentscircle-run': RUN, ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) },
    }, (res) => {
      let buf = '';
      res.on('data', (d) => (buf += d));
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { reject(new Error(`Bad answer (${res.statusCode})`)); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// Waits for the user (approvals and questions) by polling until there's an answer.
async function waitFor(first, path) {
  let r = first;
  while (r && r.pending) { await sleep(1200); r = await call('GET', `${path}/${encodeURIComponent(r.id)}`); }
  return r;
}

const TOOLS = [
  {
    name: 'read_thread',
    description: 'Read messages from the AgentsCircle group chat you are part of (the user and the other agents). Your instructions already include the recent conversation; use this for older messages or to search for something specific.',
    inputSchema: { type: 'object', properties: {
      last: { type: 'integer', description: 'How many recent messages to return (default 20, max 100).' },
      search: { type: 'string', description: 'Only messages containing this text.' },
      from: { type: 'string', description: 'Only messages from this speaker, e.g. "@codex" or "user".' },
    } },
  },
  {
    name: 'list_agents',
    description: 'List the agents in this circle: handle, which tool and account it runs on, whether it is working right now, and its skills and connectors. Use it to pick who should do a piece of work.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'mention',
    description: 'Hand a task to another agent in the circle. It starts after your turn ends (or right away when the circle runs agents in parallel) and sees the whole conversation, including your reply. Only hand off when another agent is clearly better placed or the user asked for it; don\'t hand work back and forth.',
    inputSchema: { type: 'object', properties: {
      agent: { type: 'string', description: 'Handle of the agent, e.g. "codex" or "@claude-work".' },
      task: { type: 'string', description: 'What it should do, written so it can act on it without asking.' },
    }, required: ['agent', 'task'] },
  },
  {
    name: 'commit',
    description: 'Commit changes in the project with git, through AgentsCircle. Use this instead of running git commit yourself: your sandbox may not be allowed to write to .git. Only commit when the user asked for it.',
    inputSchema: { type: 'object', properties: {
      message: { type: 'string', description: 'The commit message.' },
      files: { type: 'array', items: { type: 'string' }, description: 'Paths (relative to the project folder) of the changed files to commit.' },
      all: { type: 'boolean', description: 'Commit every uncommitted change in the project instead of listing files.' },
    }, required: ['message'] },
  },
  {
    name: 'push',
    description: 'Push the committed changes to GitHub (the folder\'s git remote), through AgentsCircle, which uses the user\'s own GitHub sign-in. Use this instead of running git push yourself: your sandbox may block the network or .git. Only push when the user asked for it. Commit first.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'ask_user',
    description: 'Ask the user a question in the chat and wait for the answer. Prefer 2-5 short options when you can; the user can always type their own answer. Use it only when you can\'t reasonably decide yourself.',
    inputSchema: { type: 'object', properties: {
      question: { type: 'string' },
      options: { type: 'array', items: { type: 'string' }, description: 'Suggested answers (optional).' },
      multiple: { type: 'boolean', description: 'Let the user pick more than one option.' },
    }, required: ['question'] },
  },
];
if (WITH_APPROVE) {
  TOOLS.push({
    name: 'approve',
    description: 'Asks the AgentsCircle user for permission to use a tool.',
    inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } }, required: ['tool_name'] },
  });
}

const text = (t) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }] });

async function callTool(name, args) {
  try {
    if (name === 'approve') {
      const input = args.input ?? args.tool_input ?? {};
      const r = await waitFor(await call('POST', '/approval', { tool_name: args.tool_name, input, tool_use_id: args.tool_use_id }), '/approval');
      const result = r && r.behavior === 'allow' ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: (r && r.message) || 'Not allowed.' };
      return text(JSON.stringify(result));
    }
    if (name === 'read_thread') return text((await call('POST', '/circle/thread', args)).text || '(no messages)');
    if (name === 'list_agents') return text((await call('POST', '/circle/agents', {})).agents);
    if (name === 'mention') {
      const r = await call('POST', '/circle/mention', args);
      return r.error ? { ...text(r.error), isError: true } : text(r.text);
    }
    if (name === 'commit') {
      const r = await call('POST', '/circle/commit', args);
      return r.error ? { ...text(r.error), isError: true } : text(r.text);
    }
    if (name === 'push') {
      const r = await call('POST', '/circle/push', args);
      return r.error ? { ...text(r.error), isError: true } : text(r.text);
    }
    if (name === 'ask_user') {
      const r = await waitFor(await call('POST', '/circle/ask', args), '/circle/ask');
      if (!r || r.error) return { ...text((r && r.error) || 'No answer.'), isError: true };
      return text(r.answer ? `The user answered: ${r.answer}` : 'The user did not answer. Decide sensibly yourself and say what you chose.');
    }
    return { ...text(`Unknown tool ${name}`), isError: true };
  } catch (e) {
    if (name === 'approve') return text(JSON.stringify({ behavior: 'deny', message: `AgentsCircle could not be reached to approve this (${e.message}).` }));
    return { ...text(`AgentsCircle could not be reached (${e.message}).`), isError: true };
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return; // notifications
  if (msg.method === 'initialize') {
    return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: (msg.params && msg.params.protocolVersion) || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'agentscircle', version: '2' } } });
  }
  if (msg.method === 'tools/list') return send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
  if (msg.method === 'tools/call') {
    const p = msg.params || {};
    return send({ jsonrpc: '2.0', id: msg.id, result: await callTool(p.name, p.arguments || {}) });
  }
  if (msg.method === 'ping') return send({ jsonrpc: '2.0', id: msg.id, result: {} });
  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
});
