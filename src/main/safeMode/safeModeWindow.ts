/**
 * The safe-mode window (261031, T277): the small "Sei had trouble starting"
 * screen with Check for updates, Open logs folder, Reset settings and Try
 * normal start.
 *
 * The page is a self-contained data: URL (safeModePage.ts) with an
 * electron-only sandboxed preload (src/preload/safeMode.ts), so showing it
 * depends on nothing the normal app loads: not the renderer bundle, not the
 * auth stack, not the game modules. Every button goes through ONE IPC
 * channel, accepted only from this window's own webContents.
 */
import { app, BrowserWindow, ipcMain, nativeImage, shell, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { renderSafeModeHtml, safeModeDataUrl, safeModeLang } from './safeModePage';
import { openLogsFolder, readPageTheme, resetSettingsEverywhere } from './safeModeActions';
import { requestNormalStartNext } from '../bootContext';
import type { SafeModeReason } from '../bootGuard';
import {
  checkForUpdatesManual,
  downloadAcceptedUpdate,
  flushUpdatePushes,
  installDownloadedUpdate,
} from '../updater';

export const SAFE_MODE_ACTION_CHANNEL = 'safe-mode:action';
export const SAFE_MODE_READY_CHANNEL = 'safe-mode:ready';
/** Deliver held updater pushes anyway if the page never says it is ready. */
const READY_FALLBACK_MS = 10_000;

let win: BrowserWindow | null = null;
let handlersWired = false;

export function safeModeWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null;
}

function fromSafeWindow(e: { sender: Electron.WebContents }): boolean {
  const w = safeModeWindow();
  return !!w && e.sender === w.webContents;
}

/** What each button does. Exported for the unit test. */
export async function runSafeModeAction(name: unknown): Promise<{ ok: boolean }> {
  switch (name) {
    case 'check':
      await checkForUpdatesManual();
      return { ok: true };
    case 'download':
      await downloadAcceptedUpdate();
      return { ok: true };
    case 'install':
      await installDownloadedUpdate();
      return { ok: true };
    case 'open-logs':
      return { ok: await openLogsFolder((p) => shell.openPath(p)) };
    case 'reset-settings':
      return { ok: (await resetSettingsEverywhere()).ok };
    case 'normal-start':
      requestNormalStartNext();
      console.log('[sei] safe mode: normal start requested, relaunching');
      app.relaunch();
      app.exit(0);
      return { ok: true };
    default:
      return { ok: false };
  }
}

function wireHandlers(): void {
  if (handlersWired) return;
  handlersWired = true;
  ipcMain.handle(SAFE_MODE_ACTION_CHANNEL, async (e: IpcMainInvokeEvent, name: unknown) => {
    if (!fromSafeWindow(e)) return { ok: false };
    try {
      return await runSafeModeAction(name);
    } catch (err) {
      console.warn(`[sei] safe mode: action ${String(name)} failed (${(err as Error)?.name ?? 'Error'})`);
      return { ok: false };
    }
  });
  ipcMain.on(SAFE_MODE_READY_CHANNEL, (e) => {
    if (fromSafeWindow(e)) flushUpdatePushes();
  });
}

/**
 * Open the safe-mode window (idempotent: a second call focuses it). Closing
 * it quits the app: there is nothing else running behind it.
 */
export async function openSafeModeWindow(reason: SafeModeReason): Promise<BrowserWindow> {
  const existing = safeModeWindow();
  if (existing) {
    existing.show();
    existing.focus();
    return existing;
  }
  wireHandlers();
  const theme = await readPageTheme().catch(() => 'system' as const);
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.join(app.getAppPath(), 'build', 'icon.png');
  const w = new BrowserWindow({
    width: 560,
    height: 700,
    minWidth: 380,
    minHeight: 480,
    show: false,
    title: 'Sei',
    icon: nativeImage.createFromPath(iconPath),
    backgroundColor: theme === 'light' ? '#F3F8FF' : '#04070F',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(app.getAppPath(), 'dist/preload/safeMode.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win = w;
  w.setMenuBarVisibility(false);
  // No navigation away from the page and no child windows.
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.once('ready-to-show', () => {
    w.show();
    w.focus();
  });
  w.on('closed', () => {
    if (win === w) win = null;
    app.quit();
  });
  // The page never asked for its pushes (a broken preload): deliver anyway.
  setTimeout(() => flushUpdatePushes(), READY_FALLBACK_MS).unref?.();

  const opts = {
    lang: safeModeLang(app.getLocale()),
    cause: reason === 'forced' ? ('forced' as const) : ('repeated' as const),
    theme,
    version: app.getVersion(),
    packaged: app.isPackaged,
  };
  try {
    await w.loadURL(safeModeDataUrl(opts));
  } catch (err) {
    // A data: URL load can only fail if the page itself is broken; fall back
    // to the bare HTML so there is still a window with a close button.
    console.warn(`[sei] safe mode: page load failed (${(err as Error)?.name ?? 'Error'})`);
    void w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(renderSafeModeHtml(opts))}`).catch(() => {});
  }
  return w;
}
