/**
 * Velopack self-repair on Windows (product call 261120). The rules and the
 * reasoning are in velopackRepairPolicy.ts; this file runs them.
 *
 *   boot.ts       initVelopackRepair() right after the boot guard (sync):
 *                 reads the last hand-off's result, counts a broken layout or
 *                 an apply that did not take, and leaves at once when another
 *                 launch is mid-repair. scheduleVelopackRepair() after
 *                 initUpdater, in normal and safe mode.
 *   index.ts /    handOffRepairAtLaunch(): a Setup downloaded by an earlier
 *   boot.ts       run is installed before Sei boots.
 *   velopackUpdater.ts  noteUpdaterFailure / noteUpdaterHealthy /
 *                 noteApplyLaunched feed the signals; repairHoldsUpdates()
 *                 stops it from checking or applying while a repair is due.
 *   updater.ts    velopackLayoutBroken() keeps electron-updater off a
 *                 Velopack install whose Update.exe is gone (it would install
 *                 a second, NSIS copy).
 *
 * State: <userData>/velopack-repair.json, written synchronously and fsynced
 * (durableWrite.ts) like the boot guard's, so a power cut never loses a count
 * or a hand-off.
 *
 * CI (velopack-update.yml, repair-* scenarios) uses the update harness's
 * SEI_VELOPACK_CI / SEI_VELOPACK_FEED / SEI_VELOPACK_CI_MODE, plus
 * SEI_REPAIR_DELAY_MS for the start delay.
 */
import { app, nativeTheme, net } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { noteNeutralExit } from './bootContext';
import { writeFileDurableSync } from './durableWrite';
import { isSeilinkHostLaunch } from './seilink/host/hostArgs';
import { ciMark, pidAlive, userDataInstallId, velopackInstalled, velopackLog } from './velopackBoot';
import { compareVersions, parseRolloutRule, velopackPathsFor, type VelopackPaths } from './velopackFastApply';
import {
  enoughDiskForMigration,
  parseSetupManifest,
  setupUrls,
  velopackRootFor,
  type SetupManifest,
} from './velopackMigrationPolicy';
import {
  DEFAULT_REPAIR_RULE,
  FAILURE_THRESHOLD,
  REPAIR_STATE_FILE,
  emptyRepairState,
  evaluateLaunch,
  noteApplyLaunched as recordApply,
  noteFailure,
  noteHealthy,
  parseRepairRule,
  parseRepairState,
  pushReport,
  recordDecision,
  rememberSetup,
  repairDue,
  repairDecision,
  DECISIVE,
  type BrokenLayout,
  type FailureKind,
  type KnownSetup,
  type RepairReport,
  type RepairRule,
  type RepairState,
  type RolloutRead,
} from './velopackRepairPolicy';
import {
  REPAIR_RUNNER_PS1,
  REPAIR_SETUP_FILE,
  RUNNER_CONFIG,
  RUNNER_SCRIPT,
  runnerArgs,
  type RunnerConfig,
} from './velopackRepairRunner';
import { downloadSetup, freeBytes, setupUnchanged } from './velopackSetupFetch';
import { checkSigned } from './velopackVerify';
import { powerShellEnv, powerShellExe } from './winPowerShell';

const DEFAULT_FEED = 'https://dl.sei.gg/velopack';
const GITHUB_REPO = 'https://github.com/sei-studio/sei';
/** A due repair starts this long after launch (the app gets to settle first). */
const DUE_DELAY_MS = 20 * 1000;
/** A healthy launch looks at setup.<channel>.json (once per version) this long after launch. */
const PROBE_DELAY_MS = 3 * 60 * 1000;
/** How long Sei waits for the runner to report it is running before it gives up and stays open. */
const RUNNER_START_TIMEOUT_MS = 20 * 1000;
const FETCH_TIMEOUT_MS = 10 * 1000;

