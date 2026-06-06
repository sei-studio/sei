// End-to-end verification of the server-side signed-URL upload path.
// Mirrors the app: sign in (ES256) -> call sign-character-asset-upload Edge
// Function -> uploadToSignedUrl -> confirm the object is readable.
//
// Usage:
//   SEI_TEST_EMAIL=... SEI_TEST_PASSWORD=... SEI_CHAR_ID=<owned char uuid> \
//     node scripts/storage_signed_upload_probe.mjs
//
// Safe to delete after running.

import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

function loadEnv(p) {
  const out = {};
  try {
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  } catch {}
  return out;
}

const env = { ...loadEnv('.env'), ...loadEnv('.env.local') };
const URL_BASE = env.SUPABASE_URL;
const ANON = env.SUPABASE_ANON_KEY;
const EMAIL = process.env.SEI_TEST_EMAIL;
const PASSWORD = process.env.SEI_TEST_PASSWORD;
const CHAR_ID = process.env.SEI_CHAR_ID;
if (!EMAIL || !PASSWORD || !CHAR_ID) { console.error('set SEI_TEST_EMAIL, SEI_TEST_PASSWORD, SEI_CHAR_ID'); process.exit(1); }

console.log(`[1] sign in ${EMAIL}`);
const signin = await fetch(`${URL_BASE}/auth/v1/token?grant_type=password`, {
  method: 'POST', headers: { apikey: ANON, 'content-type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
const sj = await signin.json();
if (!signin.ok) { console.error('  sign-in failed', signin.status, sj); process.exit(1); }
const token = sj.access_token;

for (const kind of ['portrait', 'skin']) {
  console.log(`\n[${kind}] call sign-character-asset-upload`);
  const signResp = await fetch(`${URL_BASE}/functions/v1/sign-character-asset-upload`, {
    method: 'POST',
    headers: { apikey: ANON, Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ characterId: CHAR_ID, kind }),
  });
  const signBody = await signResp.json();
  console.log(`  edge status ${signResp.status}:`, JSON.stringify(signBody));
  if (!signResp.ok) { console.error(`  ${kind} sign FAILED`); continue; }

  const { bucket, path, token: signedToken } = signBody;
  const sb = createClient(URL_BASE, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await sb.storage.from(bucket).uploadToSignedUrl(path, signedToken, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]), { contentType: 'image/png', upsert: true });
  if (error) { console.error(`  ${kind} uploadToSignedUrl FAILED:`, error.message); continue; }

  const readback = await fetch(`${URL_BASE}/storage/v1/object/public/${bucket}/${path}`);
  console.log(`  uploadToSignedUrl OK -> read back ${bucket}/${path}: status=${readback.status}`);
  console.log(`  ${kind}: ${readback.ok ? 'VERIFIED ✓' : 'upload ok but read-back ' + readback.status}`);
}
