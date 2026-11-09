/**
 * 261110: the line shown when "Open on login" truly could not change (main
 * read the OS item back and it did not take). It says where the user can do
 * it by hand on their OS; the caller adds the app's support path (the
 * feedback form) next to it. Returns the English key; callers pass it to t().
 */
export const OPEN_AT_LOGIN_FAIL_WIN =
  'Could not change this setting. Turn Sei on in Windows Settings > Apps > Startup, or in Task Manager > Startup apps.';
export const OPEN_AT_LOGIN_FAIL_MAC = 'Could not change this setting. Add Sei in System Settings > General > Login Items.';
export const OPEN_AT_LOGIN_FAIL_OTHER = 'Could not change this setting. Try again.';

export function openAtLoginFailNote(platform: string | undefined): string {
  if (platform === 'win32') return OPEN_AT_LOGIN_FAIL_WIN;
  if (platform === 'darwin') return OPEN_AT_LOGIN_FAIL_MAC;
  return OPEN_AT_LOGIN_FAIL_OTHER;
}
