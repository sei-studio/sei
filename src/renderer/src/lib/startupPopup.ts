/**
 * Startup popup (261027) — pure renderer rules: when the popup may appear and
 * how big its page is. The component is components/StartupPopup.tsx; the
 * feed, allow-list and show-once rules live in main (src/main/startupPopup.ts).
 */

/** Views where a popup may appear. Anything else (onboarding, a game route,
 *  a call, setup flows) waits. */
const CALM_VIEWS: ReadonlySet<string> = new Set([
  'home',
  'character',
  'awaken',
  'settings',
  'credits',
  'coming-soon',
]);

/** What the renderer is doing right now (the boot import offer reads the same). */
export interface PopupUi {
  viewKind: string;
  modalOpen: boolean;
  tourActive: boolean;
  liveSession: boolean;
}

/** A popup only opens on a calm screen: no modal, tour, game, call or share. */
export function popupUiReady(ui: PopupUi): boolean {
  return CALM_VIEWS.has(ui.viewKind) && !ui.modalOpen && !ui.tourActive && !ui.liveSession;
}

/** First calm-screen look after the popup is known, then the poll while busy. */
export const POPUP_FIRST_LOOK_MS = 1500;
export const POPUP_POLL_MS = 3000;
/** Give up on a page that has not loaded by then (it is retried next launch). */
export const POPUP_LOAD_TIMEOUT_MS = 20_000;

/** Default page size when the feed names none, as a fraction of the window. */
const DEFAULT_FRACTION = 0.7;
/** The page never covers more of the window than this. */
const MAX_FRACTION_W = 0.9;
const MAX_FRACTION_H = 0.86;
/**
 * Room kept clear around the page (24 px a side at least) so there is always
 * somewhere to click out. The X sits inside the page's corner since 261029,
 * so it needs no gutter of its own (was 96 for the outside X).
 */
const GUTTER_PX = 48;

/**
 * The page's on-screen size. A declared size keeps its aspect ratio and is
 * only ever scaled DOWN to fit; no size means 70% of the window each way.
 */
export function popupCardSize(
  viewportW: number,
  viewportH: number,
  width?: number,
  height?: number,
): { width: number; height: number } {
  const maxW = Math.max(1, Math.min(viewportW * MAX_FRACTION_W, viewportW - GUTTER_PX));
  const maxH = Math.max(1, Math.min(viewportH * MAX_FRACTION_H, viewportH - GUTTER_PX));
  if (!width || !height || width <= 0 || height <= 0) {
    return {
      width: Math.round(Math.min(viewportW * DEFAULT_FRACTION, maxW)),
      height: Math.round(Math.min(viewportH * DEFAULT_FRACTION, maxH)),
    };
  }
  const scale = Math.min(1, maxW / width, maxH / height);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/**
 * Actions that arrive this soon after the reveal are ignored (261029 review).
 * A sandboxed page runs no scripts, but a meta refresh or a `Refresh` response
 * header can still navigate the frame to an action URL with no click; a
 * person cannot see and click the button this fast. Before the reveal nothing
 * listens at all.
 */
export const POPUP_ACTION_ARM_MS = 500;

/** What armShownPopup wires up; StartupPopup passes the real ones. */
export interface ShownPopupDeps {
  /** Close the popup. */
  close: () => void;
  /** Run a popup action by name (lib/popupActions.ts runPopupAction). */
  runAction: (name: unknown) => void;
  /** Whether another dialog is open on top of the popup (it owns Esc then). */
  covered: () => boolean;
  /** Where keydown is heard (window). */
  keys: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  /** Main's relay of an Esc typed inside the page. */
  onEscape: (cb: () => void) => () => void;
  /** Main's push of an action link clicked in the page. */
  onAction: (cb: (name: unknown) => void) => () => void;
  now?: () => number;
}

/**
 * Wire the popup's keys and actions for as long as it is SHOWN: call at the
 * reveal, call the returned function when it closes. Esc (typed in the app or
 * relayed from the page) closes it unless another dialog covers it; an action
 * closes it and then runs, unless it came within POPUP_ACTION_ARM_MS of the
 * reveal. Once disarmed, nothing reaches `close` or `runAction`.
 */
export function armShownPopup(deps: ShownPopupDeps): () => void {
  const now = deps.now ?? Date.now;
  const shownAt = now();
  let live = true;
  const onKey = (e: Event): void => {
    const k = e as KeyboardEvent;
    if (!live || k.key !== 'Escape' || deps.covered()) return;
    k.stopPropagation();
    deps.close();
  };
  deps.keys.addEventListener('keydown', onKey);
  const unsubEscape = deps.onEscape(() => {
    if (live && !deps.covered()) deps.close();
  });
  const unsubAction = deps.onAction((name) => {
    if (!live || now() - shownAt < POPUP_ACTION_ARM_MS) return;
    deps.close();
    deps.runAction(name);
  });
  return () => {
    live = false;
    deps.keys.removeEventListener('keydown', onKey);
    unsubEscape();
    unsubAction();
  };
}
