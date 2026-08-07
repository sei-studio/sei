/**
 * Always-on-top avatar overlay window (260706 as the "call overlay"; 260804
 * avatar rework).
 *
 * A frameless, transparent BrowserWindow showing the companions' avatar tiles
 * (static portrait or Live2D) on top of every other app. The main-window
 * renderer pushes the desired state (`voice:overlay-set`) whenever the avatar
 * mode, activity surfaces, call membership or the speaking companion change,
 * and this module reconciles the window: it spawns/positions/tears it down and
 * forwards the state to it.
 *
 * The overlay loads the SAME renderer bundle with an `?overlay=1` marker, so
 * main.tsx mounts only the lightweight <CallOverlay/> (never the full App), and
 * it reuses the app's portrait resolution (relative assets + the sei-portrait://
 * protocol both resolve there because it shares the renderer origin).
 *
 * Interaction model (260804; view/edit split 260805; per-region 260806): the
 * window is click-through by DEFAULT (`setIgnoreMouseEvents(true, {forward:
 * true})` — `forward` keeps mousemove flowing to the page so hover chrome
 * works; Windows/macOS only, Linux stays display-only). The overlay renderer
 * asks for real clicks (`setOverlayInteractive`) only while the pointer is
 * over the CHROME BUTTON COLUMN (so clicks over the character land on
 * whatever is under her, like the caption window) and for the whole of edit
 * mode. Edit mode resizes the WINDOW through `resizeOverlay` (corner handles
 * only) and moves it through the hold-to-drag button's `moveAvatarOverlay`
 * stream (ordinary chrome, NOT an app-region — an app-region swallows
 * pointer events, which would break the per-region interactivity tracking;
 * the button shows in view mode too); wheel + drag over a Live2D tile instead
 * adjust the CHARACTER's camera within the tile (`setOverlayCamera` — zoom to
 * the face, pan, 260806).
 * Geometry + cameras persist in UserConfig.avatar_overlay (written HERE,
 * main-owned — deliberately not renderer-settable). While a call/backseat is
 * live the overlay grows mute + captions buttons; captions open the sibling
 * captionOverlay.ts window, which rides the same state pushes.
 */
import { BrowserWindow, screen, app } from 'electron';
import { IpcChannel, type AvatarCamera, type CallOverlayState } from '../shared/ipc';
import { loadConfig, updateConfig } from './configStore';
import {
  closeCaptionOverlay,
  hydrateCaptionConfig,
  initCaptionOverlay,
  isCaptionOverlayEnabled,
  setCaptionCaptureVisible,
  updateCaptionOverlay,
} from './captionOverlay';

interface OverlayConfig {
  preloadPath: string;
  /** The main window's renderer URL (dev) or index.html path (packaged). */
  rendererUrlOrPath: string;
}

let cfg: OverlayConfig | null = null;
let overlayWin: BrowserWindow | null = null;
let lastState: CallOverlayState | null = null;

// Chrome layout (kept in sync with CallOverlay.module.css). Tiles are square,
// side `tileSize`; the paddings leave room for the hover outline + drag button
// and do NOT scale with the tile. No bottom padding (260806): the avatar's
// bottom edge sits flush on the window's bottom edge, so she stands ON
// whatever the window is placed against instead of floating above it.
const DEFAULT_TILE = 76;
const GAP = 10;
const PAD_X = 14;
const PAD_TOP = 16; // window height = tileSize + PAD_TOP (bottom is flush)
const MARGIN = 22; // default gap from the screen edges (no stored position)
const MIN_TILE = 48;
const MAX_TILE = 1024;

/** Tile size the window is currently laid out for (hydrated from config). */
let tileSize = DEFAULT_TILE;
/** Stored window origin (user has dragged/resized), null = default corner. */
let storedPos: { x: number; y: number } | null = null;
/** Per-character tile cameras (260806): character zoom + pan WITHIN the tile,
 * streamed up from edit-mode wheel/drag, enriched into the forwarded state. */
