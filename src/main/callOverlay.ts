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
 * 260804 interaction model: the window is click-through by DEFAULT
 * (`setIgnoreMouseEvents(true, {forward: true})` — `forward` keeps mousemove
 * flowing to the page so hover chrome works; Windows/macOS only, Linux stays
 * display-only). When the pointer is over overlay chrome (the drag button, a
 * corner resize handle) the overlay renderer asks for real clicks
 * (`setOverlayInteractive`), and back. Dragging is native: the drag button is
 * `-webkit-app-region: drag` and the window is `movable`. Geometry persists in
 * UserConfig.avatar_overlay (written HERE, main-owned — deliberately not
 * renderer-settable).
 */
import { BrowserWindow, screen, app } from 'electron';
import { IpcChannel, type CallOverlayState } from '../shared/ipc';
import { loadConfig, updateConfig } from './configStore';

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
// and do NOT scale with the tile.
const DEFAULT_TILE = 76;
const GAP = 10;
const PAD_X = 14;
const PAD_Y = 16; // per edge; window height = tileSize + 2 * PAD_Y
const MARGIN = 22; // default gap from the screen edges (no stored position)
const MIN_TILE = 48;
const MAX_TILE = 1024;

/** Tile size the window is currently laid out for (hydrated from config). */
let tileSize = DEFAULT_TILE;
/** Stored window origin (user has dragged/resized), null = default corner. */
let storedPos: { x: number; y: number } | null = null;
/** True once hydrateGeometry has read config (so we only read it once). */
let geometryHydrated = false;

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

export function initCallOverlay(config: OverlayConfig): void {
  cfg = config;
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
    const g = config.avatar_overlay;
    if (g) {
      tileSize = Math.min(MAX_TILE, Math.max(MIN_TILE, g.size));
      if (typeof g.x === 'number' && typeof g.y === 'number') storedPos = { x: g.x, y: g.y };
    }
  } catch {
    /* defaults */
  }
}

/** Persist the current geometry (fire-and-forget, main-owned config field). */
function persistGeometry(): void {
  const pos = storedPos;
  const size = Math.round(tileSize);
  void updateConfig((current) => ({
    ...current,
    avatar_overlay: { size, ...(pos ? { x: Math.round(pos.x), y: Math.round(pos.y) } : {}) },
  })).catch(() => {
    /* geometry is a nicety; a failed write means default placement next run */
  });
}

function windowSize(count: number): { width: number; height: number } {
  return {
    width: PAD_X * 2 + count * tileSize + Math.max(0, count - 1) * GAP,
    height: tileSize + PAD_Y * 2,
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

function pushState(): void {
  if (overlayWin && !overlayWin.isDestroyed() && lastState) {
    overlayWin.webContents.send(IpcChannel.voice.overlayState, lastState);
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
    height: tileSize + PAD_Y * 2,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    // resizable so setBounds size changes are honored everywhere; the user
    // resizes ONLY through the overlay's own corner handles (single scalar →
    // aspect always locked). While chrome is hovered the OS's invisible
    // frameless resize edges would go live and allow a free-aspect resize, so
    // 'will-resize' below vetoes every USER resize (it never fires for
    // programmatic bounds changes).
    resizable: true,
    // movable for the -webkit-app-region: drag button (hold to drag).
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    alwaysOnTop: true,
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
  // The avatar never appears in screen captures — including Sei's own
  // backseat share ("self is hidden from screenshare") and the player's
  // OBS/Discord capture of a game. The overlay is for the PLAYER's eyes.
  win.setContentProtection(true);
  keepAppForeground();

  const t = cfg.rendererUrlOrPath;
  if (t.startsWith('http://') || t.startsWith('https://') || t.startsWith('file://')) {
    void win.loadURL(`${t}${t.includes('?') ? '&' : '?'}overlay=1`);
  } else {
    void win.loadFile(t, { search: 'overlay=1' });
  }

  // Aspect lock: the tile is square and the window derives from one scalar,
  // so an OS edge-resize (possible while the hover chrome holds real clicks)
  // must never distort it. This never fires for setBounds.
  win.on('will-resize', (e) => {
    e.preventDefault();
  });

  // Persist the position after a native drag (the app-region drag button).
  // 'moved' also fires for programmatic setBounds, so applyingBounds guards
  // reposition/resize paths from being mistaken for a user drag.
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
  void hydrateGeometry().then(() => {
    if (!lastState || !(lastState.enabled && lastState.participants.length > 0)) return;
    const existed = !!overlayWin && !overlayWin.isDestroyed();
    const win = ensureWindow();
    if (!win) return;
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
  return lastState;
}

/** Relay a mouth-level sample (main window → overlay window). Per-frame
 * animation data: no queueing, no persistence, dropped when no window. */
export function forwardOverlayLevel(id: string, level: number): void {
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.webContents.send(IpcChannel.avatar.overlayLevelState, { id, level });
  }
}

/** Pointer entered/left overlay chrome: give the window real clicks (drag
 * button, corner handles) or restore the default click-through policy. */
export function setOverlayInteractive(interactive: boolean): void {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  if (interactive) overlayWin.setIgnoreMouseEvents(false);
  else applyDefaultMousePolicy(overlayWin);
}

/**
 * Corner-resize from the overlay renderer: apply `size` (tile edge, px)
 * keeping the `anchor` corner fixed. `commit` persists the geometry — the
 * stream itself only moves the window.
 */
export async function resizeOverlay(
  size: number,
  anchor: 'tl' | 'tr' | 'bl' | 'br',
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
  const x = anchor === 'tr' || anchor === 'br' ? prev.x + prev.width - width : prev.x;
  const y = anchor === 'bl' || anchor === 'br' ? prev.y + prev.height - height : prev.y;
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
  if (repositionTimer) {
    clearTimeout(repositionTimer);
    repositionTimer = null;
  }
  if (movePersistTimer) {
    clearTimeout(movePersistTimer);
    movePersistTimer = null;
  }
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.destroy();
  overlayWin = null;
}
