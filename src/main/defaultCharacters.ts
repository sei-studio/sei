/**
 * 260516-x62: Shipped default personas.
 *
 * Three characters come with the app: Sui, Lyra, Clawd.
 *
 * 260706: the app no longer SEEDS local copies of these into
 * `<userData>/characters/` on a fresh install. Every user (signed-in AND
 * local) reaches the character database through the proxy's transparent
 * Supabase route, where the three defaults live as system-owned public rows.
 * A fresh install surfaces them via the World tab and caches them on demand
 * (cacheOnDemand.ts) like any other World character, so the old local seed was
 * stale duplication. Installs that ALREADY seeded them keep their local
 * `is_default: true` copies untouched — `refreshSeededDefaults` (below) still
 * re-asserts the bundle's authored fields onto those pre-seeded copies on every
 * launch, since cache-on-demand's cloud refresh deliberately skips
 * `is_default` rows (they are bundle-authoritative, not cloud-authoritative).
 *
 * The source-of-truth JSON files still live at
 * `resources/default-characters/<id>.json` and are imported here so the bundled
 * `DEFAULT_CHARACTERS` array (consumed by skinStore's bundled-skin fallback,
 * skinStore's reference table, and refreshSeededDefaults) has no runtime
 * filesystem read.
 *
 * Defaults carry `is_default: true` so the renderer can render them with a
 * subtle badge.
 */
import sui from '../../resources/default-characters/sui.json' with { type: 'json' };
import lyra from '../../resources/default-characters/lyra.json' with { type: 'json' };
import marv from '../../resources/default-characters/marv.json' with { type: 'json' };
import { CharacterSchema, type Character } from '../shared/characterSchema';
import { getCharacter, saveCharacter } from './characterStore';

const logger = {
  info: (m: string) => console.log(`[sei] ${m}`),
  warn: (m: string) => console.warn(`[sei] ${m}`),
};

/**
 * Phase 11 D-22 — STABLE UUIDs for the three bundled defaults.
 *
 * Source: 11-CONTEXT D-22 (bundled defaults are read-only at user level,
 *         never uploaded to cloud) + 11-RESEARCH §Pattern 8 + Assumption A6.
 *
 * These UUIDs were generated ONCE via crypto.randomUUID() at Phase 11 plan
 * execution time. They are FROZEN — re-rolling them breaks every existing
 * install's local cache after the slug→UUID migration in Plan 11-05.
 *
 * Stability is load-bearing:
 *   - The slug→UUID rename migration keys off this map to relocate
 *     <userData>/characters/sui.json → <userData>/characters/<sui-uuid>.json
 *   - resources/default-characters/{sui,lyra,clawd}.json have their `id`
 *     field set to the matching UUID and a new `slug` field carrying the
 *     original kebab name.
 *   - bundledSkinPath in skinStore.ts (Plan 11-05 caller) does a reverse
 *     lookup from UUID to slug to resolve resources/skins/<slug>.png.
 */
// The `marv` slug was historically 'clawd' (the character's old codename); the
// key was renamed to 'marv' to match the display name + the renamed bundle files
// (resources/default-characters/marv.json, resources/skins/marv.png). The UUID is
// UNCHANGED and still FROZEN. migration.ts maps the historical on-disk 'clawd'
// slug to this same UUID so older installs still migrate.
export const DEFAULT_CHARACTER_UUIDS = {
  sui:  'bbf5b66f-2f0f-4918-a953-a2cf66d5a586',
  lyra: 'e4511df2-fd20-470b-9131-f8f9968e1c01',
  marv: '25770cd6-a50b-409d-a7e2-6cc2026dd673',
} as const;

export type DefaultCharacterSlug = keyof typeof DEFAULT_CHARACTER_UUIDS;

/**
 * The account that owns the three default characters' public cloud rows. On
 * 260706 ownership was transferred off the loginless system account onto the
 * `ouen@sei.gg` user so the defaults can be authored in-app like any owned
 * public character (they are normal `shared` World characters — no longer
 * bundled read-only `is_default` copies). `runDefaultsToWorldMigration`
 * (migration.ts) stamps this owner onto any pre-existing local `is_default`
 * copy so `countsAsHomeSlot` treats it as a foreign-owned World character for
 * everyone except this account (for whom it is an own, editable character).
 * FROZEN alongside DEFAULT_CHARACTER_UUIDS.
 */
export const DEFAULT_CHARACTERS_OWNER = '571634bd-0f6d-4835-bef2-06fd7f449a3d';

/**
 * Phase 11 D-22 — DEFAULT_CHARACTERS now key on UUID via DEFAULT_CHARACTER_UUIDS.
 *
 * Each entry explicitly sets `.id` from the frozen UUID map so the array's
 * `id` field is guaranteed to match `DEFAULT_CHARACTER_UUIDS` even if the
 * bundled JSON were ever to drift. The JSON files (resources/default-characters/
 * {sui,lyra,clawd}.json) also carry the matching UUID as their `id` plus a
 * sibling `slug` field (the slug field is unknown to CharacterSchema and is
 * stripped by Zod parsing — it lives in the JSON for bundled-asset reverse
 * lookups like skinStore's UUID→slug path).
 *
 * These UUIDs match the system-owned public cloud rows for sui/lyra/clawd, so a
 * fresh install caches the SAME id from the World tab that an older install
 * seeded locally. Plan 11-05's slug→UUID migration (migration.ts) still rewrites
 * any pre-existing slug-keyed `defaults-seeded.json` tracker on older installs.
 */
