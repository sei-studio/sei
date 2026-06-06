/**
 * Platform-branched BrowserWindow chrome.
 * Sources: UI-SPEC §MacosWindow/AppWindow, CONTEXT D-32, RESEARCH Pitfall 9, D-15.
 */
import { BrowserWindow, app, nativeImage } from 'electron';
import path from 'node:path';

export interface CreateMainWindowOptions {
  preloadPath: string;
  indexHtmlUrlOrPath: string;
}

export function createMainWindow(opts: CreateMainWindowOptions): BrowserWindow {
  const platformChrome: Electron.BrowserWindowConstructorOptions =
    process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' }
      : process.platform === 'win32'
        ? {
            frame: false,
            titleBarOverlay: {
              color: '#F6F5F2',
              symbolColor: '#1A1D24',
              height: 38,
            },
          }
        : {}; // Linux: default native frame with standard window controls

  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.join(app.getAppPath(), 'build', 'icon.png');

  const win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 1180,
    minHeight: 760,
    show: false,
    title: 'Sei Launcher',
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
