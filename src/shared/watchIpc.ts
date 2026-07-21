/**
 * Screen share ("watch") activity: shared renderer <-> main contract (260720).
 *
 * The character watches the player's screen (usually a game) and reacts like a
 * duo partner on the couch. The authoritative session lives in main
 * (src/main/watch/): main polls desktopCapturer thumbnails (~1280x720 JPEG,
 * every 3s), runs a change gate over a tiny grayscale downscale, and only
 * change-worthy frames reach the LLM. Frames are never written to disk and
 * never kept beyond the turn they feed.
 *
 * Consent model (Discord-style):
 *   - the renderer lists capturable windows/screens with live thumbnail
 *     previews (watchListSources) and the player picks EXACTLY what is shared;
 *   - a session starts only on an explicit watchStart (never automatically);
 *   - while active, a "Watching: <source>" indicator with a one-click Stop is
 *     always visible in the chat screen;
 *   - the session ends on watchStop, on a Minecraft summon or board-game
 *     start for the same character, and on app quit.
 */

export type WatchSessionStatus = 'preparing' | 'active' | 'ended';

export type WatchEndReason =
  | 'stopped'     // the player clicked Stop / closed the panel
  | 'superseded'  // a Minecraft summon or a board game took over
  | 'source-lost' // the shared window went away
  | 'error';

export interface WatchSessionState {
  sessionId: string;
  characterId: string;
  status: WatchSessionStatus;
  /** Display name of the shared source ("Rocket League", "Screen 1"). */
  sourceName: string;
  /** 'window' or 'screen' (windows are the encouraged pick). */
  sourceKind: 'window' | 'screen';
  startedAt: number;
  /**
   * Frames actually sent to the LLM so far (spend awareness; the renderer can
   * show it as "N looks"). Chat replies and idle lines are not counted here.
   */
  framesSent: number;
  /**
   * True while the capture is returning all-black frames, which on macOS means
   * Screen Recording permission is missing (the OS silently hands back black).
   * The renderer reopens the permission walkthrough instead of failing silently.
   */
  blank: boolean;
  endedReason?: WatchEndReason;
}

/** A capturable source, listed in the picker with a live thumbnail preview. */
export interface WatchSource {
  id: string;
  name: string;
  kind: 'window' | 'screen';
  /** data: URL (JPEG) thumbnail for the picker preview. */
  thumbnailDataUrl: string;
  /** data: URL app icon for window sources, when the OS provides one. */
  appIconDataUrl?: string;
}

/** Push payload for watch:preview — the aside's live snapshot (~every 3s). */
export interface WatchPreviewPush {
  characterId: string;
  /** data: URL (JPEG) snapshot of the shared source. */
  thumbnailDataUrl: string;
  ts: number;
}

/**
 * macOS Screen Recording permission, from
 * systemPreferences.getMediaAccessStatus('screen'). Non-macOS platforms always
 * report 'granted' (no OS gate exists there).
 */
export type WatchPermissionStatus =
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'not-determined'
  | 'unknown';

/** Typed error codes thrown by watchStart (surface as inline copy, not toasts). */
export const WATCH_ERR_MC_ACTIVE = 'WATCH_MC_SESSION_ACTIVE';
export const WATCH_ERR_GAME_ACTIVE = 'WATCH_GAME_ACTIVE';
export const WATCH_ERR_SOURCE_GONE = 'WATCH_SOURCE_GONE';
export const WATCH_ERR_CREDITS = 'WATCH_CREDITS_DEPLETED';

/**
 * window.sei surface (implemented in src/preload/index.ts):
 *
 *   watchListSources(): Promise<WatchSource[]>
 *     Enumerate capturable windows + screens with thumbnail previews. On
 *     macOS this call also registers the app in System Settings > Privacy &
 *     Security > Screen Recording when permission was never asked.
 *   watchStart(characterId: string, sourceId: string): Promise<WatchSessionState>
 *     Start watching the picked source. Rejects with WATCH_ERR_MC_ACTIVE
 *     while summoned, WATCH_ERR_GAME_ACTIVE while a chess/Connect 4 game is
 *     open, WATCH_ERR_SOURCE_GONE when the source vanished between the pick
 *     and the start, and WATCH_ERR_CREDITS when the cloud ledger is empty.
 *   watchStop(characterId: string): Promise<void>
 *     End the session (posts the transcript row + memory line).
 *   watchGetState(characterId: string): Promise<WatchSessionState | null>
 *   watchPermissionStatus(): Promise<WatchPermissionStatus>
 *   watchOpenPermissionSettings(): Promise<void>
 *     Deep-link to the macOS Screen Recording privacy pane.
 *   onWatchState(cb: (state: WatchSessionState) => void): () => void
 *   onWatchPreview(cb: (p: WatchPreviewPush) => void): () => void
 */
