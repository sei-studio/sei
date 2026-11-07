/**
 * "Open Sei when I log in" for WorldLink (261107, product call 261107).
 *
 * Shared by main (src/main/seilink/openAtLogin.ts, the OS login item) and the
 * renderer (the move-in sheet toggle and the Settings row). Shape only: these
 * types never carry a path or an OS message.
 */

/** Where the user changed the setting. `os` = turned off in the OS (System Settings, Task Manager), seen at launch. */
export const OPEN_AT_LOGIN_SURFACES = ['move_in', 'settings', 'os'] as const;
export type OpenAtLoginSurface = (typeof OPEN_AT_LOGIN_SURFACES)[number];

/** The surfaces the renderer may name (the OS one is main's own). */
export type OpenAtLoginUiSurface = Exclude<OpenAtLoginSurface, 'os'>;

/**
 * Why registering or reading back the login item went wrong (closed set).
 *  - register_threw / unregister_threw: setLoginItemSettings threw.
 *  - read_threw: getLoginItemSettings threw.
 *  - readback_mismatch: no throw, but the OS does not report the state we set.
 *  - requires_approval: macOS 13+ registered it but waits for the user in
 *    System Settings > General > Login Items.
 *  - not_found: macOS 13+ cannot find the app's service (a moved or broken bundle).
 */
export const OPEN_AT_LOGIN_FAILURES = [
  'register_threw',
  'unregister_threw',
  'read_threw',
  'readback_mismatch',
  'requires_approval',
  'not_found',
] as const;
export type OpenAtLoginFailure = (typeof OPEN_AT_LOGIN_FAILURES)[number];

export interface OpenAtLoginState {
  /** A packaged macOS or Windows build where WorldLink can run. Otherwise the UI hides the setting. */
  supported: boolean;
  /** The user's choice, as Sei keeps it (re-synced with the OS at every launch). */
  enabled: boolean;
  /** macOS: on in Sei, but the OS waits for the user to allow it in System Settings. */
  needsApproval: boolean;
}

export const OPEN_AT_LOGIN_OFF: OpenAtLoginState = { supported: false, enabled: false, needsApproval: false };

/** Analytics events (docs/agents/seilink-analytics.md, "Open at login"). */
export const OPEN_AT_LOGIN_CHANGED_EVENT = 'seilink_login_item_changed';
export const OPEN_AT_LOGIN_FAILED_EVENT = 'seilink_login_item_failed';
export const LOGIN_LAUNCH_EVENT = 'seilink_login_launch';
export const LOGIN_LAUNCH_OPENED_EVENT = 'seilink_login_launch_opened';
