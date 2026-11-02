// Bring in a conversation from a share link: claude.ai/share/<id> or chatgpt.com/s/<id> (ChatGPT and Codex).
// Both sites sit behind a bot check, so a plain request is often refused. In the desktop app we then retry
// from a hidden browser window (global.agentscircleBrowserFetch, set in electron/main.js), which passes it.

const PER_MESSAGE = 12000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

function parseUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return null; }
  const host = u.hostname.replace(/^www\./, '');
  const m = u.pathname.match(/^\/(?:share|s)\/([A-Za-z0-9_-]{8,})\/?$/);
  if (!m) return null;
  if (host === 'claude.ai') return { kind: 'claude', id: m[1], origin: 'https://claude.ai', page: u.href };
  if (host === 'chatgpt.com' || host === 'chat.openai.com') return { kind: 'chatgpt', id: m[1], origin: 'https://' + host, page: u.href, codex: m[1].startsWith('cx_') };
  return null;
}

function apiUrls(p) {
  if (p.kind === 'claude') return [`${p.origin}/api/chat_snapshots/${p.id}?rendering_mode=messages&render_all_tools=true`];
  const list = [`${p.origin}/backend-api/share/${p.id}`];
  if (p.codex) list.push(`${p.origin}/backend-api/codex/shared/${p.id}`, `${p.origin}/backend-api/wham/shared/${p.id}`);
  return list;
}

const isJson = (t) => /^\s*[\[{]/.test(t);

async function getJson(p, browserFetch) {
  let blocked = false, notFound = false;
  for (const url of apiUrls(p)) {
    let status = 0, body = '';
    try {
      const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json', referer: p.page }, signal: AbortSignal.timeout(20000) });
      status = r.status; body = await r.text();
    } catch { /* network error: try the browser route */ }
    if (status === 200 && isJson(body)) { try { return JSON.parse(body); } catch { /* fall through */ } }
    if (status === 404) { notFound = true; continue; }
    blocked = true;
  }
  if (blocked && typeof browserFetch === 'function') {
    for (const url of apiUrls(p)) {
      try {
        const r = await browserFetch(p.page, url);
        if (r && r.status === 200 && isJson(r.body)) return JSON.parse(r.body);
        if (r && r.status === 404) notFound = true;
      } catch { /* try the next one */ }
    }
  }
  if (notFound && !blocked) throw new Error('That share link was not found. It may have been deleted or made private.');
  throw new Error(blocked
    ? "The site refused an automatic download of that link (it checks for bots). Open the link, copy the conversation, and paste it in the box below."
    : 'Could not read that share link.');
}

const clip = (t) => (t.length > PER_MESSAGE ? t.slice(0, PER_MESSAGE) + '\n…(cut)' : t);
const slugify = (s) => String(s || 'artifact').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'artifact';
const EXT = { 'text/html': 'html', 'application/vnd.ant.code': 'txt', 'image/svg+xml': 'svg', 'application/vnd.ant.mermaid': 'mmd', 'application/vnd.ant.react': 'jsx', 'text/markdown': 'md' };

// claude.ai snapshot: { snapshot_name, chat_messages: [{ sender, text, content: [{ type, text | name, input }] }] }
function fromClaude(j) {
  const msgs = [], artifacts = [];
  const seen = new Map();
  for (const m of j.chat_messages || []) {
    const role = m.sender === 'human' ? 'user' : 'assistant';
    const parts = [];
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (b && b.type === 'text' && b.text) parts.push(b.text);
      else if (b && b.type === 'tool_use' && b.name === 'artifacts' && b.input && typeof b.input === 'object') {
        const i = b.input, key = i.id || i.title || 'artifact';
        if (typeof i.content === 'string' && i.content && (i.command === 'create' || i.command === 'rewrite' || !i.command)) {
          const ext = (i.language && /^[a-z0-9]+$/i.test(i.language) ? i.language : null) || EXT[i.type] || 'txt';
          let a = seen.get(key);
          if (!a) { a = { name: `${slugify(i.title || key)}.${ext}`, content: '' }; seen.set(key, a); artifacts.push(a); }
          a.content = i.content;
        } else if (i.command === 'update' && typeof i.new_str === 'string' && seen.has(key) && typeof i.old_str === 'string') {
          const a = seen.get(key); a.content = a.content.replace(i.old_str, i.new_str);
        }
        parts.push(`[Artifact: ${i.title || key}]`);
      }
    }
    if (!parts.length && m.text) parts.push(m.text);
    const text = parts.join('\n\n').trim();
    if (text) msgs.push({ role, text: clip(text), at: m.created_at ? Date.parse(m.created_at) || undefined : undefined });
  }
  return { title: j.snapshot_name || j.title || 'Claude conversation', msgs, artifacts, source: 'a claude.ai share link' };
}

const partText = (parts) => (Array.isArray(parts) ? parts : [parts]).map((p) => (typeof p === 'string' ? p : p && typeof p.text === 'string' ? p.text : '')).filter(Boolean).join('\n');

// ChatGPT / Codex share: { title, mapping: { id: { message, parent, children } }, current_node } or a flat list.
function fromChatgpt(j, codex) {
  let nodes = [];
  if (j.mapping && typeof j.mapping === 'object') {
    let id = j.current_node;
    const chain = [];
    while (id && j.mapping[id] && chain.length < 5000) { chain.push(j.mapping[id]); id = j.mapping[id].parent; }
    nodes = chain.reverse().map((n) => n.message).filter(Boolean);
  } else if (Array.isArray(j.linear_conversation)) nodes = j.linear_conversation.map((n) => n.message || n).filter(Boolean);
  else if (Array.isArray(j.messages)) nodes = j.messages;
  const msgs = [];
  for (const m of nodes) {
    const role = (m.author && m.author.role) || m.role;
    if (role !== 'user' && role !== 'assistant') continue;
    if (m.metadata && m.metadata.is_visually_hidden_from_conversation) continue;
    const c = m.content;
    const text = (c && c.parts ? partText(c.parts) : c && typeof c.text === 'string' ? c.text : typeof c === 'string' ? c : '').trim();
    if (text) msgs.push({ role, text: clip(text), at: m.create_time ? Math.round(m.create_time * 1000) : undefined });
  }
  return { title: j.title || (codex ? 'Codex conversation' : 'ChatGPT conversation'), msgs, artifacts: [], source: codex ? 'a Codex share link' : 'a ChatGPT share link' };
}

async function fetchShare(raw, { browserFetch } = {}) {
  const p = parseUrl(raw);
  if (!p) throw new Error('That does not look like a share link. Use a claude.ai/share/… or chatgpt.com/s/… link.');
  const j = await getJson(p, browserFetch);
  const out = p.kind === 'claude' ? fromClaude(j) : fromChatgpt(j, p.codex);
  if (!out.msgs.length) throw new Error('That share link has no messages I could read.');
  out.tool = p.kind === 'claude' ? 'Claude' : p.codex ? 'Codex' : 'ChatGPT';
  return out;
}

module.exports = { parseUrl, fetchShare, fromClaude, fromChatgpt };
