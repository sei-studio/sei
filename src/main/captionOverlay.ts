/**
 * Caption overlay window (260806) — the always-on-top captions box the avatar
 * overlay's captions button toggles while a call/backseat share is live.
 *
 * A second frameless, transparent, content-protected BrowserWindow (the same
 * recipe as callOverlay.ts) loading the renderer bundle with `?captions=1`, so
 * main.tsx mounts only <CaptionOverlay/>: white companion lines over a
 * darkened rounded box. It receives the SAME CallOverlayState pushes as the
 * avatar overlay (callOverlay.ts forwards them here).
 *
 * Interaction: the window is click-through ALWAYS outside edit mode — no
 * hover chrome, no interactive flip, the cursor works on whatever is
 * underneath the captions. Edit mode (entered from the avatar overlay's
 * pencil, relayed over avatar:overlay-editing) makes it interactive: corner
 * handles resize (streamed like the avatar overlay's), dragging anywhere
 * moves it, and the +/- buttons bump the FIXED font size (a bigger font does
 * not grow the box; the text just breaks into more chunks). Geometry + font
 * persist in UserConfig.avatar_captions, written by MAIN only.
 */
import { BrowserWindow, screen } from 'electron';
import { IpcChannel, type CallOverlayState } from '../shared/ipc';
import { loadConfig, updateConfig } from './configStore';

interface OverlayConfig {
  preloadPath: string;
  rendererUrlOrPath: string;
}

let cfg: OverlayConfig | null = null;
let win: BrowserWindow | null = null;
let lastState: CallOverlayState | null = null;
let editing = false;

// Geometry + font (hydrated from config.avatar_captions).
const MIN_W = 160;
const MAX_W = 1600;
const MIN_H = 60;
const MAX_H = 800;
const MIN_FONT = 12;
const MAX_FONT = 48;
const FONT_STEP = 2;
const DEFAULT_FONT = 18;
/** Default gap between the box and the bottom of the work area. */
const BOTTOM_MARGIN = 64;

let enabled = false;
let fontSize = DEFAULT_FONT;
let storedBox: { x?: number; y?: number; width: number; height: number } = {
  width: 560,
  height: 120,
};
let hydrated = false;
let hydrating: Promise<void> | null = null;
/** UserConfig.avatar_in_captures — see setCaptionCaptureVisible. */
let captureVisible = false;

export function initCaptionOverlay(config: OverlayConfig): void {
  cfg = config;
}

/** One-time read of persisted caption geometry + enablement. */
export function hydrateCaptionConfig(): Promise<void> {
  if (hydrated) return Promise.resolve();
  hydrating ??= loadConfig()
    .then((config) => {
      captureVisible = config.avatar_in_captures === true;
      const c = config.avatar_captions;
      if (c) {
        enabled = c.enabled;
        if (typeof c.font_size === 'number') fontSize = clampFont(c.font_size);
        storedBox = {
          width: clamp(c.width ?? storedBox.width, MIN_W, MAX_W),
          height: clamp(c.height ?? storedBox.height, MIN_H, MAX_H),
          ...(typeof c.x === 'number' && typeof c.y === 'number' ? { x: c.x, y: c.y } : {}),
        };
      }
    })
    .catch(() => {
      /* defaults */
    })
    .finally(() => {
      hydrated = true;
    });
  return hydrating;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(v)));
}
function clampFont(v: number): number {
  return clamp(v, MIN_FONT, MAX_FONT);
}

function persist(): void {
  const box = storedBox;
  void updateConfig((current) => ({
    ...current,
    avatar_captions: {
      enabled,
      width: box.width,
      height: box.height,
      ...(typeof box.x === 'number' && typeof box.y === 'number'
        ? { x: Math.round(box.x), y: Math.round(box.y) }
        : {}),
      font_size: fontSize,
    },
  })).catch(() => {
    /* geometry is a nicety; a failed write means default placement next run */
  });
}

