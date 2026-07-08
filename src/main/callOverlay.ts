/**
 * Always-on-top call overlay window (260706, task 4).
 *
 * A small frameless, transparent, click-through BrowserWindow pinned to the
 * bottom-right of the primary display that shows the current voice call's
 * companion avatars (lit while speaking, dimmed while idle) on top of every
 * other app, Discord-style. Off by default; the main-window renderer pushes the
 * desired state (`voice:overlay-set`) whenever call membership, the speaking
 * companion, or the settings toggle changes, and this module reconciles the
 * window: it spawns/positions/tears it down and forwards the state to it.
 *
 * The overlay loads the SAME renderer bundle with an `?overlay=1` marker, so
 * main.tsx mounts only the lightweight <CallOverlay/> (never the full App), and
 * it reuses the app's portrait resolution (relative assets + the sei-portrait://
 * protocol both resolve there because it shares the renderer origin).
 */
import { BrowserWindow, screen, app } from 'electron';
import { IpcChannel, type CallOverlayState } from '../shared/ipc';

interface OverlayConfig {
  preloadPath: string;
  /** The main window's renderer URL (dev) or index.html path (packaged). */
  rendererUrlOrPath: string;
}

let cfg: OverlayConfig | null = null;
let overlayWin: BrowserWindow | null = null;
let lastState: CallOverlayState | null = null;

// Layout (kept in sync with CallOverlay.module.css). A circle per companion.
const AVATAR = 76;
const GAP = 10;
const PAD_X = 14;
const HEIGHT = 108;
const MARGIN = 22; // gap from the screen edges

/** Participant count the window is currently sized/positioned for. Position is
 * only recomputed when this changes (or the window is (re)created), never on the
 * per-speaking-change state pushes — see updateCallOverlay. */
let lastCount = 0;
/** Debounce handle for display-metrics-driven repositioning. */
let repositionTimer: ReturnType<typeof setTimeout> | null = null;

export function initCallOverlay(config: OverlayConfig): void {
  cfg = config;
  // Reposition to the settled bottom-right when the display layout changes.
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
        overlayWin.setBounds(desiredBounds(lastState.participants.length));
      }
    }, 600);
  });
}

/** Bottom-right bounds sized to `count` avatars on the primary display. */
function desiredBounds(count: number): Electron.Rectangle {
  const area = screen.getPrimaryDisplay().workArea;
  const width = PAD_X * 2 + count * AVATAR + Math.max(0, count - 1) * GAP;
  const height = HEIGHT;
  return {
    width,
    height,
    x: area.x + area.width - width - MARGIN,
    y: area.y + area.height - height - MARGIN,
  };
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

function ensureWindow(): BrowserWindow | null {
  if (overlayWin && !overlayWin.isDestroyed()) return overlayWin;
  if (!cfg) return null;

  const win = new BrowserWindow({
    width: 220,
    height: HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
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
    title: 'Sei call overlay',
    webPreferences: {
      preload: cfg.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Float above fullscreen apps (a game/stream), across every workspace, and
  // never intercept clicks — it is display-only, so pointer events pass through
  // to whatever is underneath.
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
  win.setIgnoreMouseEvents(true);
  keepAppForeground();

  const t = cfg.rendererUrlOrPath;
  if (t.startsWith('http://') || t.startsWith('https://') || t.startsWith('file://')) {
    void win.loadURL(`${t}${t.includes('?') ? '&' : '?'}overlay=1`);
  } else {
    void win.loadFile(t, { search: 'overlay=1' });
  }

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
 * Reconcile the overlay from the renderer's pushed state. Shows iff the toggle
 * is on AND a call has at least one participant; otherwise tears the window
 * down. Repositions to fit the current participant count on every update.
 */
export function updateCallOverlay(state: CallOverlayState): void {
  lastState = state;
  const shouldShow = state.enabled && state.participants.length > 0;
  if (!shouldShow) {
    closeCallOverlay();
    return;
  }
  const existed = !!overlayWin && !overlayWin.isDestroyed();
  const win = ensureWindow();
  if (!win) return;
  const count = state.participants.length;
  // Only (re)position when the window is new or the avatar count changed. This
  // push fires on every speaking-state change; running setBounds each time made
  // the overlay jump during a Minecraft fullscreen transition (a speaking update
  // landing while macOS reported a transient work area moved the window, then the
  // next update moved it back). Otherwise it stays fixed bottom-right; genuine
  // display changes are handled by the debounced listener in initCallOverlay.
  if (!existed || count !== lastCount) {
    win.setBounds(desiredBounds(count));
    lastCount = count;
  }
  // If the page is already loaded, forward now; otherwise ready-to-show does it.
  if (!win.webContents.isLoading()) pushState();
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

/** Tear down the overlay window (call end, toggle off, renderer death, quit). */
export function closeCallOverlay(): void {
  lastState = null;
  lastCount = 0;
  if (repositionTimer) {
    clearTimeout(repositionTimer);
    repositionTimer = null;
  }
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.destroy();
  overlayWin = null;
}
