/**
 * NSIS -> Velopack migration on Windows (261030). The plan and every rule are
 * in velopackMigrationPolicy.ts; this file runs them.
 *
 * Side-effect module, the THIRD import of src/main/index.ts (after
 * velopackBoot): `earlyBoot()` below runs before the single-instance lock.
 * Both copies share userData (%APPDATA%\Sei), so they share that lock, and a
 * launch that should not run (Setup starting the copy it just installed, or
 * an old NSIS shortcut after the migration) has to leave before taking it.
 *
 * State lives in <userData>/velopack-migration.json, written by both copies.
 *
 * CI (velopack-update.yml, migrate jobs) drives it with SEI_VELOPACK_CI=1 and
 * SEI_MIGRATION_FEED / SEI_MIGRATION_DELAY_MS / SEI_MIGRATION_CI_ACTION.
 */
import { app, net, shell } from 'electron';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ciMark, pidAlive, userDataInstallId, velopackInstalled, velopackLog } from './velopackBoot';
import { bundleRequire } from './bundleRequire';
import { checkSigned } from './velopackVerify';
import { waitForExit } from './winPowerShell';
import {
  MAX_INSTALL_ATTEMPTS,
  MIGRATION_STATE_FILE,
  cleanupDecision,
  earlyBootAction,
  enoughDiskForMigration,
  installDecision,
  nsisInstallFor,
  parseMigrationRule,
  parseMigrationState,
  parseSetupManifest,
  pinSearchDirs,
  shortcutPointsInto,
  safeToRemoveDir,
  asarPackageVersion,
  parseSqVersion,
  setupUrls,
  UNINSTALLER_RUN_AS,
  uninstallSpawn,
  velopackLaunchTarget,
  velopackRootFor,
  type MigrationRule,
  type MigrationState,
  type NsisInstall,
  type SetupManifest,
  type WinEnv,
} from './velopackMigrationPolicy';

const DEFAULT_FEED = 'https://dl.sei.gg/velopack';
const GITHUB_REPO = 'https://github.com/sei-studio/sei';
/** The NSIS copy waits this long after launch before it looks at the feed. */
const START_DELAY_MS = 2 * 60 * 1000;
/** The Velopack copy waits this long before it removes the NSIS copy. */
const CLEANUP_DELAY_MS = 30 * 1000;
const SETUP_TIMEOUT_MS = 10 * 60 * 1000;
const UNINSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 20 * 60 * 1000;
/** How long a Velopack launch waits for the NSIS process that started it to exit. */
const HANDOFF_WAIT_MS = 30 * 1000;
/**
 * `Setup --silent` does not start the app it installed (measured in the spike),
 * but an interactive or future Setup might. The state stays `installing` this
 * long after it exits, so such a launch sees this copy still installing and
 * leaves instead of knocking on the single-instance lock (which would raise
 * this copy's window).
 */
const SETUP_APP_START_GRACE_MS = 5 * 1000;

const ci = process.env.SEI_VELOPACK_CI === '1';
const active = process.platform === 'win32' && app.isPackaged;

function log(line: string): void {
  velopackLog(`[migration] ${line}`);
}

function winEnv(): WinEnv {
  return process.env as WinEnv;
}

/* -------------------------------------------------------------------------- */
/*  State                                                                      */
/* -------------------------------------------------------------------------- */

function stateFile(): string {
  return path.join(app.getPath('userData'), MIGRATION_STATE_FILE);
}

export function readMigrationState(): MigrationState | null {
  try {
    return parseMigrationState(JSON.parse(readFileSync(stateFile(), 'utf8')));
  } catch {
    return null;
  }
}

function writeState(s: MigrationState): void {
  const file = stateFile();
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(tmp, JSON.stringify({ ...s, at: Date.now() }, null, 1));
    renameSync(tmp, file);
  } catch (err) {
    log(`state write failed: ${(err as Error).message}`);
  }
}

function patchState(patch: Partial<MigrationState>): MigrationState {
  const prev = readMigrationState() ?? { phase: 'failed' as const, attempts: 0, cleanupAttempts: 0, at: 0 };
  const next = { ...prev, ...patch };
  writeState(next);
  return next;
}

