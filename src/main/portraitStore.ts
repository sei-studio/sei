/**
 * Phase 11 D-28 — Portrait persistence (per-character UUID-keyed file).
 *
 * Source: 11-RESEARCH §Pattern 5 (portrait pipeline change) +
 *         11-PATTERNS §portraitStore (composite of skinStore.applyPng +
 *         portraitImageUtil.validatePortrait).
 *
 * Layout: <userData>/portraits/<uuid>.png (mirrors the cloud Storage bucket
 * layout from Plan 11-07). The renderer stores the literal string
 * '<uuid>.png' in `character.portrait_image`; Plan 11-19's cache-on-demand
 * resolves it to a real URL at render time.
 *
 * Defense-in-depth: applyPortrait re-validates bytes via validatePortrait
 * BEFORE writing — the renderer already validated, but main is the trust
 * boundary.
 */

import { mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
// allowJs:true in tsconfig.node.json lets TS resolve the .js modules.
import { atomicWrite } from '../bot/brain/storage/atomicWrite.js';
import { withFileLock } from '../bot/brain/storage/fileLock.js';
import { paths } from './paths';
import { validatePortrait } from './portraitImageUtil';
import { getCharacter, saveCharacter } from './characterStore';

export interface ApplyPortraitArgs {
  characterId: string;
  bytes: Buffer;
}

/**
 * Write portrait bytes to disk under the canonical path and update the
 * character's `portrait_image` field to '<uuid>.png'.
 *
 * Returns the path reference so the renderer can immediately store it in the
 * character draft (the same string the file uses on disk).
 */
export async function applyPortrait(args: ApplyPortraitArgs): Promise<string> {
  // Defense-in-depth re-validate at the main-process trust boundary.
  validatePortrait(args.bytes);

  const char = await getCharacter(args.characterId);
  if (!char) throw new Error('Character not found.');

  const target = paths.portraitPath(args.characterId);
  await mkdir(path.dirname(target), { recursive: true });
  await withFileLock(target, async () => {
    await atomicWrite(target, args.bytes);
  });

  const portraitRef = `${args.characterId}.png`;
  await saveCharacter({ ...char, portrait_image: portraitRef });
  return portraitRef;
}

/**
 * Clear the character's portrait_image and remove the on-disk file.
 * ENOENT (file already gone) is swallowed — best-effort cleanup.
 */
export async function removePortrait(characterId: string): Promise<void> {
  const char = await getCharacter(characterId);
  if (!char) throw new Error('Character not found.');
  try {
    await unlink(paths.portraitPath(characterId));
  } catch {
    /* swallow ENOENT — best-effort */
  }
  await saveCharacter({ ...char, portrait_image: null });
}
