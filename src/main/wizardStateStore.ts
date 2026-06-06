/**
 * Wizard state persistence.
 *
 * Persisted JSON at `<userData>/skin-setup-state.json`. Records:
 *   - hasRunOnce — true after the first successful wizard run; gates the
 *     "first launch — finish setup" modal vs the settings-reopened flow
 *   - enabledInstallIds — which McInstall.id values the user previously
 *     ticked. mcInstallScan cross-references this to set `sei_enabled` on
 *     each detected install so the UI re-renders the correct rows-selected
 *     state on re-detect
 *   - lastRunAt — ISO timestamp, surfaced in the settings UI ("last run …")
 *   - lastSkinServerPort — the port-drift detector compares this to the
 *     current skinServer.port; mismatch means an installed CSL config
 *     points at a stale loopback port and needs rewriting
 *
 * Atomic writes via `atomicWrite` + `withFileLock` — same discipline as
 * characterStore.ts. Defensive parsing: any structural defect (missing
 * field, wrong type, non-JSON) resets to defaults rather than crashing
 * boot. Forward-compat: unknown fields in the JSON are silently dropped
 * because the parser only reads documented keys.
 *
 * Sources:
 *   - src/main/characterStore.ts (atomic-write + lock pattern this mirrors)
 *   - src/shared/ipc.ts (WizardState type)
 */
import { readFile, mkdir } from 'node:fs/promises';
import { atomicWrite } from '../bot/brain/storage/atomicWrite.js';
import { withFileLock } from '../bot/brain/storage/fileLock.js';
import { paths } from './paths';
import type { WizardState } from '../shared/ipc';

const logger = {
  warn: (m: string) => console.warn(`[sei] ${m}`),
};

/** Schema-version constant (matches WizardState.version literal). */
const SCHEMA_VERSION = 1 as const;

/* -------------------------------------------------------------------------- */
/*  Link manifest (260518-o1k T6) — persisted per vanilla install              */
/* -------------------------------------------------------------------------- */

/**
 * Per-install record of which user mods were hardlinked into the Sei
 * gameDir on the last wizard run. Used at re-run time to reconcile the
 * gameDir's mods/ against the current state of the user's
 * <.minecraft>/mods/ folder (remove stale links, add new compatible
 * ones). Stored under `WizardStateExtended.linkManifests[installId]`.
 *
 * Why persist at all? Without a manifest we'd have to fingerprint every
 * file on every re-run; with the manifest we know which files we put
 * there and which strategy was used. This also lets us cleanly handle
 * the case where the source mod is removed between runs.
 */
export interface LinkManifestEntry {
  /** Basename of the mod JAR (e.g. `Sodium-fabric-0.6.0.jar`). */
  sourceName: string;
  /** Absolute path to the source JAR under <.minecraft>/mods/. */
  sourcePath: string;
  /** Absolute path to the link target under <sei gameDir>/mods/. */
  targetPath: string;
  /** Which placement strategy succeeded for this entry. */
  strategy: 'link' | 'symlink' | 'copy';
  /** ISO timestamp the entry was created/refreshed. */
  linkedAt: string;
}

export interface LinkManifestExclusion {
  /** Basename of the mod JAR that was excluded. */
  name: string;
  /** Why it was excluded — surfaced in the wizard UI on the done step. */
  reason: 'mc-version-mismatch' | 'unparseable' | 'no-metadata' | 'read-error';
  /** Declared MC range, when known (only for mc-version-mismatch). */
  declaredMc?: string;
}

export interface LinkManifest {
  /** MC version the link scan was resolved against. */
  targetMc: string;
  entries: LinkManifestEntry[];
  excluded: LinkManifestExclusion[];
}

/**
 * Extended wizard state — the publicly typed WizardState (in shared/ipc)
 * is the original 5-field shape; this main-side extension carries the
 * link-manifest map. We keep it main-side because the renderer never
 * needs the persisted manifest directly (it receives modLinkSummary on
 * each WizardInstallResult, which is enough to render the UI).
 */
export interface WizardStateExtended extends WizardState {
  /** Per-install link manifests; absent for never-linked installs. */
  linkManifests?: Record<string, LinkManifest>;
}

/**
 * Canonical defaults for a fresh install (or a corrupted-state recovery).
 * `hasRunOnce: false` keeps the first-launch modal as the entry point.
 */
function defaults(): WizardStateExtended {
  return {
    version: SCHEMA_VERSION,
    hasRunOnce: false,
    enabledInstallIds: [],
    lastRunAt: null,
    lastSkinServerPort: null,
    linkManifests: {},
  };
}

/** Allowed exclusion reasons — matches LinkManifestExclusion.reason. */
const EXCLUSION_REASONS = new Set([
  'mc-version-mismatch',
  'unparseable',
  'no-metadata',
  'read-error',
]);

/** Allowed link strategies — matches LinkManifestEntry.strategy. */
const LINK_STRATEGIES = new Set(['link', 'symlink', 'copy']);

/**
 * Coerce a raw object into a LinkManifest. Filters out malformed entries
 * silently; an entirely-malformed manifest collapses to
 * `{ targetMc: '', entries: [], excluded: [] }`. Backward-compat: any
 * unknown field is dropped on load + not persisted on the next save.
 */
