/**
 * Operator feed (260725, reworked 261027) — https://sei.gg/notices.json.
 *
 * A side-channel JSON file hosted next to version.json and NOT linked from the
 * website. Until v0.6.9 it fed the notices inbox (markdown notices that opened
 * once). From v0.6.10 the inbox UI is gone and the feed's only job in the app
 * is the startup popup: one operator page, shown once per install. Shape:
 *
 *   {
 *     "notices": [ ... ],      // still read by 0.6.9 and older; ignored here
 *     "popup": { "id": "...", "url": "https://sei.gg/popup/<id>", ... }
 *   }
 *
 * See startupPopup.ts for the popup fields and rules. Old clients only read
 * `notices` (and accept a bare array), so `popup` is invisible to them.
 *
 * CADENCE — deliberately not its own clock. The refresh is driven from
 * updater.ts's existing trigger points (startup, window focus, machine
 * resume/unlock, the 30-minute backstop timer, and a manual "Check for
 * updates"), sharing MIN_BACKGROUND_GAP_MS. One extra ~1KB GET on the same
 * wake-ups rather than a second timer.
 *
 * SHOW-ONCE — the popup is pushed to the renderer when a refresh finds an id
 * this install has not shown, and the renderer also pulls it on mount (the
 * startup push can land before its listener exists). The renderer shows it
 * only on a calm screen, and only after main confirms the page really loaded
 * (popupFrameGuards.ts). The id is recorded in `popupShownIds` at that moment,
 * so a popup that failed to load (offline, 404) is tried again next time.
 *
 * SKIP — a popup with `skipIf` is not owed while its condition holds on this
 * install (skipConditionHolds below). It is checked on every hand-out and in
 * the `app:startup-popup-loaded` handler, so a user who connects ChatGPT while
 * the page loads is not shown "Sign in with ChatGPT". A skipped popup is not
 * recorded as shown.
 *
 * Runs in dev too. In dev only, SEI_NOTICES_URL overrides the feed URL, and
 * popup pages on that URL's origin are allowed (for local testing).
 *
 * Source:
 *   - src/main/updater.ts (net.request fetch + push helper pattern)
 *   - src/main/noticesStore.ts (persistence + coercion)
 */
import { app, net, type BrowserWindow } from 'electron';
import { IpcChannel, type StartupPopupInfo } from '../shared/ipc';
import { loadNoticesState, saveNoticesState, type NoticesState } from './noticesStore';
import {
  coerceStartupPopup,
  isAllowedPopupUrl,
  popupToShow,
  type PopupSkipCondition,
  type StartupPopup,
} from './startupPopup';

const logger = {
  info: (m: string) => console.log(`[sei] ${m}`),
  warn: (m: string) => console.warn(`[sei] ${m}`),
};

const NOTICES_URL = 'https://sei.gg/notices.json';
const NOTICES_FETCH_TIMEOUT_MS = 5000;

