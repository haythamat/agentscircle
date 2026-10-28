#!/usr/bin/env node
// One-time: create the key pair that signs agent-settings fixes (tools.json).
// The private key stays on your computer; the public key goes into package.json.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const dir = path.join(os.homedir(), '.agentscircle-signing');
const priv = path.join(dir, 'tools-signing-key.pem');
if (fs.existsSync(priv)) { console.error(`A key already exists at ${priv}. Delete it first if you really want a new one.`); process.exit(1); }
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
fs.writeFileSync(priv, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
const pub = publicKey.export({ type: 'spki', format: 'pem' });
console.log(`Private key saved to ${priv} (keep it secret, back it up).\n`);
console.log('Put this public key in package.json → "agentscircle" → "toolsPublicKey":\n');
console.log(JSON.stringify(pub));
