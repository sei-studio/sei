/**
 * 260516-x62: Shipped default personas.
 *
 * Three characters come with the app: Sui, Mochineko, Clawd. They are seeded
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
import mochineko from '../../resources/default-characters/mochineko.json' with { type: 'json' };
import clawd from '../../resources/default-characters/clawd.json' with { type: 'json' };
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { CharacterSchema, type Character } from '../shared/characterSchema';
import { atomicWrite } from '../bot/brain/storage/atomicWrite.js';
import { withFileLock } from '../bot/brain/storage/fileLock.js';
import { paths } from './paths';
import { getCharacter, saveCharacter } from './characterStore';

const logger = {
  info: (m: string) => console.log(`[sei] ${m}`),
  warn: (m: string) => console.warn(`[sei] ${m}`),
};

export const DEFAULT_CHARACTERS: readonly Character[] = Object.freeze([
  CharacterSchema.parse(sui),
  CharacterSchema.parse(mochineko),
  CharacterSchema.parse(clawd),
]);

interface SeededTracker {
  version: 1;
  ids: string[];
}

function trackerPath(): string {
  return path.join(paths.userData(), 'defaults-seeded.json');
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
  await mkdir(paths.userData(), { recursive: true });
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
