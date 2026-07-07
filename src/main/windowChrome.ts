/**
 * Platform-branched BrowserWindow chrome.
 * Sources: UI-SPEC §MacosWindow/AppWindow, CONTEXT D-32, RESEARCH Pitfall 9, D-15.
 */
import { BrowserWindow, app, nativeImage } from 'electron';
import path from 'node:path';
import { IpcChannel } from '../shared/ipc';

export interface CreateMainWindowOptions {
  preloadPath: string;
  indexHtmlUrlOrPath: string;
}

export function createMainWindow(opts: CreateMainWindowOptions): BrowserWindow {
  const isMac = process.platform === 'darwin';
  const isWin = process.platform === 'win32';

  // macOS keeps native traffic lights (hiddenInset). Windows runs frameless
  // with the renderer's CUSTOM titlebar controls (MacosWindow) — titleBarOverlay
  // was dropped because its native buttons rendered in a light box that clashed
  // with the dark chrome and went missing on some installs. Linux keeps its
  // native frame + WM-provided controls (no custom controls rendered there).
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
    win.show();
    // DevTools only auto-opens with the dev-tools flag (SEI_DEV_TOOLS=1, set by
    // `npm run dev -- --tools` / `npm run dev:tools`). A plain `npm run dev`
    // launches clean, no detached console.
    if (!app.isPackaged && process.env.SEI_DEV_TOOLS === '1') {
      win.webContents.openDevTools({ mode: 'detach' });
    }
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