const ci = process.env.SEI_VELOPACK_CI === '1';
let active = process.platform === 'win32' && app.isPackaged && !isSeilinkHostLaunch(process.argv);
/** Unique per process: the policy counts at most one failure per launch. */
let launchId = `${process.pid}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;

export interface RepairDeps {
  /** Download progress (0..100) for the update UI. */
  progress: (percent: number) => void;
  /** The download failed: clear the update UI's progress. */
  failed: (message: string) => void;
  /**
   * The Setup is downloaded and verified: stop the updater and make the
   * update button (and the safe-mode screen's install) run `restart`.
   * `forced` = it is about to run on its own.
   */
  ready: (restart: () => void, version: string, forced: boolean) => void;
}

interface Layout {
  paths: VelopackPaths;
  broken: BrokenLayout;
}

let inited = false;
let safeMode = false;
let layoutInfo: Layout | null = null;
let deps: RepairDeps | null = null;
/** True while a repair is due and undecided, downloading, or downloaded: the updater stands still. */
let holding = false;
let running = false;
let attemptedThisProcess = false;
let handingOff = false;
/** Repair or hand-off work in flight (tests wait on it). */
let inflight = 0;

function log(line: string): void {
  velopackLog(`[repair] ${line}`);
}

/* -------------------------------------------------------------------------- */
/*  State                                                                      */
/* -------------------------------------------------------------------------- */

function stateFile(): string {
  return path.join(app.getPath('userData'), REPAIR_STATE_FILE);
}

export function readRepairState(): RepairState {
  try {
    return parseRepairState(JSON.parse(readFileSync(stateFile(), 'utf8')));
  } catch {
    return emptyRepairState();
  }
}

function writeState(s: RepairState): void {
  try {
    mkdirSync(path.dirname(stateFile()), { recursive: true });
    writeFileDurableSync(stateFile(), JSON.stringify(s) + '\n');
  } catch (err) {
    log(`state write failed: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
  }
}

/** Read, change, write (all sync: no other writer can interleave in this process). */
function update(fn: (s: RepairState) => RepairState): RepairState {
  const next = fn(readRepairState());
  writeState(next);
  return next;
}

/* -------------------------------------------------------------------------- */
/*  Layout                                                                     */
/* -------------------------------------------------------------------------- */

/** This process runs from a Velopack layout (<root>\current\Sei.exe with sq.version), broken or not. */
function detectLayout(): Layout | null {
  const p = velopackPathsFor(process.execPath);
  if (!p || !existsSync(path.join(p.root, 'current', 'sq.version'))) return null;
  let broken: BrokenLayout = null;
  if (!existsSync(p.updateExe)) broken = 'update-exe-missing';
  else if (!velopackInstalled()) broken = 'not-installed';
  return { paths: p, broken };
}

/** A Velopack install that Velopack cannot update: never hand it to electron-updater. */
export function velopackLayoutBroken(): boolean {
  return !!layoutInfo?.broken;
}

