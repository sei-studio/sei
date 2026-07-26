/**
 * Notices inbox (260725) — operator announcements delivered to the app.
 *
 * A side-channel JSON feed at https://sei.gg/notices.json, hosted next to
 * version.json and NOT linked from the website (it exists for the desktop app;
 * web visitors never see an inbox). Shape:
 *
 *   {
 *     "notices": [
 *       {
 *         "id": "260725-voice-calls",     // stable, unique, never reused
 *         "title": "Voice calls are here",
 *         "date": "2026-07-25",           // ISO date, shown in the inbox
 *         "body": "Markdown body…"        // see renderNoticeBody in the renderer
 *       }
 *     ]
 *   }
 *
 * CADENCE — deliberately not its own clock. The refresh is driven from
 * updater.ts's existing trigger points (startup, window focus, machine
 * resume/unlock, the 30-minute backstop timer, and a manual "Check for
 * updates"), sharing MIN_BACKGROUND_GAP_MS. A notice check is therefore exactly
 * as frequent as an update check, and costs one extra ~1KB GET on the same
 * wake-ups rather than a second timer.
 *
 * OPEN-ONCE — the auto-open decision is derived from persisted state, never
 * from an in-memory flag, so a push dropped by a renderer that hasn't mounted
 * its listener yet doesn't lose the announcement: the renderer's mount-time
 * pull (`notices:get`) computes the same answer. The renderer acks after
 * opening (`notices:ack`), which records every current id in `announcedIds`,
 * and only then does the inbox stop opening itself.
 *
 * Unlike the updater this runs in dev too — there's nothing packaged-only about
 * fetching a JSON file, and it makes the feature testable without a build.
 *
 * Source:
 *   - src/main/updater.ts (net.request fetch + push helper pattern)
 *   - src/main/noticesStore.ts (persistence + coercion)
 */
import { net, type BrowserWindow } from 'electron';
import { IpcChannel, type Notice, type NoticesSnapshot } from '../shared/ipc';
import { coerceNotices, loadNoticesState, saveNoticesState, type NoticesState } from './noticesStore';

const logger = {
  info: (m: string) => console.log(`[sei] ${m}`),
  warn: (m: string) => console.warn(`[sei] ${m}`),
};

const NOTICES_URL = 'https://sei.gg/notices.json';
const NOTICES_FETCH_TIMEOUT_MS = 5000;

/** Module singleton — set once by initNotices. */
let getMainWindow: (() => BrowserWindow | null) | null = null;

/**
 * Serializes every read-modify-write of the notices state. loadNoticesState /
 * saveNoticesState are individually atomic, but a background refresh landing
 * mid mark-read would otherwise write back a stale `readIds`. All mutations
 * queue on this chain; it never rejects (each link swallows its own error).
 */
let stateChain: Promise<void> = Promise.resolve();