function velopackRoot(): string | null {
  const local = winEnv().LOCALAPPDATA;
  return local ? velopackRootFor(local) : null;
}

function velopackExe(): string | null {
  const root = velopackRoot();
  return root ? velopackLaunchTarget(root, existsSync) : null;
}

/** The Velopack copy's version (current\sq.version), or null. */
function velopackCopyVersion(): string | null {
  const root = velopackRoot();
  if (!root) return null;
  try {
    return parseSqVersion(readFileSync(path.join(root, 'current', 'sq.version'), 'utf8'));
  } catch {
    return null;
  }
}

/** The version of the NSIS copy in `dir`, from its app.asar, or null. */
function nsisCopyVersion(dir: string): string | null {
  let fd: number | null = null;
  let originalFs: typeof import('node:fs');
  try {
    // Electron's unpatched fs: reads app.asar as the plain file it is.
    originalFs = bundleRequire()('original-fs') as typeof import('node:fs');
  } catch {
    return null;
  }
  try {
    fd = originalFs.openSync(path.join(dir, 'resources', 'app.asar'), 'r');
    const f = fd;
    return asarPackageVersion((offset, length) => {
      const buf = Buffer.alloc(length);
      const n = originalFs.readSync(f, buf, 0, length, offset);
      return buf.subarray(0, n);
    });
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        originalFs.closeSync(fd);
      } catch {
        /* closed */
      }
    }
  }
}

/** Synchronous sleep for the early boot, which runs before the event loop matters. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/* -------------------------------------------------------------------------- */
/*  Early boot (import time, before the single-instance lock)                  */
/* -------------------------------------------------------------------------- */

function startVelopack(exe: string, args: string[], env: NodeJS.ProcessEnv = process.env): void {
  const child = spawn(exe, args, { detached: true, stdio: 'ignore', cwd: path.dirname(exe), env });
  // A failed start (EACCES from antivirus) arrives as an async 'error' event;
  // unhandled it would be an uncaught exception. The redirect-failed check
  // covers the missing hand-off on the next launch.
  child.on('error', (err) => log(`could not start ${exe}: ${err.message}`));
  child.unref();
}

function earlyBoot(): void {
  const velopack = velopackInstalled();
  if (velopack) {
    // A restart from the NSIS copy: let it finish exiting so its
    // single-instance lock is free before this one asks for it.
    const waitPid = Number(process.env.SEI_MIGRATION_WAIT_PID);
    delete process.env.SEI_MIGRATION_WAIT_PID;
    if (waitPid > 0) {
      const end = Date.now() + HANDOFF_WAIT_MS;
      while (pidAlive(waitPid) && Date.now() < end) sleepSync(100);
    }
  }
  const state = readMigrationState();
  const exe = velopackExe();
  const action = earlyBootAction({
    velopack,
    state,
    now: Date.now(),
    pidAlive,
    velopackExists: !!exe && existsSync(exe),
    selfPid: process.pid,
    appVersion: app.getVersion(),
    velopackVersion: velopack ? null : velopackCopyVersion(),
  });
  if (velopack && state && (state.phase === 'installed' || state.phase === 'done')) {
    // Proof for the NSIS copy that its last hand-off came up.
    writeState({ ...state, velopackSeenAt: Date.now() });
  }
  switch (action.kind) {
    case 'none':
      return;
    case 'exit':
      log(`launch exited early: ${action.reason}`);
      ciMark('migration-early-exit', { reason: action.reason });
      process.exit(0);
      return;
    case 'redirect': {
      log(`this NSIS copy was replaced; starting ${exe}`);
      ciMark('migration-redirect', { exe });
      writeState({ ...state!, redirectAt: Date.now() });
      try {
        startVelopack(exe!, process.argv.slice(1));
      } catch (err) {
        log(`redirect failed: ${(err as Error).message}; running this copy`);
        return;
      }
      process.exit(0);
      return;
    }
    case 'nsis-newer':
      // Installed from the website after the migration: this build is the one
      // the player chose. Stop handing off, keep this copy (cleanupDecision
      // leaves a newer NSIS copy alone too), and point the pins back here.
      log(`this NSIS copy (${app.getVersion()}) is newer than the Velopack copy (${action.velopackVersion}); running it`);
      ciMark('migration-nsis-newer', { velopackVersion: action.velopackVersion });
      writeState({
        ...state!,
        phase: 'failed',
        attempts: Math.max(state!.attempts, MAX_INSTALL_ATTEMPTS),
        error: `nsis copy ${app.getVersion()} is newer than velopack ${action.velopackVersion}`,
      });
      void app.whenReady().then(() => {
        const root = velopackRoot();
        if (root) retargetPins(root, process.execPath);
      });
      return;
    case 'redirect-failed':
      // The Velopack copy was started a moment ago and never booted. Keep this
      // copy, put the shortcuts back on it, and stop trying for this epoch.
      log('the Velopack copy did not start after the last hand-off; staying on the NSIS copy');
      ciMark('migration-redirect-failed');
      writeState({
        ...state!,
        phase: 'failed',
        attempts: Math.max(state!.attempts, MAX_INSTALL_ATTEMPTS),
        error: 'velopack copy did not start',
      });
      void app.whenReady().then(() => {
        const root = velopackRoot();
        if (root) retargetPins(root, process.execPath);
      });
      return;
  }
}