// 260703 procgen: bundled defaults now live in the World tab (the renderer hides
// them from Home unless their id is in config.added_default_ids), so they carry
// kind 'world'. The bundled JSON predates the kind field, so we stamp it here.
export const DEFAULT_CHARACTERS: readonly Character[] = Object.freeze([
  { ...CharacterSchema.parse(sui),   id: DEFAULT_CHARACTER_UUIDS.sui,   kind: 'world' as const },
  { ...CharacterSchema.parse(lyra),  id: DEFAULT_CHARACTER_UUIDS.lyra,  kind: 'world' as const },
  { ...CharacterSchema.parse(marv), id: DEFAULT_CHARACTER_UUIDS.marv, kind: 'world' as const },
]);

/**
 * 260706: `seedDefaultCharacters` was REMOVED. Fresh installs no longer write
 * local `is_default` copies of sui/lyra/clawd — the three defaults surface via
 * the World tab and are cached on demand from their system-owned public cloud
 * rows (cacheOnDemand.ts). The `defaults-seeded.json` tracker that gated the old
 * first-launch seed is now vestigial; migration.ts still remaps a pre-existing
 * tracker's slug ids to UUIDs for older installs, and partitionMigration.ts
 * still carries the file across the local→profile partition, but nothing writes
 * a fresh one. `refreshSeededDefaults` below is retained so installs that
 * already seeded the defaults keep receiving the bundle's authored-field
 * updates on every launch (cache-on-demand's cloud refresh skips `is_default`
 * rows). It is a no-op on a fresh install, where no `is_default` file exists.
 */

/**
 * The bundle-owned, author-set fields of a default character — everything the
 * user can NEVER edit through the GUI (defaults render view-only). Used to
 * decide whether an on-disk default has drifted from the shipped source.
 */
function authoredFieldsChanged(onDisk: Character, bundled: Character): boolean {
  return (
    onDisk.name !== bundled.name ||
    JSON.stringify(onDisk.persona) !== JSON.stringify(bundled.persona) ||
    (onDisk.description ?? null) !== (bundled.description ?? null) ||
    (onDisk.portrait_image ?? null) !== (bundled.portrait_image ?? null) ||
    JSON.stringify(onDisk.skin) !== JSON.stringify(bundled.skin) ||
    (onDisk.username ?? null) !== (bundled.username ?? null) ||
    (onDisk.slug ?? null) !== (bundled.slug ?? null) ||
    (onDisk.public_id ?? null) !== (bundled.public_id ?? null) ||
    (onDisk.kind ?? 'custom') !== (bundled.kind ?? 'custom') ||
    JSON.stringify(onDisk.metadata) !== JSON.stringify(bundled.metadata)
  );
}

/**
 * Re-assert the bundled source's authored fields onto already-seeded default
 * characters, on every launch. Only touches `is_default` files that a PRIOR
 * build already wrote to disk (260706: fresh installs no longer seed any, so
 * this is a no-op for them — their defaults come from the cloud/World path).
 *
 * A default seeded by an OLDER build otherwise keeps its stale persona /
 * metadata forever — e.g. v0.3.0 shipped Sui with an older persona and (before
 * the proactiveness dial existed) no `metadata.proactiveness`, so getProactiveness
 * defaulted her to Reactive even though the current bundle sets Agentic (2).
 *
 * Defaults are read-only in the UI (the user can never edit a bundled
 * character), so it is safe to overwrite the authored fields from the bundle
 * here. Per-user runtime accumulation (created / last_launched / playtime_ms)
 * and any cloud linkage (owner / cloud_updated_at / shared) are preserved.
 * Writes only when the authored fields actually drifted, so steady-state
 * launches do no disk I/O.
 */
export async function refreshSeededDefaults(): Promise<void> {
  for (const bundled of DEFAULT_CHARACTERS) {
    try {
      const existing = await getCharacter(bundled.id).catch(() => null);
      if (!existing) continue;            // never seeded, or user removed it from disk
      if (existing.is_default !== true) continue; // safety: never clobber a non-default
      if (!authoredFieldsChanged(existing, bundled)) continue;
      await saveCharacter({
        ...existing,
        // Bundle-owned authored fields:
        name: bundled.name,
        persona: bundled.persona,
        description: bundled.description,
        portrait_image: bundled.portrait_image,
        skin: bundled.skin,
        username: bundled.username,
        slug: bundled.slug,
        public_id: bundled.public_id,
        kind: bundled.kind,
        metadata: bundled.metadata,
        is_default: true,
        // Preserved from disk via the spread above:
        // created, last_launched, playtime_ms, owner, cloud_updated_at, shared.
      });
      logger.info(`refreshed default character from bundle: ${bundled.id}`);
    } catch (err) {
      logger.warn(`refreshSeededDefaults: failed for ${bundled.id}: ${(err as Error).message}`);
    }
  }
}
