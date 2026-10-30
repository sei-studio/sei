/**
 * Windows updates on Velopack (261030).
 *
 * updater.ts drives a small `AutoUpdater` surface (checkForUpdates,
 * downloadUpdate, quitAndInstall, events, allowPrerelease, setFeedURL). This
 * adapter implements that surface on Velopack's UpdateManager, so the whole
 * policy layer (updatePolicy.ts levels, version.json `apply`, the beta toggle,
 * the sidebar button, what's-new) runs unchanged on top of it. What differs:
 *
 *   - check: UpdateManager.checkForUpdatesAsync on the channel feed (stable =
 *     `win`, beta = `beta`; release.yml packs every stable into the beta feed
 *     too, so beta users get stables the way electron-updater gave them).
 *     An optional rollout.<channel>.json beside the feed holds a new version
 *     back from part of the installs (velopackFastApply.rolloutAllows).
 *   - download: downloadUpdateAsync (deltas with a fallback to the full
 *     package), then `Update.exe stage` extracts it next to the app at
 *     background priority. update-downloaded fires once that is done, so a
 *     restart only swaps folders. A failed, skipped (low disk) or slow stage
 *     still offers the update; the apply then extracts as stock Velopack does.
 *   - restart (quitAndInstall): the update screen. Sei shows its launch splash
 *     with "Updating…", hides its other windows, renders the same splash as
 *     frames for Update.exe's native overlay, starts `Update.exe apply
 *     --noHooks --seiOverlay`, waits until the overlay is on screen and quits.
 *     The overlay covers the gap and closes when the new Sei's splash (also
 *     "Updating…") is up. On failure it says so and opens the old version.
 *   - update on quit: the same apply without restart and without overlay.
 *   - launch with a staged update still pending (Sei was killed before it
 *     could apply): applyPendingAtLaunch() applies it behind the splash.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, net, screen } from 'electron';
import {
  ciMark,
  velopackInstalled,
  velopackLog,
  velopackModule,
  velopackPaths,
  velopackRestartedVersion,
  userDataInstallId,
  type VelopackAsset,
  type VelopackUpdateInfo,
  type VelopackUpdateManager,
} from './velopackBoot';
import {
  applyArgs,
  overlayFrames,
  overlaySpec,
  OVERLAY_SHOWN_TIMEOUT_MS,
  parseRolloutRule,
  parseStageResult,
  rolloutAllows,
  shouldApplyAtLaunch,
  stageArgs,
  stagedMarkerName,
  STAGE_TIMEOUT_MS,
  updateScreenText,
  type LaunchApplyState,
  type UpdateLang,
  type VelopackPaths,
} from './velopackFastApply';
import { closeSplashWindow, createSplashWindow, renderSplashFrames } from './windowChrome';
import { hasPassingVerdict, verifyPackage } from './velopackVerify';

/** The feed: releases.<channel>.json plus packages, served from R2 behind dl.sei.gg. */
const DEFAULT_FEED = 'https://dl.sei.gg/velopack';
/** Fallback when dl.sei.gg fails: the same files attached to the GitHub releases. */
const GITHUB_REPO = 'https://github.com/sei-studio/sei';
/** Stable channel name (vpk's default for Windows); betas are `beta`. */
const STABLE_CHANNEL = 'win';
const BETA_CHANNEL = 'beta';
/** How long a finished download waits for its stage before the restart is offered anyway. */
const STAGE_OFFER_WAIT_MS = 3 * 60 * 1000;
/** Bump when the splash page changes, so cached overlay frames are re-rendered. */
const FRAMES_VERSION = '2';

export interface VelopackAutoUpdater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  /** electron-updater parity (updater.ts sets it). Unused: the Velopack
   *  restart always reopens Sei and the quit apply never does. */
  autoRunAppAfterInstall: boolean;
  allowPrerelease: boolean;
  logger: unknown;
  checkForUpdates: () => Promise<unknown>;
  downloadUpdate: () => Promise<unknown>;
  quitAndInstall: (isSilent?: boolean, isForceRunAfter?: boolean) => void;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
  setFeedURL: (options: { provider: string; url: string; channel?: string }) => void;
}

