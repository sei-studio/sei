/**
 * Startup popup (261027) — pure rules for the operator's one-page popup.
 *
 * Replaces the notices inbox in the UI. The same side-channel feed
 * (https://sei.gg/notices.json) gains an optional top-level `popup` object:
 *
 *   {
 *     "notices": [ ... ],                         // unchanged, old clients only
 *     "popup": {
 *       "id": "261101-halloween",                 // unique, never reused
 *       "url": "https://sei.gg/popup/261101-halloween",
 *       "width": 960, "height": 540,              // optional, CSS px of the page
 *       "minVersion": "0.6.10",                   // optional, inclusive
 *       "maxVersion": "0.7.0",                    // optional, inclusive
 *       "until": "2026-11-08T00:00:00Z",          // optional, hidden after this
 *       "skipIf": "chatgpt-connected"             // optional, see POPUP_SKIP_CONDITIONS
 *     }
 *   }
 *
 * Old clients (0.6.9 and earlier) read only `notices` and ignore every other
 * key, so adding `popup` changes nothing for them.
 *
 * The page is shown in a sandboxed iframe in the renderer (see
 * components/StartupPopup.tsx and popupFrameGuards.ts). Only https://sei.gg
 * pages under /popup/ may be shown: the feed is operator-authored, but the
 * allow-list keeps a bad edit (or a compromised feed) from putting an
 * arbitrary site inside the app window.
 *
 * Buttons that do something IN the app (261029) are links to
 * https://sei.gg/popup/_action/<name>; see src/shared/popupActions.ts for the
 * allow-list and routeSubframeNavigation below for how main tells an action
 * link from a page load or an outside link. Action URLs are never popup
 * pages: the feed cannot point the popup at one and the frame never loads one.
 *
 * `skipIf` (261029) names a condition under which this install does not need
 * the popup at all (for "Sign in with ChatGPT": already connected). Main
 * checks it when it hands the popup out and again just before it records the
 * popup as shown; a skipped popup is not recorded, so it is owed again if the
 * condition stops holding. A condition this build does not know drops the
 * popup (fail closed, like a bad version).
 *
 * That only protects builds that know the field. v0.6.10 (the first build
 * with the popup, before skipIf and actions) ignores unknown keys: it shows
 * the popup WITHOUT the skip, and opens an action link in the browser like
 * any other link. So a popup that names `skipIf` or uses an action link must
 * set `minVersion` to the first release that ships them, and sei.gg must
 * serve the fallback page at every action URL it links (README-popup.md in
 * the website repo) BEFORE the feed entry goes live.
 *
 * This module is electron-free so the rules are unit-testable.
 */
import semver from 'semver';
import { POPUP_ACTION_PATH_PREFIX, isPopupAction, type PopupAction } from '../shared/popupActions';

/** The one production origin popup pages may come from. */
export const POPUP_ORIGIN = 'https://sei.gg';
/** Popup pages live under this path, and only frames on it are trusted. */
export const POPUP_PATH_PREFIX = '/popup/';

/** Bounds for a page-declared size, in CSS px. Anything outside is ignored. */
const MIN_SIDE = 120;
const MAX_SIDE = 4000;
const MAX_ID_LEN = 200;

/**
 * Conditions a popup may name in `skipIf`.
 *   chatgpt-connected  the active ChatGPT account is signed in with plan
 *                      usage on (the renderer's chatgptReady()).
 */
export const POPUP_SKIP_CONDITIONS = ['chatgpt-connected'] as const;
export type PopupSkipCondition = (typeof POPUP_SKIP_CONDITIONS)[number];

/** One popup the renderer may show. */
export interface StartupPopup {
  /** Unique id; a popup is shown at most once per install per id. */
  id: string;
  /** Page URL (already allow-listed). */
  url: string;
  /** The page's intended size in CSS px; the renderer scales it to fit. */
  width?: number;
  height?: number;
  /** Skip the popup on an install where this holds (checked by main). */
  skipIf?: PopupSkipCondition;
}