let cameras: Record<string, AvatarCamera> = {};
/** True once hydrateGeometry has read config (so we only read it once). */
let geometryHydrated = false;
/** UserConfig.avatar_in_captures — see setAvatarCaptureVisible. */
let captureVisible = false;

/** Participant count the window is currently sized/positioned for. Position is
 * only recomputed when this changes (or the window is (re)created), never on the
 * per-speaking-change state pushes — see updateCallOverlay. */
let lastCount = 0;
/** Debounce handle for display-metrics-driven repositioning. */
let repositionTimer: ReturnType<typeof setTimeout> | null = null;
/** Debounce handle for persisting a native drag ('moved' events). */
let movePersistTimer: ReturnType<typeof setTimeout> | null = null;
/** True while resizeOverlay is applying bounds, so the 'moved' listener does
 * not mistake a programmatic move for a user drag. */
let applyingBounds = false;
/** Window origin at the start of a hold-to-drag move stream. */
let moveStartPos: { x: number; y: number } | null = null;
/** Cursor poll for gaze cursor-follow (armed only while a Live2D tile shows). */
let cursorTimer: ReturnType<typeof setInterval> | null = null;
const CURSOR_POLL_MS = 120;

export function initCallOverlay(config: OverlayConfig): void {
  cfg = config;
  initCaptionOverlay(config);
  // Reposition to the settled work area when the display layout changes.
  // A Minecraft fullscreen transition fires several `display-metrics-changed`
  // events with TRANSIENT work areas (menu bar / dock animating in and out);
  // repositioning on each one made the overlay visibly slide to an intermediate
  // spot and back (the "moves to bottom center then returns" report). Debounce
  // so we reposition exactly once, to the final work area.
  screen.on('display-metrics-changed', () => {
    if (repositionTimer) clearTimeout(repositionTimer);
    repositionTimer = setTimeout(() => {
      repositionTimer = null;
      if (overlayWin && !overlayWin.isDestroyed() && lastState) {
        setBoundsProgrammatic(desiredBounds(lastState.participants.length));
      }
    }, 600);
  });
}

/** One-time read of persisted geometry (size + optional dragged position). */
async function hydrateGeometry(): Promise<void> {
  if (geometryHydrated) return;
  geometryHydrated = true;
  try {
    const config = await loadConfig();
    captureVisible = config.avatar_in_captures === true;
    const g = config.avatar_overlay;
    if (g) {
      tileSize = Math.min(MAX_TILE, Math.max(MIN_TILE, g.size));
      if (typeof g.x === 'number' && typeof g.y === 'number') storedPos = { x: g.x, y: g.y };
      if (g.cameras) cameras = { ...g.cameras };
    }
  } catch {
    /* defaults */
  }
}

/** Persist the current geometry (fire-and-forget, main-owned config field). */
function persistGeometry(): void {
  const pos = storedPos;
  const size = Math.round(tileSize);
  const cams = Object.keys(cameras).length > 0 ? { cameras } : {};
  void updateConfig((current) => ({
    ...current,
    avatar_overlay: {
      size,
      ...(pos ? { x: Math.round(pos.x), y: Math.round(pos.y) } : {}),
      ...cams,
    },
  })).catch(() => {
    /* geometry is a nicety; a failed write means default placement next run */
  });
}

function windowSize(count: number): { width: number; height: number } {
  return {
    width: PAD_X * 2 + count * tileSize + Math.max(0, count - 1) * GAP,
    height: tileSize + PAD_TOP,
  };
}

/**
 * Bounds sized to `count` tiles: at the stored (dragged) position clamped into
 * the work area, or pinned bottom-right of the primary display when the user
 * has never moved it. With a stored position the RIGHT edge stays fixed as the
 * count changes, matching the default corner's growth direction.
 */
function desiredBounds(count: number): Electron.Rectangle {
  const area = screen.getPrimaryDisplay().workArea;
  const { width, height } = windowSize(count);
  if (storedPos) {
    const x = Math.min(Math.max(storedPos.x, area.x), area.x + area.width - width);
    const y = Math.min(Math.max(storedPos.y, area.y), area.y + area.height - height);
    return { width, height, x, y };
  }
  return {
    width,
    height,
    x: area.x + area.width - width - MARGIN,
    y: area.y + area.height - height - MARGIN,
  };
}

