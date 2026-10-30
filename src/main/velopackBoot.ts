/**
 * SPIKE (spike/velopack, 261030): Velopack startup hook for Windows.
 *
 * Side-effect module. MUST be the second import of src/main/index.ts, right
 * after remoteDebugGuard: Velopack runs install/update/uninstall hooks by
 * launching Sei.exe with `--veloapp-*` arguments and expects the process to
 * handle them and exit within 15-30 s. ES module bodies evaluate in import
 * order, so `VelopackApp.run()` here exits a hook launch before the rest of
 * the main graph evaluates (the graph is still parsed, which is part of what
 * the spike measures as hook cost).
 *
 * Only active in a packaged win32 build. When the app was NOT installed by
 * Velopack (an NSIS install, or dev), `run()` logs "Error loading
 * manager/locator" and returns, and `velopackInstalled()` stays false, so the
 * same build keeps working under electron-updater. That property is what the
 * migration design relies on.
 */
import { app } from 'electron';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { bundleRequire } from './bundleRequire';

/** Wall-clock time this module evaluated: the earliest JS point of a launch. */
export const velopackBootAt = Date.now();

/** Minimal structural types for the parts of the `velopack` package we use. */
export interface VelopackAsset {
  PackageId: string;
  Version: string;
  Type: string;
  FileName: string;
  Size: number;
  NotesMarkdown: string;
}
export interface VelopackUpdateInfo {
  TargetFullRelease: VelopackAsset;
  BaseRelease?: VelopackAsset;
  DeltasToTarget: VelopackAsset[];
  IsDowngrade: boolean;
}
export interface VelopackUpdateManager {
  getCurrentVersion(): string;
  getAppId(): string;
  isPortable(): boolean;
  getUpdatePendingRestart(): VelopackAsset | null;
  checkForUpdatesAsync(): Promise<VelopackUpdateInfo | null>;
  downloadUpdateAsync(update: VelopackUpdateInfo, progress?: (perc: number) => void): Promise<void>;
  waitExitThenApplyUpdate(
    update: VelopackUpdateInfo | VelopackAsset,
    silent?: boolean,
    restart?: boolean,
    restartArgs?: string[],
  ): void;
}
export interface VelopackModule {
  VelopackApp: {
    build(): {
      setLogger(cb: (level: string, msg: string) => void): unknown;
      onRestarted(cb: (v: string) => void): unknown;
      onFirstRun(cb: (v: string) => void): unknown;
      run(): void;
    };
  };
  UpdateManager: new (
    source: unknown,
    options?: { AllowVersionDowngrade?: boolean; ExplicitChannel?: string; MaximumDeltasBeforeFallback?: number },
  ) => VelopackUpdateManager;
  HttpSource: new (url: string) => unknown;
  FileSource: new (path: string) => unknown;
  GithubSource: new (repoUrl: string, accessToken?: string, prerelease?: boolean) => unknown;
}

let mod: VelopackModule | null = null;
let installed = false;
let restartedVersion: string | null = null;
let firstRunVersion: string | null = null;

/** Append one line to <userData>/logs/velopack.log. Never throws. */
export function velopackLog(line: string): void {
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, 'velopack.log'), `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* best effort */
  }
}

/** Spike timing marks, one JSON object per line in <userData>/velopack-spike.jsonl. */
export function spikeMark(ev: string, extra: Record<string, unknown> = {}): void {
  if (process.env.SEI_VELOPACK_SPIKE !== '1') return;
  try {
    const file = path.join(app.getPath('userData'), 'velopack-spike.jsonl');
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(
      file,
      JSON.stringify({ ev, t: Date.now(), pid: process.pid, version: app.getVersion(), ...extra }) + '\n',
    );
  } catch {
    /* best effort */
  }
}

if (process.platform === 'win32' && app.isPackaged) {
  try {
    mod = bundleRequire()('velopack') as VelopackModule;
    const builder = mod.VelopackApp.build();
    builder.setLogger((level, msg) => velopackLog(`[${level}] ${msg}`));
    builder.onRestarted((v) => {
      restartedVersion = v;
    });
    builder.onFirstRun((v) => {
      firstRunVersion = v;
    });
    builder.run();
    // run() returned, so this is a normal launch (hooks exit inside run()).
    // An UpdateManager only constructs when a Velopack locator exists, i.e.
    // this copy was installed by Velopack's Setup.exe.
    try {
      new mod.UpdateManager(new mod.FileSource(app.getPath('temp')));
      installed = true;
    } catch {
      installed = false;
    }
    spikeMark('boot', { velopackInstalled: installed, restartedVersion, firstRunVersion, argv: process.argv.slice(1) });
  } catch (err) {
    velopackLog(`velopack boot failed: ${(err as Error).message}`);
    mod = null;
  }
}

export function velopackModule(): VelopackModule | null {
  return mod;
}

/** True when this process runs from a Velopack install (not NSIS, not dev). */
export function velopackInstalled(): boolean {
  return installed;
}

export function velopackRestartedVersion(): string | null {
  return restartedVersion;
}