/**
 * Points every shortcut (taskbar and Start pins, Start menu, Desktop) whose
 * target is inside `fromDir` at `target`, through the shell's own Unicode
 * shortcut API (IShellLinkW). The first cut ran a WScript.Shell script, which
 * cannot handle a path outside the system code page: a Chinese install folder
 * on an English Windows threw "Value does not fall within the expected range"
 * (261031 CI, migrate peruser-unicode). Returns how many it changed.
 */
function retargetPins(fromDir: string, target: string): number {
  let n = 0;
  const visit = (dir: string, depth: number): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth > 0) visit(full, depth - 1);
        continue;
      }
      if (!e.name.toLowerCase().endsWith('.lnk')) continue;
      try {
        if (!shortcutPointsInto(shell.readShortcutLink(full).target, fromDir)) continue;
        if (shell.writeShortcutLink(full, 'update', { target, cwd: path.dirname(target) })) n++;
      } catch {
        // not a readable shortcut
      }
    }
  };
  try {
    let desktop: string | null = null;
    try {
      desktop = app.getPath('desktop');
    } catch {
      desktop = null;
    }
    const dirs = pinSearchDirs(process.env.APPDATA || app.getPath('appData'), desktop);
    for (const d of dirs.deep) visit(d, 4);
    for (const d of dirs.shallow) visit(d, 0);
  } catch (err) {
    log(`pin retarget failed: ${(err as Error).message}`);
  }
  return n;
}