export function isCaptionOverlayEnabled(): boolean {
  return enabled;
}

/**
 * Mirror of setAvatarCaptureVisible for the captions box (260807). Called from
 * callOverlay so both windows always agree: one setting, both windows. Applied
 * live, since setContentProtection takes effect on the existing window and a
 * player toggling this mid-session should not have to close the captions to
 * see it work.
 */
export function setCaptionCaptureVisible(visible: boolean): void {
  captureVisible = visible;
  if (win && !win.isDestroyed()) win.setContentProtection(!visible);
}

function desiredBounds(): Electron.Rectangle {
  const area = screen.getPrimaryDisplay().workArea;
  const width = clamp(storedBox.width, MIN_W, Math.min(MAX_W, area.width));
  const height = clamp(storedBox.height, MIN_H, Math.min(MAX_H, area.height));
  if (typeof storedBox.x === 'number' && typeof storedBox.y === 'number') {
    return {
      width,
      height,
      x: clamp(storedBox.x, area.x, area.x + area.width - width),
      y: clamp(storedBox.y, area.y, area.y + area.height - height),
    };
  }
  return {
    width,
    height,
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + area.height - height - BOTTOM_MARGIN,
  };
}

function applyMousePolicy(w: BrowserWindow): void {
  // Click-through outside edit mode — the cursor interacts with whatever is
  // under the captions. No {forward} either: there is no hover chrome.
  if (editing) w.setIgnoreMouseEvents(false);
  else w.setIgnoreMouseEvents(true);
}

function pushState(): void {
  if (win && !win.isDestroyed() && lastState) {
    win.webContents.send(IpcChannel.voice.overlayState, lastState);
  }
}

function pushEditState(): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send(IpcChannel.avatar.captionEditState, editing);
  }
}

function ensureWindow(): BrowserWindow | null {
  if (win && !win.isDestroyed()) return win;
  if (!cfg) return null;

  const w = new BrowserWindow({
    ...desiredBounds(),
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    // Same reasoning as the avatar overlay: all resizing is setBounds, so an
    // OS resize frame would only fight the corner handles.
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    alwaysOnTop: true,
    // Same as the avatar overlay: the first click into an inactive app's
    // window must reach the page (the edit-mode handles), not activate Sei.
    acceptFirstMouse: true,
    ...(process.platform === 'darwin' ? { type: 'panel' as const } : {}),
    title: 'Sei captions',
    webPreferences: {
      preload: cfg.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Captions must keep flowing under a fullscreen game.
      backgroundThrottling: false,
    },
  });

  w.setAlwaysOnTop(true, 'screen-saver');
  w.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
  applyMousePolicy(w);
  // Like the avatar tiles: for the player's eyes only, never in captures —
  // unless the player has opted into recording them (setCaptionCaptureVisible).
  w.setContentProtection(!captureVisible);

  const t = cfg.rendererUrlOrPath;
  if (t.startsWith('http://') || t.startsWith('https://') || t.startsWith('file://')) {
    void w.loadURL(`${t}${t.includes('?') ? '&' : '?'}captions=1`);
  } else {
    void w.loadFile(t, { search: 'captions=1' });
  }

  // Reveal on whichever of ready-to-show / did-finish-load lands first, with a
  // backstop — transparent windows are known to skip ready-to-show
  // (electron#29036; same guard as callOverlay.ts).
  let revealed = false;
  const reveal = (): void => {
    if (revealed || w.isDestroyed()) return;
    revealed = true;
    pushState();
    pushEditState();
    w.showInactive();
  };
  w.once('ready-to-show', reveal);
  w.webContents.once('did-finish-load', reveal);
  setTimeout(reveal, 1500);
  w.on('closed', () => {
    if (win === w) win = null;
  });

  win = w;
  return w;
}