/** The updater must not check or apply now (a repair is due or under way). */
export function repairHoldsUpdates(): boolean {
  return holding;
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function tail(text: string | null, lines: number): string[] {
  if (!text) return [];
  return text.split(/\r?\n/).filter((l) => l.trim()).slice(-lines);
}

/* -------------------------------------------------------------------------- */
/*  Launch                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Called by boot.ts right after the boot guard, in normal and safe mode.
 * Sync. Never throws. May exit the process (a repair is running right now).
 */
export function initVelopackRepair(opts: { safeMode: boolean }): void {
  if (!active || inited) return;
  try {
    const lay = detectLayout();
    if (!lay) return;
    inited = true;
    layoutInfo = lay;
    safeMode = opts.safeMode;
    const prev = readRepairState();
    const h = prev.handoff;
    const result = h ? readText(path.join(h.dir, 'result.txt')) : null;
    const runnerPid = h ? Number(readText(path.join(h.dir, 'started'))?.trim()) : NaN;
    const out = evaluateLaunch(prev, {
      launch: launchId,
      version: app.getVersion(),
      now: Date.now(),
      broken: lay.broken,
      handoffResult: result,
      handoffRunnerAlive: Number.isInteger(runnerPid) && runnerPid > 0 && pidAlive(runnerPid),
    });
    for (const n of out.notes) log(n);
    if (out.leave) {
      ciMark('repair-left-during-repair', { target: h?.target });
      process.exit(0);
    }
    let s = out.state;
    if (h && out.removeDir) {
      // What Setup and the runner said, for the support log, then the folder goes.
      for (const l of tail(readText(path.join(h.dir, 'runner.log')), 20)) log(`runner: ${l}`);
      for (const l of tail(readText(path.join(h.dir, 'setup.log')), 40)) log(`setup: ${l}`);
      ciMark('repair-result', { result: result?.trim() ?? null, attempt: h.attempt, from: h.from, target: h.target, reports: s.reports.slice(-1) });
      const dir = out.removeDir;
      setTimeout(() => void removeDir(dir), 30_000).unref?.();
    }
    // packages\.betaId keys the update rollout's bucket. A reinstall writes a
    // new one; put the old one back so the install stays in its bucket.
    const betaFile = path.join(lay.paths.packagesDir, '.betaId');
    const beta = readText(betaFile)?.trim();
    if (h && s.betaId && beta !== s.betaId && !lay.broken) {
      try {
        writeFileSync(betaFile, s.betaId);
        log('kept the install id across the reinstall');
      } catch {
        /* a new bucket is all it costs */
      }
    } else if (beta) {
      s = { ...s, betaId: beta };
    }
    writeState(s);
    holding = repairDue(s) || !!s.ready;
    ciMark('repair-init', {
      broken: lay.broken,
      streak: s.streak,
      attempts: s.attempts,
      due: repairDue(s),
      ready: !!s.ready,
      last: s.lastFailure?.kind ?? null,
      safeMode,
    });
  } catch (err) {
    log(`init failed: ${(err as Error).message}`);
  }
}

async function removeDir(dir: string): Promise<void> {
  // Only folders this module made: %TEMP%\sei-repair-<hex>.
  if (!/[\\/]sei-repair-[0-9a-f]+$/i.test(dir)) return;
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (err) {
    log(`could not remove ${dir}: ${(err as Error).message}`);
  }
}

/** Analytics events waiting to be sent (index.ts, normal launches only). */
export function takeRepairReports(): RepairReport[] {
  if (!inited) return [];
  const s = readRepairState();
  if (s.reports.length === 0) return [];
  writeState({ ...s, reports: [] });
  return s.reports;
}

/* -------------------------------------------------------------------------- */
/*  Signals from the updater                                                   */
/* -------------------------------------------------------------------------- */

export interface FailureInfo {
  detail?: string;
  target?: string;
  /**
   * check / download: a URL that must answer for the failure to count (the
   * feed's releases file, the package). Offline or a broken feed is not a
   * broken install.
   */
  probe?: { url: string; json?: boolean };
}

async function probeOk(probe: { url: string; json?: boolean }): Promise<boolean> {
  try {
    const res = await net.fetch(probe.url, {
      method: probe.json ? 'GET' : 'HEAD',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!res.ok) return false;
    if (!probe.json) return true;
    const body = (await res.json()) as { Assets?: unknown };
    return Array.isArray(body?.Assets) && body.Assets.length > 0;
  } catch {
    return false;
  }
}

/** The updater failed in a way a reinstall could fix. Never throws. */
export async function noteUpdaterFailure(kind: FailureKind, info: FailureInfo = {}): Promise<void> {
  if (!inited) return;
  try {
    if (info.probe && !(await probeOk(info.probe))) {
      log(`${kind} failed but ${info.probe.url} does not answer either; not counted (${info.detail ?? ''})`);
      ciMark('repair-signal', { kind, counted: false, why: 'probe' });
      return;
    }
    let counted = false;
    const s = update((prev) => {
      const r = noteFailure(prev, kind, { launch: launchId, version: app.getVersion(), now: Date.now(), target: info.target, detail: info.detail });
      counted = r.counted;
      return r.state;
    });
    log(`${kind} failed (${info.detail ?? 'no detail'}); ${counted ? `streak ${s.streak}` : 'already counted this launch'}`);
    ciMark('repair-signal', { kind, counted, streak: s.streak });
    if (repairDue(s)) {
      holding = true;
      void runRepair('threshold');
    }
  } catch (err) {
    log(`could not record ${kind}: ${(err as Error).message}`);
  }
}

/** A real check found nothing to install: the updater works. */
export function noteUpdaterHealthy(): void {
  if (!inited) return;
  const prev = readRepairState();
  if (prev.streak === 0 && !prev.lastFailure) return;
  if (prev.lastFailure && DECISIVE.includes(prev.lastFailure.kind) && layoutInfo?.broken) return;
  writeState(noteHealthy(prev));
  log('a check worked; streak cleared');
  ciMark('repair-signal', { kind: 'healthy' });
}

/** Update.exe was started to apply `target`. Sync: it runs while Sei quits. */
export function noteApplyLaunched(target: string): void {
  if (!inited) return;
  update((s) => recordApply(s, app.getVersion(), target, Date.now()));
}

/* -------------------------------------------------------------------------- */
/*  Feed                                                                       */
/* -------------------------------------------------------------------------- */

function feedBase(): string {
  const override = ci ? process.env.SEI_VELOPACK_FEED : undefined;
  return (override || DEFAULT_FEED).replace(/\/+$/, '');
}

async function fetchJson(url: string): Promise<{ status: number; json: unknown }> {
  try {
    const res = await net.fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), cache: 'no-store' });
    if (!res.ok) return { status: res.status, json: null };
    return { status: res.status, json: await res.json().catch(() => null) };
  } catch {
    return { status: 0, json: null };
  }
}

