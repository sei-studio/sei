/**
 * Identity anchors for the three characters that were once bundled defaults
 * (Sui, Marv, Lyra).
 *
 * 260707: the app no longer ships ANY bundle baseline for these three. They are
 * ordinary user-owned public World characters (owner = DEFAULT_CHARACTERS_OWNER)
 * and are delivered EXACTLY like every other public character — surfaced via the
 * World tab and cached on demand from their cloud rows (portrait, skin, persona
 * all pulled from Supabase; `src/main/cloud/cacheOnDemand.ts`). There is no
 * `resources/default-characters/*.json`, no `resources/skins/*.png`, no
 * `refreshSeededDefaults`, and no bundled-skin fallback in skinStore — a fresh
 * or offline install shows the cloud art once it caches (Steve until then), the
 * same as any other public character.
 *
 * What remains here are pure IDENTITY constants (not assets): the frozen UUIDs
 * and the owner id. They are still needed by:
 *   - `runUuidRenameMigration` (migration.ts) to relocate a legacy on-disk
 *     slug-named copy to its UUID, and
 *   - `runDefaultsToWorldMigration` (migration.ts) to convert any leftover
 *     pre-0.4 `is_default:true` local copy into the owned/public World shape,
 *     after which cache-on-demand refreshes it from the cloud row like anything
 *     else.
 */

/**
 * Phase 11 D-22 — STABLE UUIDs for the three former bundled defaults.
 *
 * These UUIDs were generated ONCE via crypto.randomUUID() at Phase 11 plan
 * execution time. They are FROZEN — re-rolling them breaks every existing
 * install's local cache and the cloud rows keyed on them.
 *
 * The `marv` slug was historically 'clawd' (the character's old codename); the
 * key was renamed to 'marv' to match the display name. The UUID is UNCHANGED
 * and still FROZEN. migration.ts maps the historical on-disk 'clawd' slug to
 * this same UUID so older installs still migrate.
 */
export const DEFAULT_CHARACTER_UUIDS = {
  sui:  'bbf5b66f-2f0f-4918-a953-a2cf66d5a586',
  lyra: 'e4511df2-fd20-470b-9131-f8f9968e1c01',
  marv: '25770cd6-a50b-409d-a7e2-6cc2026dd673',
} as const;

export type DefaultCharacterSlug = keyof typeof DEFAULT_CHARACTER_UUIDS;

/**
 * The account that owns the three characters' public cloud rows. On 260706
 * ownership was transferred onto the `ouen@sei.gg` user so the characters can be
 * authored in-app like any owned public character. `runDefaultsToWorldMigration`
 * (migration.ts) stamps this owner onto any pre-existing local `is_default` copy
 * so `countsAsHomeSlot` treats it as a foreign-owned World character for everyone
 * except this account (for whom it is an own, editable character). FROZEN
 * alongside DEFAULT_CHARACTER_UUIDS.
 */
export const DEFAULT_CHARACTERS_OWNER = '571634bd-0f6d-4835-bef2-06fd7f449a3d';
