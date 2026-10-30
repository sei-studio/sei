/**
 * Startup popup actions (261029): the fixed set of in-app actions an operator
 * popup page may trigger.
 *
 * The popup page runs in a sandboxed frame with no scripts, so it cannot call
 * the app. Instead a button is a plain link to
 *
 *   https://sei.gg/popup/_action/<name>
 *
 * Main (popupFrameGuards.ts) intercepts that navigation when it comes from
 * the committed popup frame, cancels it (nothing is fetched) and pushes the
 * name to the renderer over `app:startup-popup-action`. The renderer closes
 * the popup and runs the named action (lib/popupActions.ts). A name that is
 * not listed here is dropped on both sides: nothing runs and no browser tab
 * opens.
 *
 * Adding an action is deliberate: add the name here, a case in the renderer's
 * runPopupAction, and a test. Never add one that takes a parameter from the
 * URL (ids, URLs, amounts): the page is operator-authored, but the action
 * set is what bounds what a bad feed edit can do.
 *
 * Clients older than the one that ships an action do not know the path and
 * open it in the default browser, so sei.gg serves a short fallback page at
 * each action URL telling people where the feature lives in the app.
 */

/** Action links live under this path on the popup origin. */
export const POPUP_ACTION_PATH_PREFIX = '/popup/_action/';

/**
 * Every action a popup page may trigger.
 *   chatgpt-plan  open Settings at the ChatGPT plan row and start "Continue
 *                 with ChatGPT" (or run the switch when already signed in).
 */
export const POPUP_ACTIONS = ['chatgpt-plan'] as const;

export type PopupAction = (typeof POPUP_ACTIONS)[number];

/** Whether `name` is one of the allow-listed actions. */
export function isPopupAction(name: unknown): name is PopupAction {
  return typeof name === 'string' && (POPUP_ACTIONS as readonly string[]).includes(name);
}