/** The install's channel(s): the one it follows, plus beta while it runs a beta (never strand a beta below its own version). */
async function channels(): Promise<string[]> {
  let beta = false;
  try {
    const { loadConfig } = await import('./configStore');
    beta = (await loadConfig()).advanced_updates === true;
  } catch {
    /* stable */
  }
  const list = [beta ? 'beta' : 'win'];
  if (!beta && app.getVersion().includes('-')) list.push('beta');
  return list;
}

async function readRule(channel: string): Promise<RepairRule | null> {
  const r = await fetchJson(`${feedBase()}/repair.${channel}.json`);
  if (r.status === 404) return DEFAULT_REPAIR_RULE;
  if (r.status !== 200) return null;
  return parseRepairRule(r.json);
}

async function readRollout(channel: string): Promise<RolloutRead> {
  const r = await fetchJson(`${feedBase()}/rollout.${channel}.json`);
  if (r.status === 404) return null;
  if (r.status !== 200) return 'unreadable';
  return parseRolloutRule(r.json) ?? 'unreadable';
}

async function readSetup(channel: string): Promise<SetupManifest | null> {
  const r = await fetchJson(`${feedBase()}/setup.${channel}.json`);
  return r.status === 200 ? parseSetupManifest(r.json) : null;
}

/** Healthy runs: remember this version's Setup once, so a later repair can fall back to it. */
async function cacheSetupOnce(): Promise<void> {
  const version = app.getVersion();
  if (readRepairState().setupProbedFor === version) return;
  const [channel] = await channels();
  const m = await readSetup(channel);
  update((s) => {
    let next: RepairState = { ...s, setupProbedFor: version };
    if (m && compareVersions(m.version, version) >= 0) next = rememberSetup(next, m, channel);
    return next;
  });
}

/* -------------------------------------------------------------------------- */
/*  Repair                                                                     */
/* -------------------------------------------------------------------------- */

function mode(): string {
  return safeMode ? 'safe' : 'normal';
}

function report(r: RepairReport): void {
  update((s) => pushReport(s, r));
}

function release(why: string): void {
  if (!holding) return;
  holding = false;
  log(`updates resume (${why})`);
}

function supportedRoot(root: string): boolean {
  const local = process.env.LOCALAPPDATA;
  return !!local && path.win32.resolve(velopackRootFor(local)).toLowerCase() === path.win32.resolve(root).toLowerCase();
}