function setBoundsProgrammatic(bounds: Electron.Rectangle): void {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  applyingBounds = true;
  try {
    overlayWin.setBounds(bounds);
  } finally {
    // 'moved' fires async; release on the next macrotask so it is still
    // flagged while Electron dispatches the events this setBounds caused.
    setTimeout(() => {
      applyingBounds = false;
    }, 0);
  }
}

/**
 * Hard safety net (macOS): even with skipTransformProcessType, spawning/showing
 * an all-workspaces, screen-saver-level window has been observed to demote the
 * app to an ACCESSORY process — which strips its Dock icon and cmd-tab entry and
 * drops the main window behind everything (the "app disappears when a call
 * starts" report: gone from the Dock and cmd-tab). Re-assert a regular
 * foreground app with a Dock icon so a call can never demote Sei. Idempotent and
 * safe to call repeatedly; a no-op off macOS.
 */
function keepAppForeground(): void {
  if (process.platform !== 'darwin') return;
  try {
    app.setActivationPolicy('regular');
  } catch {
    /* older Electron without setActivationPolicy — skipTransformProcessType covers it */
  }
  void app.dock?.show();
}

/** The renderer-pushed state enriched with main-owned extras (per-character
 * tile cameras + the caption toggle) before it reaches either overlay window. */
function enrichedState(): CallOverlayState | null {
  if (!lastState) return null;
  return { ...lastState, cameras, captionsOn: isCaptionOverlayEnabled() };
}

function pushState(): void {
  const state = enrichedState();
  if (overlayWin && !overlayWin.isDestroyed() && state) {
    overlayWin.webContents.send(IpcChannel.voice.overlayState, state);
  }
}

/** Default mouse policy: click-through, but keep forwarding pointer movement
 * to the page so hover chrome can appear (forward: Windows/macOS only; on
 * Linux the overlay is simply display-only). */
function applyDefaultMousePolicy(win: BrowserWindow): void {
  win.setIgnoreMouseEvents(true, { forward: true });
}

