// Draws the AgentsCircle mark: three strips forming one circle around a shared centre.
// node scripts/make-logo.js  -> public/logo.svg, public/logo-mark.svg, build/icon.svg
const fs = require('fs');
const path = require('path');

function arc(cx, cy, r, a0, a1) {
  const p = (a) => [cx + r * Math.cos((a - 90) * Math.PI / 180), cy + r * Math.sin((a - 90) * Math.PI / 180)];
  const [x0, y0] = p(a0), [x1, y1] = p(a1);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}
// Three arcs of 120° with gaps; round caps eat into the gap, so the gap is generous.
function mark({ size = 64, r = 19.5, w = 8.5, gap = 30, colors, dot, dotR = 5, rotate = 0 }) {
  const c = size / 2;
  const arcs = [0, 1, 2].map((i) => {
    const a0 = rotate + i * 120 + gap / 2, a1 = rotate + (i + 1) * 120 - gap / 2;
    return `<path d="${arc(c, c, r, a0, a1)}" fill="none" stroke="${colors[i]}" stroke-width="${w}" stroke-linecap="round"/>`;
  }).join('');
  return `${arcs}<circle cx="${c}" cy="${c}" r="${dotR}" fill="${dot}"/>`;
}

const STRIP = ['#EBD9AE', '#F1F2F3', '#8FB9E2']; // flight-strip buff, white, departure blue
const root = path.join(__dirname, '..');

// Mark for the app UI: uses currentColor so it follows the theme.
const uiMark = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" aria-hidden="true">${mark({ colors: ['var(--logo-a, #EBD9AE)', 'var(--logo-b, currentColor)', 'var(--logo-c, #8FB9E2)'], dot: 'var(--logo-dot, currentColor)' })}</svg>`;
fs.writeFileSync(path.join(root, 'public', 'logo-mark.svg'), uiMark);

// App icon: graphite tile with a soft top light, the mark in strip colours.
const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2B3034"/><stop offset="1" stop-color="#14171A"/></linearGradient>
    <radialGradient id="l" cx=".5" cy="0" r=".9"><stop offset="0" stop-color="#ffffff" stop-opacity=".10"/><stop offset=".6" stop-color="#ffffff" stop-opacity="0"/></radialGradient>
    <filter id="s" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="#000" flood-opacity=".35"/></filter>
  </defs>
  <rect x="100" y="100" width="824" height="824" rx="186" fill="url(#g)"/>
  <rect x="100" y="100" width="824" height="824" rx="186" fill="url(#l)"/>
  <rect x="101.5" y="101.5" width="821" height="821" rx="184.5" fill="none" stroke="#ffffff" stroke-opacity=".08" stroke-width="3"/>
  <g filter="url(#s)" transform="translate(192 192) scale(10)">${mark({ colors: STRIP, dot: '#F1F2F3', dotR: 5.2 })}</g>
</svg>`;
fs.mkdirSync(path.join(root, 'build'), { recursive: true });
fs.writeFileSync(path.join(root, 'build', 'icon.svg'), icon);

// Horizontal logo for docs and the website (dark ground).
const logo = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 64"><g>${mark({ colors: STRIP, dot: '#F1F2F3' })}</g><text x="76" y="43" font-family="Barlow Semi Condensed, sans-serif" font-weight="600" font-size="34" letter-spacing="-.2" fill="#F1F2F3">AgentsCircle</text></svg>`;
fs.writeFileSync(path.join(root, 'public', 'logo.svg'), logo);
console.log('ok');
