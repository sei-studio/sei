/**
 * SeiLink desktop host (261104, milestone 3): the companion's room as a live
 * wallpaper behind the desktop icons. Shared by main (the service and the
 * host process, src/main/seilink/host/), the main window (status, start/stop)
 * and the host's own page (renderer components/seilink/host/).
 *
 * See docs/agents/seilink-host.md.
 */
import type { AvatarEmotion } from './ipc';
import type { SeilinkRoomPayload } from './seilinkPack';

/**
 * - off: nothing on the desktop.
 * - starting: the host process is coming up (first spawn after start()).
 * - running: attached behind the icons and drawing.
 * - restarting: the host died, hung or lost the desktop; the supervisor is bringing it back.
 * - failed: gave up (see `failure`); start() again to retry.
 * - unsupported: no desktop layer on this OS/install (Linux, or the addon is missing).
 */
export type SeilinkHostState = 'off' | 'starting' | 'running' | 'restarting' | 'failed' | 'unsupported';

/** Why the host could not get (or stay) on the desktop. Shape only, safe for analytics. */
export type SeilinkHostFailure =
  | 'unsupported_platform'
  | 'addon_missing'
  | 'addon_load_failed'
  | 'spawn_failed'
  | 'no_shell'
  | 'no_window'
  | 'no_workerw'
  | 'set_parent_failed'
  | 'level_not_applied'
  | 'attach_failed'
  | 'renderer_failed'
  | 'host_hung'
  | 'crash_loop';

export const SEILINK_HOST_FAILURES: readonly SeilinkHostFailure[] = [
  'unsupported_platform',
  'addon_missing',
  'addon_load_failed',
  'spawn_failed',
  'no_shell',
  'no_window',
  'no_workerw',
  'set_parent_failed',
  'level_not_applied',
  'attach_failed',
  'renderer_failed',
  'host_hung',
  'crash_loop',
];

export function isSeilinkHostFailure(v: unknown): v is SeilinkHostFailure {
  return typeof v === 'string' && (SEILINK_HOST_FAILURES as readonly string[]).includes(v);
}

/** Why a desktop session ended (seilink_ended.reason). */
export type SeilinkEndReason =
  | 'user_stop'
  | 'replaced'
  | 'app_quit'
  | 'account_switch'
  | 'failed'
  | 'disabled'
  /** M4: the moved-in companion was deleted or removed from the library. */
  | 'character_removed';

/** What the main window sees (push + pull). */
export interface SeilinkHostStatus {
  state: SeilinkHostState;
  /** The companion who moved in (null when off). */
  characterId: string | null;
  /** A maximized/fullscreen window hides her (mac: her box is occluded). */
  covered: boolean;
  /** Screen locked or the machine asleep. */
  paused: boolean;
  /** Frames drawn in the last second (heartbeat). */
  fps: number;
  /** Set when state is failed or unsupported. */
  failure?: SeilinkHostFailure;
}

/**
 * M4: can SeiLink be turned on here, and is it on? (main gate.ts)
 * - supported: macOS or Windows with the host addon in this build (or the dev fake desktop).
 * - reason: why not, when unsupported.
 * - setting: the Labs setting (`seilink_enabled`, this profile).
 * - enabled: SeiLink is on (the setting on a supported install, or the dev flag).
 */
export interface SeilinkAvailability {
  supported: boolean;
  reason?: 'platform' | 'addon';
  setting: boolean;
  enabled: boolean;
  dev: boolean;
}

export const SEILINK_HOST_OFF: SeilinkHostStatus = { state: 'off', characterId: null, covered: false, paused: false, fps: 0 };

/** Her box in CSS px of the room page (the room window covers the primary display). */
export interface SeilinkBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Frame cap while visible. The room's own effects are cheap; 30 keeps the GPU calm. */
export const SEILINK_HOST_FPS = 30;

/**
 * The host page's bridge (`window.seiRoomHost`, src/preload/seilinkHost.ts).
 * The page never talks to the main app directly: everything goes through
 * the host process, which relays to main over its pipe.
 */
/** Her room as the host page gets it: the saved room plus what RoomAvatar needs. */
export interface SeilinkHostRoom extends SeilinkRoomPayload {
  /**
   * Her portrait as a URL the host page can load: `sei-room://_portrait/<file>?v=<mtime>`
   * for a portrait stored on disk, else her portrait_image as is (https, or a bundled
   * `./img/...` path, which resolves against the host page like the app's). null: none.
   */
  portrait: string | null;
  name: string;
  /** M4: the app's UI language (UserConfig.ui_language) for the dock's few words; null = follow the system. */
  uiLanguage?: string | null;
}

