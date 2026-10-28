// Secrets (account API keys, connector tokens) encrypted with the operating system's keychain:
// macOS Keychain, Windows DPAPI (Credential Manager), or the Linux secret service, through
// Electron's safeStorage. The encrypted values live in ~/.agentscircle/secrets.json; the key
// that unlocks them never leaves the keychain.
//
// Outside the desktop app (npm start in a terminal) there's no keychain access, so secrets
// stay in the owner-only files as before, and secrets already in the keychain can't be read
// there: the app says so instead of failing silently.

const fs = require('fs');
const path = require('path');

module.exports = function createVault(dataDir) {
  const file = path.join(dataDir, 'secrets.json');
  let safe = null;
  try {
    if (process.versions.electron && process.type === 'browser') {
      const s = require('electron').safeStorage;
      if (s && s.isEncryptionAvailable()) safe = s;
    }
  } catch { /* not in Electron */ }
  if (process.env.AGENTSCIRCLE_TEST_VAULT) {
    // Test stand-in: reversible, NOT secure. Only for automated tests.
    safe = { encryptString: (t) => Buffer.from([...Buffer.from(t)].reverse()), decryptString: (b) => Buffer.from([...b].reverse()).toString() };
  }

  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')).items || {}; } catch { return {}; } };
  const write = (items) => {
    fs.writeFileSync(file, JSON.stringify({ about: 'Encrypted with this computer\'s keychain. Copying this file elsewhere does not reveal anything.', items }, null, 2), { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* windows */ }
  };

  return {
    // True when secrets can be kept in the keychain here.
    available: () => !!safe,
    kind: () => (!safe ? 'file' : process.platform === 'darwin' ? 'macOS Keychain' : process.platform === 'win32' ? 'Windows Credential Manager' : 'system keychain'),
    set(key, value) {
      if (!safe) return false;
      const items = read();
      items[key] = safe.encryptString(String(value)).toString('base64');
      write(items);
      return true;
    },
    // The secret, or null when it isn't there or can't be unlocked here.
    get(key) {
      if (!safe) return null;
      const v = read()[key];
      if (!v) return null;
      try { return safe.decryptString(Buffer.from(v, 'base64')); } catch { return null; }
    },
    delete(key) {
      const items = read();
      if (!(key in items)) return;
      delete items[key];
      write(items);
    },
  };
};