export interface PopupContext {
  /** app.getVersion(). */
  appVersion: string;
  /** Epoch ms, for `until`. */
  now: number;
  /**
   * Extra origins allowed in DEV only (the SEI_NOTICES_URL override's origin,
   * e.g. http://127.0.0.1:8765). Always empty in a packaged build.
   */
  devOrigins?: readonly string[];
}

/**
 * The URL parsed, when it is on the popup origin (or a dev origin) with no
 * credentials. Shared by the page and action checks.
 */
function popupOriginUrl(url: string, devOrigins: readonly string[]): URL | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  if (u.origin !== POPUP_ORIGIN && !devOrigins.includes(u.origin)) return null;
  return u;
}

/**
 * Whether `url` is a page the app may load in the popup frame: https on
 * exactly sei.gg (no port, no credentials) under /popup/, or the same path on
 * a dev origin. Anything unparseable is rejected, and so is an action URL
 * (/popup/_action/...): those are buttons, never pages.
 */
export function isAllowedPopupUrl(url: string, devOrigins: readonly string[] = []): boolean {
  const u = popupOriginUrl(url, devOrigins);
  if (!u) return false;
  if (u.pathname.startsWith(POPUP_ACTION_PATH_PREFIX)) return false;
  return u.pathname.startsWith(POPUP_PATH_PREFIX);
}

/**
 * The action an action URL names: the action when it is allow-listed,
 * 'unknown' for an action URL with any other name, null when `url` is not an
 * action URL at all. Only https://sei.gg/popup/_action/<name> (or the same
 * path on a dev origin) counts; the query and hash are ignored, so an action
 * never takes a parameter from the page.
 */
export function popupActionFromUrl(
  url: string,
  devOrigins: readonly string[] = [],
): PopupAction | 'unknown' | null {
  const u = popupOriginUrl(url, devOrigins);
  if (!u || !u.pathname.startsWith(POPUP_ACTION_PATH_PREFIX)) return null;
  const name = u.pathname.slice(POPUP_ACTION_PATH_PREFIX.length);
  return isPopupAction(name) ? name : 'unknown';
}

/** What main does with one subframe navigation (will-frame-navigate). */
export type SubframeRoute =
  /** A popup page (or about:blank) loading: let it. */
  | { kind: 'allow' }
  /** The popup page following an action link: cancel, send the action on. */
  | { kind: 'action'; action: PopupAction }
  /** The popup page following an ordinary link: cancel, open the browser. */
  | { kind: 'external' }
  /** Anything else (a nested embed, an unknown action, a stray frame): cancel. */
  | { kind: 'block' };

/**
 * Route a navigation of a subframe of the main window. `fromUrl` is the URL
 * the navigating frame has committed right now: a popup page when it is
 * following a link, '' or about:blank for a nested iframe's first load.
 *
 * "Following a link" is usually a click, but not always: the sandboxed page
 * runs no scripts, yet a meta refresh or a `Refresh` response header still
 * navigates it with no click. So an action routed here is not proof of a
 * click; the renderer only takes actions once the popup has been shown for
 * POPUP_ACTION_ARM_MS (renderer lib/startupPopup.ts armShownPopup), and popup
 * pages must not use a refresh.
 *
 * Only a frame showing a popup page can trigger an action or open the
 * browser. An action URL never loads as a page, whoever navigates to it.
 */
export function routeSubframeNavigation(
  url: string,
  fromUrl: string,
  devOrigins: readonly string[] = [],
): SubframeRoute {
  const fromPopup = isAllowedPopupUrl(fromUrl, devOrigins);
  const action = popupActionFromUrl(url, devOrigins);
  if (action !== null) {
    return fromPopup && action !== 'unknown' ? { kind: 'action', action } : { kind: 'block' };
  }
  if (url === 'about:blank' || isAllowedPopupUrl(url, devOrigins)) return { kind: 'allow' };
  return fromPopup ? { kind: 'external' } : { kind: 'block' };
}

function cleanVersion(raw: string): string | null {
  const v = raw.trim().replace(/^v/i, '');
  return semver.valid(v);
}

