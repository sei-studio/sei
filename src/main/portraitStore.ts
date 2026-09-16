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
 *
 * ── Versions (260909) ─────────────────────────────────────────────────────
 * Every portrait that lands on a character is ALSO kept as a sidecar
 * `<uuid>-v<n>.png` next to the canonical file, recorded in
 * `metadata.portrait_versions` (+ `portrait_active`, `portrait_regen_count`).
 * The cloud mirror (syncQueue / cloudCharacterClient) reads the CANONICAL
 * `<uuid>.png` unconditionally and derives the storage object name server-
 * side, so "select version N" = copy that sidecar's bytes onto the canonical
 * file through the same save path (which enqueues the mirror upload). Only
 * the displayed version ever reaches the cloud; the sidecars stay local.
 *
 * On the first versioned write, an existing unversioned canonical portrait
 * is snapshotted as v1 (source 'original') so the user can always go back.
 */

import { access, mkdir, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
// allowJs:true in tsconfig.node.json lets TS resolve the .js modules.
import { atomicWrite } from '../bot/brain/storage/atomicWrite.js';
import { withFileLock } from '../bot/brain/storage/fileLock.js';
import { paths } from './paths';
import { validatePortrait } from './portraitImageUtil';
import { getCharacter, saveCharacter } from './characterStore';
import {
  listPortraitVersionFilesOnDisk,
  portraitVersionPath,
  unlinkPortraitVersionFiles,
} from './portraitFiles';
import type { Character, PortraitVersion, PortraitVersionSource } from '../shared/characterSchema';
import {
  MAX_PORTRAIT_REGENS,
  MAX_PORTRAIT_VERSIONS,
  portraitActiveOf,
  portraitRegenCountOf,
  portraitVersionFile,
  portraitVersionIndex,
  portraitVersionsOf,
} from '../shared/characterSchema';
import type { PortraitVersionsState } from '../shared/ipc';

export interface ApplyPortraitArgs {
  characterId: string;
  bytes: Buffer;
  /**
   * How this portrait came to be. 'upload' (default) = the picker; 'regen' =
   * the KusArt regenerate path, which also counts against MAX_PORTRAIT_REGENS
   * (refused with PORTRAIT_REGEN_LIMIT once the cap is reached).
   */
  source?: Exclude<PortraitVersionSource, 'original'>;
}

/** Thrown by addPortraitVersion when a 'regen' write would exceed the cap. */
export const PORTRAIT_REGEN_LIMIT = 'PORTRAIT_REGEN_LIMIT';

function canonicalRef(characterId: string): string {
  return `${characterId}.png`;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function writeCanonical(characterId: string, bytes: Buffer): Promise<void> {
  const target = paths.portraitPath(characterId);
  await mkdir(path.dirname(target), { recursive: true });
  await withFileLock(target, async () => {
    await atomicWrite(target, bytes);
  });
}

async function writeSidecar(file: string, bytes: Buffer): Promise<void> {
  const target = portraitVersionPath(file);
  await mkdir(path.dirname(target), { recursive: true });
  await atomicWrite(target, bytes);
}

/**
 * Build the renderer-facing state for a character. An unversioned canonical
 * portrait (pre-260909 characters, cloud-cached rows) is surfaced as a single
 * virtual 'original' entry whose file IS the canonical name, so the modal can
 * show it without a write happening just because the modal opened.
 */
async function stateOf(char: Character): Promise<PortraitVersionsState> {
  const versions = portraitVersionsOf(char);
  const regenCount = portraitRegenCountOf(char);
  if (versions.length === 0) {
    const canonical = canonicalRef(char.id);
    const has = await fileExists(paths.portraitPath(char.id));
    return {
      versions: has ? [{ file: canonical, created_at: char.created, source: 'original' }] : [],
      active: has ? canonical : null,
      regenCount,
      regenLimit: MAX_PORTRAIT_REGENS,
    };
  }
  return {
    versions,
    active: portraitActiveOf(char),
    regenCount,
    regenLimit: MAX_PORTRAIT_REGENS,
  };
}

/** List stored versions + the active one for `characterId`. */
export async function getPortraitVersions(characterId: string): Promise<PortraitVersionsState> {
  const char = await getCharacter(characterId);
  if (!char) throw new Error('Character not found.');
  return stateOf(char);
}

/**
 * Store `bytes` as the next sidecar version AND make it the active portrait
 * (writes the canonical file + saves the character, which enqueues the cloud
 * mirror). Snapshots a pre-existing unversioned canonical portrait as v1
 * ('original') first. Returns the updated state.
 */
export async function addPortraitVersion(args: ApplyPortraitArgs): Promise<PortraitVersionsState> {
  // Defense-in-depth re-validate at the main-process trust boundary.
  validatePortrait(args.bytes);

  const char = await getCharacter(args.characterId);
  if (!char) throw new Error('Character not found.');
  const source: PortraitVersionSource = args.source ?? 'upload';

  let regenCount = portraitRegenCountOf(char);
  if (source === 'regen') {
    if (regenCount >= MAX_PORTRAIT_REGENS) {
      throw new Error(`${PORTRAIT_REGEN_LIMIT}: no regenerations left for this character.`);
    }
    regenCount += 1;
  }

  const id = args.characterId;
  let versions = portraitVersionsOf(char);
  // Next index: past everything recorded AND everything on disk, so a stale
  // sidecar from an interrupted write can never be silently overwritten.
  const onDisk = await listPortraitVersionFilesOnDisk(id);
  let maxIdx = 0;
  for (const f of [...versions.map((v) => v.file), ...onDisk]) {
    const n = portraitVersionIndex(id, f);
    if (n !== null && n > maxIdx) maxIdx = n;
  }

  // First versioned write: keep the current canonical bytes as 'original'.
  if (versions.length === 0) {
    const canonicalPath = paths.portraitPath(id);
    if (await fileExists(canonicalPath)) {
      const orig = await readFile(canonicalPath);
      const origFile = portraitVersionFile(id, maxIdx + 1);
      maxIdx += 1;
      await writeSidecar(origFile, orig);
      versions = [{ file: origFile, created_at: char.created, source: 'original' }];
    }
  }

  const file = portraitVersionFile(id, maxIdx + 1);
  await writeSidecar(file, args.bytes);
  await writeCanonical(id, args.bytes);
  versions = [...versions, { file, created_at: new Date().toISOString(), source }];

  // Soft cap: uploads are unbounded, so evict the oldest inactive upload
  // versions past MAX_PORTRAIT_VERSIONS (never the original or a regen, and
  // never the version just made active).
  while (versions.length > MAX_PORTRAIT_VERSIONS) {
    const victim = versions.find((v) => v.source === 'upload' && v.file !== file);
    if (!victim) break;
    versions = versions.filter((v) => v !== victim);
    try {
      await unlink(portraitVersionPath(victim.file));
    } catch {
      /* best-effort */
    }
  }

  const metadata: Record<string, unknown> = {
    ...(char.metadata ?? {}),
    portrait_versions: versions,
    portrait_active: file,
  };
  if (source === 'regen') metadata.portrait_regen_count = regenCount;
  await saveCharacter({ ...char, portrait_image: canonicalRef(id), metadata });

  return {
    versions,
    active: file,
    regenCount,
    regenLimit: MAX_PORTRAIT_REGENS,
  };
}

/**
 * Write portrait bytes to disk under the canonical path and update the
 * character's `portrait_image` field to '<uuid>.png'. Also records the bytes
 * as a stored version (source 'upload' unless told otherwise).
 *
 * Returns the path reference so the renderer can immediately store it in the
 * character draft (the same string the file uses on disk).
 */
export async function applyPortrait(args: ApplyPortraitArgs): Promise<string> {
  await addPortraitVersion(args);
  return canonicalRef(args.characterId);
}

/**
 * Make a stored version the active portrait: copy the sidecar's bytes onto
 * the canonical file and save the character (cloud mirror picks up the new
 * canonical bytes; an already-uploaded identical file is skipped by the md5
 * marker, which is correct). Selecting the virtual canonical 'original' of
 * an unversioned character is a no-op.
 */
export async function selectPortraitVersion(args: {
  characterId: string;
  file: string;
}): Promise<PortraitVersionsState> {
  const { characterId: id, file } = args;
  const char = await getCharacter(id);
  if (!char) throw new Error('Character not found.');

  const versions = portraitVersionsOf(char);
  if (file === canonicalRef(id)) {
    if (versions.length === 0) return stateOf(char);
    throw new Error('Unknown portrait version.');
  }
  if (portraitVersionIndex(id, file) === null || !versions.some((v) => v.file === file)) {
    throw new Error('Unknown portrait version.');
  }
  if (portraitActiveOf(char) === file && char.portrait_image === canonicalRef(id)) {
    return stateOf(char);
  }

  const bytes = await readFile(portraitVersionPath(file));
  validatePortrait(bytes);
  await writeCanonical(id, bytes);
  await saveCharacter({
    ...char,
    portrait_image: canonicalRef(id),
    metadata: { ...(char.metadata ?? {}), portrait_active: file },
  });
  return {
    versions,
    active: file,
    regenCount: portraitRegenCountOf(char),
    regenLimit: MAX_PORTRAIT_REGENS,
  };
}

/**
 * Clear the character's portrait_image and remove the on-disk file plus every
 * stored version. The lifetime regen count is kept (it is a cap, not a
 * per-portrait budget). ENOENT (file already gone) is swallowed — best-effort
 * cleanup.
 */
export async function removePortrait(characterId: string): Promise<void> {
  const char = await getCharacter(characterId);
  if (!char) throw new Error('Character not found.');
  try {
    await unlink(paths.portraitPath(characterId));
  } catch {
    /* swallow ENOENT — best-effort */
  }
  await unlinkPortraitVersionFiles(characterId);
  const metadata: Record<string, unknown> = { ...(char.metadata ?? {}) };
  delete metadata.portrait_versions;
  delete metadata.portrait_active;
  await saveCharacter({ ...char, portrait_image: null, metadata });
}

/** Re-exported for callers that only need the sidecar shape. */
export type { PortraitVersion };
