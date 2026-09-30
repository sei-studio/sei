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
 *
 * The version LIST is reconciled against disk on every read (`versionsOnDisk`):
 * `metadata.portrait_versions` / `portrait_active` ride the cloud row verbatim
 * while the sidecars are local-only, so a second device sees recorded versions
 * whose files it never had. Those are filtered out rather than listed, a
 * missing active file means "the canonical is what is showing", and a write
 * on such a device snapshots its canonical first so the picture is not lost.
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
  deletePortraitFiles,
  listPortraitVersionFilesOnDisk,
  portraitVersionPath,
} from './portraitFiles';
import type { Character, PortraitVersion, PortraitVersionSource } from '../shared/characterSchema';
import {
  MAX_PORTRAIT_REGENS,
  MAX_PORTRAIT_VERSIONS,
  PORTRAIT_REGEN_LIMIT,
  PORTRAIT_REGEN_LIMIT_COPY,
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

/**
 * `code` of the Error addPortraitVersion throws when a 'regen' write would
 * exceed the cap (+ its user copy). Defined in the shared schema so the fast
 * guard in uniqueGeneration can import it statically; re-exported here for
 * callers that only know the store.
 */
export { PORTRAIT_REGEN_LIMIT, PORTRAIT_REGEN_LIMIT_COPY } from '../shared/characterSchema';

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

/**
 * The recorded versions that are actually on THIS device's disk, plus every
 * sidecar found (recorded or not). `metadata.portrait_versions` cloud-syncs
 * verbatim with the character row (cloudCharacterClient passes metadata
 * through; cacheOnDemand saves the row and downloads only the canonical
 * `<uuid>.png`), but the `<uuid>-v<n>.png` sidecars never leave the machine
 * that wrote them. Every reader of the list goes through here so a phantom
 * entry can never be shown, selected (raw ENOENT) or mistaken for "this
 * device already has a versioned history".
 */
async function versionsOnDisk(char: Character): Promise<{ versions: PortraitVersion[]; onDisk: string[] }> {
  const onDisk = await listPortraitVersionFilesOnDisk(char.id);
  const present = new Set(onDisk.map((f) => f.toLowerCase()));
  const versions = portraitVersionsOf(char).filter((v) => present.has(v.file.toLowerCase()));
  return { versions, onDisk };
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
  const { versions } = await versionsOnDisk(char);
  const regenCount = portraitRegenCountOf(char);
  const canonical = canonicalRef(char.id);
  if (versions.length === 0) {
    const has = await fileExists(paths.portraitPath(char.id));
    return {
      versions: has ? [{ file: canonical, created_at: char.created, source: 'original' }] : [],
      active: has ? canonical : null,
      regenCount,
      regenLimit: MAX_PORTRAIT_REGENS,
    };
  }
  // A recorded active file this device does not have (metadata synced from
  // another machine) means the canonical file is showing bytes no local
  // sidecar holds: report the canonical as active rather than a phantom.
  const recordedActive = portraitActiveOf(char);
  const active =
    recordedActive !== null && versions.some((v) => v.file === recordedActive) ? recordedActive : canonical;
  return {
    versions,
    active,
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
      const err = new Error(`${PORTRAIT_REGEN_LIMIT}: ${PORTRAIT_REGEN_LIMIT_COPY}`) as Error & { code: string };
      err.code = PORTRAIT_REGEN_LIMIT;
      throw err;
    }
    regenCount += 1;
  }

  const id = args.characterId;
  const recorded = portraitVersionsOf(char);
  const present = await versionsOnDisk(char);
  const onDisk = present.onDisk;
  let versions = present.versions;
  // Next index: past everything recorded (on this device or not) AND
  // everything on disk, so neither a stale sidecar from an interrupted write
  // nor an index another device already handed out is silently overwritten.
  let maxIdx = 0;
  for (const f of [...recorded.map((v) => v.file), ...onDisk]) {
    const n = portraitVersionIndex(id, f);
    if (n !== null && n > maxIdx) maxIdx = n;
  }

  // Keep the current canonical bytes as 'original' whenever no local sidecar
  // holds them: the first versioned write on this device (nothing on disk,
  // whatever the synced metadata claims), or a canonical whose recorded
  // active version lives on another machine. Without this the picture the
  // user is looking at is overwritten with nothing to switch back to.
  const recordedActive = portraitActiveOf(char);
  const canonicalHeld = recordedActive !== null && versions.some((v) => v.file === recordedActive);
  if (onDisk.length === 0 || !canonicalHeld) {
    const canonicalPath = paths.portraitPath(id);
    if (await fileExists(canonicalPath)) {
      const orig = await readFile(canonicalPath);
      const origFile = portraitVersionFile(id, maxIdx + 1);
      maxIdx += 1;
      await writeSidecar(origFile, orig);
      versions = [...versions, { file: origFile, created_at: char.created, source: 'original' }];
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

  const { versions } = await versionsOnDisk(char);
  if (file === canonicalRef(id)) {
    // The virtual canonical entry: a no-op while it is what is showing.
    const state = await stateOf(char);
    if (state.active === file) return state;
    throw new Error('Unknown portrait version.');
  }
  // A version recorded in synced metadata but absent from this disk fails
  // here too, instead of surfacing as a raw ENOENT from readFile below.
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
 * Clear the character's portrait_image and remove the on-disk file, every
 * stored version AND the cloud client's md5 upload marker (deletePortraitFiles,
 * the same sweep character delete runs; leaving the marker behind would make
 * a later re-upload of identical bytes look already-uploaded). The lifetime
 * regen count is kept (it is a cap, not a per-portrait budget). ENOENT (file
 * already gone) is swallowed — best-effort cleanup.
 */
export async function removePortrait(characterId: string): Promise<void> {
  const char = await getCharacter(characterId);
  if (!char) throw new Error('Character not found.');
  await deletePortraitFiles(characterId);
  const metadata: Record<string, unknown> = { ...(char.metadata ?? {}) };
  delete metadata.portrait_versions;
  delete metadata.portrait_active;
  await saveCharacter({ ...char, portrait_image: null, metadata });
}

/** Re-exported for callers that only need the sidecar shape. */
export type { PortraitVersion };