function side(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  if (raw < MIN_SIDE || raw > MAX_SIDE) return null;
  return Math.round(raw);
}

/**
 * Coerce the feed's `popup` value into a StartupPopup for THIS client, or null
 * when there is nothing to show: missing, malformed, a disallowed url, outside
 * the version range, or past `until`. Fails closed: a version or date that
 * does not parse hides the popup rather than showing it everywhere.
 */
export function coerceStartupPopup(raw: unknown, ctx: PopupContext): StartupPopup | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;

  if (typeof o.id !== 'string') return null;
  const id = o.id.trim();
  if (id.length === 0 || id.length > MAX_ID_LEN) return null;

  if (typeof o.url !== 'string' || !isAllowedPopupUrl(o.url, ctx.devOrigins)) return null;

  const app = cleanVersion(ctx.appVersion);
  if (o.minVersion !== undefined || o.maxVersion !== undefined) {
    if (!app) return null;
    if (o.minVersion !== undefined) {
      const min = typeof o.minVersion === 'string' ? cleanVersion(o.minVersion) : null;
      if (!min || semver.lt(app, min)) return null;
    }
    if (o.maxVersion !== undefined) {
      const max = typeof o.maxVersion === 'string' ? cleanVersion(o.maxVersion) : null;
      if (!max || semver.gt(app, max)) return null;
    }
  }

  if (o.until !== undefined) {
    const until = typeof o.until === 'string' ? Date.parse(o.until) : NaN;
    if (Number.isNaN(until) || ctx.now > until) return null;
  }

  let skipIf: PopupSkipCondition | undefined;
  if (o.skipIf !== undefined) {
    if (!(POPUP_SKIP_CONDITIONS as readonly unknown[]).includes(o.skipIf)) return null;
    skipIf = o.skipIf as PopupSkipCondition;
  }

  const out: StartupPopup = { id, url: new URL(o.url).toString() };
  if (skipIf) out.skipIf = skipIf;
  const w = side(o.width);
  const h = side(o.height);
  // A size is only useful as a pair (it sets the aspect ratio).
  if (w !== null && h !== null) {
    out.width = w;
    out.height = h;
  }
  return out;
}

/**
 * The popup still owed to this install, or null once its id was shown or
 * while its `skipIf` condition holds (`holds` answers for this install).
 */
export function popupToShow(
  popup: StartupPopup | null,
  shownIds: readonly string[],
  holds: (cond: PopupSkipCondition) => boolean = () => false,
): StartupPopup | null {
  if (!popup) return null;
  if (shownIds.includes(popup.id)) return null;
  if (popup.skipIf && holds(popup.skipIf)) return null;
  return popup;
}

/**
 * Tracks whether the popup frame's latest load actually committed a 2xx page.
 *
 * The iframe's `load` event fires for error pages too (offline, a 404 page,
 * a blocked response), and a cross-origin frame cannot be inspected from the
 * renderer, so main watches the frame's navigations and the renderer asks
 * before it reveals anything. That is what keeps a dead page from ever
 * showing as a blank overlay.
 */
export class PopupFrameTracker {
  private state: 'none' | 'pending' | 'ok' | 'failed' = 'none';

  constructor(private readonly isAllowed: (url: string) => boolean) {}

  /** A subframe started navigating. */
  onStart(url: string): void {
    if (this.isAllowed(url)) this.state = 'pending';
  }

  /** A subframe committed a page (did-frame-navigate). */
  onCommit(url: string, httpResponseCode: number): void {
    if (!this.isAllowed(url)) return;
    this.state = httpResponseCode >= 200 && httpResponseCode < 300 ? 'ok' : 'failed';
  }

  /** A subframe navigation failed (did-fail-provisional-load). */
  onFail(url: string): void {
    if (this.isAllowed(url)) this.state = 'failed';
  }

  /** True only when the latest popup-frame load committed a 2xx page. */
  loadedOk(): boolean {
    return this.state === 'ok';
  }
}
