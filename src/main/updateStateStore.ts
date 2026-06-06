/**
 * Update state persistence (quick/260604-uoy).
 *
 * Persisted JSON at `<userDataRoot>/update-state.json` (DEVICE-GLOBAL — the
 * installed app version is a property of the machine/install, never an
 * account; see paths.updateStatePath). Records:
 *   - lastSeenVersion — `app.getVersion()` as observed on the previous launch.
 *     Drives the patch-only what's-new FALLBACK: if the running version is a
 *     patch-bump above lastSeenVersion and there is no stashed `pending`, we
 *     best-effort fetch the changelog and show it once.
 *   - pending — set when a MANDATORY update was silently downloaded but its
 *     changelog hasn't been shown yet. On the next launch, if
 *     `pending.version === app.getVersion()`, we show `pending.changelog` and
 *     clear the record. `{ version, changelog }` or null.
 *
 * Atomic writes via `atomicWrite` + `withFileLock` — same discipline as
 * wizardStateStore.ts / characterStore.ts. Defensive parsing: any structural
 * defect (missing field, wrong type, non-JSON) resets to defaults rather than
 * crashing boot. Forward-compat: unknown fields are silently dropped because
 * the parser only reads documented keys.
 *
 * Sources:
 *   - src/main/wizardStateStore.ts (atomic-write + lock + coerce pattern)
 *   - .planning/quick/260604-uoy-... PLAN.md Task 3 + Flow D
 */
import { readFile, mkdir } from 'node:fs/promises';
import { atomicWrite } from '../bot/brain/storage/atomicWrite.js';
import { withFileLock } from '../bot/brain/storage/fileLock.js';
import { paths } from './paths';

const logger = {
  warn: (m: string) => console.warn(`[sei] ${m}`),
};

/** Schema-version constant (matches UpdateState.version literal). */
const SCHEMA_VERSION = 1 as const;

/** A stashed, not-yet-shown post-update changelog for a specific version. */
export interface PendingWhatsNew {
  /** The version the changelog belongs to (matched against app.getVersion()). */
  version: string;
  /** Human-readable changelog (markdown-ish) to render in the what's-new popup. */
  changelog: string;
}

/** Device-global updater state shape. */
export interface UpdateState {
  version: typeof SCHEMA_VERSION;
  /** Version observed on the previous launch; null on a fresh install. */
  lastSeenVersion: string | null;
  /** Stashed mandatory-update changelog awaiting display; null when none. */
  pending: PendingWhatsNew | null;
}

/** Canonical defaults for a fresh install (or a corrupted-state recovery). */
function defaults(): UpdateState {
  return {
    version: SCHEMA_VERSION,
    lastSeenVersion: null,
    pending: null,
  };
}

/**
 * Coerce a raw object's `pending` field into PendingWhatsNew | null. Both
 * `version` and `changelog` must be non-empty strings; anything else collapses
 * to null (we'd rather drop a malformed changelog than render junk).
 */
function coercePending(raw: unknown): PendingWhatsNew | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (
    typeof obj.version !== 'string' ||
    obj.version.length === 0 ||
    typeof obj.changelog !== 'string'
  ) {
    return null;
  }
  return { version: obj.version, changelog: obj.changelog };
}

/**
 * Coerce an arbitrary JSON-parsed value into a valid UpdateState, falling back
 * to defaults for any field that isn't strictly typed correctly. Defensive —
 * never throws on malformed input.
 */
function coerce(raw: unknown): UpdateState {
  if (!raw || typeof raw !== 'object') return defaults();
  const obj = raw as Record<string, unknown>;

  const lastSeenVersion =
    typeof obj.lastSeenVersion === 'string' && obj.lastSeenVersion.length > 0
      ? obj.lastSeenVersion
      : null;

  return {
    version: SCHEMA_VERSION,
    lastSeenVersion,
    pending: coercePending(obj.pending),
  };
}

/**
 * Read `<userDataRoot>/update-state.json`. Returns defaults on ENOENT or any
 * parse failure (corrupted file → don't crash boot, just reset).
 */
export async function loadUpdateState(): Promise<UpdateState> {
  const target = paths.updateStatePath();
  let raw: string;
  try {
    raw = await readFile(target, 'utf8');
  } catch (err) {
    if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return defaults();
    }
    logger.warn(`updateStateStore: read failed (${(err as Error).message}); using defaults`);
    return defaults();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.warn('updateStateStore: update-state.json is not valid JSON; resetting to defaults');
    return defaults();
  }
  return coerce(parsed);
}

/**
 * Persist updater state atomically. mkdir-recursive the userData dir first
 * (covers a first-write race), then withFileLock to serialize concurrent
 * saves against the same path (the updater may stash `pending` on download
 * and clear it on next launch in quick succession).
 */
export async function saveUpdateState(next: UpdateState): Promise<void> {
  const validated = coerce(next);
  const target = paths.updateStatePath();
  await mkdir(paths.userData(), { recursive: true });
  await withFileLock(target, async () => {
    await atomicWrite(target, JSON.stringify(validated, null, 2) + '\n');
  });
}