function mutate<T>(fn: (state: NoticesState) => Promise<T> | T): Promise<T> {
  const run = stateChain.then(async () => {
    const state = await loadNoticesState();
    return fn(state);
  });
  stateChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** True while a refresh is in flight — collapses overlapping triggers. */
let refreshInFlight = false;

/* -------------------------------------------------------------------------- */
/*  Feed fetch                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Best-effort fetch of the notices feed. Returns null on any failure (no
 * network, timeout, bad JSON, non-2xx) so the cached feed simply stays put.
 * Accepts either `{ notices: [...] }` or a bare `[...]` top level.
 */
function fetchNoticesFeed(): Promise<Notice[] | null> {
  return new Promise((resolve) => {
    const req = net.request({ url: NOTICES_URL, method: 'GET', redirect: 'follow' });
    const timer = setTimeout(() => {
      try {
        req.abort();
      } catch {
        /* already settled */
      }
      resolve(null);
    }, NOTICES_FETCH_TIMEOUT_MS);

    let body = '';
    req.on('response', (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        clearTimeout(timer);
        resolve(null);
        return;
      }
      res.on('data', (chunk) => {
        body += chunk.toString('utf8');
      });
      res.on('end', () => {
        clearTimeout(timer);
        try {
          const json = JSON.parse(body) as unknown;
          const raw = Array.isArray(json) ? json : (json as { notices?: unknown })?.notices;
          if (!Array.isArray(raw)) {
            resolve(null);
            return;
          }
          resolve(sortNewestFirst(coerceNotices(raw)));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    req.end();
  });
}

/**
 * Order the feed newest-first by `date`. Entries with a missing/unparseable
 * date sink to the bottom keeping their feed order (Array#sort is stable), so a
 * malformed date never reshuffles the rest.
 */
export function sortNewestFirst(notices: Notice[]): Notice[] {
  const stamp = (n: Notice): number => {
    const t = Date.parse(n.date);
    return Number.isNaN(t) ? -Infinity : t;
  };
  return [...notices].sort((a, b) => stamp(b) - stamp(a));
}

/* -------------------------------------------------------------------------- */
/*  Snapshot                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Build the renderer-facing snapshot. `autoOpen` is true when the feed holds at
 * least one notice that has never been announced — the "opens once when
 * received" rule, derived rather than remembered.
 */
function snapshotOf(state: NoticesState): NoticesSnapshot {
  const announced = new Set(state.announcedIds);
  return {
    notices: state.notices,
    readIds: state.readIds.filter((id) => state.notices.some((n) => n.id === id)),
    autoOpen: state.notices.some((n) => !announced.has(n.id)),
  };
}

function push(snapshot: NoticesSnapshot): void {
  const win = getMainWindow?.() ?? null;
  if (win && !win.isDestroyed()) win.webContents.send(IpcChannel.app.notices, snapshot);
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                 */
/* -------------------------------------------------------------------------- */

/** Wire the push channel. Called once from main bootstrap, before initUpdater. */
export function initNotices(deps: { getMainWindow: () => BrowserWindow | null }): void {
  getMainWindow = deps.getMainWindow;
}

/**
 * Fetch the feed and merge it into persisted state, then push the new snapshot
 * to the renderer. No-ops while another refresh is in flight. Never throws —
 * an unreachable feed leaves the cached notices untouched.
 *
 * Ids that vanish from the feed have their notices dropped from the cache (the
 * operator retracted them) but keep their announced/read marks, so a
 * re-published id is not re-announced.
 */
export async function refreshNotices(reason: string): Promise<void> {
  if (refreshInFlight) return;
  refreshInFlight = true;
  try {
    const fetched = await fetchNoticesFeed();
    if (!fetched) {
      logger.info(`notices: refresh (${reason}) found no usable feed`);
      return;
    }
    const snapshot = await mutate(async (state) => {
      const known = new Set(state.notices.map((n) => n.id));
      const fresh = fetched.filter((n) => !known.has(n.id)).length;
      const next: NoticesState = { ...state, notices: fetched };
      await saveNoticesState(next);
      if (fresh > 0) logger.info(`notices: ${fresh} new notice(s) from refresh (${reason})`);
      return snapshotOf(next);
    });
    push(snapshot);
  } catch (err) {
    logger.warn(`notices: refresh failed (${(err as Error).message})`);
  } finally {
    refreshInFlight = false;
  }
}

/**
 * Renderer pull (`notices:get`). Returns the cached snapshot without touching
 * the network — the refresh cadence owns fetching. Race-proof counterpart to
 * the push: a renderer that mounts after the startup refresh still learns it
 * should auto-open, because `autoOpen` is derived from persisted state.
 */
export async function getNoticesSnapshot(): Promise<NoticesSnapshot> {
  return mutate((state) => snapshotOf(state));
}

/**
 * Renderer ack (`notices:ack`) — records every currently-cached notice as
 * announced, so the inbox never auto-opens for them again. Sent right after the
 * renderer opens the inbox on its own; harmless to call repeatedly.
 */
export async function ackNoticesAnnounced(): Promise<NoticesSnapshot> {
  return mutate(async (state) => {
    const announced = new Set(state.announcedIds);
    for (const n of state.notices) announced.add(n.id);
    const next: NoticesState = { ...state, announcedIds: [...announced] };
    await saveNoticesState(next);
    return snapshotOf(next);
  });
}

/**
 * Renderer mark-read (`notices:read`) — the user selected a notice in the
 * inbox. Clears its unread dot. Unknown ids are ignored.
 */
export async function markNoticeRead(id: string): Promise<NoticesSnapshot> {
  return mutate(async (state) => {
    if (!state.notices.some((n) => n.id === id) || state.readIds.includes(id)) {
      return snapshotOf(state);
    }
    const next: NoticesState = { ...state, readIds: [...state.readIds, id] };
    await saveNoticesState(next);
    return snapshotOf(next);
  });
}