async function runRepair(reason: string): Promise<void> {
  if (!inited || running || attemptedThisProcess || handingOff) return;
  running = true;
  inflight++;
  try {
    let s = readRepairState();
    if (s.ready) {
      // Downloaded earlier in this process (the hand-off at launch runs before this).
      holding = true;
      return;
    }
    if (!repairDue(s)) {
      release('not due');
      await cacheSetupOnce().catch(() => {});
      return;
    }
    // A decisive signal is re-checked: Update.exe can be back (an antivirus
    // restored it) and then the ordinary threshold applies again.
    const lay = layoutInfo!;
    if (s.lastFailure && DECISIVE.includes(s.lastFailure.kind)) {
      const now = detectLayout();
      if (!now?.broken && s.streak < FAILURE_THRESHOLD) {
        layoutInfo = now ?? lay;
        writeState(noteHealthy(s));
        release('the layout is whole again');
        return;
      }
    }
    holding = true;
    ciMark('repair-due', { reason, streak: s.streak, last: s.lastFailure?.kind ?? null });

    const chans = await channels();
    const [rule, ...perChannel] = await Promise.all([
      readRule(chans[0]),
      ...chans.map(async (c) => ({ c, setup: await readSetup(c), rollout: await readRollout(c) })),
    ]);
    const fresh = perChannel as Array<{ c: string; setup: SetupManifest | null; rollout: RolloutRead }>;
    s = readRepairState();
    for (const f of fresh) if (f.setup) s = rememberSetup(s, f.setup, f.c);
    const candidates: KnownSetup[] = s.setups.filter((x) => chans.includes(x.channel));
    const rollouts: Record<string, RolloutRead> = {};
    for (const f of fresh) rollouts[f.c] = f.rollout;
    let decision = repairDecision({
      state: s,
      rule,
      installId: s.betaId ?? userDataInstallId(),
      appVersion: app.getVersion(),
      candidates,
      rollouts,
    });
    if (decision.ok && !supportedRoot(lay.paths.root)) decision = { ok: false, reason: 'unsupported-layout' };
    const tmp = path.join(app.getPath('temp'), `sei-repair-${randomBytes(4).toString('hex')}`);
    if (decision.ok) {
      const size = decision.target.size;
      const local = process.env.LOCALAPPDATA ?? lay.paths.root;
      if (!enoughDiskForMigration(freeBytes(app.getPath('temp')), size) || !enoughDiskForMigration(freeBytes(local), size)) {
        decision = { ok: false, reason: 'low-disk' };
      }
    }
    s = recordDecision(s, decision, mode());
    writeState(s);
    ciMark('repair-decision', { decision: decision.ok ? { ok: true, attempt: decision.attempt, target: decision.target.version } : decision });
    if (!decision.ok) {
      log(`not repairing: ${decision.reason}`);
      release(decision.reason);
      return;
    }
    attemptedThisProcess = true;
    const m = decision.target;
    log(`repair ${decision.attempt}: installing ${m.version} (${m.channel}) over ${lay.paths.root}`);

    const fail = (stage: string, cls: string, detail: string) => {
      log(`repair ${decision.ok ? decision.attempt : 0} failed at ${stage}: ${detail}`);
      ciMark('repair-failed', { stage, class: cls, detail: detail.slice(0, 200) });
      report({ phase: 'failed', stage, class: cls, attempt: decision.ok ? decision.attempt : 0, mode: mode() });
      deps?.failed(detail);
      release(`failed at ${stage}`);
    };

    mkdirSync(tmp, { recursive: true });
    const file = path.join(tmp, REPAIR_SETUP_FILE);
    let fetched = false;
    let lastPct = -1;
    for (const url of setupUrls(m, feedBase(), GITHUB_REPO)) {
      try {
        await downloadSetup(url, file, m, (bytes) => {
          const pct = Math.floor((bytes / m.size) * 100);
          if (pct !== lastPct) {
            lastPct = pct;
            deps?.progress(pct);
          }
        });
        fetched = true;
        break;
      } catch (err) {
        log(`download from ${url} failed: ${(err as Error).message}`);
      }
    }
    if (!fetched) {
      fail('download', 'download', 'the Setup could not be downloaded');
      await removeDir(tmp);
      return;
    }
    // The sha256 comes from the same bucket as the Setup; Windows has to
    // vouch for the signer before Sei runs it. Fail closed.
    const sig = await checkSigned([file]);
    ciMark('repair-signature', { ok: sig.ok, skipped: 'skipped' in sig, reason: sig.ok ? undefined : sig.reason });
    if (!sig.ok) {
      fail('signature', 'signature', `setup signature: ${sig.reason}`);
      await removeDir(tmp);
      return;
    }
    if ('skipped' in sig) log('signature check off: this build is unsigned');
    update((st) => ({ ...st, ready: { attempt: decision.ok ? decision.attempt : 0, dir: tmp, file, manifest: m, at: Date.now() } }));
    ciMark('repair-ready', { target: m.version });
    log(`Setup ${m.version} downloaded and verified`);

    const now = safeMode || (ci && (process.env.SEI_VELOPACK_CI_MODE ?? 'restart') === 'restart');
    deps?.ready(() => void handOff(mode()), m.version, now);
    if (now) await handOff(mode());
  } catch (err) {
    log(`repair failed: ${(err as Error).message}`);
    ciMark('repair-failed', { stage: 'internal', detail: (err as Error).message.slice(0, 200) });
    release('internal error');
  } finally {
    running = false;
    inflight--;
  }
}

