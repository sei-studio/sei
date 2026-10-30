/**
 * SPIKE (spike/velopack, 261030): a Velopack-backed stand-in for
 * electron-updater's `autoUpdater` on Windows.
 *
 * updater.ts drives a small `AutoUpdater` surface (checkForUpdates,
 * downloadUpdate, quitAndInstall, events, allowPrerelease, setFeedURL). This
 * adapter implements that same surface on Velopack's UpdateManager, so the
 * whole policy layer (updatePolicy.ts levels, version.json `apply`, the beta
 * toggle, the sidebar button, what's-new) runs unchanged on top of it. Only
 * the transport and the install step differ:
 *
 *   - check/download: UpdateManager.checkForUpdatesAsync / downloadUpdateAsync
 *     (deltas are picked automatically, with a fallback to the full package).
 *   - install: waitExitThenApplyUpdate(silent, restart). Update.exe waits for
 *     this process to exit, swaps `current\` and restarts Sei.
 *   - autoInstallOnAppQuit: the same call with restart=false from will-quit.
 *
 * Channels: stable packages are built with `vpk pack --channel win`, betas with
 * `--channel beta`; the beta toggle maps to ExplicitChannel. The feed is a
 * plain HTTP directory (HttpSource) so it can live on dl.sei.gg; GithubSource
 * would work too but reads api.github.com, which is limited to 60
 * unauthenticated requests per hour per IP.
 */
import { EventEmitter } from 'node:events';
import { app } from 'electron';
import {
  spikeMark,
  velopackLog,
  velopackModule,
  type VelopackUpdateInfo,
  type VelopackUpdateManager,
} from './velopackBoot';

/** Default feed. Overridden by SEI_VELOPACK_FEED (a URL or a local folder) in the spike harness. */
const DEFAULT_FEED = 'https://dl.sei.gg/velopack';

export interface VelopackAutoUpdater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  logger: unknown;
  checkForUpdates: () => Promise<unknown>;
  downloadUpdate: () => Promise<unknown>;
  quitAndInstall: (isSilent?: boolean, isForceRunAfter?: boolean) => void;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
  setFeedURL: (options: { provider: string; url: string; channel?: string }) => void;
}

export function createVelopackAutoUpdater(): VelopackAutoUpdater | null {
  const vp = velopackModule();
  if (!vp) return null;

  const events = new EventEmitter();
  let feed = process.env.SEI_VELOPACK_FEED || DEFAULT_FEED;
  let pending: VelopackUpdateInfo | null = null;
  let downloaded = false;
  let applyLaunched = false;

  const self: VelopackAutoUpdater = {
    autoDownload: false,
    autoInstallOnAppQuit: true,
    allowPrerelease: false,
    logger: null,
    on: (event, listener) => {
      events.on(event, listener);
    },
    setFeedURL: (options) => {
      // The electron-updater mirror fallback points at the generic yml feed;
      // the Velopack feed would sit beside it on the same host.
      if (options.url) feed = options.url.replace(/\/updates\/?$/, '/velopack');
    },
    checkForUpdates: async () => {
      events.emit('checking-for-update');
      if (process.env.SEI_VELOPACK_SPIKE_MODE === 'none') {
        // SPIKE harness: a launch that must not pick up (and stage) an update.
        events.emit('update-not-available');
        return null;
      }
      spikeMark('check-start', { feed });
      try {
        const info = await manager().checkForUpdatesAsync();
        if (!info) {
          spikeMark('check-none');
          events.emit('update-not-available');
          return null;
        }
        pending = info;
        downloaded = false;
        const version = info.TargetFullRelease.Version;
        spikeMark('check-found', {
          target: version,
          fullSize: info.TargetFullRelease.Size,
          deltas: info.DeltasToTarget.map((d) => ({ v: d.Version, size: d.Size, file: d.FileName })),
        });
        events.emit('update-available', { version });
        return { updateInfo: { version } };
      } catch (err) {
        events.emit('error', err);
        throw err;
      }
    },
    downloadUpdate: async () => {
      const info = pending;
      if (!info) throw new Error('no update to download');
      spikeMark('download-start');
      try {
        await manager().downloadUpdateAsync(info, (percent) => {
          events.emit('download-progress', { percent });
        });
      } catch (err) {
        events.emit('error', err);
        throw err;
      }
      downloaded = true;
      spikeMark('download-done');
      events.emit('update-downloaded', { version: info.TargetFullRelease.Version });
      return [];
    },
    quitAndInstall: () => {
      // Arguments are electron-updater's (isSilent, isForceRunAfter). The
      // in-app restart always relaunches; Velopack's own progress window is
      // suppressed (silent) because it is the stock xdialog, not ours.
      launchApply(true);
      app.quit();
    },
  };

  function manager(): VelopackUpdateManager {
    const source = /^https?:\/\//i.test(feed) ? new vp!.HttpSource(feed) : new vp!.FileSource(feed);
    return new vp!.UpdateManager(source, {
      ExplicitChannel: self.allowPrerelease ? 'beta' : undefined,
      MaximumDeltasBeforeFallback: 10,
    });
  }

  function launchApply(restart: boolean): void {
    if (applyLaunched || !pending || !downloaded) return;
    applyLaunched = true;
    spikeMark('apply-launch', { restart });
    velopackLog(`apply ${pending.TargetFullRelease.Version} restart=${restart}`);
    manager().waitExitThenApplyUpdate(pending, true, restart, []);
  }

  // Update on quit: hand the downloaded package to Update.exe, which applies it
  // after this process exits, silently and without reopening Sei. 'quit', not
  // 'will-quit': Sei's before-quit chain ends in app.exit(0), which skips
  // will-quit but still emits quit (electron-updater hooks quit for the same
  // reason). Run 40994110388 never applied on quit with will-quit.
  app.on('quit', () => {
    if (self.autoInstallOnAppQuit) {
      try {
        launchApply(false);
      } catch (err) {
        velopackLog(`apply on quit failed: ${(err as Error).message}`);
      }
    }
    spikeMark('quit');
  });

  return self;
}