function log(line: string): void {
  velopackLog(`[sei] ${line}`);
}

async function uiLang(): Promise<UpdateLang> {
  try {
    const { loadConfig } = await import('./configStore');
    const cfg = await loadConfig();
    return cfg.ui_language === 'zh' ? 'zh' : 'en';
  } catch {
    return 'en';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForFile(file: string, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (existsSync(file)) return true;
    await sleep(40);
  }
  return existsSync(file);
}

/** Stable per-install id for the rollout gate: Velopack's own staging id when it has one. */
function installId(p: VelopackPaths): string {
  try {
    const id = readFileSync(path.join(p.packagesDir, '.betaId'), 'utf8').trim();
    if (id) return id;
  } catch {
    /* fall through */
  }
  return userDataInstallId();
}

/* -------------------------------------------------------------------------- */
/*  Update screen                                                             */
/* -------------------------------------------------------------------------- */

/** <userData>/update-splash.json: what the restarted Sei's splash says. */
function splashNoteFile(): string {
  return path.join(app.getPath('userData'), 'update-splash.json');
}

/**
 * The status line for this launch's splash: "Updating…" when Update.exe just
 * restarted us into the new version, the error line when it restarted the old
 * one after a failed update, nothing on a normal launch. One-shot.
 */
export function updateSplashStatusForLaunch(): string | undefined {
  if (process.platform !== 'win32' || velopackRestartedVersion() === null) return undefined;
  const file = splashNoteFile();
  try {
    if (Date.now() - statSync(file).mtimeMs > 10 * 60 * 1000) return undefined;
    const note = JSON.parse(readFileSync(file, 'utf8')) as { target?: string; updating?: string; error?: string };
    return app.getVersion() === note.target ? note.updating : note.error;
  } catch {
    return undefined;
  } finally {
    try {
      unlinkSync(file);
    } catch {
      /* none */
    }
  }
}

/**
 * Renders the overlay frames for `scaleFactor` and `lang` into the overlay
 * folder, unless the same set is already there. Returns the frame names.
 */
let framesInFlight: { key: string; promise: Promise<string[]> } | null = null;

function ensureOverlayFrames(p: VelopackPaths, scaleFactor: number, lang: UpdateLang): Promise<string[]> {
  // Single flight: the prerender after the stage and a restart click must not
  // write the same folder at once.
  const key = `${FRAMES_VERSION}|${scaleFactor}|${lang}`;
  if (framesInFlight?.key === key) return framesInFlight.promise;
  const promise = renderOverlayFramesOnce(p, scaleFactor, lang, key).finally(() => {
    if (framesInFlight?.promise === promise) framesInFlight = null;
  });
  framesInFlight = { key, promise };
  return promise;
}

/**
 * Renders the frames right after the stage, for the display and language the
 * update screen will most likely use, so the restart click does not spend
 * ~1 s on it (CI 261030: 0.9 s of the 1.1 s from click to overlay).
 */
async function prerenderOverlayFrames(p: VelopackPaths): Promise<void> {
  try {
    await ensureOverlayFrames(p, screen.getPrimaryDisplay().scaleFactor, await uiLang());
  } catch (err) {
    log(`overlay prerender failed: ${(err as Error).message}`);
  }
}

async function renderOverlayFramesOnce(p: VelopackPaths, scaleFactor: number, lang: UpdateLang, key: string): Promise<string[]> {
  const frames = overlayFrames(lang);
  const keyFile = path.join(p.overlayDir, 'frames.key');
  const names = Object.keys(frames);
  try {
    if (readFileSync(keyFile, 'utf8') === key && names.every((n) => existsSync(path.join(p.overlayDir, `${n}.png`)))) {
      return names;
    }
  } catch {
    /* render */
  }
  const t0 = Date.now();
  const pngs = await renderSplashFrames(frames, scaleFactor);
  rmSync(p.overlayDir, { recursive: true, force: true });
  mkdirSync(p.overlayDir, { recursive: true });
  for (const [name, png] of Object.entries(pngs)) writeFileSync(path.join(p.overlayDir, `${name}.png`), png);
  const rendered = Object.keys(pngs);
  if (rendered.length === names.length) writeFileSync(keyFile, key);
  log(`rendered ${rendered.length}/${names.length} overlay frames at ${scaleFactor}x in ${Date.now() - t0} ms`);
  ciMark('frames-rendered', { count: rendered.length, scaleFactor, ms: Date.now() - t0 });
  return rendered;
}

/**
 * Puts the update screen up and starts Update.exe with its overlay. Resolves
 * true once the overlay is on screen (or after a short timeout); the caller
 * quits. Resolves false when Update.exe could not be started (antivirus, a
 * missing file): the windows it hid are shown again and Sei keeps running.
 */
async function launchApplyWithScreen(
  p: VelopackPaths,
  packagePath: string,
  targetVersion: string,
  existingSplash: BrowserWindow | null,
): Promise<boolean> {
  const screenState: ScreenState = { hidden: [], splash: null, spawned: false };
  try {
    return await showScreenAndApply(p, packagePath, targetVersion, existingSplash, screenState);
  } catch (err) {
    log(`update screen failed: ${(err as Error).message}`);
    // Update.exe is running: it closes this process and applies. Otherwise
    // nothing will, so the windows come back and Sei stays open.
    if (screenState.spawned) return true;
    await restoreWindows(screenState);
    return false;
  }
}

interface ScreenState {
  hidden: BrowserWindow[];
  splash: BrowserWindow | null;
  spawned: boolean;
}

async function restoreWindows(st: ScreenState): Promise<void> {
  try {
    unlinkSync(splashNoteFile());
  } catch {
    /* none */
  }
  let shown = 0;
  for (const w of st.hidden) {
    if (w.isDestroyed()) continue;
    w.show();
    shown++;
  }
  ciMark('windows-restored', { shown });
  const splash = st.splash;
  if (!splash || splash.isDestroyed()) return;
  if (st.hidden.some((w) => !w.isDestroyed())) {
    await closeSplashWindow(splash);
  } else {
    // A launch-time apply: nothing else is open yet, and closing the last
    // window quits Sei (window-all-closed). Close it once the boot opens one.
    app.once('browser-window-created', () => void closeSplashWindow(splash));
  }
}

async function showScreenAndApply(
  p: VelopackPaths,
  packagePath: string,
  targetVersion: string,
  existingSplash: BrowserWindow | null,
  st: ScreenState,
): Promise<boolean> {
  const lang = await uiLang();
  const text = updateScreenText(lang);
  if (existingSplash && !existingSplash.isDestroyed()) await closeSplashWindow(existingSplash);
  const splash = createSplashWindow({ status: text.updating });
  st.splash = splash;
  for (const w of BrowserWindow.getAllWindows()) {
    if (w !== splash && !w.isDestroyed() && w.isVisible()) {
      w.hide();
      st.hidden.push(w);
    }
  }
  if (splash) {
    await Promise.race([new Promise<void>((r) => splash.once('show', () => r())), sleep(1000)]);
  }
  ciMark('update-screen-shown');

  let overlay: string | undefined;
  try {
    const bounds = splash && !splash.isDestroyed() ? splash.getBounds() : null;
    if (bounds) {
      const sf = screen.getDisplayMatching(bounds).scaleFactor;
      const names = await ensureOverlayFrames(p, sf, lang);
      if (names.includes('updating')) {
        const phys = screen.dipToScreenRect(splash, bounds);
        writeFileSync(path.join(p.overlayDir, 'overlay.txt'), overlaySpec(phys.x, phys.y, names));
        rmSync(path.join(p.overlayDir, 'shown'), { force: true });
        overlay = p.overlayDir;
      }
    }
  } catch (err) {
    log(`overlay setup failed, applying without it: ${(err as Error).message}`);
  }
  try {
    writeFileSync(
      splashNoteFile(),
      JSON.stringify({ target: targetVersion, updating: text.updating, error: text.error }),
    );
  } catch {
    /* the restarted splash just has no status line */
  }

  const args = applyArgs({
    packagePath,
    waitPid: process.pid,
    restart: true,
    root: p.root,
    packagesDir: p.packagesDir,
    overlayDir: overlay,
  });
  log(`apply ${targetVersion} with restart, overlay=${overlay ? 'yes' : 'no'}`);
  ciMark('apply-launch', { restart: true, overlay: Boolean(overlay) });
  st.spawned = await startDetached(p.updateExe, args, p.root);
  if (!st.spawned) {
    ciMark('apply-spawn-failed', { restart: true });
    await restoreWindows(st);
    return false;
  }
  if (overlay) {
    const shown = await waitForFile(path.join(overlay, 'shown'), OVERLAY_SHOWN_TIMEOUT_MS);
    ciMark('overlay-shown', { shown });
    if (!shown) log('overlay did not report on screen in time; quitting anyway');
  }
  return true;
}

/**
 * Starts Update.exe detached and resolves once it is running (the 'spawn'
 * event) or false when it could not start. A failed start arrives as an async
 * 'error' event, so quitting right after spawn() would leave the user with no
 * Sei and no update.
 */
function startDetached(exe: string, args: string[], cwd: string): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(exe, args, { detached: true, stdio: 'ignore', cwd });
    } catch (err) {
      log(`Update.exe failed to start: ${(err as Error).message}`);
      resolve(false);
      return;
    }
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
    child.once('error', (err) => {
      log(`Update.exe failed to start: ${err.message}`);
      resolve(false);
    });
  });
}

