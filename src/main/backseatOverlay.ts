/**
 * Backseat overlay window (260728).
 *
 * An always-on-top, frameless, transparent window that floats over whatever the
 * player is playing. Unlike the call overlay (src/main/callOverlay.ts) this one
 * is INTERACTIVE and MOVABLE: it carries the pause and stop controls, and in
 * text mode a small chat panel, so it must take clicks and be draggable.
 *
 * It is also where the screen-share capture lives. That is not an aesthetic
 * choice: the main window is hidden or fully occluded for the entire life of a
 * backseat session (the player is in a game), and a renderer in that state gets
 * its timers clamped and its rAF stopped. This window is always on screen, so
 * its renderer stays hot. Loading the same bundle with `?backseat=1` mounts
 * only <BackseatOverlay/>, which starts capture on mount and tears it down on
 * unmount.
 *
 * Everything it needs to start is passed in the query string, because the
 * window may finish loading before any IPC subscription is in place, and a
 * missed seed would leave the session with no capture and no way to notice.
 */
import { BrowserWindow, screen, app } from 'electron';
import type { BackseatMode } from '../shared/backseatIpc';

interface OverlayConfig {
  preloadPath: string;
  rendererUrlOrPath: string;
}

let cfg: OverlayConfig | null = null;
let win: BrowserWindow | null = null;

/** Roomy enough for the text-mode chat panel; the renderer clips to content. */
const WIDTH = 340;
const HEIGHT_VOICE = 92;
const HEIGHT_TEXT = 300;
const MARGIN = 24;

export function initBackseatOverlay(config: OverlayConfig): void {
  cfg = config;
}

export function isBackseatOverlayOpen(): boolean {
  return !!win && !win.isDestroyed();
}

/**
 * macOS demotes an app to ACCESSORY (no Dock icon, no cmd-tab) when it shows an
 * all-workspaces screen-saver-level window. The call overlay hit this and the
 * fix is the same here: re-assert a regular foreground app.
 */
function keepAppForeground(): void {
  if (process.platform !== 'darwin') return;
  try {
    app.setActivationPolicy('regular');
  } catch {
    /* older Electron */
  }
  void app.dock?.show();
}

export function openBackseatOverlay(args: {
  characterId: string;
  sourceId: string;
  mode: BackseatMode;
}): void {
  if (!cfg) return;
  closeBackseatOverlay();

  const area = screen.getPrimaryDisplay().workArea;
  const height = args.mode === 'text' ? HEIGHT_TEXT : HEIGHT_VOICE;
  const w = new BrowserWindow({
    width: WIDTH,
    height,
    // Bottom-right, out of the way of most HUDs; the player can drag it.
    x: area.x + area.width - WIDTH - MARGIN,
    y: area.y + area.height - height - MARGIN,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    // Unlike the call overlay this window must NOT be a non-activating panel:
    // the text-mode chat has a real input, and a window that can never become
    // key can never receive typed characters.
    title: 'Sei backseat',
    webPreferences: {
      preload: cfg.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // The capture pipeline lives in this renderer, and it must keep running
      // while a fullscreen game is in front of it.
      backgroundThrottling: false,
    },
  });

  w.setAlwaysOnTop(true, 'screen-saver');
  w.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    // Load-bearing: without it macOS flips the process type and hides the main
    // Sei window every time this is called. See callOverlay.ts.
    skipTransformProcessType: true,
  });
  keepAppForeground();

  const query = new URLSearchParams({
    backseat: '1',
    characterId: args.characterId,
    sourceId: args.sourceId,
    mode: args.mode,
  }).toString();
  const t = cfg.rendererUrlOrPath;
  if (t.startsWith('http://') || t.startsWith('https://') || t.startsWith('file://')) {
    void w.loadURL(`${t}${t.includes('?') ? '&' : '?'}${query}`);
  } else {
    void w.loadFile(t, { search: query });
  }

  // ready-to-show is known not to fire for some transparent windows
  // (electron#29036), which would leave capture running in an invisible window.
  let revealed = false;
  const reveal = (): void => {
    if (revealed || w.isDestroyed()) return;
    revealed = true;
    w.showInactive();
    keepAppForeground();
  };
  w.once('ready-to-show', reveal);
  w.webContents.once('did-finish-load', reveal);
  setTimeout(reveal, 1500);
  w.on('closed', () => {
    if (win === w) win = null;
  });
  win = w;
}

/**
 * Push to the overlay renderer. Backseat's state, line and clip-request pushes
 * all go HERE rather than to the main window, because this is the renderer that
 * owns the capture pipeline and draws the mini chat. The main window gets only
 * the ordinary chat messages, on the ordinary chat channel.
 */
export function sendToBackseatOverlay(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

export function closeBackseatOverlay(): void {
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
}
