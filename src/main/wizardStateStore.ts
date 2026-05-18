/**
 * Wizard state persistence (Phase 9 Plan 04 Task 1B).
 *
 * Persisted JSON at `<userData>/skin-setup-state.json`. Records:
 *   - hasRunOnce — true after the first successful wizard run; gates the
 *     "first launch — finish setup" modal vs the settings-reopened flow
 *   - enabledInstallIds — which McInstall.id values the user previously
 *     ticked. mcInstallScan cross-references this to set `sei_enabled` on
 *     each detected install so the UI re-renders the correct rows-selected
 *     state on re-detect
 *   - lastRunAt — ISO timestamp, surfaced in the settings UI ("last run …")
 *   - lastSkinServerPort — Plan 05's port-drift detector compares this to
 *     the current skinServer.port; mismatch means an installed CSL config
 *     points at a stale loopback port and needs rewriting (WARNING 7)
 *
 * Atomic writes via `atomicWrite` + `withFileLock` — same discipline as
 * characterStore.ts. Defensive parsing: any structural defect (missing
 * field, wrong type, non-JSON) resets to defaults rather than crashing
 * boot. Forward-compat: unknown fields in the JSON are silently dropped
 * because the parser only reads documented keys.
 *
 * Sources:
 *   - 09-04-PLAN Task 1B
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

/**
 * Canonical defaults for a fresh install (or a corrupted-state recovery).
 * `hasRunOnce: false` keeps the first-launch modal as the entry point.
 */
function defaults(): WizardState {
  return {
    version: SCHEMA_VERSION,
    hasRunOnce: false,
    enabledInstallIds: [],
    lastRunAt: null,
    lastSkinServerPort: null,
  };
}

/**
 * Coerce an arbitrary JSON-parsed value into a valid WizardState, falling
 * back to defaults for any field that isn't strictly typed correctly.
 * Defensive — never throws on malformed input.
 */
function coerce(raw: unknown): WizardState {
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

  return {
    version: SCHEMA_VERSION,
    hasRunOnce,
    enabledInstallIds,
    lastRunAt,
    lastSkinServerPort,
  };
}

/**
 * Read `<userData>/skin-setup-state.json`. Returns defaults on ENOENT or any
 * parse failure (corrupted file → don't crash boot, just reset).
 */
export async function loadWizardState(): Promise<WizardState> {
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
export async function saveWizardState(next: WizardState): Promise<void> {
  // Coerce here too — if a caller hand-rolled a WizardState literal with a
  // bad type, we'd rather silently normalize than persist garbage.
  const validated = coerce(next);
  const target = paths.wizardStatePath();
  await mkdir(paths.userData(), { recursive: true });
  await withFileLock(target, async () => {
    await atomicWrite(target, JSON.stringify(validated, null, 2) + '\n');
  });
}