function coerceLinkManifest(raw: unknown): LinkManifest {
  if (!raw || typeof raw !== 'object') {
    return { targetMc: '', entries: [], excluded: [] };
  }
  const obj = raw as Record<string, unknown>;
  const targetMc = typeof obj.targetMc === 'string' ? obj.targetMc : '';

  const entries: LinkManifestEntry[] = [];
  if (Array.isArray(obj.entries)) {
    for (const e of obj.entries) {
      if (!e || typeof e !== 'object') continue;
      const ee = e as Record<string, unknown>;
      if (
        typeof ee.sourceName !== 'string' ||
        typeof ee.sourcePath !== 'string' ||
        typeof ee.targetPath !== 'string' ||
        typeof ee.strategy !== 'string' ||
        !LINK_STRATEGIES.has(ee.strategy) ||
        typeof ee.linkedAt !== 'string'
      ) continue;
      entries.push({
        sourceName: ee.sourceName,
        sourcePath: ee.sourcePath,
        targetPath: ee.targetPath,
        strategy: ee.strategy as 'link' | 'symlink' | 'copy',
        linkedAt: ee.linkedAt,
      });
    }
  }

  const excluded: LinkManifestExclusion[] = [];
  if (Array.isArray(obj.excluded)) {
    for (const e of obj.excluded) {
      if (!e || typeof e !== 'object') continue;
      const ee = e as Record<string, unknown>;
      if (
        typeof ee.name !== 'string' ||
        typeof ee.reason !== 'string' ||
        !EXCLUSION_REASONS.has(ee.reason)
      ) continue;
      excluded.push({
        name: ee.name,
        reason: ee.reason as LinkManifestExclusion['reason'],
        ...(typeof ee.declaredMc === 'string' ? { declaredMc: ee.declaredMc } : {}),
      });
    }
  }

  return { targetMc, entries, excluded };
}

/**
 * Coerce an arbitrary JSON-parsed value into a valid WizardStateExtended,
 * falling back to defaults for any field that isn't strictly typed
 * correctly. Defensive — never throws on malformed input.
 *
 * Backward-compat: pre-260518-o1k state files had no `linkManifests`
 * field; coerce just defaults to `{}` in that case.
 */
function coerce(raw: unknown): WizardStateExtended {
  if (!raw || typeof raw !== 'object') return defaults();
  const obj = raw as Record<string, unknown>;

  // hasRunOnce: must be boolean; anything else (including undefined) → false.
  const hasRunOnce = obj.hasRunOnce === true;

  // enabledInstallIds: filter to string entries; non-arrays → [].
  const enabledInstallIds = Array.isArray(obj.enabledInstallIds)
    ? obj.enabledInstallIds.filter((x): x is string => typeof x === 'string')
    : [];

  // lastRunAt: must be a non-empty string (ISO timestamp); anything else → null.
  const lastRunAt =
    typeof obj.lastRunAt === 'string' && obj.lastRunAt !== '' ? obj.lastRunAt : null;

  // lastSkinServerPort: must be a finite integer in [1, 65535]; else → null.
  const port = obj.lastSkinServerPort;
  const lastSkinServerPort =
    typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535
      ? port
      : null;

  // linkManifests: optional map of installId → LinkManifest. Each value
  // goes through coerceLinkManifest; non-object inputs collapse to {}.
  let linkManifests: Record<string, LinkManifest> = {};
  if (obj.linkManifests && typeof obj.linkManifests === 'object') {
    for (const [k, v] of Object.entries(obj.linkManifests)) {
      if (typeof k === 'string' && k.length > 0) {
        linkManifests[k] = coerceLinkManifest(v);
      }
    }
  }

  return {
    version: SCHEMA_VERSION,
    hasRunOnce,
    enabledInstallIds,
    lastRunAt,
    lastSkinServerPort,
    linkManifests,
  };
}

/**
 * Read `<userData>/skin-setup-state.json`. Returns defaults on ENOENT or any
 * parse failure (corrupted file → don't crash boot, just reset).
 */
export async function loadWizardState(): Promise<WizardStateExtended> {
  const target = paths.wizardStatePath();
  let raw: string;
  try {
    raw = await readFile(target, 'utf8');
  } catch (err) {
    if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return defaults();
    }
    logger.warn(`wizardStateStore: read failed (${(err as Error).message}); using defaults`);
    return defaults();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.warn('wizardStateStore: skin-setup-state.json is not valid JSON; resetting to defaults');
    return defaults();
  }
  return coerce(parsed);
}

/**
 * Persist wizard state atomically. mkdir-recursive the userData dir first
 * (covers the case where this is the very first <userData> write). Uses
 * withFileLock to serialize concurrent saves against the same path in this
 * process (the wizard orchestrator may write progress + final state in
 * quick succession; the lock prevents interleaved rename(2) ordering bugs).
 */
export async function saveWizardState(next: WizardStateExtended): Promise<void> {
  // Coerce here too — if a caller hand-rolled a WizardState literal with a
  // bad type, we'd rather silently normalize than persist garbage.
  const validated = coerce(next);
  const target = paths.wizardStatePath();
  await mkdir(paths.userData(), { recursive: true });
  await withFileLock(target, async () => {
    await atomicWrite(target, JSON.stringify(validated, null, 2) + '\n');
  });
}
