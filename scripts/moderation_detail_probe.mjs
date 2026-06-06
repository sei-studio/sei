// Reproduce the moderate-character-images 502 and print the FULL response body,
// which carries the `detail` (openai_moderation_http_<status> / abort msg) that
// the app log swallows.
//
// Usage:
//   SEI_TEST_EMAIL=... SEI_TEST_PASSWORD=... SEI_CHAR_ID=<owned char uuid> \
//     node scripts/moderation_detail_probe.mjs
import { readFileSync } from 'node:fs';

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

const signin = await fetch(`${URL_BASE}/auth/v1/token?grant_type=password`, {
  method: 'POST', headers: { apikey: ANON, 'content-type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
const sj = await signin.json();
if (!signin.ok) { console.error('sign-in failed', signin.status, sj); process.exit(1); }
const token = sj.access_token;

const r = await fetch(`${URL_BASE}/functions/v1/moderate-character-images`, {
  method: 'POST',
  headers: { apikey: ANON, Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ characterId: CHAR_ID }),
});
const text = await r.text();
console.log(`moderate-character-images status=${r.status}`);
console.log('body:', text);
