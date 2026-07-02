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

  // Same default + floor on every platform (1180×760) so the card grid lays out
  // identically (5 per row). The window is resizable (Electron default — no
  // `resizable: false` anywhere) and can grow freely; it just can't shrink below
  // the 1180×760 floor. Windows previously shipped smaller (1040×700) to fit
  // 1366×768 laptops, but is now matched to macOS per product direction.
  const dims = { width: 1180, height: 760, minWidth: 1180, minHeight: 760 };

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
    if (!app.isPackaged) {
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