/** The pack-id slot of sei-room:// URLs that serves her portrait in the host (pack ids never start with '_'). */
export const SEILINK_PORTRAIT_HOST = '_portrait';

/**
 * The avatar bridge calls the host page may make (RoomAvatar's views read them off
 * `window.sei`); the host relays them to main, which answers for the moved-in
 * character only.
 */
export const SEILINK_HOST_AVATAR_METHODS = [
  'avatarGet',
  'avatarModelFiles',
  'facepackForCharacter',
  'facepackManifest',
  'facepackFile',
  // 261105: what RoomAvatar ended up showing (analytics only; answers null).
  'avatarShown',
] as const;
export type SeilinkHostAvatarMethod = (typeof SEILINK_HOST_AVATAR_METHODS)[number];

export function isSeilinkHostAvatarMethod(v: unknown): v is SeilinkHostAvatarMethod {
  return typeof v === 'string' && (SEILINK_HOST_AVATAR_METHODS as readonly string[]).includes(v);
}

export interface SeilinkHostBridge {
  /** Her room (on start, after every save, and when her portrait changes). */
  onRoom(cb: (room: SeilinkHostRoom) => void): () => void;
  /** The player is chatting with her or just clicked her: she holds still in her seat. */
  onBusy(cb: (busy: boolean) => void): () => void;
  /** The frame cap now: 0 while covered, locked or asleep. */
  onFps(cb: (fps: number) => void): () => void;
  /** A click on her (after the double-click wait), a double click, or a drag stroke. */
  onPoke(cb: (kind: SeilinkPokeKind) => void): () => void;
  /** Her box moved (layout, a new room). Drives the click area. */
  setBox(box: SeilinkBox | null): void;
  /** Frames drawn so far; sent about once a second. */
  frames(count: number): void;
  /** The first frame of a scene is on screen. */
  firstFrame(): void;
  /** Ask for the current room + fps (the page mounted). */
  ready(): void;
  // ── M4: the dock and her desktop lines ──
  /** The display's work area in page CSS px (the dock sits above the taskbar / Dock). */
  onLayout(cb: (layout: SeilinkHostLayout) => void): () => void;
  /** Dock state from main (deafened). */
  onDockState(cb: (state: SeilinkDockState) => void): () => void;
  /** A press on a dock button (the host routes presses by position; the page never gets DOM clicks). */
  onDockPress(cb: (id: SeilinkDockAction) => void): () => void;
  /** The dock buttons' boxes (CSS px), or null when the dock is hidden. Part of the click area. */
  setDock(buttons: SeilinkDockButton[] | null): void;
  /** A dock action the user confirmed: the host relays it to main. */
  dockAction(action: SeilinkDockAction): void;
  /** A short line from her (a click reply or a rare idle line), shown as a bubble. */
  onLine(cb: (line: SeilinkHostLine) => void): () => void;
}

export type SeilinkPokeKind = 'click' | 'dblclick' | 'drag';

/**
 * Dock buttons (M4): edit her room (opens the editor in the app), deafen
 * (mute her idle desktop lines; replies to a poke still show), move out
 * (a second press confirms).
 */
export const SEILINK_DOCK_ACTIONS = ['edit', 'deafen', 'moveout'] as const;
export type SeilinkDockAction = (typeof SEILINK_DOCK_ACTIONS)[number];

export function isSeilinkDockAction(v: unknown): v is SeilinkDockAction {
  return typeof v === 'string' && (SEILINK_DOCK_ACTIONS as readonly string[]).includes(v);
}

export interface SeilinkDockButton extends SeilinkBox {
  id: SeilinkDockAction;
}

export interface SeilinkDockState {
  deafened: boolean;
}

export interface SeilinkHostLayout {
  /** The work area (display minus taskbar / menu bar / Dock), page CSS px. */
  workArea: SeilinkBox;
}

/** A line she says on the desktop: `poke` answers a double click, `idle` is unprompted. */
export interface SeilinkHostLine {
  id: number;
  text: string;
  kind: 'idle' | 'poke';
  /** 261105: her face for this line (seilinkExpression.ts): the Live2D emotion and the face set's word. */
  emotion?: AvatarEmotion | null;
  face?: string | null;
}
