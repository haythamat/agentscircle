// node-pty's macOS spawn-helper sometimes arrives without its execute bit, and then no terminal
// can start. Put it back after every install (CI builds the app from this install).
const fs = require('fs');
const path = require('path');
let dir;
try { dir = path.dirname(require.resolve('node-pty/package.json')); } catch { process.exit(0); }
for (const sub of ['build/Release', 'prebuilds/darwin-x64', 'prebuilds/darwin-arm64']) {
  const f = path.join(dir, sub, 'spawn-helper');
  try { fs.chmodSync(f, 0o755); } catch { /* not there */ }
}
