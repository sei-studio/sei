/**
 * Main-process entry shim (261031, T277): boot safety.
 *
 * This file is the built `dist/main/index.js`. It loads only what has to work
 * even when the rest of Sei does not, decides the start mode, starts the
 * updater, and only then loads the app (`./index`, built as `app.js`):
 *
 *   1. remoteDebugGuard / velopackBoot / velopackMigration: same order and
 *      same job as before, ahead of everything (see each file).
 *   2. App name + userData, then the single-instance lock.
 *   3. The boot guard (bootGuard.ts + bootContext.ts) reads
 *      `<userData>/boot-state.json`, counts the previous start if it never
 *      finished, and picks normal or safe mode (2 failed starts in a row =
 *      safe; `--safe-mode` or SEI_SAFE_MODE=1 forces it).
 *   4. Normal mode: the updater is initialised on `ready` BEFORE bootstrap,
 *      so an update can still reach a build whose bootstrap, renderer, native
 *      modules or game services fail. A failure to even load the app graph
 *      counts as a failed start.
 *      Safe mode: the app graph is never loaded. The updater and the small
 *      safe-mode window (safeMode/) are all that run.
 *
 * Anything imported statically here is loaded in safe mode too, so keep this
 * list short and keep heavy modules (games, auth, native addons) behind the
 * app import.
 */
import './remoteDebugGuard';
import './velopackBoot';
import './velopackMigration';
import { app, ipcMain } from 'electron';
import path from 'node:path';
import {
  focusableWindow,
  initBootGuard,
  isMainWindowSender,
  noteNeutralExit,
  noteQuitting,
  noteRendererReady,
  profileScopeReady,
  reportStartupFailure,
  setRelaunch,
  setSafeWindowGetter,
  updaterWindow,
} from './bootContext';
import { safeModeForced, type SafeModeReason } from './bootGuard';
import { noteLaunch } from './firstLaunch';
import { flushUpdatePushes, initUpdater } from './updater';
import { applyPendingAtLaunch } from './velopackUpdater';
import { openSafeModeWindow, safeModeWindow } from './safeMode/safeModeWindow';
import { IpcChannel } from '../shared/ipc';

// Lock the app name early so app.getPath('userData') resolves to "Sei"
// (packaged) or "Sei Dev" (electron-vite dev), keeping dev state out of the
// shipped build. SEI_DEV_USERDATA (dev only) gives a second dev build its own
// userData dir and therefore its own single-instance lock.
const devUserData = process.env.SEI_DEV_USERDATA?.trim() || 'Sei Dev';
app.setName(app.isPackaged ? 'Sei' : devUserData);
if (!app.isPackaged) {
  app.setPath('userData', path.join(app.getPath('appData'), devUserData));
}

function log(line: string): void {
  console.log(`[sei] boot: ${line}`);
}

// Single-instance lock: a second launch focuses the existing window and
// never touches the boot state (it is not a start attempt).
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  await start();
}

async function start(): Promise<void> {
  app.on('second-instance', () => {
    const w = focusableWindow();
    if (w && !w.isDestroyed()) {
      if (w.isMinimized()) w.restore();
      w.focus();
    }
  });

  const boot = initBootGuard({
    userData: app.getPath('userData'),
    appVersion: app.getVersion(),
    // Dev counts nothing unless asked to (SEI_BOOT_GUARD=1): a developer wants
    // the crash, not the safe-mode screen. --safe-mode works everywhere.
    persistent: app.isPackaged || process.env.SEI_BOOT_GUARD === '1',
    forceSafe: safeModeForced(process.argv, process.env),
  });

  setSafeWindowGetter(safeModeWindow);
  // A failed start (bootstrap threw, the renderer died or never loaded)
  // starts Sei again in a fresh process; the boot guard then picks normal or
  // safe mode from the count. Safe mode never shares a process with the app
  // that just failed.
  setRelaunch(() => {
    log('starting again after a failed start');
    app.relaunch();
    app.exit(0);
  });
  // Registered before the app's own before-quit handler (which ends in
  // app.exit), so the start is judged on every ordinary quit.
  app.on('before-quit', () => noteQuitting());

  // The main window's renderer mounted (App.tsx). Success after a short hold.
  ipcMain.on(IpcChannel.app.rendererReady, (e) => {
    if (!isMainWindowSender(e.sender)) return;
    noteRendererReady();
    flushUpdatePushes();
  });

  if (boot.mode === 'safe') {
    startSafeMode(boot.reason ?? 'unclean_exit');
    return;
  }

  // Normal mode. Classify the install first (firstLaunch.ts probes userData
  // for older Sei state, and the early updater's what's-new check writes
  // update-state.json, one of the probed files). bootstrap() calls it again
  // and gets the same answer. Never throws.
  noteLaunch(app.getPath('userData'), app.getVersion());
  // The updater goes first on ready; the app's own ready handler (registered
  // by the import below) runs after it.
  void app.whenReady().then(() => {
    try {
      initUpdater({
        getMainWindow: updaterWindow,
        channelReady: profileScopeReady,
        holdPushes: true,
        startupNotices: false,
      });
    } catch (err) {
      log(`updater init failed (${(err as Error)?.name ?? 'Error'})`);
    }
  });
  try {
    await import('./index');
  } catch (err) {
    log(`app failed to load (${(err as Error)?.name ?? 'Error'})`);
    // Nothing else will open a window: count it and start again (packaged),
    // or just exit (dev logs only).
    void app.whenReady().then(() => {
      reportStartupFailure('module_load', err);
      app.exit(1);
    });
  }
}

function startSafeMode(reason: SafeModeReason): void {
  log(`safe mode (${reason})`);
  app.on('window-all-closed', () => app.quit());
  void app.whenReady().then(async () => {
    // Windows Velopack: a staged update that never got applied is applied
    // now instead, exactly as a normal start would.
    const applying = await applyPendingAtLaunch(null).catch(() => false);
    if (applying) {
      noteNeutralExit();
      return;
    }
    try {
      initUpdater({ getMainWindow: updaterWindow, safeMode: true, holdPushes: true });
    } catch (err) {
      log(`updater init failed (${(err as Error)?.name ?? 'Error'})`);
    }
    try {
      await openSafeModeWindow(reason);
    } catch (err) {
      log(`safe-mode window failed (${(err as Error)?.name ?? 'Error'})`);
      app.quit();
    }
  });
}
