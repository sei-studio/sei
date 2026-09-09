/**
 * Portrait file helpers with NO characterStore dependency (260909).
 *
 * portraitStore.ts owns the character-aware operations (apply / select /
 * versions) and imports characterStore; characterStore.deleteCharacter in turn
 * needs to wipe portrait files, so the pure filesystem pieces live here to
 * avoid an import cycle.
 *
 * Layout under <profile>/portraits/:
 *   <uuid>.png        canonical portrait (the ONLY bytes the cloud mirror reads)
 *   <uuid>-v<n>.png   stored versions (original snapshot / regens / uploads)
 * The reserved `_user.png` / `_bg.png` slots never match the version pattern
 * and are never touched here.
 */

import { readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { paths } from './paths';

/** Absolute path of a sidecar version file inside the portraits dir. */
export function portraitVersionPath(file: string): string {
  // `file` has already been validated against the character's uuid by the
  // caller (portraitStore / IPC), so basename is belt-and-braces only.
  return path.join(paths.portraitsDir(), path.basename(file));
}

/** Sidecar filenames on disk for `characterId`, sorted by version index. */
export async function listPortraitVersionFilesOnDisk(characterId: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(paths.portraitsDir());
  } catch {
    return [];
  }
  const re = new RegExp(`^${characterId}-v(\\d+)\\.png$`, 'i');
  return names
    .filter((n) => re.test(n))
    .sort((a, b) => Number(re.exec(a)![1]) - Number(re.exec(b)![1]));
}

/** Unlink every `<uuid>-v<n>.png` sidecar for `characterId` (ENOENT-tolerant). */
export async function unlinkPortraitVersionFiles(characterId: string): Promise<void> {
  for (const file of await listPortraitVersionFilesOnDisk(characterId)) {
    try {
      await unlink(portraitVersionPath(file));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[sei] portrait version unlink ${file}: ${(err as Error).message}`);
      }
    }
  }
}

/**
 * Remove the canonical portrait AND every sidecar version for a character.
 * Used by character delete / remove-from-library. Best-effort, ENOENT-tolerant.
 */
export async function deletePortraitFiles(characterId: string): Promise<void> {
  try {
    await unlink(paths.portraitPath(characterId));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[sei] portrait unlink ${characterId}: ${(err as Error).message}`);
    }
  }
  // The cloud client's md5 upload marker sits next to the canonical file.
  try {
    await unlink(`${paths.portraitPath(characterId)}.uploaded.json`);
  } catch {
    /* absent = never uploaded */
  }
  await unlinkPortraitVersionFiles(characterId);
}