function ensureWindow(): BrowserWindow | null {
  if (overlayWin && !overlayWin.isDestroyed()) return overlayWin;
  if (!cfg) return null;

  const win = new BrowserWindow({
    width: 220,
    height: tileSize + PAD_TOP,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    // NOT resizable: a frameless resizable window keeps invisible OS
    // resize-frame regions along its edges — exactly where the corner handles
    // sit — and a click there is window-frame interaction: macOS ACTIVATED the
    // app ("clicking the corner opens up the app") and the frame region fought
    // the handles' CSS resize cursor. All real resizing goes through setBounds
    // (resizeOverlay), which ignores `resizable`; aspect stays locked because
    // every path derives from the single tile scalar.
    resizable: false,
    // Moving goes through the hold-to-drag button's moveAvatarOverlay stream
    // (setBounds ignores `movable`, so this is belt-and-braces only).
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    alwaysOnTop: true,
    // macOS: without this, the FIRST click into the overlay while Sei is not
    // the active app is treated as an activation click — AppKit activates Sei
    // and raises the main window ("clicking the resize handle pops open the
    // app", 260806) and the click never reaches the handle. acceptFirstMouse
    // delivers that click to the page instead; focusable:false + the panel
    // type below keep the window itself from ever taking key status.
    acceptFirstMouse: true,
    // macOS: a non-activating NSPanel floats above other windows without ever
    // becoming the app's key/main window, so spawning it can't reorder or hide
    // the main Sei window (the "app disappears when a call starts" report).
    ...(process.platform === 'darwin' ? { type: 'panel' as const } : {}),
    title: 'Sei avatar overlay',
    webPreferences: {
      preload: cfg.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // A Live2D tile must keep animating while a fullscreen game occludes
      // the window — same reasoning as the main window (windowChrome.ts).
      backgroundThrottling: false,
    },
  });

  // Float above fullscreen apps (a game/stream), across every workspace.
  win.setAlwaysOnTop(true, 'screen-saver');
  // skipTransformProcessType is load-bearing: without it, setVisibleOnAllWorkspaces
  // transforms the app's process type (Foreground ↔ UIElement) on macOS, which
  // "will hide the window and dock for a short time every time it is called"
  // (Electron docs) — that flash HID the MAIN Sei window every time a call
  // launched. Skipping the transform keeps the main window visible; the overlay
  // is already non-activating (focusable:false, skipTaskbar) so the transform
  // bought us nothing.
  win.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
  applyDefaultMousePolicy(win);
  // By default the avatar never appears in screen captures — including Sei's
  // own backseat share ("self is hidden from screenshare") and the player's
  // OBS/Discord capture of a game. The overlay is for the PLAYER's eyes.
  // Opt out via the share picker's toggle; see setAvatarCaptureVisible.
  win.setContentProtection(!captureVisible);
  keepAppForeground();

  const t = cfg.rendererUrlOrPath;
  if (t.startsWith('http://') || t.startsWith('https://') || t.startsWith('file://')) {
    void win.loadURL(`${t}${t.includes('?') ? '&' : '?'}overlay=1`);
  } else {
    void win.loadFile(t, { search: 'overlay=1' });
  }

  // Persist the position after any native move (safety net — the hold-to-drag
  // button streams through moveAvatarOverlay/setBounds now, which persists at
  // 'end' itself). 'moved' also fires for programmatic setBounds, so
  // applyingBounds guards reposition/resize paths from being mistaken for a
  // user drag.
  win.on('moved', () => {
    if (applyingBounds || win.isDestroyed()) return;
    if (movePersistTimer) clearTimeout(movePersistTimer);
    movePersistTimer = setTimeout(() => {
      movePersistTimer = null;
      if (win.isDestroyed()) return;
      const b = win.getBounds();
      storedPos = { x: b.x, y: b.y };
      persistGeometry();
    }, 400);
  });

  // Show without stealing focus once loaded, and seed it with the latest state.
  // `ready-to-show` is known to never fire for some transparent windows
  // (electron#29036 and friends) — when it silently skipped, the overlay window
  // existed but was never shown (the "call popup doesn't show sometimes"
  // report). Reveal on whichever of ready-to-show / did-finish-load lands
  // first, with a wall-clock backstop in case neither ever does.
  let revealed = false;
  const reveal = (): void => {
    if (revealed || win.isDestroyed()) return;
    revealed = true;
    pushState();
    win.showInactive();
    // showInactive on an all-workspaces panel can itself trigger the demotion;
    // re-assert foreground once more after the window is actually on screen.
    keepAppForeground();
  };
  win.once('ready-to-show', reveal);
  win.webContents.once('did-finish-load', reveal);
  setTimeout(reveal, 1500);
  win.on('closed', () => {
    if (overlayWin === win) overlayWin = null;
  });

  overlayWin = win;
  return win;
}

/**
 * Reconcile the overlay from the renderer's pushed state. Shows iff the mode's
 * visibility condition holds (folded into `enabled` renderer-side) AND there is
 * at least one participant; otherwise tears the window down.
 */
export function updateCallOverlay(state: CallOverlayState): void {
  lastState = state;
  const shouldShow = state.enabled && state.participants.length > 0;
  if (!shouldShow) {
    closeCallOverlay();
    return;
  }
  void Promise.all([hydrateGeometry(), hydrateCaptionConfig()]).then(() => {
    if (!lastState || !(lastState.enabled && lastState.participants.length > 0)) return;
    const existed = !!overlayWin && !overlayWin.isDestroyed();
    const win = ensureWindow();
    if (!win) return;
    // The caption window rides the same state (it reconciles itself: shows
    // iff captions toggled on && (onCall || edit mode)).
    updateCaptionOverlay(enrichedState());
    const count = lastState.participants.length;
    // Only (re)position when the window is new or the tile count changed. This
    // push fires on every speaking-state change; running setBounds each time made
    // the overlay jump during a Minecraft fullscreen transition (a speaking update
    // landing while macOS reported a transient work area moved the window, then the
    // next update moved it back). Otherwise it stays put; genuine display changes
    // are handled by the debounced listener in initCallOverlay.
    if (!existed || count !== lastCount) {
      setBoundsProgrammatic(desiredBounds(count));
      lastCount = count;
    }
    // If the page is already loaded, forward now; otherwise ready-to-show does it.
    if (!win.webContents.isLoading()) pushState();
    reconcileCursorPoll();
  });
}

