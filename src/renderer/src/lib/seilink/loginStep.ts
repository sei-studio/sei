/**
 * The "Open on login" step (product call 261107): asked once, right after
 * the guided room setup's Done, when the room is hers. Pure helpers for
 * RoomEditor; main owns the setting (main/seilink/openAtLogin.ts).
 *
 *  - Offered only where main says the login item works (packaged macOS and
 *    Windows with WorldLink: `supported`) and the user has not answered yet
 *    (`decided`: this step, the Settings row, or turned off in the OS).
 *  - Preselected: the main button turns it on. Nothing is registered until
 *    the user presses it; closing the editor on the step leaves it off (and
 *    unanswered: setup is done, so the step does not come back; Settings has it).
 *  - "Not now" is an answer too: main marks it decided without touching the
 *    OS item.
 */
import type { OpenAtLoginState } from '@shared/openAtLogin';
import { sei } from '../ipcClient';

/** What the editor needs from the setting (IPC in the app, a stub in dev shots). */
export interface OpenAtLoginSource {
  get(): Promise<OpenAtLoginState | null>;
  set(enabled: boolean): Promise<OpenAtLoginState>;
}

/** The step's default: on (261107). */
export const LOGIN_STEP_DEFAULT = true;

/** Whether the step comes up after Done. */
export function offersLoginStep(state: OpenAtLoginState | null | undefined): boolean {
  return Boolean(state?.supported && !state.decided);
}

/** After an answer: close the editor, or stay with a line (the OS refused, or macOS waits for approval). */
export function loginStepAfter(wanted: boolean, state: OpenAtLoginState | null): 'close' | 'failed' | 'approval' {
  if (!state || state.enabled !== wanted) return wanted ? 'failed' : 'close';
  return wanted && state.needsApproval ? 'approval' : 'close';
}

/** The app's source (surface `setup`), or null where the preload has no login item API. */
export function ipcOpenAtLoginSource(): OpenAtLoginSource | null {
  const get = sei.seilinkLoginItemGet;
  const set = sei.seilinkLoginItemSet;
  if (!get || !set) return null;
  return { get: () => get(), set: (enabled) => set(enabled, 'setup') };
}