/* -------------------------------------------------------------------------- */
/*  Adapter                                                                   */
/* -------------------------------------------------------------------------- */

let stager: ChildProcess | null = null;

function stopStager(): void {
  if (stager && stager.exitCode === null) {
    log('stopping the running stage');
    try {
      stager.kill();
    } catch {
      /* already gone */
    }
  }
  stager = null;
}

/** Runs `Update.exe stage` and resolves when it exits (or after `waitMs`, leaving it running). */
function stage(p: VelopackPaths, packagePath: string, waitMs: number): Promise<void> {
  stopStager();
  const t0 = Date.now();
  ciMark('stage-start');
  const child = spawn(p.updateExe, stageArgs(packagePath, p.root, p.packagesDir), {
    stdio: 'ignore',
    cwd: p.root,
    windowsHide: true,
  });
  stager = child;
  const done = new Promise<void>((resolve) => {
    const finish = (code: number | null): void => {
      if (stager === child) stager = null;
      let result = parseStageResult(null);
      try {
        result = parseStageResult(readFileSync(path.join(p.stageDir, 'last-result.txt'), 'utf8'));
      } catch {
        /* none written */
      }
      log(`stage exited ${code} after ${Date.now() - t0} ms: ${result.line || '(no result)'}`);
      ciMark('stage-done', { code, ms: Date.now() - t0, result: result.line });
      resolve();
    };
    child.on('exit', finish);
    child.on('error', (err) => {
      log(`stage failed to start: ${err.message}`);
      finish(null);
    });
  });
  // A stage killed with Sei, or still running at a restart, is harmless: the
  // apply only uses a copy whose .ok marker is written.
  setTimeout(() => {
    if (stager === child && child.exitCode === null) child.kill();
  }, STAGE_TIMEOUT_MS).unref();
  return Promise.race([done, sleep(waitMs)]);
}

