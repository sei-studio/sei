// Ensure every voice in src/voices.js exists in an ElevenLabs account.
//
//   ELEVENLABS_API_KEY=... node scripts/syncVoices.js [--dry-run]
//
// Premade voices (owner: null) exist in every account. Shared-library voices
// must be added once per account; adding preserves the public voice_id, so the
// ids in voices.js stay valid for any account that has run this script. Run it
// against the production key when rotating accounts. Idempotent: already-added
// voices are skipped.

import { VOICES } from '../src/voices.js';

const API = 'https://api.elevenlabs.io';
const key = process.env.ELEVENLABS_API_KEY;
const dryRun = process.argv.includes('--dry-run');

if (!key) {
  console.error('ELEVENLABS_API_KEY is required');
  process.exit(1);
}

async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'xi-api-key': key, 'content-type': 'application/json', ...(init.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${init.method || 'GET'} ${path} -> ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

const account = await api('/v1/voices?show_legacy=true');
const have = new Set(account.voices.map((v) => v.voice_id));

let added = 0;
let skipped = 0;
let failed = 0;

for (const v of VOICES) {
  if (have.has(v.id)) {
    skipped += 1;
    continue;
  }
  if (v.owner === null) {
    // Premade voices should always be present; missing means the account is
    // unusual (or ElevenLabs retired the voice) — flag loudly.
    console.error(`MISSING PREMADE: ${v.label} (${v.id}) — not in account and cannot be added by owner id`);
    failed += 1;
    continue;
  }
  if (dryRun) {
    console.log(`would add: ${v.label} (${v.id})`);
    added += 1;
    continue;
  }
  try {
    const res = await api(`/v1/voices/add/${v.owner}/${v.id}`, {
      method: 'POST',
      body: JSON.stringify({ new_name: `Sei — ${v.label}` }),
    });
    if (res.voice_id !== v.id) {
      // Contract check: the add must preserve the public id or the table is broken.
      console.error(`ID CHANGED for ${v.label}: table ${v.id} -> account ${res.voice_id}`);
      failed += 1;
    } else {
      console.log(`added: ${v.label} (${v.id})`);
      added += 1;
    }
  } catch (err) {
    console.error(`FAILED: ${v.label} (${v.id}) — ${err.message}`);
    failed += 1;
  }
}

console.log(`\n${added} added, ${skipped} already present, ${failed} failed (pool: ${VOICES.length})`);
process.exit(failed ? 1 : 0);
