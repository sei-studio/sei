/**
 * Notices state persistence (260725).
 *
 * Persisted JSON at `<userDataRoot>/notices.json` (DEVICE-GLOBAL — a notice is
 * an announcement to the install, mirroring update-state.json's tier). Records:
 *   - notices — the last successfully fetched feed, cached so the inbox opens
 *     instantly and still works offline.
 *   - announcedIds — ids the inbox has already auto-opened for. This is what
 *     makes "opens once when received" true: a notice whose id is missing here
 *     triggers the one auto-open, and the renderer acks so it never fires again.
 *   - readIds — ids the user actually selected in the inbox. Drives the unread
 *     dot. A superset relationship does NOT hold in either direction: a notice
 *     can be announced-but-unread (two arrived, the user read one).
 *
 * Atomic writes via `atomicWrite` + `withFileLock` — same discipline as
 * updateStateStore.ts. Defensive parsing: any structural defect (missing field,
 * wrong type, non-JSON) resets to defaults rather than crashing boot.
 *
 * Source: src/main/updateStateStore.ts (atomic-write + lock + coerce pattern).
 */
import { readFile, mkdir } from 'node:fs/promises';
import { atomicWrite } from '../bot/brain/storage/atomicWrite.js';
import { withFileLock } from '../bot/brain/storage/fileLock.js';
import { paths } from './paths';
import type { Notice } from '../shared/ipc';

const logger = {
  warn: (m: string) => console.warn(`[sei] ${m}`),
};

/** Schema-version constant (matches NoticesState.version literal). */
const SCHEMA_VERSION = 1 as const;

/**
 * Hard cap on retained ids. The feed itself is expected to stay small (tens of
 * entries), but the id sets are append-only across every notice ever shipped,
 * so they are trimmed to the most recent N to keep the file bounded. Trimming
 * the OLDEST is safe: an id that falls off is one whose notice left the feed
 * long ago, so it can never be re-announced.
 */
const MAX_IDS = 500;

/** Device-global notices state shape. */
export interface NoticesState {
  version: typeof SCHEMA_VERSION;
  /** Last successfully fetched feed (newest-first), cached for offline opens. */
  notices: Notice[];
  /** Ids the inbox has already auto-opened for. */
  announcedIds: string[];
  /** Ids the user has opened in the inbox (drives the unread dot). */
  readIds: string[];
}

/** Canonical defaults for a fresh install (or a corrupted-state recovery). */
function defaults(): NoticesState {
  return { version: SCHEMA_VERSION, notices: [], announcedIds: [], readIds: [] };
}

/** Coerce a raw value into a de-duplicated array of non-empty id strings. */
function coerceIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== 'string' || v.length === 0 || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out.slice(-MAX_IDS);
}

/**
 * Coerce one raw feed entry into a Notice, or null if it is unusable. `id`,
 * `title` and `body` are required; `date` is optional (rendered as a blank
 * timestamp rather than dropping an otherwise-valid notice).
 */
export function coerceNotice(raw: unknown): Notice | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || o.id.length === 0) return null;
  if (typeof o.title !== 'string' || o.title.length === 0) return null;
  if (typeof o.body !== 'string') return null;
  return {
    id: o.id,
    title: o.title,
    date: typeof o.date === 'string' ? o.date : '',
    body: o.body,
  };
}

/** Coerce a raw value into a Notice[] (drops unusable entries, de-dupes ids). */
export function coerceNotices(raw: unknown): Notice[] {
  if (!Array.isArray(raw)) return [];
  const out: Notice[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const n = coerceNotice(entry);
    if (!n || seen.has(n.id)) continue;
    seen.add(n.id);
    out.push(n);
  }
  return out;
}

/**
 * Coerce an arbitrary JSON-parsed value into a valid NoticesState, falling back
 * to defaults for any field that isn't strictly typed correctly. Defensive —
 * never throws on malformed input.
 */
function coerce(raw: unknown): NoticesState {
  if (!raw || typeof raw !== 'object') return defaults();
  const o = raw as Record<string, unknown>;
  return {
    version: SCHEMA_VERSION,
    notices: coerceNotices(o.notices),
    announcedIds: coerceIds(o.announcedIds),
    readIds: coerceIds(o.readIds),
  };
}

/**
 * Read `<userDataRoot>/notices.json`. Returns defaults on ENOENT or any parse
 * failure (corrupted file → don't crash boot, just reset).
 */
export async function loadNoticesState(): Promise<NoticesState> {
  const target = paths.noticesStatePath();
  let raw: string;
  try {
    raw = await readFile(target, 'utf8');
  } catch (err) {
    if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return defaults();
    logger.warn(`noticesStore: read failed (${(err as Error).message}); using defaults`);
    return defaults();
  }
  try {
    return coerce(JSON.parse(raw));
  } catch {
    logger.warn('noticesStore: notices.json is not valid JSON; resetting to defaults');
    return defaults();
  }
}

/**
 * Persist notices state atomically. mkdir-recursive the userData dir first
 * (covers a first-write race), then withFileLock to serialize concurrent saves
 * against the same path (a background refresh can race a mark-read write).
 */
export async function saveNoticesState(next: NoticesState): Promise<void> {
  const validated = coerce(next);
  const target = paths.noticesStatePath();
  await mkdir(paths.userData(), { recursive: true });
  await withFileLock(target, async () => {
    await atomicWrite(target, JSON.stringify(validated, null, 2) + '\n');
  });
}
