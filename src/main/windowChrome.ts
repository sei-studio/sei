/**
 * Platform-branched BrowserWindow chrome.
 * Sources: UI-SPEC §MacosWindow/AppWindow, CONTEXT D-32, RESEARCH Pitfall 9, D-15.
 */
import { BrowserWindow, app, nativeImage, screen } from 'electron';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { IpcChannel } from '../shared/ipc';
import { overlayFrameLooksRight } from './velopackFastApply';
import { SPLASH_SIZE, splashHtml } from './splashPage';

export interface CreateMainWindowOptions {
  preloadPath: string;
  indexHtmlUrlOrPath: string;
  /** Awaited between ready-to-show and the first show. The update splash
   * handoff lives here: the caller closes the splash so the main window never
   * appears while the logo is still on screen. Errors never block the show. */
  beforeFirstShow?: () => Promise<void>;
  /** 261107: a login launch (seilink/loginLaunch.ts): load, but never show on its own. */
  startHidden?: boolean;
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
      // Backseat (260728): while the player is in a fullscreen game, Sei's
      // window is hidden or fully occluded, and Chromium then clamps timers in
      // that renderer to roughly once a second. Backseat's whole job happens in
      // exactly that state — the audio meter, the gate cadence and the rolling
      // clip recorders all live there — so throttling has to be off. The frame
      // pump itself is already immune (it runs in a worker off
      // MediaStreamTrackProcessor), but its companions are not.
      backgroundThrottling: false,
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
      // Something already showed it (a click on her, the Dock) while it loaded.
      if (opts.startHidden) return;
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

/** The white Sei logo PNG as base64, or null when the asset is missing. */
function splashLogoB64(): string | null {
  try {
    // app.getAppPath(), not __dirname (261031): this module can land in a
    // shared chunk under dist/main/chunks/ now that boot.ts and index.ts are
    // separate entries, and __dirname follows the chunk.
    const logoPath = app.isPackaged
      ? path.join(app.getAppPath(), 'dist/renderer/img/sei-text.png')
      : path.join(app.getAppPath(), 'src/renderer/public/img/sei-text.png');
    return readFileSync(logoPath).toString('base64');
  } catch {
    return null;
  }
}

/**
 * The update splash (261030): a tiny frameless window with the white Sei logo
 * and a status line ("Updating…", or the error line), placed in the middle of
 * the primary display's work area, the spot Update.exe's overlay frames are
 * drawn at. Self-contained data: URL (no renderer bundle, no dev-server
 * dependency), so it appears instantly. The logo PNG (black pixel art on
 * transparent) is read from the renderer's static assets and turned white
 * with CSS (splashPage.ts). Returns null if the asset cannot be found; an
 * update must never fail over a splash.
 *
 * product call (261108): only the update screen uses it. A normal launch no
 * longer shows the logo window (it was the startup splash from 260728).
 */
export function createSplashWindow(status: string): BrowserWindow | null {
  const logoB64 = splashLogoB64();
  if (!logoB64) return null;

  const wa = screen.getPrimaryDisplay().workArea;
  const win = new BrowserWindow({
    ...SPLASH_SIZE,
    x: Math.round(wa.x + (wa.width - SPLASH_SIZE.width) / 2),
    y: Math.round(wa.y + (wa.height - SPLASH_SIZE.height) / 2),
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
    focusable: false,
    backgroundColor: '#00000000',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show();
  });
  const html = splashHtml(logoB64, { status });
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  return win;
}

/**
 * Renders the splash with each status line to PNGs at `scaleFactor` physical
 * pixels per DIP, for Update.exe's overlay (velopackUpdater.ts). Uses an
 * offscreen window with the exact page the live splash shows, so the overlay
 * and the splash Sei shows after restarting are the same pixels. Resolves
 * with only the frames that rendered; never throws.
 */
export async function renderSplashFrames(
  statuses: Record<string, string>,
  scaleFactor: number,
  timeoutMs = 8000,
): Promise<Record<string, Buffer>> {
  const out: Record<string, Buffer> = {};
  const logoB64 = splashLogoB64();
  if (!logoB64) return out;
  let win: BrowserWindow | null = null;
  try {
    win = new BrowserWindow({
      ...SPLASH_SIZE,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      webPreferences: {
        offscreen: { deviceScaleFactor: scaleFactor },
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    const wc = win.webContents;
    wc.setFrameRate(60);
    let latest: Electron.NativeImage | null = null;
    let waiter: ((img: Electron.NativeImage) => void) | null = null;
    wc.on('paint', (_e, _dirty, image) => {
      latest = image;
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(image);
      }
    });
    const nextPaint = (ms: number): Promise<Electron.NativeImage | null> =>
      Promise.race([
        new Promise<Electron.NativeImage>((resolve) => {
          waiter = resolve;
          wc.invalidate();
        }),
        new Promise<null>((r) => setTimeout(() => r(null), ms)),
      ]).finally(() => {
        waiter = null;
      });
    const deadline = Date.now() + timeoutMs;
    for (const [name, status] of Object.entries(statuses)) {
      if (Date.now() > deadline) break;
      latest = null;
      const html = splashHtml(logoB64, { status });
      // The page reports when the logo is decoded, its fonts are in and two
      // frames have committed.
      const page = html.replace(
        '</body>',
        '<script>Promise.all([document.fonts.ready,document.querySelector("img").decode().catch(()=>{})])' +
          '.then(()=>requestAnimationFrame(()=>requestAnimationFrame(()=>{document.title="ready"})))</script></body>',
      );
      const ready = new Promise<void>((resolve) => {
        const onTitle = (_e: Electron.Event, title: string): void => {
          if (title === 'ready') {
            wc.off('page-title-updated', onTitle);
            resolve();
          }
        };
        wc.on('page-title-updated', onTitle);
      });
      await wc.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
      await Promise.race([ready, new Promise((r) => setTimeout(r, 1500))]);
      // Keep asking for paints until one looks like the splash. The first
      // paint of a fresh offscreen view can be solid white (CI 261030), and
      // caching that frame put a white box on screen during the update.
      const frameDeadline = Math.min(deadline, Date.now() + 1500);
      let good: Electron.NativeImage | null = null;
      while (!good && Date.now() < frameDeadline) {
        const img = (await nextPaint(500)) ?? latest;
        if (img && !img.isEmpty() && overlayFrameLooksRight(img.toBitmap())) good = img;
        else await new Promise((r) => setTimeout(r, 50));
      }
      if (good) out[name] = good.toPNG();
    }
  } catch {
    /* fewer frames: the overlay shows what exists, or nothing */
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
  }
  return out;
}

/**
 * Close the splash. Resolves once the window is closed, so callers can
 * sequence the main window's first show strictly after it. No fade (260729):
 * the logo cuts out the instant the main window is ready.
 */
export function closeSplashWindow(win: BrowserWindow): Promise<void> {
  if (!win.isDestroyed()) win.close();
  return Promise.resolve();
}
