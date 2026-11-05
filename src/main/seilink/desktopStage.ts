/**
 * The desktop stage (261106, first-link flow): the main window steps out
 * over the desktop to play the first-link intro and to hold the room
 * editor ON the desktop, above the desktop icons, then steps aside again.
 *
 * Why the main window, and not a second editor window or the wallpaper
 * window itself: the editor lives in the main renderer with everything it
 * leans on (her chat and talk box, a live voice call, the stores, the
 * modals). A second window would need its own copy of all of that, and the
 * wallpaper window (hostEntry) sits behind the icons by design (Windows
 * WorkerW, macOS desktop level) and runs a sandboxed page with no app bridge;
 * lifting it above the icons means re-parenting it out of the desktop and
 * back, the riskiest native step SeiLink has. So the main window becomes the
 * stage: borderless, exactly the primary display (where the wallpaper is),
 * drawing the same room with RoomCanvas fit="cover" at the same size, so it
 * lines up with the wallpaper pixel for pixel. While it covers the display
 * the wallpaper host sees itself covered and drops to 0 fps.
 *
 * Per platform:
 *  - macOS: move onto the primary display, then setSimpleFullScreen(true)
 *    (the screen's whole frame, menu bar and Dock auto-hidden, no Space
 *    animation, stays on the desktop's Space so the wallpaper is right under
 *    it) and hide the traffic lights. Exit: setSimpleFullScreen(false)
 *    restores the frame and style. A window already in native fullscreen is
 *    in its own Space, away from the desktop, so the stage refuses
 *    (`native_fullscreen`) and the caller uses the in-app editor.
 *  - Windows (and Linux): unmaximize if needed, then setBounds(display.bounds)
 *    on the frameless window. NOT setFullScreen: leaving fullscreen while the
 *    window is hidden forces it visible again (Electron flips WS_VISIBLE back
 *    on), which would flash the app between the editor and the desktop. A
 *    frameless foreground window the size of the monitor is drawn over the
 *    taskbar by the shell (the borderless-game rule).
 *
 * Stepping aside ("reveal"): the window goes away so the desktop is what
 * shows, her new room in the wallpaper and the icons on top.
 *  - macOS: hide the window first (no frame change is visible), leave simple
 *    fullscreen, restore the old frame, and hide the app when nothing else of
 *    it is on screen, so Finder (the desktop) is the active app. The Dock
 *    icon or the app switcher brings it back ('activate' shows a hidden main
 *    window: index.ts).
 *  - Windows/Linux: hide, restore the old bounds while hidden, then minimize
 *    (a hidden window gets no taskbar button; a minimized one does). A window
 *    that was maximized is maximized again the next time it is restored.
 * Without reveal (the intro was cut short, the editor failed, the app
 * needs the window back): leave the stage and show the window as it was.
 *
 * A window that is hidden (macOS, after a reveal) or minimized (Windows,
 * after a reveal) is brought back at opacity 0, moved and sized, and only
 * then made opaque, so its old frame never flashes on the way to the stage.
 *
 * planEnter / planExit / planReveal are pure (tested); applyOps runs them on
 * a window.
 */
import { BrowserWindow, app, screen, type Rectangle } from 'electron';
import type { SeilinkStageError } from '../../shared/seilinkHost';

export type StagePlatform = 'darwin' | 'win32' | 'linux';

/** Why the stage could not be entered (the caller falls back to the in-app editor). */
export type StageErrorClass = Extract<SeilinkStageError, 'no_window' | 'native_fullscreen' | 'busy' | 'failed'>;

export type StageOp =
  | { op: 'unmaximize' }
  | { op: 'setBounds'; bounds: Rectangle }
  | { op: 'simpleFullScreen'; on: boolean }
  | { op: 'buttons'; visible: boolean }
  | { op: 'resizable'; on: boolean }
  | { op: 'restore' }
  | { op: 'show' }
  | { op: 'focus' }
  | { op: 'hide' }
  | { op: 'minimize' }
  | { op: 'hideApp' }
  | { op: 'remaximizeOnRestore' }
  | { op: 'maximize' }
  | { op: 'opacity'; value: number };

export interface StageSnapshot {
  platform: StagePlatform;
  /** The window's bounds now (its normal bounds when maximized). */
  bounds: Rectangle;
  maximized: boolean;
  minimized: boolean;
  visible: boolean;
  nativeFullScreen: boolean;
  resizable: boolean;
  /** The primary display's full bounds (DIP). */
  display: Rectangle;
}