/** Dev-only feed override (never honoured in a packaged build). */
function devFeedOverride(): string | null {
  if (app.isPackaged) return null;
  const raw = process.env.SEI_NOTICES_URL;
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Origins popup pages may come from besides sei.gg: the dev override's, in dev only. */
export function popupDevOrigins(): string[] {
  const o = devFeedOverride();
  return o ? [new URL(o).origin] : [];
}

/** Whether a frame URL is an allowed popup page (sei.gg/popup/, or the dev origin). */
export function isPopupFrameUrl(url: string): boolean {
  return isAllowedPopupUrl(url, popupDevOrigins());
}

/** Module singleton — set once by initNotices. */
let getMainWindow: (() => BrowserWindow | null) | null = null;

/**
 * Serializes every read-modify-write of the notices state. loadNoticesState /
 * saveNoticesState are individually atomic, but two writers interleaving
 * would otherwise write back a stale copy. It never rejects (each link
 * swallows its own error).
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

/**
 * The feed's current popup for this client (allowed, in range, not expired),
 * before the shown-ids filter. Null until a refresh finds one, and after a
 * refresh finds none (the operator took it down).
 */
let feedPopup: StartupPopup | null = null;

/* -------------------------------------------------------------------------- */
/*  Feed fetch                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Best-effort fetch of the feed. Returns the parsed JSON, or null on any
 * failure (no network, timeout, bad JSON, non-2xx).
 */
function fetchFeed(): Promise<unknown | null> {
  const url = devFeedOverride() ?? NOTICES_URL;
  return new Promise((resolve) => {
    const req = net.request({ url, method: 'GET', redirect: 'follow' });
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
          resolve(JSON.parse(body) as unknown);
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

/** The `popup` key of a parsed feed (a bare-array feed has none). */
export function feedPopupField(json: unknown): unknown {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return undefined;
  return (json as { popup?: unknown }).popup;
}

function push(popup: StartupPopupInfo | null): void {
  const win = getMainWindow?.() ?? null;
  if (win && !win.isDestroyed()) win.webContents.send(IpcChannel.app.startupPopup, popup);
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                 */
/* -------------------------------------------------------------------------- */

/** Wire the push channel. Called once from main bootstrap, before initUpdater. */
export function initNotices(deps: { getMainWindow: () => BrowserWindow | null }): void {
  getMainWindow = deps.getMainWindow;
}

/**
 * Fetch the feed and update the current popup, pushing it to the renderer
 * when it changed. No-ops while another refresh is in flight. Never throws.
 * An unreachable feed keeps whatever the last good refresh found.
 */
export async function refreshNotices(reason: string): Promise<void> {
  if (refreshInFlight) return;
  refreshInFlight = true;
  try {
    const json = await fetchFeed();
    // A feed is an object (or the old bare array). Anything else is broken,
    // not "no popup", so it must not take a live popup down.
    if (json === null || typeof json !== 'object') {
      logger.info(`notices: refresh (${reason}) found no usable feed`);
      return;
    }
    const before = feedPopup?.id ?? null;
    feedPopup = coerceStartupPopup(feedPopupField(json), {
      appVersion: app.getVersion(),
      now: Date.now(),
      devOrigins: popupDevOrigins(),
    });
    if ((feedPopup?.id ?? null) === before) return;
    const owed = await getStartupPopup();
    if (owed) logger.info(`notices: popup ${owed.id} is live (${reason})`);
    push(owed);
  } catch (err) {
    logger.warn(`notices: refresh failed (${(err as Error).message})`);
  } finally {
    refreshInFlight = false;
  }
}

/**
 * Whether a popup's `skipIf` condition holds on this install right now. A
 * check that throws counts as "does not hold" (the popup shows), since a
 * broken check must not hide an announcement from everyone.
 */
async function skipConditionHolds(cond: PopupSkipCondition): Promise<boolean> {
  try {
    switch (cond) {
      case 'chatgpt-connected': {
        // Same test as the renderer's chatgptReady(): the active account is
        // signed in with plan usage on. Lazy: the plan module is only loaded
        // when a popup asks.
        const { chatgptSession } = await import('./chatgptPlan');
        const s = await chatgptSession().status();
        const active = s.accounts.find((a) => a.id === s.activeId);
        return !!active && active.signedIn && active.planEnabled;
      }
      default:
        return false;
    }
  } catch {
    return false;
  }
}

/**
 * Renderer pull (`app:startup-popup-get`): the popup this install still owes,
 * or null. No network; the refresh cadence owns fetching.
 */
export async function getStartupPopup(): Promise<StartupPopupInfo | null> {
  const popup = feedPopup;
  const skip = popup?.skipIf ? await skipConditionHolds(popup.skipIf) : false;
  return mutate((state) => popupToShow(popup, state.popupShownIds, () => skip));
}

/**
 * Record that popup `id` was shown, so it never shows again on this install.
 * Called from the `app:startup-popup-loaded` handler once main has confirmed
 * the page loaded.
 */
export async function markStartupPopupShown(id: string): Promise<void> {
  await mutate(async (state) => {
    if (state.popupShownIds.includes(id)) return;
    await saveNoticesState({ ...state, popupShownIds: [...state.popupShownIds, id] });
  });
}