/**
 * Current overlay state, for the overlay renderer to PULL on mount. The seed
 * push (`pushState` at reveal) races the overlay page's React effect that
 * subscribes to `voice:overlay-state` — when the push landed first, the
 * subscriber missed it and the window stayed empty until the next
 * speaking-state change. The overlay pulls this right after subscribing, so a
 * lost seed can no longer leave it blank.
 */
export function getCallOverlayState(): CallOverlayState | null {
  return enrichedState();
}

/**
 * Let the overlay windows be picked up by screen capture (260807), from the
 * share picker's toggle via the config:save handler.
 *
 * Content protection is a per-window OS flag and it is all-or-nothing:
 * `NSWindowSharingNone` / `WDA_EXCLUDEFROMCAPTURE` drop the window out of
 * EVERY capture path, so there is no way to be visible to OBS and hidden from
 * Sei's own backseat share. Turning it off therefore also means a companion
 * sharing an ENTIRE SCREEN can see her own tile (a window share is unaffected
 * — a window capture cannot contain another window), which is why the toggle
 * is off by default and says so.
 *
 * Applied to the LIVE window rather than only at creation: the player is
 * likely to flip this while the overlay is already up.
 */
export function setAvatarCaptureVisible(visible: boolean): void {
  captureVisible = visible;
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.setContentProtection(!visible);
  setCaptionCaptureVisible(visible);
}

/**
 * Camera stream from the overlay renderer (260806): edit-mode wheel/drag over
 * a Live2D tile adjusting how the character is framed within it. The overlay
 * window is the writer, so nothing is pushed back; `commit` persists.
 */
export function setOverlayCamera(id: string, cam: AvatarCamera, commit: boolean): void {
  const isDefault = cam.zoom === 1 && cam.x === 0 && cam.y === 0;
  if (isDefault) delete cameras[id];
  else cameras[id] = cam;
  if (commit) persistGeometry();
}

/** Re-push the enriched state to the overlay window (after a caption toggle,
 * so its captions button reflects the new value). */
export function repushOverlayState(): void {
  pushState();
}

/** Relay a mouth-level sample (main window → overlay window). Per-frame
 * animation data: no queueing, no persistence, dropped when no window. */
export function forwardOverlayLevel(id: string, level: number): void {
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.webContents.send(IpcChannel.avatar.overlayLevelState, { id, level });
  }
}

/** Pointer entered/left the overlay's chrome BUTTON COLUMN (or edit mode
 * started/ended): give the window real clicks or restore the default
 * click-through policy. The renderer only asks for clicks over the button
 * region, so the character herself stays click-through in view mode. */
export function setOverlayInteractive(interactive: boolean): void {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  if (interactive) overlayWin.setIgnoreMouseEvents(false);
  else applyDefaultMousePolicy(overlayWin);
}

/**
 * Hold-to-drag window move stream from the overlay renderer (mirrors
 * moveCaptionOverlay): deltas are screen-space from the pointer-down,
 * anchored to the origin snapshotted at 'start' so the drag stays 1:1 while
 * the window moves under the pointer. 'end' persists the new position.
 */
export function moveAvatarOverlay(phase: 'start' | 'move' | 'end', dx: number, dy: number): void {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  const b = overlayWin.getBounds();
  if (phase === 'start') {
    moveStartPos = { x: b.x, y: b.y };
    return;
  }
  if (phase === 'move') {
    if (!moveStartPos) moveStartPos = { x: b.x, y: b.y };
    setBoundsProgrammatic({
      x: Math.round(moveStartPos.x + dx),
      y: Math.round(moveStartPos.y + dy),
      width: b.width,
      height: b.height,
    });
    return;
  }
  moveStartPos = null;
  storedPos = { x: b.x, y: b.y };
  persistGeometry();
}

