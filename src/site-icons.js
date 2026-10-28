// Official icons for connectors, taken from each service's own website and kept on this
// computer, so they show offline after the first time. Only public website hostnames are
// fetched (never IP addresses or local names).

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 512 * 1024;
const MISS_TTL = 24 * 3600 * 1000; // don't retry a site without an icon for a day
const HOST_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const sniff = (buf) => {
  if (buf.length < 4) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) return 'image/x-icon';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.slice(0, 4).toString() === 'GIF8') return 'image/gif';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  const head = buf.slice(0, 300).toString('utf8').toLowerCase();
  if (head.includes('<svg')) return 'image/svg+xml';
  return null;
};

module.exports = function createSiteIcons({ dataDir }) {
  const dir = path.join(dataDir, 'icons');
  fs.mkdirSync(dir, { recursive: true });
  const pending = new Map();

  async function fetchImage(url) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 6000);
    try {
      const r = await fetch(url, { redirect: 'follow', signal: ctl.signal, headers: { 'user-agent': 'AgentsCircle (connector icon)' } });
      if (!r.ok) return null;
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length || buf.length > MAX_BYTES) return null;
      const type = sniff(buf);
      return type ? { type, buf } : null;
    } catch { return null; } finally { clearTimeout(t); }
  }

  // The icon for a hostname: { type, buf } or null.
  async function get(site) {
    const host = String(site || '').toLowerCase().replace(/^www\./, '');
    if (!HOST_RE.test(host) || /\.(local|internal|lan|home|corp|localdomain|intranet|test|invalid|example)$/.test(host)) return null;
    const file = path.join(dir, host + '.bin');
    const meta = path.join(dir, host + '.json');
    try {
      const m = JSON.parse(fs.readFileSync(meta, 'utf8'));
      if (m.type) return { type: m.type, buf: fs.readFileSync(file) };
      if (Date.now() - m.at < MISS_TTL) return null;
    } catch { /* not cached yet */ }
    if (pending.has(host)) return pending.get(host);
    const job = (async () => {
      // Largest first: Apple touch icons are 180px PNGs; favicons are often 16-32px.
      const tries = [`https://${host}/apple-touch-icon.png`, `https://www.${host}/apple-touch-icon.png`, `https://${host}/favicon.ico`, `https://www.${host}/favicon.ico`, `https://${host}/favicon.svg`];
      let got = null;
      for (const u of tries) { got = await fetchImage(u); if (got) break; }
      try {
        if (got) fs.writeFileSync(file, got.buf);
        fs.writeFileSync(meta, JSON.stringify({ type: got ? got.type : null, at: Date.now() }));
      } catch { /* cache is optional */ }
      return got;
    })();
    pending.set(host, job);
    try { return await job; } finally { pending.delete(host); }
  }
  return { get };
};
