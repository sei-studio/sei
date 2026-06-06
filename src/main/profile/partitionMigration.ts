/**
 * Global → per-profile partition migration (260603). One-shot.
 *
 * Before this change, every per-account store lived directly under
 * `<userData>/…` (a single global bucket). After it, each account scope owns an
 * isolated subtree under `<userData>/profiles/<scopeId>/…`. This migration
 * relocates a pre-existing install's global per-account data into the profile
 * that owns it at first boot of the new build.
 *
 * The OWNING scope is decided by the caller (src/main/index.ts) and applied via
 * `setActiveScope()` BEFORE this runs:
 *   - signed in at boot  → the account's UUID  (their global data was theirs)
 *   - signed out at boot → `'local'`           (anonymous bucket)
 *
 * Idempotency: guarded by `paths.partitionMarkerPath()` (a device-global file).
 * On a fresh install there is nothing to move; the marker is still written so
 * the scan never repeats.
 *
 * What moves (device-global → profileRoot): config.json, api_key.bin,
 * characters/, skins/, portraits/, memory/, sync-queue.json,
 * defaults-seeded.json, migration-modal-shown.json.
 *
 * What stays device-global (NOT moved): session.bin (the auth identity),
 * skin-setup-state.json (wizard / MC installs are per-machine), logs/, tmp/,
 * migration-uuid-rename.json (legacy marker), and the profiles/ tree itself.
 */
import { access, mkdir, rename, rm, cp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { paths, getActiveScope } from '../paths';

const logger = {
  info: (m: string) => console.log(`[sei] partition: ${m}`),
  warn: (m: string) => console.warn(`[sei] partition: ${m}`),
};

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; }
  catch { return false; }
}

/**
 * Per-account files/dirs that lived directly under `<userData>/` in the
 * pre-partition layout. Names only — both the device-global source and the
 * profile-scoped target are derived from this list.
 */
const PARTITIONED_ENTRIES = [
  'config.json',
  'api_key.bin',
  'characters',
  'skins',
  'portraits',
  'memory',
  'sync-queue.json',
  'defaults-seeded.json',
  'migration-modal-shown.json',
] as const;

/** Move a single file/dir from the global root into the profile root. */
async function moveInto(name: string, profileRoot: string): Promise<boolean> {
  const src = path.join(paths.userData(), name);
  const dest = path.join(profileRoot, name);
  if (!(await exists(src))) return false;
  // Defensive: never clobber an existing target (a partial prior run, or a
  // freshly-seeded profile). Leave the source in place for manual inspection.
  if (await exists(dest)) {
    logger.warn(`target already exists, leaving global copy in place: ${name}`);
    return false;
  }
  try {
    await rename(src, dest);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      // Cross-device (shouldn't happen within one userData root, but be safe):
      // recursive copy then remove the source.
      await cp(src, dest, { recursive: true });
      await rm(src, { recursive: true, force: true });
      return true;
    }
    throw err;
  }
}

/**
 * Run the one-shot global→profile partition. Assumes the caller has already
 * called `setActiveScope()` with the owning scope. Best-effort per entry: a
 * single failed move is logged and the rest still proceed, but the marker is
 * only written once the pass completes so a hard failure retries next boot.
 */
export async function migrateGlobalToProfile(): Promise<void> {
  if (await exists(paths.partitionMarkerPath())) return;

  const profileRoot = paths.profileRoot();
  await mkdir(profileRoot, { recursive: true });

  let moved = 0;
  for (const name of PARTITIONED_ENTRIES) {
    try {
      if (await moveInto(name, profileRoot)) {
        moved += 1;
        logger.info(`moved ${name} → ${path.relative(paths.userData(), path.join(profileRoot, name))}`);
      }
    } catch (err) {
      logger.warn(`failed to move ${name}: ${(err as Error).message}`);
    }
  }

  // Marker is device-global and written LAST so an interrupted move retries.
  await writeFile(
    paths.partitionMarkerPath(),
    JSON.stringify({ version: 1, partitionedAt: new Date().toISOString(), movedCount: moved }, null, 2) + '\n',
    'utf8',
  );
  logger.info(moved > 0 ? `completed: ${moved} entries → profiles/${getActiveScope()}` : 'fresh install — nothing to move');
}
