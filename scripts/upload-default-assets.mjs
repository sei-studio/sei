// Admin one-shot: publish the three bundled default characters' art AND prompt
// (sui, lyra, marv) into Supabase so installs receive UPDATES via the
// cache-on-demand refresh, instead of only the app-bundled baseline.
//
// What it does, idempotently (safe to re-run after changing the art/persona):
//   1. Uploads each default's portrait  -> bucket `portraits`/<OWNER>/<uuid>.png
//   2. Uploads each default's skin       -> bucket `skins`/<OWNER>/<uuid>.png
//   3. Flips the public.characters rows to point at the uploaded objects AND
//      re-asserts the bundle's authored PROMPT fields, so the cloud row matches
//      resources/default-characters/<slug>.json exactly:
//        name, slug, persona_source, persona_expanded, metadata (merged with
//        the top-level description), portrait_image = '<OWNER>/<uuid>.png',
//        skin_source = 'upload', skin_png_sha256 (cache-bust), skin_applied_at.
//      The characters_set_updated_at trigger bumps updated_at, which is what
//      makes already-installed clients notice the change on next open and
//      re-pull the new prompt/image (see src/main/cloud/cacheOnDemand.ts).
//
// The bundled art (resources/skins/<slug>.png, src/renderer/public/img/<slug>.png)
// stays shipped as the OFFLINE fallback — this only adds the cloud override.
//
// Requires the service-role key, passed via env so it never touches disk/code:
//   SUPABASE_SERVICE_ROLE_KEY='...' \
//   SUPABASE_URL='https://<ref>.supabase.co' \
//     node scripts/upload-default-assets.mjs
//
// SUPABASE_URL also falls back to .env / .env.local (anon-safe), but the
// service-role key is read ONLY from the process env — keep it out of files.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..');

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

const fileEnv = { ...loadEnv(path.join(REPO, '.env')), ...loadEnv(path.join(REPO, '.env.local')) };
const URL_BASE = process.env.SUPABASE_URL || fileEnv.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; // env ONLY — never from a file
if (!URL_BASE) { console.error('set SUPABASE_URL (env or .env)'); process.exit(1); }
if (!SERVICE_KEY) { console.error('set SUPABASE_SERVICE_ROLE_KEY in the process env'); process.exit(1); }

// Owner of the default characters' public rows. Originally the loginless "Sei"
// system account 9608dffc-… (see supabase/migrations/20260605130000_seed_builtin_
// characters_as_public.sql); on 260706 ownership was transferred to the ouen@sei.gg
// user account so the defaults can be edited in-app like any owned character.
// This constant drives BOTH the storage folder (<OWNER>/<uuid>.png) and the row
// filter, so it must match whatever account currently owns the rows — otherwise
// the in-app edit channel (which uploads under the owner's folder) and this
// script diverge. Keep it in sync with public.characters.owner for these ids.
const OWNER = '571634bd-0f6d-4835-bef2-06fd7f449a3d';
const SLUGS = ['sui', 'lyra', 'marv'];

const sb = createClient(URL_BASE, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

async function uploadOne(bucket, objPath, bytes) {
  const { error } = await sb.storage
    .from(bucket)
    .upload(objPath, bytes, { contentType: 'image/png', upsert: true });
  if (error) throw new Error(`${bucket}/${objPath}: ${error.message}`);
}

let failed = 0;
for (const slug of SLUGS) {
  try {
    const meta = JSON.parse(
      readFileSync(path.join(REPO, 'resources', 'default-characters', `${slug}.json`), 'utf8'),
    );
    const uuid = meta.id;
    const objPath = `${OWNER}/${uuid}.png`;

    const portraitBytes = readFileSync(path.join(REPO, 'src', 'renderer', 'public', 'img', `${slug}.png`));
    const skinBytes = readFileSync(path.join(REPO, 'resources', 'skins', `${slug}.png`));
    const skinHash = sha256(skinBytes);

    console.log(`\n[${slug}] ${uuid}`);
    await uploadOne('portraits', objPath, portraitBytes);
    console.log(`  portraits/${objPath} <- ${portraitBytes.length} B`);
    await uploadOne('skins', objPath, skinBytes);
    console.log(`  skins/${objPath} <- ${skinBytes.length} B (sha256 ${skinHash.slice(0, 12)}…)`);

    // Cloud stores `description` inside metadata (the bundle carries it as a
    // top-level field); merge it in so the published metadata is complete.
    const mergedMeta = { ...(meta.metadata ?? {}) };
    if (meta.description) mergedMeta.description = meta.description;

    const { error: upErr } = await sb
      .from('characters')
      .update({
        // Ownership — claim the row for OWNER. We upload the art to OWNER's
        // storage folder ABOVE (before this update), so by the time owner flips
        // the `<owner>/<uuid>.png` bytes the whole app derives already exist.
        // This is the safe ordering for an ownership move: copy bytes first,
        // flip owner second, so image URLs never resolve to an empty folder.
        owner: OWNER,
        // Prompt / authored fields — make the cloud row match the bundle JSON.
        name: meta.name,
        slug: meta.slug,
        persona_source: meta.persona.source,
        persona_expanded: meta.persona.expanded,
        metadata: mergedMeta,
        // Art.
        portrait_image: objPath, // bucket-relative <owner>/<uuid>.png; client strips the prefix
        skin_source: 'upload',
        skin_png_sha256: skinHash,
        skin_applied_at: new Date().toISOString(),
      })
      // Match by the frozen default UUID only — NOT by current owner — so the
      // script self-completes regardless of who owns the row right now (it may
      // be the system account or a prior partial transfer).
      .eq('id', uuid);
    if (upErr) throw new Error(`row update: ${upErr.message}`);
    console.log(
      `  row updated: name=${meta.name} slug=${meta.slug} persona(${meta.persona.source.length}/${meta.persona.expanded.length}) ` +
        `skin_source=upload portrait_image=${objPath} (updated_at bumped by trigger)`,
    );

    // Read-back sanity check via the public object URLs.
    for (const bucket of ['portraits', 'skins']) {
      const r = await fetch(`${URL_BASE}/storage/v1/object/public/${bucket}/${objPath}`);
      console.log(`  read-back ${bucket}: ${r.ok ? 'OK ✓' : 'FAILED ' + r.status}`);
      if (!r.ok) failed++;
    }
  } catch (err) {
    failed++;
    console.error(`  [${slug}] FAILED: ${err.message}`);
  }
}

console.log(`\n${failed ? `done with ${failed} failure(s)` : 'all defaults published ✓'}`);
process.exit(failed ? 1 : 0);
