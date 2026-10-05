/**
 * "Keep Sei in the menu bar / tray" + the free-play refill notification
 * (261005). Shared between main (src/main/tray/*) and the renderer (the
 * Settings rows and the one-time prompt on the credit wall).
 *
 * The setting is DEVICE-GLOBAL (<userData>/tray-settings.json), not part of
 * the per-profile config.json: closing the window, the menu bar icon and the
 * OS login item are properties of the install, and an account switch must
 * not silently flip them.
 */

/** What the renderer reads to draw the Settings rows and the wall prompt. */
export interface TraySettingsView {
  /**
   * Whether this platform gets the feature at all. macOS (menu bar) and
   * Windows (system tray) only; Linux tray support depends on the desktop and
   * cannot be verified, so the rows are hidden there.
   */
  supported: boolean;
  /** Closing the window hides Sei to the menu bar / tray instead of quitting. */
  enabled: boolean;
  /** Start Sei (hidden, in the tray) when the user logs in. Only meaningful while enabled. */
  openAtLogin: boolean;
  /**
   * macOS 13+: the login item was registered but the user has to approve it
   * in System Settings > General > Login Items. false everywhere else.
   */
  loginNeedsApproval: boolean;
  /** The one-time "Want a heads-up when free play is back?" prompt was already shown. */
  wallPromptSeen: boolean;
}

/** Where a settings change came from (analytics only). */
export type TraySettingSource = 'settings' | 'wall_prompt';

export interface TraySetArgs {
  enabled?: boolean;
  openAtLogin?: boolean;
  source: TraySettingSource;
}
