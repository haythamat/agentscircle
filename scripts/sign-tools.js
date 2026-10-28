#!/usr/bin/env node
// Sign tools.json after editing it (bump "revision" first). Writes tools.json.sig.
// Commit both files; installed apps pick up the fix within a few hours.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const keyFile = process.env.AGENTSCIRCLE_SIGNING_KEY || path.join(os.homedir(), '.agentscircle-signing', 'tools-signing-key.pem');
const text = fs.readFileSync(path.join(root, 'tools.json'), 'utf8');
const json = JSON.parse(text);
if (!Number.isInteger(json.revision)) { console.error('tools.json needs an integer "revision". Bump it for every fix.'); process.exit(1); }
const sig = crypto.sign(null, Buffer.from(text, 'utf8'), fs.readFileSync(keyFile, 'utf8')).toString('base64');
fs.writeFileSync(path.join(root, 'tools.json.sig'), sig + '\n');
console.log(`Signed tools.json revision ${json.revision}. Commit tools.json and tools.json.sig.`);
