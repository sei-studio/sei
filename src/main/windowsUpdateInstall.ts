/**
 * The Windows restart-to-update with Sei's own progress window (261030).
 *
 * updater.ts calls this instead of quitAndInstall on win32, for both the
 * sidebar "Update Sei" button and the forced apply:'now' restart:
 *
 *   1. Start the progress window (updateProgressHelper.ts) and wait for its
 *      first frame, at most READY_TIMEOUT_MS (READY_LOADED_CAP_MS once WPF loaded).
 *   2. Ready: record the start time, then quitAndInstall(true, true), the
 *      SILENT installer with a relaunch, so only Sei's window is on screen.
 *      Not ready (or no installer path to watch): hold the renderer's note up
 *      until `minHoldMs` after the click, then quitAndInstall(false, true),
 *      the stock installer banner, exactly as before this window existed.
 *   3. If the app has not begun quitting a few seconds after a ready install
 *      (install() refused, nothing spawned), close the window again so it
 *      never sits over a Sei that is still running.
 *
 * Never throws; every failure ends in the stock install path.
 */
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, nativeTheme } from 'electron';
import { loadConfig } from './configStore';
import { restartInstallArgs, type QuitAndInstallArgs } from './updateInstall';
import { buildHelperConfig, launchUpdateProgressHelper, type HelperHandle } from './updateProgressHelper';
import { loadUpdateState, saveUpdateState } from './updateStateStore';
import { updaterLog as logger } from './updaterLog';

/** After a ready install, the app must begin quitting within this long. */
const QUIT_GUARD_MS = 6_000;

export interface WindowsInstallOptions {
  quitAndInstall: (...args: QuitAndInstallArgs) => void;
  /** autoUpdater.installerPath (the downloaded installer), null if unknown. */
  installerPath: string | null | undefined;
  /** Version being installed ('' if unknown). */
  version: string;
  /** Fallback only: the stock installer starts no sooner than this after the click. */
  minHoldMs: number;
}

function helperResourcesDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'update-progress')
    : path.join(app.getAppPath(), 'resources', 'update-progress');
}

async function recordStart(startedAt: number, progressWindow: boolean): Promise<void> {
  try {
    const state = await loadUpdateState();
    await saveUpdateState({
      ...state,
      installTiming: { startedAt, fromVersion: app.getVersion(), progressWindow },
    });
  } catch (err) {
    logger.warn(`updater: could not record the install start (${(err as Error).message})`);
  }
}

export async function installWithProgressWindow(opts: WindowsInstallOptions): Promise<void> {
  const clickedAt = Date.now();
  let handle: HelperHandle | null = null;

  if (opts.installerPath) {
    try {
      const [cfg, state] = await Promise.all([
        loadConfig().catch(() => null),
        loadUpdateState().catch(() => null),
      ]);
      const config = buildHelperConfig({
        themeMode: cfg?.theme_mode,
        osDark: nativeTheme.shouldUseDarkColors,
        uiLanguage: cfg?.ui_language,
        history: state?.installSeconds,
        version: opts.version,
        installerPath: opts.installerPath,
        // installerPath is set only once the download is complete and
        // verified; the file check guards against a stale path.
        downloaded: existsSync(opts.installerPath),
        appExe: process.execPath,
      });
      handle = await launchUpdateProgressHelper({
        resourcesDir: helperResourcesDir(),
        tmpRoot: os.tmpdir(),
        config,
      });
      logger.info(
        handle.ready
          ? `updater: progress window up after ${Date.now() - clickedAt} ms (estimate ${config.plan.estimateSec} s, ${handle.dir})`
          : `updater: progress window unavailable (${handle.reason}); using the installer's own window`,
      );
    } catch (err) {
      logger.warn(`updater: progress window failed (${(err as Error).message}); using the installer's own window`);
      handle = null;
    }
  } else {
    logger.info("updater: no installer path to watch; using the installer's own window");
  }

  const ready = handle?.ready === true;
  if (!ready) {
    const wait = opts.minHoldMs - (Date.now() - clickedAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  await recordStart(clickedAt, ready);

  let quitting = false;
  const onQuit = (): void => {
    quitting = true;
  };
  app.once('before-quit', onQuit);
  try {
    opts.quitAndInstall(...restartInstallArgs('win32', { progressWindow: ready }));
  } catch (err) {
    logger.warn(`updater: quitAndInstall failed (${(err as Error).message})`);
  }
  if (ready && handle) {
    const h = handle;
    setTimeout(() => {
      app.removeListener('before-quit', onQuit);
      if (!quitting) {
        logger.warn('updater: the app did not quit after the install call; closing the progress window');
        h.kill();
      }
    }, QUIT_GUARD_MS).unref();
  } else {
    setTimeout(() => app.removeListener('before-quit', onQuit), QUIT_GUARD_MS).unref();
  }
}