/** What entering saved, for the way back. */
export interface StageSaved {
  platform: StagePlatform;
  bounds: Rectangle;
  maximized: boolean;
  resizable: boolean;
}

export type EnterPlan = { ok: true; ops: StageOp[]; saved: StageSaved } | { ok: false; error: StageErrorClass };

/** A rect of the same size on the primary display (macOS: simple fullscreen uses the window's current screen). */
function ontoDisplay(b: Rectangle, d: Rectangle): Rectangle {
  const width = Math.min(b.width, d.width);
  const height = Math.min(b.height, d.height);
  return { x: d.x + Math.round((d.width - width) / 2), y: d.y + Math.round((d.height - height) / 2), width, height };
}

export function planEnter(s: StageSnapshot): EnterPlan {
  if (s.nativeFullScreen) return { ok: false, error: 'native_fullscreen' };
  const saved: StageSaved = { platform: s.platform, bounds: { ...s.bounds }, maximized: s.maximized, resizable: s.resizable };
  const ops: StageOp[] = [];
  const away = s.minimized || !s.visible;
  if (away) ops.push({ op: 'opacity', value: 0 }, { op: s.minimized ? 'restore' : 'show' });
  if (s.platform === 'darwin') {
    if (s.maximized) ops.push({ op: 'unmaximize' });
    ops.push({ op: 'setBounds', bounds: ontoDisplay(s.bounds, s.display) });
    ops.push({ op: 'buttons', visible: false });
    ops.push({ op: 'simpleFullScreen', on: true });
  } else {
    if (s.maximized) ops.push({ op: 'unmaximize' });
    ops.push({ op: 'resizable', on: false });
    ops.push({ op: 'setBounds', bounds: { ...s.display } });
  }
  // Back from hidden or minimized: seen only now, already over the desktop.
  if (away) ops.push({ op: 'opacity', value: 1 });
  ops.push({ op: 'focus' });
  return { ok: true, ops, saved };
}

/**
 * Step aside without having been on the stage (a first room moved in from
 * the app with no intro): the window goes, the desktop shows. macOS hides the
 * app (or just this window while another of Sei's windows is up); Windows and
 * Linux minimize, which keeps a maximized window maximized for its restore.
 */
export function planReveal(platform: StagePlatform): StageOp[] {
  return platform === 'darwin' ? [{ op: 'hide' }, { op: 'hideApp' }] : [{ op: 'minimize' }];
}

export function planExit(saved: StageSaved, reveal: boolean): StageOp[] {
  const ops: StageOp[] = [];
  if (saved.platform === 'darwin') {
    if (reveal) ops.push({ op: 'hide' });
    ops.push({ op: 'simpleFullScreen', on: false });
    ops.push({ op: 'buttons', visible: true });
    ops.push({ op: 'setBounds', bounds: { ...saved.bounds } });
    if (reveal) {
      if (saved.maximized) ops.push({ op: 'remaximizeOnRestore' });
      ops.push({ op: 'hideApp' });
    } else {
      if (saved.maximized) ops.push({ op: 'maximize' });
      ops.push({ op: 'show' }, { op: 'focus' });
    }
    return ops;
  }
  if (reveal) ops.push({ op: 'hide' });
  ops.push({ op: 'setBounds', bounds: { ...saved.bounds } });
  ops.push({ op: 'resizable', on: saved.resizable });
  if (reveal) {
    if (saved.maximized) ops.push({ op: 'remaximizeOnRestore' });
    ops.push({ op: 'minimize' });
  } else {
    if (saved.maximized) ops.push({ op: 'maximize' });
    ops.push({ op: 'show' }, { op: 'focus' });
  }
  return ops;
}

// ── Runtime ─────────────────────────────────────────────────────────────────

interface Staged {
  win: BrowserWindow;
  saved: StageSaved;
  since: number;
}

let staged: Staged | null = null;

export function isStaged(win?: BrowserWindow | null): boolean {
  return staged !== null && (!win || staged.win === win);
}

function platform(): StagePlatform {
  return process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'linux';
}

