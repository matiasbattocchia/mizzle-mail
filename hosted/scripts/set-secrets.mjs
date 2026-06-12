#!/usr/bin/env node
// One-time helper: read the Google OAuth client_secret_*.json, generate a session
// secret, and push all three into the Worker as Cloudflare secrets (via stdin, so
// nothing is echoed to the terminal or shell history).
//
//   node scripts/set-secrets.mjs [path/to/client_secret_*.json]
//
// Prereqs: `wrangler login` first (this hits your Cloudflare account). If the Worker
// hasn't been deployed yet, wrangler will offer to create it.

import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const hostedDir = resolve(here, '..');     // hosted/
const repoRoot = resolve(hostedDir, '..'); // repo root (where the JSON lives, git-ignored)

// Locate the client secret JSON: explicit arg, else the first client_secret_*.json at root.
function findJson() {
  if (process.argv[2]) return resolve(process.argv[2]);
  const hit = readdirSync(repoRoot).find((f) => /^client_secret_.*\.json$/.test(f));
  if (!hit) {
    console.error(`No client_secret_*.json found in ${repoRoot}. Pass the path as an argument.`);
    process.exit(1);
  }
  return join(repoRoot, hit);
}

const jsonPath = findJson();
const parsed = JSON.parse(readFileSync(jsonPath, 'utf8'));
const cfg = parsed.web || parsed.installed;
if (!cfg?.client_id || !cfg?.client_secret) {
  console.error(`${jsonPath} doesn't look like a Google OAuth client (missing web.client_id/client_secret).`);
  process.exit(1);
}

const secrets = {
  GOOGLE_CLIENT_ID: cfg.client_id,
  GOOGLE_CLIENT_SECRET: cfg.client_secret,
  SESSION_SECRET: randomBytes(48).toString('base64url'),
};

console.log(`Reading OAuth client from: ${jsonPath}`);
console.log('Pushing 3 secrets to the Worker (values are piped via stdin, never printed):\n');

for (const [name, value] of Object.entries(secrets)) {
  process.stdout.write(`  • ${name} … `);
  const r = spawnSync('npx', ['wrangler', 'secret', 'put', name], {
    cwd: hostedDir,
    input: value,            // wrangler reads the value from stdin when not a TTY
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  if (r.status === 0) {
    console.log('ok');
  } else {
    console.log('FAILED');
    process.stderr.write((r.stderr || r.stdout || '').toString());
    console.error(`\nSecret ${name} failed. If it says "not logged in", run: npx wrangler login`);
    console.error('If it says the Worker doesn\'t exist, run `npm run deploy` once, then re-run this.');
    process.exit(1);
  }
}

console.log('\nDone. (SESSION_SECRET was generated fresh and stored only as a Worker secret.)');