if (active) {
  try {
    earlyBoot();
  } catch (err) {
    log(`early boot failed: ${(err as Error).message}`);
  }
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function freeBytes(dir: string): number | null {
  try {
    const s = statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

async function capture(event: string, props: Record<string, unknown>): Promise<void> {
  if (ci) return;
  try {
    const { loadAnalytics } = await import('./lazyAnalytics');
    (await loadAnalytics()).capture(event, props);
  } catch {
    /* analytics is best effort */
  }
}

function feedBase(): string {
  const override = ci ? process.env.SEI_MIGRATION_FEED : undefined;
  return (override || DEFAULT_FEED).replace(/\/+$/, '');
}

async function fetchJson(url: string): Promise<{ status: number; json: unknown }> {
  const res = await net.fetch(url, { signal: AbortSignal.timeout(10_000), cache: 'no-store' });
  if (!res.ok) return { status: res.status, json: null };
  return { status: res.status, json: await res.json() };
}

/** Downloads to `dest`, checking size and sha256. Throws on any mismatch. */
async function download(url: string, dest: string, m: SetupManifest): Promise<void> {
  const res = await net.fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const hash = createHash('sha256');
  const out = createWriteStream(dest);
  // A write error (disk full, antivirus locking the new .exe) must reject this
  // download: with no listener it is an uncaught exception in main, and the
  // drain wait below would never resolve.
  const failed: { error: Error | null } = { error: null };
  out.on('error', (err) => {
    failed.error = err;
  });
  let size = 0;
  const reader = res.body.getReader();
  try {
    for (;;) {
      if (failed.error) throw failed.error;
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > m.size) throw new Error('larger than the manifest says');
      hash.update(value);
      if (!out.write(value)) {
        await new Promise<void>((r) => {
          out.once('drain', () => r());
          out.once('error', () => r());
        });
      }
    }
  } catch (err) {
    void reader.cancel().catch(() => {});
    throw err;
  } finally {
    if (!out.destroyed) {
      await new Promise<void>((r) => {
        out.once('error', () => r());
        out.end(() => r());
      });
    }
  }
  if (failed.error) throw failed.error;
  if (size !== m.size) throw new Error(`size ${size}, expected ${m.size}`);
  const digest = hash.digest('hex');
  if (digest !== m.sha256) throw new Error(`sha256 ${digest.slice(0, 12)}, expected ${m.sha256.slice(0, 12)}`);
}

/* -------------------------------------------------------------------------- */
/*  NSIS side: install the Velopack copy                                       */
/* -------------------------------------------------------------------------- */

export interface MigrationDeps {
  /** An electron-updater (NSIS) update is downloaded and waiting. */
  isUpdateReady: () => boolean;
  /** Stop electron-updater and make the restart button start the Velopack copy. */
  handOff: (restart: () => void, version: string) => void;
}

let running = false;

function restartIntoVelopack(): void {
  const exe = velopackExe();
  if (!exe || !existsSync(exe)) {
    log('restart into Velopack: no Velopack copy, ignoring');
    return;
  }
  log(`restarting into ${exe}`);
  ciMark('migration-restart', { exe });
  startVelopack(exe, [], { ...process.env, SEI_MIGRATION_WAIT_PID: String(process.pid) });
  app.quit();
}

async function readRules(): Promise<{ rule: MigrationRule | null; manifest: SetupManifest | null; channel: string }> {
  let beta = false;
  try {
    const { loadConfig } = await import('./configStore');
    beta = (await loadConfig()).advanced_updates === true;
  } catch {
    /* stable */
  }
  const channel = beta ? 'beta' : 'win';
  const base = feedBase();
  const r = await fetchJson(`${base}/migration.${channel}.json`);
  const rule = r.status === 200 ? parseMigrationRule(r.json) : null;
  if (!rule || rule.percent <= 0) return { rule, manifest: null, channel };
  const s = await fetchJson(`${base}/setup.${channel}.json`);
  return { rule, manifest: s.status === 200 ? parseSetupManifest(s.json) : null, channel };
}

/**
 * Best-effort removal of the migration's temp folder. Right after a Setup
 * exits (or is killed) Windows can still hold its image for a moment, and a
 * throw here used to escape installVelopack before the state left
 * 'installing' (velopack-update.yml migrate/setup-killed, 261031).
 */
async function removeTemp(dir: string): Promise<void> {
  try {
    // Async: the retries must not block the main process.
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (err) {
    log(`could not remove ${dir}: ${(err as Error).message}`);
  }
}

async function installVelopack(nsis: NsisInstall, deps: MigrationDeps): Promise<void> {
  const { rule, manifest, channel } = await readRules();
  const prior = readMigrationState();
  const installId = userDataInstallId();
  const decision = installDecision({
    state: prior,
    rule,
    manifest,
    appVersion: app.getVersion(),
    installId,
    updatePending: deps.isUpdateReady(),
    installingElsewhere: !!prior?.pid && prior.pid !== process.pid && pidAlive(prior.pid),
  });
  ciMark('migration-check', { decision, channel });
  if (!decision.ok) {
    log(`not migrating: ${decision.reason}`);
    return;
  }
  const m = manifest!;
  const local = winEnv().LOCALAPPDATA;
  if (!local) return;
  const tmp = path.join(app.getPath('temp'), `sei-migration-${randomBytes(4).toString('hex')}`);
  mkdirSync(tmp, { recursive: true });
  if (!enoughDiskForMigration(freeBytes(tmp), m.size) || !enoughDiskForMigration(freeBytes(local), m.size)) {
    log('not migrating: low disk');
    ciMark('migration-check', { decision: { ok: false, reason: 'low-disk' } });
    await removeTemp(tmp);
    return;
  }

  const base: MigrationState = {
    phase: 'installing',
    version: m.version,
    nsisDir: nsis.dir,
    perMachine: nsis.perMachine,
    pid: process.pid,
    epoch: decision.epoch,
    attempts: decision.attempt,
    cleanupAttempts: 0,
    at: Date.now(),
  };
  const fail = (error: string) => {
    log(`install failed: ${error}`);
    ciMark('migration-failed', { error });
    writeState({ ...base, phase: 'failed', pid: undefined, error });
    void capture('velopack_migration', { phase: 'failed', attempt: decision.attempt, error: error.slice(0, 80) });
  };

  // The Setup's process name is what CI's kill test looks for.
  const setup = path.join(tmp, 'sei-velopack-setup.exe');
  let fetched = false;
  for (const url of setupUrls(m, feedBase(), GITHUB_REPO)) {
    try {
      await download(url, setup, m);
      fetched = true;
      break;
    } catch (err) {
      log(`download from ${url} failed: ${(err as Error).message}`);
    }
  }
  if (!fetched) {
    fail('download failed');
    await removeTemp(tmp);
    return;
  }
  // The sha256 above comes from the same bucket as the Setup, so it only
  // proves the download matches the bucket. Windows has to vouch for the
  // signer before Sei runs it.
  const sig = await checkSigned([setup]);
  ciMark('migration-signature', { ok: sig.ok, skipped: 'skipped' in sig, reason: sig.ok ? undefined : sig.reason });
  if (!sig.ok) {
    fail(`setup signature: ${sig.reason}`);
    await removeTemp(tmp);
    return;
  }
  if ('skipped' in sig) log('signature check off: this build is unsigned');

  writeState(base);
  ciMark('migration-installing', { version: m.version, attempt: decision.attempt });
  log(`installing Velopack ${m.version} (attempt ${decision.attempt})`);
  const child = spawn(setup, ['--silent'], { windowsHide: true, stdio: 'ignore', cwd: tmp });
  try {
    if (child.pid) os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    /* a normal priority install is fine */
  }
  const r = await waitForExit(child, SETUP_TIMEOUT_MS);
  if (r.code === 0) await new Promise((res) => setTimeout(res, SETUP_APP_START_GRACE_MS));
  await removeTemp(tmp);
  const root = velopackRootFor(local);
  const ok =
    r.code === 0 &&
    existsSync(path.join(root, 'current', 'Sei.exe')) &&
    existsSync(path.join(root, 'current', 'sq.version')) &&
    existsSync(path.join(root, 'Update.exe'));
  if (!ok) {
    fail(r.timedOut ? 'setup timed out' : r.error ? `setup: ${r.error}` : `setup exit ${r.code}`);
    return;
  }

  const target = velopackLaunchTarget(root, existsSync);
  const retargeted = `retargeted ${retargetPins(nsis.dir, target)}`;
  log(`installed; pins: ${retargeted}`);
  writeState({ ...base, phase: 'installed', pid: undefined });
  ciMark('migration-installed', { version: m.version, pins: retargeted });
  void capture('velopack_migration', { phase: 'installed', attempt: decision.attempt, version: m.version });
  deps.handOff(restartIntoVelopack, m.version);
  if (ci && process.env.SEI_MIGRATION_CI_ACTION === 'restart') restartIntoVelopack();
}

/* -------------------------------------------------------------------------- */
/*  Velopack side: remove the NSIS copy                                        */
/* -------------------------------------------------------------------------- */

async function removeNsisCopy(): Promise<void> {
  const state = readMigrationState();
  const nsisDir = state?.nsisDir;
  const nsisExe = nsisDir ? path.join(nsisDir, 'Sei.exe') : null;
  const left = !!nsisExe && existsSync(nsisExe);
  const nsisVersion = left ? nsisCopyVersion(nsisDir!) : null;
  const decision = cleanupDecision(state, left, { pidAlive, nsisVersion, selfVersion: app.getVersion() });
  ciMark('migration-cleanup-check', { decision, nsisVersion });
  if (decision === 'keep-newer') {
    log(`NSIS copy at ${nsisDir} is ${nsisVersion}, newer than this copy; keeping it`);
    writeState({
      ...state!,
      phase: 'failed',
      attempts: Math.max(state!.attempts, MAX_INSTALL_ATTEMPTS),
      error: `nsis copy ${nsisVersion} is newer than velopack ${app.getVersion()}`,
    });
    return;
  }
  if (decision !== 'skip' && state!.phase === 'installing') {
    // The NSIS Sei that ran Setup went away before it wrote `installed`; this
    // copy running is the proof that it was.
    log('migration was left at installing by a closed NSIS copy; taking it as installed');
    writeState({ ...state!, phase: 'installed', pid: undefined });
  }
  if (decision === 'done') {
    writeState({ ...state!, phase: 'done' });
    ciMark('migration-done');
    return;
  }
  if (decision !== 'run') {
    if (decision === 'keep' || decision === 'gave-up') log(`NSIS copy at ${nsisDir} left in place (${decision})`);
    return;
  }
  const s = patchState({ cleanupAttempts: state!.cleanupAttempts + 1 });
  const dir = nsisDir!;
  const root = velopackRoot();
  if (root) retargetPins(dir, velopackLaunchTarget(root, existsSync));

  const uninstaller = path.join(dir, 'Uninstall Sei.exe');
  if (existsSync(uninstaller)) {
    const tmp = path.join(app.getPath('temp'), `sei-uninstall-${randomBytes(4).toString('hex')}`);
    try {
      mkdirSync(tmp, { recursive: true });
      // Not 'Uninstall Sei.exe': see UNINSTALLER_RUN_AS.
      const copy = path.join(tmp, UNINSTALLER_RUN_AS);
      copyFileSync(uninstaller, copy);
      const how = uninstallSpawn(copy, dir);
      const child = spawn(copy, how.args, { ...how.options, windowsHide: true, stdio: 'ignore', cwd: tmp });
      const r = await waitForExit(child, UNINSTALL_TIMEOUT_MS);
      log(`NSIS uninstaller: ${r.timedOut ? 'timed out' : `exit ${r.code}`}${r.error ? ` (${r.error})` : ''}`);
    } catch (err) {
      log(`NSIS uninstaller failed: ${(err as Error).message}`);
    } finally {
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch (err) {
        log(`could not remove ${tmp}: ${(err as Error).message}`);
      }
    }
  }
  // The uninstaller leaves the folder behind when anything in it was in use
  // or was not its own; take it once it no longer holds Sei.
  if (existsSync(dir) && !existsSync(path.join(dir, 'Sei.exe')) && safeToRemoveDir(dir, winEnv())) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      log(`could not remove ${dir}: ${(err as Error).message}`);
    }
  }
  if (existsSync(path.join(dir, 'Sei.exe'))) {
    log(`NSIS copy still present after attempt ${s.cleanupAttempts}`);
    ciMark('migration-cleanup-failed', { attempt: s.cleanupAttempts });
    return;
  }
  writeState({ ...readMigrationState()!, phase: 'done', error: undefined });
  ciMark('migration-done', { dirLeft: existsSync(dir) });
  void capture('velopack_migration', { phase: 'cleaned', attempts: s.cleanupAttempts });
}

/* -------------------------------------------------------------------------- */
/*  Entry                                                                      */
/* -------------------------------------------------------------------------- */

function delay(fallback: number): number {
  const v = ci ? Number(process.env.SEI_MIGRATION_DELAY_MS) : NaN;
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

/** Called once from bootstrap, after initUpdater. No-op outside a packaged Windows build. */
export function scheduleVelopackMigration(deps: MigrationDeps): void {
  if (!active) return;
  if (velopackInstalled()) {
    setTimeout(() => {
      void removeNsisCopy().catch((err) => log(`cleanup failed: ${(err as Error).message}`));
    }, delay(CLEANUP_DELAY_MS)).unref?.();
    return;
  }
  const nsis = nsisInstallFor(process.execPath, winEnv(), existsSync);
  if (!nsis) return;
  setTimeout(() => {
    if (running) return;
    running = true;
    void installVelopack(nsis, deps)
      .catch((err) => {
        log(`migration failed: ${(err as Error).message}`);
        ciMark('migration-failed', { error: (err as Error).message });
      })
      .finally(() => {
        running = false;
      });
  }, delay(START_DELAY_MS)).unref?.();
}