/* -------------------------------------------------------------------------- */
/*  Hand-off                                                                   */
/* -------------------------------------------------------------------------- */

function waitForFile(file: string, ms: number, child: ChildProcess): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      clearInterval(poll);
      clearTimeout(timer);
      resolve(v);
    };
    const poll = setInterval(() => {
      if (existsSync(file)) finish(true);
    }, 100);
    const timer = setTimeout(() => finish(existsSync(file)), ms);
    child.once('error', () => finish(false));
    child.once('exit', (code) => {
      if (code !== 0) setTimeout(() => finish(existsSync(file)), 500);
    });
  });
}

async function progressWindow(version: string, root: string): Promise<{ kill: () => void } | null> {
  try {
    const [{ buildHelperConfig, launchUpdateProgressHelper }, { loadConfig }] = await Promise.all([
      import('./updateProgressHelper'),
      import('./configStore'),
    ]);
    const cfg = await loadConfig().catch(() => null);
    const config = buildHelperConfig({
      themeMode: cfg?.theme_mode,
      osDark: nativeTheme.shouldUseDarkColors,
      uiLanguage: cfg?.ui_language,
      version,
      installerPath: REPAIR_SETUP_FILE,
      appExe: path.win32.join(root, 'current', 'Sei.exe'),
      downloaded: true,
    });
    const handle = await launchUpdateProgressHelper({
      resourcesDir: path.join(process.resourcesPath, 'update-progress'),
      tmpRoot: os.tmpdir(),
      config,
    });
    if (!handle.ready) {
      log(`progress window unavailable: ${handle.reason}`);
      return null;
    }
    return handle;
  } catch (err) {
    log(`progress window failed: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Starts the runner and quits. Resolves false (Sei stays open) when the
 * runner never reported it was running.
 */
async function handOff(how: string): Promise<boolean> {
  inflight++;
  try {
    return await handOffInner(how);
  } finally {
    inflight--;
  }
}

async function handOffInner(how: string): Promise<boolean> {
  if (!inited || handingOff) return false;
  const s = readRepairState();
  const r = s.ready;
  const lay = layoutInfo;
  if (!r || !lay) return false;
  handingOff = true;
  holding = true;
  const dropReady = (cls: string, detail: string) => {
    log(`hand-off failed: ${detail}`);
    ciMark('repair-failed', { stage: 'handoff', class: cls, detail });
    update((st) => pushReport({ ...st, ready: undefined, handoff: undefined }, { phase: 'failed', stage: 'handoff', class: cls, attempt: r.attempt, mode: how }));
    void removeDir(r.dir);
    release('hand-off failed');
    handingOff = false;
    return false;
  };
  try {
    const changed = await setupUnchanged(r.file, r.manifest);
    if (changed) return dropReady('setup-changed', changed);
    const exe = powerShellExe();
    if (!exe) return dropReady('no-powershell', 'Windows PowerShell is missing');
    const script = path.join(r.dir, RUNNER_SCRIPT);
    const config: RunnerConfig = { setup: r.file, sha256: r.manifest.sha256, root: lay.paths.root, waitPid: process.pid };
    writeFileSync(script, REPAIR_RUNNER_PS1.replace(/\r?\n/g, '\r\n'), 'ascii');
    writeFileSync(path.join(r.dir, RUNNER_CONFIG), JSON.stringify(config));
    for (const f of ['started', 'cancel', 'result.txt']) rmSync(path.join(r.dir, f), { force: true });

    update((st) => ({
      ...st,
      ready: undefined,
      handoff: {
        attempt: r.attempt,
        from: app.getVersion(),
        target: r.manifest.version,
        channel: r.manifest.channel,
        at: Date.now(),
        dir: r.dir,
        trigger: st.lastFailure?.kind ?? 'check',
        mode: how,
      },
    }));
    const helper = await progressWindow(r.manifest.version, lay.paths.root);
    const child = spawn(exe, runnerArgs(script, r.dir), {
      cwd: r.dir,
      stdio: 'ignore',
      windowsHide: true,
      env: powerShellEnv(process.env),
    });
    child.on('error', (err) => log(`runner failed to start: ${err.message}`));
    const started = await waitForFile(path.join(r.dir, 'started'), RUNNER_START_TIMEOUT_MS, child);
    if (!started) {
      try {
        writeFileSync(path.join(r.dir, 'cancel'), 'cancel');
      } catch {
        /* folder gone */
      }
      helper?.kill();
      for (const l of tail(readText(path.join(r.dir, 'runner.log')), 10)) log(`runner: ${l}`);
      return dropReady('runner-blocked', 'the repair runner did not start');
    }
    log(`handed off to the runner (repair ${r.attempt}, ${how}); quitting`);
    ciMark('repair-handoff', { attempt: r.attempt, target: r.manifest.version, mode: how, progressWindow: !!helper });
    noteNeutralExit(); // boot safety: a hand-over, not a failed start
    app.quit();
    return true;
  } catch (err) {
    return dropReady('handoff', (err as Error).message);
  }
}

/**
 * At the start of a launch (before the app boots): installs a Setup an
 * earlier run downloaded. Resolves true when Sei is quitting into it.
 */
export async function handOffRepairAtLaunch(): Promise<boolean> {
  if (!inited) return false;
  const s = readRepairState();
  const r = s.ready;
  if (!r || s.handoff) return false;
  if (!existsSync(r.file) || compareVersions(r.manifest.version, app.getVersion()) < 0) {
    update((st) => ({ ...st, ready: undefined }));
    void removeDir(r.dir);
    release('stale download');
    return false;
  }
  // The kill switch still wins: switched off since the download = no install.
  // Unreachable = go ahead (it was allowed when the download started).
  const res = await fetchJson(`${feedBase()}/repair.${r.manifest.channel}.json`);
  const rule = res.status === 200 ? parseRepairRule(res.json) : res.status === 404 ? DEFAULT_REPAIR_RULE : null;
  if (rule && rule.percent <= 0) {
    log('repair switched off since the download; dropping it');
    update((st) => pushReport({ ...st, ready: undefined }, { phase: 'held', reason: 'disabled' }));
    void removeDir(r.dir);
    release('switched off');
    return false;
  }
  ciMark('repair-launch-handoff', { target: r.manifest.version });
  return handOff('launch');
}

function delay(fallback: number): number {
  const v = ci ? Number(process.env.SEI_REPAIR_DELAY_MS) : NaN;
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

/** Called from boot.ts after initUpdater (normal and safe mode). No-op outside a Velopack install. */
export function scheduleVelopackRepair(d: RepairDeps): void {
  if (!inited) return;
  deps = d;
  const due = repairDue(readRepairState());
  setTimeout(() => void runRepair('launch'), delay(due ? DUE_DELAY_MS : PROBE_DELAY_MS)).unref?.();
}

/** For velopackRepair.test.ts. */
export const __test = {
  detectLayout,
  launchId: () => launchId,
  busy: () => inflight > 0,
  /** A fresh process: new launch id, nothing decided yet. */
  newLaunch(): void {
    this.reset();
    active = true;
    launchId = `test-${randomBytes(4).toString('hex')}`;
  },
  runRepair,
  handOff,
  reset(): void {
    inited = false;
    safeMode = false;
    layoutInfo = null;
    deps = null;
    holding = false;
    running = false;
    attemptedThisProcess = false;
    handingOff = false;
  },
};

