/**
 * Platform-branched BrowserWindow chrome.
 * Sources: UI-SPEC §MacosWindow/AppWindow, CONTEXT D-32, RESEARCH Pitfall 9, D-15.
 */
import { BrowserWindow, app, nativeImage } from 'electron';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { IpcChannel } from '../shared/ipc';

export interface CreateMainWindowOptions {
  preloadPath: string;
  indexHtmlUrlOrPath: string;
  /** Awaited between ready-to-show and the first show. The splash handoff
   * lives here: the caller fades the splash out fully so the main window
   * never appears while the logo is still on screen. Errors never block the
   * show. */
  beforeFirstShow?: () => Promise<void>;
}

export function createMainWindow(opts: CreateMainWindowOptions): BrowserWindow {
  const isMac = process.platform === 'darwin';
  const isWin = process.platform === 'win32';

  // macOS keeps native traffic lights (hiddenInset). Windows runs frameless
  // with the renderer's CUSTOM titlebar controls (MacosWindow) — titleBarOverlay
  // was dropped because its native buttons rendered in a light box that clashed
  // with the dark chrome and went missing on some installs. Linux keeps its
  // native frame + WM-provided controls (no custom controls rendered there).
  // During first-run onboarding the renderer hides the mac traffic lights via
  // the window:set-buttons-visible IPC (the Sui scene has no chrome at all).
  const platformChrome: Electron.BrowserWindowConstructorOptions = isMac
    ? { titleBarStyle: 'hiddenInset' }
    : isWin
      ? { frame: false }
      : {}; // Linux: native frame

  // Same default on every platform. The Party redesign shortened the window
  // (1180×720, was ×760) and unlocked the floor (1000×560) — panels flex, so
  // the layout survives small sizes and the window can grow freely.
  const dims = { width: 1180, height: 720, minWidth: 1000, minHeight: 560 };

  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.join(app.getAppPath(), 'build', 'icon.png');

  const win = new BrowserWindow({
    ...dims,
    show: false,
    title: 'Sei',
    icon: nativeImage.createFromPath(iconPath),
    backgroundColor: '#FDFEFF',
    webPreferences: {
      preload: opts.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    ...platformChrome,
  });

  // Electron's default placement biases toward the top of the screen; put the
  // window in the middle of the display work area instead (260729).
  win.center();

  // Custom-titlebar feedback: push every maximize/unmaximize so the renderer's
  // control can swap the maximize⇄restore icon live. Harmless on macOS (the
  // native chrome never shows our custom control, but the events still fire).
  const pushMaximized = (isMaximized: boolean): void => {
    if (!win.isDestroyed()) {
      win.webContents.send(IpcChannel.window.maximizedChanged, isMaximized);
    }
  };
  win.on('maximize', () => pushMaximized(true));
  win.on('unmaximize', () => pushMaximized(false));

  win.once('ready-to-show', () => {
    const reveal = (): void => {
      if (win.isDestroyed()) return;
      win.show();
      // DevTools only auto-opens with the dev-tools flag (SEI_DEV_TOOLS=1, set
      // by `npm run dev -- --tools` / `npm run dev:tools`). A plain `npm run
      // dev` launches clean, no detached console.
      if (!app.isPackaged && process.env.SEI_DEV_TOOLS === '1') {
        win.webContents.openDevTools({ mode: 'detach' });
      }
    };
    if (opts.beforeFirstShow) opts.beforeFirstShow().then(reveal, reveal);
    else reveal();
  });

  if (
    opts.indexHtmlUrlOrPath.startsWith('http://') ||
    opts.indexHtmlUrlOrPath.startsWith('https://') ||
    opts.indexHtmlUrlOrPath.startsWith('file://')
  ) {
    void win.loadURL(opts.indexHtmlUrlOrPath);
  } else {
    void win.loadFile(opts.indexHtmlUrlOrPath);
  }

  return win;
}

/**
 * Startup splash (260728): a tiny frameless window with the white Sei logo,
 * shown the moment the app is ready and closed when the main window first
 * paints. Self-contained data: URL — no renderer bundle, no dev-server
 * dependency — so it appears instantly. The logo PNG (black pixel art on
 * transparent) is read from the renderer's static assets and inverted to
 * white with CSS. Returns null if the asset cannot be found; startup must
 * never fail over a splash.
 */
export function createSplashWindow(): BrowserWindow | null {
  let logoB64: string;
  try {
    const logoPath = app.isPackaged
      ? path.join(__dirname, '../renderer/img/sei-text.png')
      : path.join(app.getAppPath(), 'src/renderer/public/img/sei-text.png');
    logoB64 = readFileSync(logoPath).toString('base64');
  } catch {
    return null;
  }

  const win = new BrowserWindow({
    width: 320,
    height: 170,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  // No card, no backdrop: just the white logo floating on the desktop
  // (the window itself is transparent). brightness(0) forces the glyphs to
  // black regardless of source color before invert(1) lifts them to white,
  // and the faint drop-shadow keeps it readable over a light desktop.
  // The BODY owns a slow opacity transition: it fades in to FULLY OPAQUE on
  // first paint (the double-rAF guarantees the opacity:0 frame is committed
  // first) and holds there — no pulse, which kept it oscillating below 1.
  // Closing is a hard cut (260729): closeSplashWindow does not fade.
  const html =
    '<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;display:flex;' +
    'align-items:center;justify-content:center;background:transparent;overflow:hidden;' +
    'opacity:0;transition:opacity 800ms ease">' +
    `<img alt="Sei" style="height:92px;filter:brightness(0) invert(1) ` +
    `drop-shadow(0 2px 10px rgba(0,0,0,.55));image-rendering:pixelated" ` +
    `src="data:image/png;base64,${logoB64}">` +
    '<script>requestAnimationFrame(()=>requestAnimationFrame(()=>{document.body.style.opacity="1"}))</script>' +
    '</body>';

  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show();
  });
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  return win;
}

/**
 * Fade the splash out over its body transition, then close it. Resolves once
 * the window is closed, so callers can sequence the main window's first show
 * strictly after it. No fade (260729): the logo cuts out the instant the main
 * window is ready — the fade-out just delayed startup by 850ms.
 */
export function closeSplashWindow(win: BrowserWindow): Promise<void> {
  if (!win.isDestroyed()) win.close();
  return Promise.resolve();
}
