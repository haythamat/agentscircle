// AgentsCircle icon set: one 24px grid, 1.6px round strokes, drawn for this app.
// ic('send') returns inline SVG markup that inherits currentColor.
const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  settings: '<path d="M10.3 3.6a1.8 1.8 0 0 1 3.4 0l.3.9a1.8 1.8 0 0 0 2.5 1l.8-.4a1.8 1.8 0 0 1 2.4 2.4l-.4.8a1.8 1.8 0 0 0 1 2.5l.9.3a1.8 1.8 0 0 1 0 3.4l-.9.3a1.8 1.8 0 0 0-1 2.5l.4.8a1.8 1.8 0 0 1-2.4 2.4l-.8-.4a1.8 1.8 0 0 0-2.5 1l-.3.9a1.8 1.8 0 0 1-3.4 0l-.3-.9a1.8 1.8 0 0 0-2.5-1l-.8.4a1.8 1.8 0 0 1-2.4-2.4l.4-.8a1.8 1.8 0 0 0-1-2.5l-.9-.3a1.8 1.8 0 0 1 0-3.4l.9-.3a1.8 1.8 0 0 0 1-2.5l-.4-.8a1.8 1.8 0 0 1 2.4-2.4l.8.4a1.8 1.8 0 0 0 2.5-1z"/><circle cx="12" cy="12" r="3"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  attach: '<path d="m20.5 11.5-8.2 8.2a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8"/>',
  send: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>',
  panel: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M14.5 4.5v15"/>',
  panelBottom: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M3.5 14.5h17"/>',
  sidebar: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M9.5 4.5v15"/>',
  export: '<path d="M12 3.5v11M7.5 10 12 14.5 16.5 10M4.5 15.5v2a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-2"/>',
  import: '<path d="M4.5 13.5h4l1.5 2.5h4l1.5-2.5h4"/><path d="M4.5 13.5 6.8 6a2 2 0 0 1 1.9-1.5h6.6A2 2 0 0 1 17.2 6l2.3 7.5v4a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2z"/>',
  shared: '<path d="M4 7.5h16M4 12h16M4 16.5h10"/>',
  branch: '<circle cx="6.5" cy="5.5" r="2"/><circle cx="6.5" cy="18.5" r="2"/><circle cx="17.5" cy="8.5" r="2"/><path d="M6.5 7.5v9M17.5 10.5c0 4-5 3.5-9.6 6.6"/>',
  handoff: '<path d="M4 8.5h13.5M14 5l3.5 3.5L14 12M20 15.5H6.5M10 12l-3.5 3.5L10 19"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  chevronDown: '<path d="m6 9.5 6 6 6-6"/>',
  chevronRight: '<path d="m9.5 6 6 6-6 6"/>',
  back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  file: '<path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z"/><path d="M14 3.5v5h5"/>',
  fileCode: '<path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z"/><path d="M14 3.5v5h5M10 12.5 8 14.5l2 2M14 12.5l2 2-2 2"/>',
  fileText: '<path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z"/><path d="M14 3.5v5h5M8.5 13h7M8.5 16.5h5"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.8"/><path d="m20.5 15.5-4.7-4.5-9.3 8.5"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.6 2.6 3.6 5.4 3.6 8.5s-1 5.9-3.6 8.5c-2.6-2.6-3.6-5.4-3.6-8.5s1-5.9 3.6-8.5z"/>',
  folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  alert: '<path d="M10.3 4.4a2 2 0 0 1 3.4 0l7.1 12.3a2 2 0 0 1-1.7 3H4.9a2 2 0 0 1-1.7-3z"/><path d="M12 9.5v4M12 16.7v.1"/>',
  bell: '<path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 2h-14z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  sun: '<circle cx="12" cy="12" r="3.8"/><path d="M12 2.8v2M12 19.2v2M2.8 12h2M19.2 12h2M5.5 5.5l1.4 1.4M17.1 17.1l1.4 1.4M5.5 18.5l1.4-1.4M17.1 6.9l1.4-1.4"/>',
  moon: '<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/>',
  monitor: '<rect x="3.5" y="4.5" width="17" height="11.5" rx="2"/><path d="M9 20h6M12 16v4"/>',
  question: '<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.6a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.7M12 16.8v.1"/>',
  plug: '<path d="M9 3.5v4M15 3.5v4M7 7.5h10v3.5a5 5 0 0 1-10 0zM12 16v4.5"/>',
  layers: '<path d="m12 3.5 8.5 4.5-8.5 4.5L3.5 8z"/><path d="m3.5 12 8.5 4.5 8.5-4.5M3.5 16l8.5 4.5 8.5-4.5"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.7v.1"/>',
  undo: '<path d="M8.5 6 4.5 10l4 4"/><path d="M4.5 10h10a5 5 0 0 1 0 10h-3"/>',
  redo: '<path d="m15.5 6 4 4-4 4"/><path d="M19.5 10h-10a5 5 0 0 0 0 10h3"/>',
  eye: '<path d="M2.8 12S6.2 5.5 12 5.5 21.2 12 21.2 12 17.8 18.5 12 18.5 2.8 12 2.8 12z"/><circle cx="12" cy="12" r="2.8"/>',
  commit: '<circle cx="12" cy="12" r="3.5"/><path d="M3.5 12h5M15.5 12h5"/>',
  trash: '<path d="M4.5 7h15M9.5 7V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v2M6.5 7l.8 11.6a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9L17.5 7"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 0 1-13 5.1M4.5 12a7.5 7.5 0 0 1 13-5.1"/><path d="M17.5 3.5v3.5H14M6.5 20.5V17H10"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  key: '<circle cx="8" cy="15.5" r="4"/><path d="m10.8 12.7 8.7-8.7M16.5 7l2.5 2.5M14 9.5l2 2"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  palette: '<path d="M12 3.5a8.5 8.5 0 0 0 0 17c1.2 0 1.8-.8 1.8-1.7 0-1.3-1.2-1.6-1.2-2.8 0-1 .8-1.6 1.8-1.6h2.2a3.9 3.9 0 0 0 3.9-3.9c0-4-3.8-7-8.5-7z"/><circle cx="7.8" cy="11" r="1"/><circle cx="10.5" cy="7.5" r="1"/><circle cx="15" cy="7.8" r="1"/>',
  layout: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M3.5 9.5h17M9.5 9.5v10"/>',
  users: '<circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19.5a5.5 5.5 0 0 1 11 0"/><path d="M15.5 5.6a3.2 3.2 0 0 1 0 6.1M17.5 14.4a5.5 5.5 0 0 1 3 5.1"/>',
  message: '<path d="M4.5 6.5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-6l-4.5 3.5v-3.5h-.5a2 2 0 0 1-2-2z"/>',
  sparkle: '<path d="M12 3.5c.6 4.3 2.2 5.9 6.5 6.5-4.3.6-5.9 2.2-6.5 6.5-.6-4.3-2.2-5.9-6.5-6.5 4.3-.6 5.9-2.2 6.5-6.5zM18.5 15.5c.3 1.9 1 2.6 2.9 2.9-1.9.3-2.6 1-2.9 2.9-.3-1.9-1-2.6-2.9-2.9 1.9-.3 2.6-1 2.9-2.9z"/>',
  pause: '<path d="M9 6v12M15 6v12"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z"/>',
  external: '<path d="M13.5 4.5h6v6M19.5 4.5l-8 8M17.5 14v4a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2h4"/>',
  expand: '<path d="M14 4.5h5.5V10M10 19.5H4.5V14M19.5 4.5l-6 6M4.5 19.5l6-6"/>',
  contract: '<path d="M19.5 10H14V4.5M4.5 14H10v5.5M14 10l5.5-5.5M10 14l-5.5 5.5"/>',
  pencil: '<path d="M4.5 19.5l1-4.2L15.6 5.2a2 2 0 0 1 2.8 0l.4.4a2 2 0 0 1 0 2.8L8.7 18.5z"/><path d="m13.6 7.2 3.2 3.2"/>',
  notes: '<rect x="5" y="3.5" width="14" height="17" rx="2.5"/><path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2.2"/><path d="M15.5 8.5V6.2A1.7 1.7 0 0 0 13.8 4.5H6.2A1.7 1.7 0 0 0 4.5 6.2v7.6a1.7 1.7 0 0 0 1.7 1.7h2.3"/>',
  dots: '<circle cx="6" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18" cy="12" r="1.2"/>',
  star: '<path d="m12 4 2.4 5 5.4.6-4 3.7 1.1 5.4L12 16l-4.9 2.7 1.1-5.4-4-3.7 5.4-.6z"/>',
  eraser: '<path d="M8.5 19.5h11M4.9 14.6l8.5-8.5a2 2 0 0 1 2.8 0l2.7 2.7a2 2 0 0 1 0 2.8l-7.3 7.3a2 2 0 0 1-1.4.6H8.6a2 2 0 0 1-1.4-.6l-2.3-2.3a1.4 1.4 0 0 1 0-2zM9 10.5l5.5 5.5"/>',
  terminal: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="m7.5 9.5 3 2.5-3 2.5M12.5 15h4"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6.5 10h.1M10 10h.1M13.5 10h.1M17 10h.1M8 14h8"/>',
};
function ic(name, cls = '') {
  const p = ICONS[name] || ICONS.dots;
  return `<svg class="ic${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
}
// The AgentsCircle mark (three strips around a shared centre), themable through CSS variables.
function logoMark(cls = '') {
  const arc = (a0, a1) => {
    const p = (a) => [32 + 19.5 * Math.cos((a - 90) * Math.PI / 180), 32 + 19.5 * Math.sin((a - 90) * Math.PI / 180)];
    const [x0, y0] = p(a0), [x1, y1] = p(a1);
    return `M${x0.toFixed(2)} ${y0.toFixed(2)}A19.5 19.5 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  };
  return `<svg class="logo-mark ${cls}" viewBox="0 0 64 64" aria-hidden="true"><path d="${arc(15, 105)}" stroke="var(--logo-a)" stroke-width="8.5" stroke-linecap="round" fill="none"/><path d="${arc(135, 225)}" stroke="var(--logo-b)" stroke-width="8.5" stroke-linecap="round" fill="none"/><path d="${arc(255, 345)}" stroke="var(--logo-c)" stroke-width="8.5" stroke-linecap="round" fill="none"/><circle cx="32" cy="32" r="5" fill="var(--logo-b)"/></svg>`;
}
// Callsign tile: the agent's identity everywhere (chips, replies, board, inbox).
const KNOWN_MONO = { claude: 'CL', codex: 'CX', cursor: 'CR', opencode: 'OC', mock: 'MK', all: 'ALL' };
function monogram(id) {
  if (KNOWN_MONO[id]) return KNOWN_MONO[id];
  const parts = String(id || '?').split(/[-_]/).filter(Boolean);
  const a = (parts[0] || '?')[0] || '?';
  const b = parts[1] ? parts[1][0] : (parts[0] || '').replace(/[aeiou]/gi, '')[1] || (parts[0] || '')[1] || '';
  return (a + b).toUpperCase();
}
function tile(id, color, size = '') {
  return `<span class="tile${size ? ' ' + size : ''}" style="--c:${color || 'var(--muted)'}" aria-hidden="true">${monogram(id)}</span>`;
}
