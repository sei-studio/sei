/**
 * OS permission flows (260929): microphone for calls, Screen Recording for
 * screen share on macOS. Shared between main (permissions/*) and the renderer
 * (lib/permissions/*).
 *
 * The renderer never passes a URL to open. It names a KIND and main picks the
 * System Settings / ms-settings deep link from a fixed allowlist, because
 * app.openExternal is limited to https and these are custom-scheme URLs that
 * must not become a general-purpose opener.
 */

import type { BackseatGameSelection } from './backseatGames';

/** Which OS permission a flow is about. */
export type OsPermissionKind = 'mic' | 'screen';

/**
 * Electron's getMediaAccessStatus values, plus 'unknown' for a platform or
 * Electron build that cannot answer (Linux, a throw).
 */
export type OsPermissionStatus = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown';

/**
 * What to reopen after "Restart Sei and continue". Written just before the
 * relaunch (and when System Settings is opened for Screen Recording, since
 * macOS's own "Quit & Reopen" button restarts Sei too), taken once at boot.
 */
export type PermissionResume =
  // `game`: the share came from a backseat game tile (Roblox), so the reopened
  // picker preselects the game's window and the share keeps its prompt context.
  | { kind: 'share-screen'; characterId: string; game?: BackseatGameSelection }
  | { kind: 'call'; characterId: string };

/** A resume flag older than this is ignored: the player has moved on. */
export const PERMISSION_RESUME_TTL_MS = 10 * 60 * 1000;
