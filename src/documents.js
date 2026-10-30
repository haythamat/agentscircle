// Documents in the panel: previews for Word and spreadsheet files, and export of what agents write
// (Markdown, HTML, CSV, spreadsheets) to Word, PDF, HTML and Excel. Exports are saved next to the
// original in the project folder, so they show up in Files and agents can see them too.

const fs = require('fs');
const path = require('path');

const ext = (p) => path.extname(p).slice(1).toLowerCase();
const SHEET_EXT = new Set(['xlsx', 'xlsm', 'csv', 'tsv']);
const DOC_EXT = new Set(['docx']);
const MAX_ROWS = 500, MAX_COLS = 60;

const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- CSV ----------
function parseCsv(text, sep) {
  sep = sep || (text.split('\n')[0].split('\t').length > text.split('\n')[0].split(',').length ? '\t' : ',');
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
    if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
const asNumber = (v) => { if (typeof v !== 'string') return v; const t = v.trim().replace(/[,\s](?=\d{3}\b)/g, ''); return /^-?\d+(\.\d+)?$/.test(t) && t.length < 16 ? Number(t) : v; };

// ---------- reading spreadsheets ----------
async function readSheets(file) {
  const e = ext(file);
  if (e === 'csv' || e === 'tsv') {
    const rows = parseCsv(fs.readFileSync(file, 'utf8'), e === 'tsv' ? '\t' : undefined);
    return [{ name: path.basename(file), rows: rows.slice(0, MAX_ROWS).map((r) => r.slice(0, MAX_COLS)), total: rows.length }];
  }
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  return wb.worksheets.map((ws) => {
    const rows = [];
    ws.eachRow({ includeEmpty: true }, (r, n) => {
      if (n > MAX_ROWS) return;
      const vals = [];
      for (let c = 1; c <= Math.min(ws.columnCount, MAX_COLS); c++) {
        const v = r.getCell(c).value;
        vals.push(v == null ? '' : v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === 'object' ? (v.result ?? v.text ?? (v.richText ? v.richText.map((x) => x.text).join('') : v.hyperlink || '')) : v);
      }
      rows[n - 1] = vals;
    });
    for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
    return { name: ws.name, rows, total: ws.rowCount };
  });
}

// ---------- Markdown to HTML (for previews, HTML and PDF export) ----------
function mdToHtml(md) {
  const { marked } = require('marked');
  return marked.parse(md, { gfm: true, breaks: false });
}
const PAGE_CSS = `body{font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;color:#1b1d20;max-width:820px;margin:40px auto;padding:0 24px}
h1,h2,h3,h4{line-height:1.25;margin:1.4em 0 .5em}h1{font-size:28px}h2{font-size:22px}h3{font-size:18px}
table{border-collapse:collapse;margin:1em 0;width:100%;font-size:14px}th,td{border:1px solid #d8dbe0;padding:6px 10px;text-align:left;vertical-align:top}th{background:#f3f4f6}
code{font:13px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#f3f4f6;padding:1px 4px;border-radius:4px}pre{background:#f6f7f8;padding:12px 14px;border-radius:8px;overflow:auto}pre code{background:none;padding:0}
blockquote{margin:1em 0;padding:0 14px;border-left:3px solid #d8dbe0;color:#555}img{max-width:100%}a{color:#0b6bcb}
@media print{body{margin:0;max-width:none}a{color:inherit}}`;
const htmlPage = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escHtml(title)}</title><style>${PAGE_CSS}</style></head><body>${body}</body></html>`;

// ---------- tables out of Markdown / HTML ----------
function tablesFromMarkdown(md) {
  const { marked } = require('marked');
  const out = [];
  const text = (tokens) => (tokens || []).map((t) => t.text ?? '').join('');
  for (const t of marked.lexer(md)) if (t.type === 'table') out.push([t.header.map((h) => h.text), ...t.rows.map((r) => r.map((c) => c.text))]);
  void text;
  return out;
}
function tablesFromHtml(html) {
  const out = [];
  const strip = (s) => s.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
  for (const t of html.match(/<table[\s\S]*?<\/table>/gi) || []) {
    const rows = [];
    for (const r of t.match(/<tr[\s\S]*?<\/tr>/gi) || []) rows.push((r.match(/<t[hd][^>]*>[\s\S]*?<\/t[hd]>/gi) || []).map((c) => strip(c)));
    if (rows.length) out.push(rows);
  }
  return out;
}

// ---------- Markdown to Word ----------
async function mdToDocx(md, title) {
  const d = require('docx');
  const { marked } = require('marked');
  const runs = (tokens, style = {}) => {
    const out = [];
    for (const t of tokens || []) {
      if (t.type === 'strong') out.push(...runs(t.tokens, { ...style, bold: true }));
      else if (t.type === 'em') out.push(...runs(t.tokens, { ...style, italics: true }));
      else if (t.type === 'del') out.push(...runs(t.tokens, { ...style, strike: true }));
      else if (t.type === 'codespan') out.push(new d.TextRun({ text: t.text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"), font: 'Menlo', ...style }));
      else if (t.type === 'link') out.push(new d.ExternalHyperlink({ link: t.href, children: [new d.TextRun({ text: t.text, style: 'Hyperlink', ...style })] }));
      else if (t.type === 'br') out.push(new d.TextRun({ break: 1 }));
      else if (t.tokens) out.push(...runs(t.tokens, style));
      else out.push(new d.TextRun({ text: String(t.text ?? t.raw ?? '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"), ...style }));
    }
    return out;
  };
  const blocks = [];
  const HEAD = [d.HeadingLevel.HEADING_1, d.HeadingLevel.HEADING_2, d.HeadingLevel.HEADING_3, d.HeadingLevel.HEADING_4, d.HeadingLevel.HEADING_5, d.HeadingLevel.HEADING_6];
  const walk = (tokens, level = 0) => {
    for (const t of tokens) {
      if (t.type === 'heading') blocks.push(new d.Paragraph({ heading: HEAD[t.depth - 1], children: runs(t.tokens) }));
      else if (t.type === 'paragraph') blocks.push(new d.Paragraph({ children: runs(t.tokens), spacing: { after: 120 } }));
      else if (t.type === 'text' && t.tokens) blocks.push(new d.Paragraph({ children: runs(t.tokens) }));
      else if (t.type === 'list') {
        t.items.forEach((it, i) => {
          const inline = it.tokens.filter((x) => x.type === 'text' || x.type === 'paragraph');
          const nested = it.tokens.filter((x) => x.type === 'list');
          const kids = inline.flatMap((x) => runs(x.tokens || [x]));
          if (it.task) kids.unshift(new d.TextRun({ text: it.checked ? '☑ ' : '☐ ' }));
          blocks.push(new d.Paragraph(t.ordered ? { children: [new d.TextRun({ text: `${(Number(t.start) || 1) + i}. ` }), ...kids], indent: { left: 360 * (level + 1), hanging: 260 } } : { children: kids, bullet: { level: Math.min(level, 8) } }));
          if (nested.length) walk(nested, level + 1);
        });
      } else if (t.type === 'code') {
        for (const line of t.text.split('\n')) blocks.push(new d.Paragraph({ children: [new d.TextRun({ text: line || ' ', font: 'Menlo', size: 19 })], shading: { type: d.ShadingType.CLEAR, fill: 'F3F4F6', color: 'auto' }, spacing: { after: 0 } }));
        blocks.push(new d.Paragraph({ children: [] }));
      } else if (t.type === 'blockquote') {
        for (const b of t.tokens) if (b.tokens) blocks.push(new d.Paragraph({ children: runs(b.tokens, { italics: true }), indent: { left: 400 } }));
      } else if (t.type === 'hr') blocks.push(new d.Paragraph({ border: { bottom: { style: d.BorderStyle.SINGLE, size: 6, color: 'D8DBE0', space: 1 } }, children: [] }));
      else if (t.type === 'table') {
        const cell = (c, head) => new d.TableCell({ children: [new d.Paragraph({ children: runs(c.tokens, head ? { bold: true } : {}) })], shading: head ? { type: d.ShadingType.CLEAR, fill: 'F3F4F6', color: 'auto' } : undefined, margins: { top: 60, bottom: 60, left: 100, right: 100 } });
        blocks.push(new d.Table({ width: { size: 100, type: d.WidthType.PERCENTAGE }, rows: [new d.TableRow({ tableHeader: true, children: t.header.map((c) => cell(c, true)) }), ...t.rows.map((r) => new d.TableRow({ children: r.map((c) => cell(c)) }))] }));
        blocks.push(new d.Paragraph({ children: [] }));
      } else if (t.type === 'html' && t.text.trim()) blocks.push(new d.Paragraph({ children: [new d.TextRun({ text: t.text.replace(/<[^>]+>/g, '').trim() })] }));
    }
  };
  walk(marked.lexer(md));
  const doc = new d.Document({
    creator: 'AgentsCircle', title,
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    sections: [{ children: blocks.length ? blocks : [new d.Paragraph('')] }],
  });
  return d.Packer.toBuffer(doc);
}

// ---------- tables to Excel ----------
async function tablesToXlsx(tables, names = []) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook(); wb.creator = 'AgentsCircle';
  const used = new Set();
  tables.forEach((rows, i) => {
    let name = String(names[i] || (tables.length > 1 ? `Table ${i + 1}` : 'Sheet1')).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || `Sheet${i + 1}`;
    while (used.has(name)) name = `${name.slice(0, 28)} ${i + 1}`;
    used.add(name);
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    rows.forEach((r) => ws.addRow(r.map(asNumber)));
    const head = ws.getRow(1); head.font = { bold: true }; head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } };
    ws.columns.forEach((col, ci) => { const w = Math.max(...rows.map((r) => String(r[ci] ?? '').length), 4); col.width = Math.min(60, w + 2); });
    if (rows.length > 1 && rows[0].length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: rows[0].length } };
  });
  return wb.xlsx.writeBuffer();
}

// ---------- PDF (desktop app: Chromium renders the page) ----------
async function htmlToPdf(html, baseDir) {
  let electron; try { electron = require('electron'); } catch { electron = null; }
  if (!electron || !electron.BrowserWindow || typeof electron.BrowserWindow !== 'function') throw Object.assign(new Error('PDF export works in the AgentsCircle app. Here, open the file and use your browser\'s Print → Save as PDF.'), { code: 'nopdf' });
  const tmp = path.join(baseDir, `.agentscircle-print-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.html`);
  fs.writeFileSync(tmp, html);
  const url = require('url').pathToFileURL(tmp).toString();
  try {
    for (let attempt = 0; ; attempt++) {
      const win = new electron.BrowserWindow({ show: false, webPreferences: { javascript: true, sandbox: true } });
      try {
        await win.loadURL(url);
        await new Promise((r) => setTimeout(r, 600)); // charts and fonts settle
        return await win.webContents.printToPDF({ printBackground: true, generateTaggedPDF: true, preferCSSPageSize: true, pageSize: 'A4', margins: { marginType: 'default' } });
      } catch (e) {
        if (attempt >= 2) throw e;
        await new Promise((r) => setTimeout(r, 300));
      } finally { win.destroy(); }
    }
  } finally { fs.rm(tmp, { force: true }, () => {}); }
}

// ---------- the public part ----------
function uniqueOut(file, newExt) {
  const dir = path.dirname(file), base = path.basename(file, path.extname(file));
  let out = path.join(dir, `${base}.${newExt}`), n = 2;
  while (fs.existsSync(out)) out = path.join(dir, `${base} (${n++}).${newExt}`);
  return out;
}

// What a file can be exported to.
function exportOptions(file) {
  const e = ext(file);
  let content = null;
  try { if (['md', 'markdown', 'html', 'htm'].includes(e) && fs.statSync(file).size < 4 * 1024 * 1024) content = fs.readFileSync(file, 'utf8'); } catch { /* unreadable */ }
  const hasTables = content != null && (/^(md|markdown)$/.test(e) ? tablesFromMarkdown(content).length > 0 : tablesFromHtml(content).length > 0);
  if (e === 'md' || e === 'markdown') return ['docx', 'pdf', 'html', ...(hasTables ? ['xlsx'] : [])];
  if (e === 'html' || e === 'htm') return ['pdf', ...(hasTables ? ['xlsx'] : [])];
  if (e === 'csv' || e === 'tsv') return ['xlsx'];
  if (e === 'xlsx' || e === 'xlsm') return ['csv', 'pdf'];
  if (e === 'docx') return ['pdf', 'html'];
  if (e === 'txt') return ['docx', 'pdf'];
  return [];
}

async function exportFile(file, to, target) {
  const e = ext(file), title = path.basename(file, path.extname(file));
  if (!exportOptions(file).includes(to)) throw new Error(`Can't turn a .${e} file into .${to}.`);
  const out = target || uniqueOut(file, to);
  const dir = path.dirname(file);
  let buf;
  const asHtml = async () => {
    if (e === 'md' || e === 'markdown') return htmlPage(title, mdToHtml(fs.readFileSync(file, 'utf8')));
    if (e === 'txt') return htmlPage(title, `<pre style="white-space:pre-wrap;background:none;padding:0">${escHtml(fs.readFileSync(file, 'utf8'))}</pre>`);
    if (e === 'html' || e === 'htm') return fs.readFileSync(file, 'utf8');
    if (e === 'docx') { const r = await require('mammoth').convertToHtml({ path: file }); return htmlPage(title, r.value); }
    if (e === 'xlsx' || e === 'xlsm') { const sheets = await readSheets(file); return htmlPage(title, sheets.map((s) => `<h2>${escHtml(s.name)}</h2><table>${s.rows.map((r, i) => `<tr>${r.map((c) => (i ? `<td>${escHtml(c)}</td>` : `<th>${escHtml(c)}</th>`)).join('')}</tr>`).join('')}</table>`).join('')); }
    throw new Error('No HTML version of this file.');
  };
  if (to === 'html') buf = Buffer.from(await asHtml());
  else if (to === 'pdf') buf = await htmlToPdf(await asHtml(), dir);
  else if (to === 'docx') buf = await mdToDocx(fs.readFileSync(file, 'utf8'), title);
  else if (to === 'xlsx') {
    let tables;
    if (e === 'csv' || e === 'tsv') tables = [parseCsv(fs.readFileSync(file, 'utf8'), e === 'tsv' ? '\t' : undefined)];
    else if (e === 'md' || e === 'markdown') tables = tablesFromMarkdown(fs.readFileSync(file, 'utf8'));
    else tables = tablesFromHtml(fs.readFileSync(file, 'utf8'));
    if (!tables.length) throw new Error('There are no tables in this file to put in a spreadsheet.');
    buf = await tablesToXlsx(tables);
  } else if (to === 'csv') {
    const [first] = await readSheets(file);
    buf = Buffer.from(first.rows.map((r) => r.map((c) => { const s = String(c ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(',')).join('\n'));
  }
  fs.writeFileSync(out, Buffer.from(buf));
  return out;
}

// Extra preview data for the panel.
async function preview(file) {
  const e = ext(file);
  if (DOC_EXT.has(e)) {
    const r = await require('mammoth').convertToHtml({ path: file });
    return { docHtml: r.value };
  }
  if (SHEET_EXT.has(e)) return { sheets: await readSheets(file) };
  return {};
}

module.exports = { exportOptions, exportFile, suggestPath: uniqueOut, preview, isDoc: (p) => DOC_EXT.has(ext(p)), isSheet: (p) => SHEET_EXT.has(ext(p)) && !['csv', 'tsv'].includes(ext(p)), canPreviewTable: (p) => SHEET_EXT.has(ext(p)) };
