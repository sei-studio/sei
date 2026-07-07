// One-shot generator: emits the seed-builtins migration from the bundled JSON.
// Usage: node scripts/gen-seed-builtins.cjs <system-owner-uuid>
//
// NOTE: this migration creates the default rows with a `bundled` skin + null
// portrait BASELINE only. Default art now ALSO lives in cloud Storage so installs
// receive updates — run `scripts/upload-default-assets.mjs` (service-role) to
// upload the PNGs and flip skin_source='upload' / portrait_image=<owner>/<uuid>.png
// on these rows. The `on conflict do update` below intentionally does NOT touch
// skin_source/portrait_image, so re-running this migration never reverts that flip.
const fs = require('fs');
const SYS = process.argv[2];
if (!SYS) throw new Error('pass system owner uuid');

const slugs = ['sui', 'lyra', 'marv'];
const chars = slugs.map(s => require('../resources/default-characters/' + s + '.json'));

// Dollar-quote with a tag guaranteed not to appear in the body.
function dq(s) {
  let n = 0, tag;
  do { tag = '$p' + n + '$'; n++; } while (s.includes(tag));
  return tag + s + tag;
}

let out = `-- Publish the three bundled default characters (Sui, Lyra, Marv) into
-- public.characters as system-owned PUBLIC characters so they appear in Browse
-- like any user-authored public character.
--
-- Additive only: bundled local seeding (offline / auto-add) is unchanged; the
-- client never uploads defaults (the is_default guard in cloudCharacterClient is
-- untouched). These rows exist purely for Browse discoverability. portrait_image
-- is NULL (defaults render with the palette fallback, same as locally); skins
-- resolve for every install via skinStore frozen-UUID -> bundled-PNG fallback,
-- so no Storage upload is required.

-- 1) Dedicated confirmed-but-loginless "Sei" system auth user (owner FK target).
insert into auth.users (
  instance_id, id, aud, role, email,
  encrypted_password, email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin
) values (
  '00000000-0000-0000-0000-000000000000',
  '${SYS}',
  'authenticated', 'authenticated', 'system@sei.gg',
  '', now(), now(), now(),
  '{"provider":"system","providers":["system"]}'::jsonb,
  '{"preferred_name":"Sei"}'::jsonb,
  false
) on conflict (id) do nothing;

-- 2) Browse byline ("by Sei").
insert into public.profiles (user_id, preferred_name, updated_at)
values ('${SYS}', 'Sei', now())
on conflict (user_id) do update
  set preferred_name = excluded.preferred_name, updated_at = now();

-- 3) The three built-ins as shared, moderation-clean public characters.
`;

for (const c of chars) {
  out += `
insert into public.characters (
  id, owner, slug, name, persona_source, persona_expanded,
  skin_source, mojang_username, skin_png_sha256, skin_applied_at,
  username, is_default, shared, portrait_image, metadata,
  moderation_status, moderation_checked_at, moderation_provider
) values (
  '${c.id}', '${SYS}', ${dq(c.slug)}, ${dq(c.name)},
  ${dq(c.persona.source)},
  ${dq(c.persona.expanded)},
  'bundled', null, null, null,
  ${dq(c.username || '')}, false, true, null,
  ${c.description ? `jsonb_build_object('description', ${dq(c.description)})` : `'{}'::jsonb`},
  'clean', now(), 'seed'
) on conflict (id) do update set
  owner          = excluded.owner,
  slug           = excluded.slug,
  name           = excluded.name,
  username       = excluded.username,
  persona_source = excluded.persona_source,
  persona_expanded = excluded.persona_expanded,
  metadata       = excluded.metadata,
  shared         = true,
  is_default     = false,
  moderation_status = 'clean';
`;
}

fs.writeFileSync(
  __dirname + '/../supabase/migrations/20260605130000_seed_builtin_characters_as_public.sql',
  out,
);
process.stdout.write('wrote ' + out.length + ' bytes\n');