function applyOps(win: BrowserWindow, ops: StageOp[]): void {
  for (const o of ops) {
    if (win.isDestroyed()) return;
    switch (o.op) {
      case 'unmaximize':
        win.unmaximize();
        break;
      case 'setBounds':
        win.setBounds(o.bounds, false);
        break;
      case 'simpleFullScreen':
        win.setSimpleFullScreen(o.on);
        break;
      case 'buttons':
        if (process.platform === 'darwin') win.setWindowButtonVisibility(o.visible);
        break;
      case 'resizable':
        win.setResizable(o.on);
        break;
      case 'restore':
        win.restore();
        break;
      case 'show':
        win.show();
        break;
      case 'focus':
        if (process.platform === 'darwin') app.focus({ steal: true });
        win.focus();
        break;
      case 'hide':
        win.hide();
        break;
      case 'minimize':
        win.minimize();
        break;
      case 'hideApp': {
        // Only when nothing else of Sei is on screen (a call overlay stays, and so does the app).
        const others = BrowserWindow.getAllWindows().some((w) => w !== win && !w.isDestroyed() && w.isVisible());
        if (!others && process.platform === 'darwin') app.hide();
        break;
      }
      case 'remaximizeOnRestore': {
        const again = (): void => {
          win.off('show', again);
          win.off('restore', again);
          if (!win.isDestroyed() && !isStaged(win)) win.maximize();
        };
        win.once('show', again);
        win.once('restore', again);
        break;
      }
      case 'maximize':
        win.maximize();
        break;
      case 'opacity':
        // Linux has no window opacity; it shows the frame change instead.
        if (process.platform !== 'linux') win.setOpacity(o.value);
        break;
    }
  }
}

/** Step the window out over the desktop. */
export function enterDesktopStage(win: BrowserWindow | null): { ok: true } | { ok: false; error: StageErrorClass } {
  if (!win || win.isDestroyed()) return { ok: false, error: 'no_window' };
  if (staged) return staged.win === win ? { ok: true } : { ok: false, error: 'busy' };
  try {
    const plan = planEnter({
      platform: platform(),
      bounds: win.isMaximized() ? win.getNormalBounds() : win.getBounds(),
      maximized: win.isMaximized(),
      minimized: win.isMinimized(),
      visible: win.isVisible(),
      nativeFullScreen: win.isFullScreen(),
      resizable: win.isResizable(),
      display: screen.getPrimaryDisplay().bounds,
    });
    if (!plan.ok) return plan;
    staged = { win, saved: plan.saved, since: Date.now() };
    win.once('closed', () => {
      if (staged?.win === win) staged = null;
    });
    applyOps(win, plan.ops);
    return { ok: true };
  } catch (err) {
    console.warn(`[seilink] desktop stage enter failed: ${(err as Error).message}`);
    if (staged?.win === win) {
      const s = staged;
      staged = null;
      try {
        applyOps(win, planExit(s.saved, false));
      } catch {
        /* best effort */
      }
    }
    // The caller falls back to the app window: make sure there is one to see.
    try {
      if (!win.isDestroyed()) {
        if (process.platform !== 'linux') win.setOpacity(1);
        if (win.isMinimized()) win.restore();
        if (!win.isVisible()) win.show();
      }
    } catch {
      /* nothing more to do */
    }
    return { ok: false, error: 'failed' };
  }
}

/** Step aside (not staged): the desktop shows. False when there is no window or it is on the stage. */
export function revealDesktop(win: BrowserWindow | null): boolean {
  if (!win || win.isDestroyed() || staged) return false;
  if (win.isMinimized() || !win.isVisible()) return true;
  try {
    applyOps(win, planReveal(platform()));
    return true;
  } catch (err) {
    console.warn(`[seilink] desktop reveal failed: ${(err as Error).message}`);
    return false;
  }
}

/** Step aside: `reveal` leaves the desktop showing; otherwise the window comes back as it was. */
export function exitDesktopStage(win: BrowserWindow | null, reveal: boolean): { ok: boolean; stagedMs: number } {
  const s = staged;
  if (!s || !win || s.win !== win) return { ok: false, stagedMs: 0 };
  staged = null;
  const stagedMs = Date.now() - s.since;
  if (win.isDestroyed()) return { ok: false, stagedMs };
  try {
    applyOps(win, planExit(s.saved, reveal));
    return { ok: true, stagedMs };
  } catch (err) {
    console.warn(`[seilink] desktop stage exit failed: ${(err as Error).message}`);
    try {
      if (!win.isDestroyed() && !win.isVisible()) win.show();
    } catch {
      /* nothing more to do */
    }
    return { ok: false, stagedMs };
  }
}