/**
 * Gaze cursor-follow feed (260806): while a Live2D tile is showing, poll the
 * global cursor (`screen.getCursorScreenPoint`, cheap) and push it to the
 * overlay window normalized to [-1, 1] around the window's center (x right,
 * y UP — the focusController's frame), scaled by the half-extent of the
 * display the window sits on. The renderer alternates its gaze between this
 * and the idle wander; a feed that stops (window gone) just means wander.
 */
function pushCursorSample(): void {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  try {
    const pt = screen.getCursorScreenPoint();
    const b = overlayWin.getBounds();
    const disp = screen.getDisplayMatching(b).bounds;
    const halfW = Math.max(1, disp.width / 2);
    const halfH = Math.max(1, disp.height / 2);
    const x = Math.max(-1, Math.min(1, (pt.x - (b.x + b.width / 2)) / halfW));
    const y = Math.max(-1, Math.min(1, (b.y + b.height / 2 - pt.y) / halfH));
    overlayWin.webContents.send(IpcChannel.avatar.overlayCursorState, { x, y });
  } catch {
    /* a mid-teardown poll tick must never throw */
  }
}

/** Arm/disarm the cursor poll to match "window up AND a Live2D tile shown". */
function reconcileCursorPoll(): void {
  const wants =
    !!overlayWin &&
    !overlayWin.isDestroyed() &&
    !!lastState?.participants.some((p) => p.live2d === true);
  if (wants && !cursorTimer) cursorTimer = setInterval(pushCursorSample, CURSOR_POLL_MS);
  if (!wants && cursorTimer) {
    clearInterval(cursorTimer);
    cursorTimer = null;
  }
}

/**
 * Resize from the overlay renderer: apply `size` (tile edge, px) keeping the
 * `anchor` corner fixed ('center' = wheel zoom, grows around the window
 * center). `commit` persists the geometry — the stream itself only moves the
 * window.
 */
export async function resizeOverlay(
  size: number,
  anchor: 'tl' | 'tr' | 'bl' | 'br' | 'center',
  commit: boolean,
): Promise<void> {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  const prev = overlayWin.getBounds();
  tileSize = Math.min(MAX_TILE, Math.max(MIN_TILE, Math.round(size)));
  const count = Math.max(1, lastState?.participants.length ?? 1);
  const { width, height } = windowSize(count);
  // Keep the anchored corner where it is: 'br' means the bottom-right corner
  // stays fixed while the top-left moves, i.e. the user is dragging the TL
  // handle. x moves for anchors on the right, y for anchors on the bottom.
  const x =
    anchor === 'center'
      ? prev.x + Math.round((prev.width - width) / 2)
      : anchor === 'tr' || anchor === 'br'
        ? prev.x + prev.width - width
        : prev.x;
  const y =
    anchor === 'center'
      ? prev.y + Math.round((prev.height - height) / 2)
      : anchor === 'bl' || anchor === 'br'
        ? prev.y + prev.height - height
        : prev.y;
  const bounds = { x, y, width, height };
  setBoundsProgrammatic(bounds);
  if (commit) {
    storedPos = { x: bounds.x, y: bounds.y };
    persistGeometry();
  }
}

/** Tear down the overlay window (mode off, no participants, renderer death, quit). */
export function closeCallOverlay(): void {
  lastState = null;
  lastCount = 0;
  closeCaptionOverlay();
  if (repositionTimer) {
    clearTimeout(repositionTimer);
    repositionTimer = null;
  }
  if (movePersistTimer) {
    clearTimeout(movePersistTimer);
    movePersistTimer = null;
  }
  if (cursorTimer) {
    clearInterval(cursorTimer);
    cursorTimer = null;
  }
  moveStartPos = null;
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.destroy();
  overlayWin = null;
}
