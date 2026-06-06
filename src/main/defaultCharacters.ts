/**
 * 260516-x62: Shipped default personas.
 *
 * Three characters come with the app: Sui, Lyra, Clawd. They are seeded
 * into the user's `<userData>/characters/` on first launch (and on any
 * launch where the id is not yet recorded in the `defaults-seeded.json`
 * tracker — but recorded ids are never re-seeded, so user deletions persist).
 *
 * The source-of-truth JSON files live at
 * `resources/default-characters/<id>.json` and are imported here so they
 * bundle into the main-process build (no runtime filesystem read needed,
 * which would require electron-builder `extraResources` plumbing).
 *
 * Defaults carry `is_default: true` so the renderer can render them with a
 * subtle badge.
 */
import sui from '../../resources/default-characters/sui.json' with { type: 'json' };
import lyra from '../../resources/default-characters/lyra.json' with { type: 'json' };
import clawd from '../../resources/default-characters/clawd.json' with { type: 'json' };
import { readFile, mkdir } from 'node:fs/promises';
import { CharacterSchema, type Character } from '../shared/characterSchema';
import { atomicWrite } from '../bot/brain/storage/atomicWrite.js';
import { withFileLock } from '../bot/brain/storage/fileLock.js';
import { paths } from './paths';
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
export const DEFAULT_CHARACTER_UUIDS = {
  sui:   'bbf5b66f-2f0f-4918-a953-a2cf66d5a586',
  lyra:  'e4511df2-fd20-470b-9131-f8f9968e1c01',
  clawd: '25770cd6-a50b-409d-a7e2-6cc2026dd673',
} as const;

export type DefaultCharacterSlug = keyof typeof DEFAULT_CHARACTER_UUIDS;

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
 * `seedDefaultCharacters` below keys on these UUIDs in defaults-seeded.json.
 * Plan 11-05's slug→UUID migration rewrites any pre-existing slug-keyed
 * tracker on first run of the new build.
 */
export const DEFAULT_CHARACTERS: readonly Character[] = Object.freeze([
  { ...CharacterSchema.parse(sui),   id: DEFAULT_CHARACTER_UUIDS.sui },
  { ...CharacterSchema.parse(lyra),  id: DEFAULT_CHARACTER_UUIDS.lyra },
  { ...CharacterSchema.parse(clawd), id: DEFAULT_CHARACTER_UUIDS.clawd },
]);

interface SeededTracker {
  version: 1;
  ids: string[];
}

function trackerPath(): string {
  return paths.defaultsSeededPath();
}

async function readTracker(): Promise<SeededTracker> {
  try {
    const raw = await readFile(trackerPath(), 'utf8');
    const parsed = JSON.parse(raw) as { version?: number; ids?: unknown };
    if (parsed.version === 1 && Array.isArray(parsed.ids)) {
      return { version: 1, ids: parsed.ids.filter(x => typeof x === 'string') as string[] };
    }
  } catch { /* missing or invalid — treat as empty */ }
  return { version: 1, ids: [] };
}

async function writeTracker(t: SeededTracker): Promise<void> {
  await mkdir(paths.profileRoot(), { recursive: true });
  await withFileLock(trackerPath(), async () => {
    await atomicWrite(trackerPath(), JSON.stringify(t, null, 2) + '\n');
  });
}

/**
 * Seed any default character whose id has never been seeded before. Skips
 * defaults already present on disk OR already recorded as seeded (so user
 * deletions stay deleted). Errors per-character are non-fatal — log and
 * continue so a single bad default doesn't block boot.
 *
 * Runs after `runFirstLaunchMigration` so the migration's `is_default`
 * sui (from a legacy CLI clone) wins over the shipped default if both
 * paths fire.
 */
export async function seedDefaultCharacters(): Promise<void> {
  const tracker = await readTracker();
  const already = new Set(tracker.ids);
  let mutated = false;

  for (const c of DEFAULT_CHARACTERS) {
    if (already.has(c.id)) continue;
    try {
      const existing = await getCharacter(c.id).catch(() => null);
      if (existing) {
        // Someone (migration, prior version, user import) already created
        // this character — don't overwrite, but mark seeded so we never
        // touch it on future boots.
        already.add(c.id);
        tracker.ids.push(c.id);
        mutated = true;
        continue;
      }
      await saveCharacter({
        ...c,
        created: c.created || new Date().toISOString(),
      });
      already.add(c.id);
      tracker.ids.push(c.id);
      mutated = true;
      logger.info(`seeded default character: ${c.id}`);
    } catch (err) {
      logger.warn(`seedDefaultCharacters: failed to seed ${c.id}: ${(err as Error).message}`);
    }
  }

  if (mutated) {
    try { await writeTracker(tracker); }
    catch (err) { logger.warn(`seedDefaultCharacters: tracker write failed: ${(err as Error).message}`); }
  }
}
