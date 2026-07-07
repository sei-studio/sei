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
const AVATAR = 60;
const GAP = 10;
const PAD_X = 14;
const HEIGHT = 88;
const MARGIN = 22; // gap from the screen edges

export function initCallOverlay(config: OverlayConfig): void {
  cfg = config;
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
  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return;
    pushState();
    win.showInactive();
    // showInactive on an all-workspaces panel can itself trigger the demotion;
    // re-assert foreground once more after the window is actually on screen.
    keepAppForeground();
  });
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
  const win = ensureWindow();
  if (!win) return;
  win.setBounds(desiredBounds(state.participants.length));
  // If the page is already loaded, forward now; otherwise ready-to-show does it.
  if (!win.webContents.isLoading()) pushState();
}

/** Tear down the overlay window (call end, toggle off, renderer death, quit). */
export function closeCallOverlay(): void {
  lastState = null;
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.destroy();
  overlayWin = null;
}