/**
 * Removes a package that failed its signature check, with its staged copy, so
 * neither the restart nor a later launch can apply it.
 */
function discardPackage(p: VelopackPaths, version: string, pkg: string, reason: string): void {
  log(`update ${version} failed its signature check (${reason}); deleting it`);
  const t0 = Date.now();
  // The marker goes first: a staged copy without it is never used, so a delete
  // cut short (Sei closed, a file held) cannot leave a half-deleted copy marked good.
  for (const f of [path.join(p.stageDir, stagedMarkerName(version)), pkg, path.join(p.stageDir, `v${version}`)]) {
    try {
      rmSync(f, { recursive: true, force: true });
    } catch (err) {
      log(`could not delete ${f}: ${(err as Error).message}`);
    }
  }
  ciMark('signature-discarded', { target: version, ms: Date.now() - t0 });
}

export function createVelopackAutoUpdater(): VelopackAutoUpdater | null {
  const vp = velopackModule();
  const p = velopackPaths();
  if (!vp || !p) return null;

  const events = new EventEmitter();
  // CI only: a local feed (velopack-update.yml).
  const feedOverride = (process.env.SEI_VELOPACK_CI === '1' && process.env.SEI_VELOPACK_FEED) || null;
  let useGithub = false;
  let pending: VelopackUpdateInfo | null = null;
  let downloaded = false;
  let applyLaunched = false;
  /** Versions whose download failed the signature check: not offered again this run. */
  const rejected = new Set<string>();

  // A launch on the version a launch-time apply targeted: that apply worked.
  clearLaunchApplyStateIfCurrent();

  const self: VelopackAutoUpdater = {
    autoDownload: false,
    autoInstallOnAppQuit: true,
    autoRunAppAfterInstall: true,
    allowPrerelease: false,
    logger: null,
    on: (event, listener) => {
      events.on(event, listener);
    },
    setFeedURL: () => {
      // updater.ts calls this to move a failed check onto its mirror. For
      // Velopack dl.sei.gg IS the primary feed, so the fallback is GitHub.
      if (!feedOverride) useGithub = true;
    },
    checkForUpdates: async () => {
      events.emit('checking-for-update');
      if (process.env.SEI_VELOPACK_CI === '1' && process.env.SEI_VELOPACK_CI_MODE === 'none') {
        // CI harness: a launch that must not pick up (and stage) an update.
        events.emit('update-not-available');
        return null;
      }
      ciMark('check-start', { feed: feedOverride ?? (useGithub ? GITHUB_REPO : DEFAULT_FEED), channel: channel() });
      try {
        const info = await manager().checkForUpdatesAsync();
        if (!info) {
          ciMark('check-none');
          events.emit('update-not-available');
          return null;
        }
        const version = info.TargetFullRelease.Version;
        if (rejected.has(version)) {
          log(`${version} failed its signature check earlier in this run; not offering it`);
          ciMark('check-held-by-signature', { target: version });
          events.emit('update-not-available');
          return null;
        }
        if (!(await rolloutOpen(version))) {
          log(`${version} is rolling out and not offered to this install yet`);
          ciMark('check-held-by-rollout', { target: version });
          events.emit('update-not-available');
          return null;
        }
        if (pending?.TargetFullRelease.Version !== version) downloaded = false;
        pending = info;
        ciMark('check-found', {
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
      ciMark('download-start');
      try {
        await manager().downloadUpdateAsync(info, (percent) => {
          events.emit('download-progress', { percent });
        });
      } catch (err) {
        events.emit('error', err);
        throw err;
      }
      ciMark('download-done');
      // CI only: SEI_VELOPACK_CI_NOSTAGE exercises the stock extraction path.
      if (!(process.env.SEI_VELOPACK_CI === '1' && process.env.SEI_VELOPACK_CI_NOSTAGE === '1')) {
        await stage(p, packagePath(info.TargetFullRelease), STAGE_OFFER_WAIT_MS);
      }
      const pkg = packagePath(info.TargetFullRelease);
      const version = info.TargetFullRelease.Version;
      const sig = await verifyPackage(p.stageDir, version, pkg);
      ciMark('signature-check', { target: version, ok: sig.ok, skipped: 'skipped' in sig, reason: sig.ok ? undefined : sig.reason });
      if (!sig.ok) {
        rejected.add(version);
        if (pending === info) pending = null;
        discardPackage(p, version, pkg, sig.reason);
        const err = new Error(`update ${version} failed its signature check (${sig.reason})`);
        events.emit('error', err);
        throw err;
      }
      if ('skipped' in sig) log('signature check off: this build is unsigned');
      await prerenderOverlayFrames(p);
      downloaded = true;
      events.emit('update-downloaded', { version: info.TargetFullRelease.Version });
      return [];
    },
    quitAndInstall: () => {
      // Arguments are electron-updater's (isSilent, isForceRunAfter): the
      // in-app restart always relaunches, with Sei's update screen.
      if (applyLaunched || !pending || !downloaded) return;
      applyLaunched = true;
      stopStager();
      const info = pending;
      void launchApplyWithScreen(p, packagePath(info.TargetFullRelease), info.TargetFullRelease.Version, null)
        .then((launched) => {
          if (launched) {
            app.quit();
            return;
          }
          // Update.exe never started: stay open, and let the next click (or
          // the quit) try again.
          applyLaunched = false;
          events.emit('error', new Error('the updater could not be started'));
        });
    },
  };

  function channel(): string {
    return self.allowPrerelease ? BETA_CHANNEL : STABLE_CHANNEL;
  }

  function manager(): VelopackUpdateManager {
    let source: unknown;
    if (feedOverride) {
      source = /^https?:\/\//i.test(feedOverride) ? new vp!.HttpSource(feedOverride) : new vp!.FileSource(feedOverride);
    } else if (useGithub) {
      source = new vp!.GithubSource(GITHUB_REPO, undefined, self.allowPrerelease);
    } else {
      source = new vp!.HttpSource(DEFAULT_FEED);
    }
    // Always explicit: without it Velopack follows the channel of the package
    // that is installed, so a beta install would ignore the toggle.
    return new vp!.UpdateManager(source, { ExplicitChannel: channel(), MaximumDeltasBeforeFallback: 10 });
  }

  function packagePath(asset: VelopackAsset): string {
    return path.join(p!.packagesDir, path.basename(asset.FileName));
  }

  /**
   * rollout.<channel>.json, the kill switch. Missing (404) = everyone;
   * unreachable or unreadable = not this time. It always comes from the
   * dl.sei.gg feed folder, also when the packages come from the GitHub
   * fallback: GitHub releases carry no rollout rule, so an update found there
   * is only offered when dl.sei.gg answers for its rollout file.
   */
  async function rolloutOpen(version: string): Promise<boolean> {
    const name = `rollout.${channel()}.json`;
    if (feedOverride && !/^https?:\/\//i.test(feedOverride)) {
      // CI: a local feed folder.
      try {
        return ruleAllows(JSON.parse(readFileSync(path.join(feedOverride, name), 'utf8')), version);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true;
        log(`rollout file unreadable (${(err as Error).message}); holding ${version}`);
        return false;
      }
    }
    const base = feedOverride ?? DEFAULT_FEED;
    const url = `${base.replace(/\/$/, '')}/${name}`;
    try {
      const res = await net.fetch(url, { signal: AbortSignal.timeout(5000), cache: 'no-store' });
      if (res.status === 404) return true;
      if (!res.ok) {
        log(`rollout check answered ${res.status}; holding ${version} for this check`);
        return false;
      }
      return ruleAllows(await res.json(), version);
    } catch (err) {
      log(`rollout check failed (${(err as Error).message}); holding ${version} for this check`);
      return false;
    }
  }

  /** A rollout file that is there but not a rule holds the update, like an unreachable one. */
  function ruleAllows(json: unknown, version: string): boolean {
    const rule = parseRolloutRule(json);
    if (!rule) {
      log(`rollout file is not a rule; holding ${version}`);
      return false;
    }
    return rolloutAllows(rule, version, installId(p!));
  }

  // Update on quit: hand the downloaded package to Update.exe, which applies it
  // after this process exits, silently and without reopening Sei. 'quit', not
  // 'will-quit': Sei's before-quit chain ends in app.exit(0), which skips
  // will-quit but still emits quit (electron-updater hooks quit for the same
  // reason). Run 40994110388 never applied on quit with will-quit.
  // Windows is logging off or shutting down: an apply started now would be
  // killed mid-swap (or hold the shutdown up). The next launch applies the
  // downloaded update behind the splash instead (applyPendingAtLaunch).
  // 'session-end' is a window event (WM_ENDSESSION reaches each top-level
  // window), so every window reports it.
  let sessionEnding = false;
  const onSessionEnd = (): void => {
    if (sessionEnding) return;
    sessionEnding = true;
    log('session ending; leaving the update for the next launch');
    ciMark('session-end');
  };
  for (const w of BrowserWindow.getAllWindows()) w.on('session-end', onSessionEnd);
  app.on('browser-window-created', (_e, w) => w.on('session-end', onSessionEnd));

  app.on('quit', () => {
    if (sessionEnding) {
      stopStager();
      ciMark('quit', { sessionEnd: true });
      return;
    }
    if (self.autoInstallOnAppQuit && !applyLaunched && pending && downloaded) {
      applyLaunched = true;
      stopStager();
      try {
        const args = applyArgs({
          packagePath: packagePath(pending.TargetFullRelease),
          waitPid: process.pid,
          restart: false,
          root: p.root,
          packagesDir: p.packagesDir,
        });
        log(`apply ${pending.TargetFullRelease.Version} on quit`);
        ciMark('apply-launch', { restart: false });
        const child = spawn(p.updateExe, args, { detached: true, stdio: 'ignore', cwd: p.root });
        child.on('error', (err) => log(`Update.exe failed to start on quit: ${err.message}`));
        child.unref();
      } catch (err) {
        log(`apply on quit failed: ${(err as Error).message}`);
      }
    } else {
      stopStager();
    }
    ciMark('quit');
  });

  return self;
}

/* -------------------------------------------------------------------------- */
/*  Launch-time apply                                                         */
/* -------------------------------------------------------------------------- */

function launchApplyStateFile(): string {
  return path.join(app.getPath('userData'), 'update-launch-apply.json');
}

function readLaunchApplyState(): LaunchApplyState | null {
  try {
    const s = JSON.parse(readFileSync(launchApplyStateFile(), 'utf8')) as LaunchApplyState;
    return typeof s.version === 'string' && typeof s.attempts === 'number' ? s : null;
  } catch {
    return null;
  }
}

function clearLaunchApplyStateIfCurrent(): void {
  const s = readLaunchApplyState();
  if (s && s.version === app.getVersion()) {
    try {
      unlinkSync(launchApplyStateFile());
    } catch {
      /* none */
    }
  }
}

/**
 * Called by index.ts right after the splash is up, before bootstrap. When an
 * update was downloaded and staged but never applied (Sei was killed, or the
 * PC shut down before the update on quit ran), applies it now behind the
 * update screen and quits; returns true so the caller stops booting. A stage
 * that never finished is left to the normal check, which re-stages it in the
 * background, so a launch never waits for a full extraction.
 */
export async function applyPendingAtLaunch(splash: BrowserWindow | null): Promise<boolean> {
  if (process.platform !== 'win32' || !velopackInstalled()) return false;
  if (process.env.SEI_VELOPACK_CI === '1' && process.env.SEI_VELOPACK_CI_MODE === 'none') return false;
  const vp = velopackModule();
  const p = velopackPaths();
  if (!vp || !p) return false;
  try {
    const um = new vp.UpdateManager(new vp.FileSource(app.getPath('temp')));
    const asset = um.getUpdatePendingRestart();
    if (!asset) return false;
    const staged = existsSync(path.join(p.stageDir, stagedMarkerName(asset.Version)));
    const state = readLaunchApplyState();
    if (!shouldApplyAtLaunch(asset.Version, app.getVersion(), staged, velopackRestartedVersion() !== null, state)) {
      log(`pending ${asset.Version} not applied at launch (staged=${staged}, attempts=${state?.attempts ?? 0})`);
      return false;
    }
    const pkg = path.join(p.packagesDir, path.basename(asset.FileName));
    if (!hasPassingVerdict(p.stageDir, asset.Version, pkg)) {
      // Downloaded by a build without the check, or its verdict file is gone.
      const sig = await verifyPackage(p.stageDir, asset.Version, pkg);
      ciMark('signature-check', { target: asset.Version, ok: sig.ok, launch: true, reason: sig.ok ? undefined : sig.reason });
      if (!sig.ok) {
        discardPackage(p, asset.Version, pkg, sig.reason);
        return false;
      }
    }
    writeFileSync(
      launchApplyStateFile(),
      JSON.stringify({ version: asset.Version, attempts: (state?.version === asset.Version ? state.attempts : 0) + 1 }),
    );
    log(`applying pending ${asset.Version} at launch`);
    ciMark('launch-apply', { target: asset.Version });
    if (!(await launchApplyWithScreen(p, pkg, asset.Version, splash))) {
      // Update.exe would not start; boot this version normally.
      return false;
    }
    app.quit();
    return true;
  } catch (err) {
    log(`launch apply failed: ${(err as Error).message}`);
    return false;
  }
}