/**
 * Reconcile from the forwarded overlay state: the caption window shows iff
 * the avatar overlay is up (enabled + participants), a call/backseat is live,
 * and captions are toggled on. Edit mode substitutes for the live call
 * (260806): entering it forces the window up with its placeholder so the box
 * can be positioned and sized BEFORE any call exists.
 */
export function updateCaptionOverlay(state: CallOverlayState | null): void {
  lastState = state;
  const shouldShow =
    !!state &&
    state.enabled &&
    state.participants.length > 0 &&
    (state.onCall === true || editing) &&
    enabled;
  if (!shouldShow) {
    closeCaptionOverlay();
    return;
  }
  const w = ensureWindow();
  if (!w) return;
  if (!w.webContents.isLoading()) {
    pushState();
    pushEditState();
  }
}

/** The captions button in the avatar overlay: flip + persist + reconcile. */
export async function toggleCaptionOverlay(): Promise<boolean> {
  await hydrateCaptionConfig();
  enabled = !enabled;
  persist();
  updateCaptionOverlay(lastState);
  return enabled;
}

/** The avatar overlay's edit mode, relayed: interactivity + edit chrome, and
 * (260806) a reconcile — edit mode shows the window with its placeholder even
 * off-call, so leaving/entering it opens or closes the box as needed. */
export function setCaptionEditing(on: boolean): void {
  editing = on;
  if (win && !win.isDestroyed()) {
    applyMousePolicy(win);
    pushEditState();
  }
  void hydrateCaptionConfig().then(() => updateCaptionOverlay(lastState));
}

/** Corner-resize stream from the caption renderer, anchored like the avatar
 * overlay's: 'br' keeps the bottom-right corner fixed (dragging TL). */
export function resizeCaptionOverlay(
  width: number,
  height: number,
  anchor: 'tl' | 'tr' | 'bl' | 'br',
  commit: boolean,
): void {
  if (!win || win.isDestroyed()) return;
  const prev = win.getBounds();
  const wpx = clamp(width, MIN_W, MAX_W);
  const hpx = clamp(height, MIN_H, MAX_H);
  const x = anchor === 'tr' || anchor === 'br' ? prev.x + prev.width - wpx : prev.x;
  const y = anchor === 'bl' || anchor === 'br' ? prev.y + prev.height - hpx : prev.y;
  const bounds = { x, y, width: wpx, height: hpx };
  win.setBounds(bounds);
  if (commit) {
    storedBox = { x: bounds.x, y: bounds.y, width: wpx, height: hpx };
    persist();
  }
}

/** Window origin at the start of an edit-mode drag-anywhere move. */
let moveStartPos: { x: number; y: number } | null = null;

/** Edit-mode drag-anywhere move stream: deltas are screen-space from the
 * pointer-down, anchored to the origin snapshotted at 'start' so the drag
 * stays 1:1 while the window moves under the pointer. */
export function moveCaptionOverlay(phase: 'start' | 'move' | 'end', dx: number, dy: number): void {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  if (phase === 'start') {
    moveStartPos = { x: b.x, y: b.y };
    return;
  }
  if (phase === 'move') {
    if (!moveStartPos) moveStartPos = { x: b.x, y: b.y };
    win.setBounds({
      x: Math.round(moveStartPos.x + dx),
      y: Math.round(moveStartPos.y + dy),
      width: b.width,
      height: b.height,
    });
    return;
  }
  moveStartPos = null;
  storedBox = { x: b.x, y: b.y, width: b.width, height: b.height };
  persist();
}

/** Bump the fixed caption font size; returns the new value. */
export function bumpCaptionFont(delta: 1 | -1): number {
  fontSize = clampFont(fontSize + delta * FONT_STEP);
  persist();
  return fontSize;
}

/** Initial pull for the caption window on mount. */
export function getCaptionInfo(): { editing: boolean; fontSize: number } {
  return { editing, fontSize };
}

export function closeCaptionOverlay(): void {
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
  moveStartPos = null;
}
