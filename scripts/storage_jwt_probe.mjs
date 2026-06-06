// One-shot infra probe: does real storage-api accept a real user JWT?
// No app rebuild, no supabase-js — just the auth REST endpoint + storage REST endpoint.
//
// Usage:
//   SEI_TEST_EMAIL=test@removelater.com SEI_TEST_PASSWORD='...' node scripts/storage_jwt_probe.mjs
//
// Reads SUPABASE_URL + SUPABASE_ANON_KEY from .env. Signs in as the test user,
// decodes the issued access token, then attempts a storage upload to
// portraits/<sub>/__probe__.png exactly like the app does. Prints the storage
// HTTP status + body. Safe to delete after running.

import { readFileSync } from 'node:fs';

function loadEnv(path) {
  const out = {};
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
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

if (!URL_BASE || !ANON) { console.error('missing SUPABASE_URL / SUPABASE_ANON_KEY in .env'); process.exit(1); }
if (!EMAIL || !PASSWORD) { console.error('set SEI_TEST_EMAIL and SEI_TEST_PASSWORD env vars'); process.exit(1); }

const decode = (jwt) => {
  const [h, p] = jwt.split('.');
  const j = (s) => JSON.parse(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
  return { header: j(h), payload: j(p) };
};

console.log(`\n[1] sign in ${EMAIL} @ ${URL_BASE}`);
const signin = await fetch(`${URL_BASE}/auth/v1/token?grant_type=password`, {
  method: 'POST',
  headers: { apikey: ANON, 'content-type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
const sj = await signin.json();
if (!signin.ok) { console.error('  sign-in failed:', signin.status, sj); process.exit(1); }
const token = sj.access_token;
const { header, payload } = decode(token);
console.log('  token header:', JSON.stringify(header));
console.log('  token claims:', JSON.stringify({ sub: payload.sub, role: payload.role, iss: payload.iss, aud: payload.aud, exp: payload.exp }));

const sub = payload.sub;
console.log(`\n[2] storage upload -> portraits/${sub}/__probe__.png (mirrors the app's authed upload)`);
const up = await fetch(`${URL_BASE}/storage/v1/object/portraits/${sub}/__probe__.png`, {
  method: 'POST',
  headers: {
    apikey: ANON,
    Authorization: `Bearer ${token}`,
    'content-type': 'image/png',
    'x-upsert': 'true',
    'cache-control': 'max-age=3600',
  },
  body: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
});
const body = await up.text();
console.log(`  storage status: ${up.status}`);
console.log(`  storage body:   ${body}`);

console.log(`\n[3] verdict: ${up.ok
  ? 'STORAGE ACCEPTS the user JWT  -> infra is fine; the app-side path differs (rebuild/session). '
  : 'STORAGE REJECTS the user JWT  -> confirmed storage-api is not honoring valid user tokens (infra).'}`);

// best-effort cleanup of the probe object
if (up.ok) {
  await fetch(`${URL_BASE}/storage/v1/object/portraits/${sub}/__probe__.png`, {
    method: 'DELETE', headers: { apikey: ANON, Authorization: `Bearer ${token}` },
  }).catch(() => {});
}
