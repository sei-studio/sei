/**
 * Boot guard: counts failed starts and decides when to start in safe mode
 * (261031, T277).
 *
 * State lives in `<userData>/boot-state.json`, device-global and separate
 * from every settings store (a broken settings file must never be able to
 * break the thing that recovers from it). It is tiny and written
 * synchronously with fsync (durableWrite.ts), because the attempt has to be on
 * disk before anything that could crash runs, and a crash gives no chance to
 * write it afterwards.
 *
 * How a start is judged:
 *   - beginBoot() records a pending attempt. If the previous launch left a
 *     pending NORMAL attempt behind, that launch never reached success and
 *     never quit cleanly: it crashed, hung and was killed, or lost power. That
 *     counts as one failure ('unclean_exit').
 *   - Success = the main window's renderer reported ready and stayed up for
 *     SUCCESS_HOLD_MS (index.ts / bootContext.ts). markSuccess() resets the
 *     count to 0.
 *   - A failure the process can see (the main graph failed to load, bootstrap
 *     threw, the renderer crashed or failed to load before success) is
 *     counted at once with markFailure().
 *   - A clean quit before success is neutral (markNeutral): someone closing
 *     the app during the splash, or an update restart, is not a broken start.
 *     The exception is a quit NEVER_READY_QUIT_MS or more into a start whose
 *     renderer never reported ready (quitVerdict): Sei never came up.
 *   - A new app version resets the count: an update deserves a normal start.
 *
 * After FAILURE_THRESHOLD consecutive failures the next start is a safe-mode
 * start. "Try normal start" sets forceNormalOnce, which gives exactly one
 * normal start without clearing the count, so a still-broken build falls
 * straight back to safe mode.
 *
 * Everything above the IO section is pure and unit tested.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { writeFileDurableSync } from './durableWrite';

export const BOOT_STATE_FILE = 'boot-state.json';
export const FAILURE_THRESHOLD = 2;
/** How long the renderer must stay up after its ready ping to count as a successful start. */
export const SUCCESS_HOLD_MS = 5_000;
/**
 * A clean quit counts as a failure only when the renderer never reported
 * ready and the start had been running this long: Sei never came up and the
 * person gave up on it. A quit earlier than that (closing the app during the
 * splash) says nothing.
 */
export const NEVER_READY_QUIT_MS = 30_000;

export type BootMode = 'normal' | 'safe';

export type FailureKind =
  | 'unclean_exit'
  | 'module_load'
  | 'bootstrap'
  | 'renderer_gone'
  | 'renderer_load_failed'
  | 'renderer_never_ready';

export type SafeModeReason = FailureKind | 'forced';

export interface BootState {
  v: 1;
  /** Consecutive failed normal starts on `appVersion`. */
  failures: number;
  /** The version the count belongs to. */
  appVersion: string | null;
  /** The attempt in progress (or left behind by a launch that never finished). */
  pending: { at: number; appVersion: string; mode: BootMode } | null;
  lastFailure: { at: number; appVersion: string; kind: FailureKind } | null;
  /** Set by "Try normal start": the next start is normal regardless of the count. */
  forceNormalOnce: boolean;
  /** A safe-mode entry not yet reported to analytics (sent from the next normal start). */
  report: { reason: SafeModeReason; failures: number; at: number } | null;
}

export function freshBootState(): BootState {
  return { v: 1, failures: 0, appVersion: null, pending: null, lastFailure: null, forceNormalOnce: false, report: null };
}

const FAILURE_KINDS: readonly FailureKind[] = [
  'unclean_exit',
  'module_load',
  'bootstrap',
  'renderer_gone',
  'renderer_load_failed',
  'renderer_never_ready',
];

function isObj(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}

/** Coerce anything read from disk into a valid state. Garbage = a fresh state. */
export function normalizeBootState(raw: unknown): BootState {
  const s = freshBootState();
  if (!isObj(raw)) return s;
  if (typeof raw.failures === 'number' && Number.isFinite(raw.failures) && raw.failures > 0) {
    s.failures = Math.min(Math.floor(raw.failures), 1000);
  }
  if (typeof raw.appVersion === 'string') s.appVersion = raw.appVersion;
  const p = raw.pending;
  if (isObj(p) && typeof p.at === 'number' && typeof p.appVersion === 'string' && (p.mode === 'normal' || p.mode === 'safe')) {
    s.pending = { at: p.at, appVersion: p.appVersion, mode: p.mode };
  }
  const f = raw.lastFailure;
  if (isObj(f) && typeof f.at === 'number' && typeof f.appVersion === 'string' && FAILURE_KINDS.includes(f.kind as FailureKind)) {
    s.lastFailure = { at: f.at, appVersion: f.appVersion, kind: f.kind as FailureKind };
  }
  s.forceNormalOnce = raw.forceNormalOnce === true;
  const r = raw.report;
  if (
    isObj(r) &&
    typeof r.failures === 'number' &&
    typeof r.at === 'number' &&
    (r.reason === 'forced' || FAILURE_KINDS.includes(r.reason as FailureKind))
  ) {
    s.report = { reason: r.reason as SafeModeReason, failures: r.failures, at: r.at };
  }
  return s;
}

export interface BeginBootResult {
  state: BootState;
  mode: BootMode;
  /** Why this start is a safe-mode start (null for a normal start). */
  reason: SafeModeReason | null;
}

/**
 * Account for the previous launch and decide this one. Pure: the caller
 * persists `state`.
 */
export function beginBoot(
  prev: BootState,
  opts: { appVersion: string; now: number; forceSafe?: boolean },
): BeginBootResult {
  const s: BootState = { ...prev };
  // 1. The previous launch left an unfinished NORMAL attempt: count it.
  //    An unfinished safe-mode run counts for nothing (safe mode is the fallback,
  //    its own exit says nothing about the normal path).
  if (s.pending && s.pending.mode === 'normal') {
    if (s.appVersion === null || s.appVersion === s.pending.appVersion) {
      s.failures += 1;
      s.appVersion = s.pending.appVersion;
    }
    s.lastFailure = { at: s.pending.at, appVersion: s.pending.appVersion, kind: 'unclean_exit' };
  }
  s.pending = null;
  // 2. A different version starts clean: an update gets a normal start.
  if (s.appVersion !== opts.appVersion) {
    s.failures = 0;
    s.forceNormalOnce = false;
    s.appVersion = opts.appVersion;
  }
  // 3. Decide.
  let mode: BootMode = 'normal';
  let reason: SafeModeReason | null = null;
  if (opts.forceSafe) {
    mode = 'safe';
    reason = 'forced';
  } else if (s.forceNormalOnce) {
    s.forceNormalOnce = false;
  } else if (s.failures >= FAILURE_THRESHOLD) {
    mode = 'safe';
    reason = s.lastFailure?.kind ?? 'unclean_exit';
  }
  s.pending = { at: opts.now, appVersion: opts.appVersion, mode };
  if (mode === 'safe') s.report = { reason: reason!, failures: s.failures, at: opts.now };
  return { state: s, mode, reason };
}

/** The start succeeded: the count goes back to zero. */
export function markSuccess(s: BootState): BootState {
  return { ...s, failures: 0, pending: null, forceNormalOnce: false };
}

/** A failure seen in-process. Clears the pending attempt so it is not counted twice. */
export function markFailure(s: BootState, kind: FailureKind, opts: { appVersion: string; now: number }): BootState {
  const failures = (s.appVersion === null || s.appVersion === opts.appVersion ? s.failures : 0) + 1;
  return {
    ...s,
    failures,
    appVersion: opts.appVersion,
    pending: null,
    lastFailure: { at: opts.now, appVersion: opts.appVersion, kind },
  };
}

/** A clean exit that says nothing about whether the start works. */
export function markNeutral(s: BootState): BootState {
  return { ...s, pending: null };
}

/** This process switched to safe mode after an in-process failure. */
export function markInProcessSafe(s: BootState, reason: SafeModeReason, opts: { appVersion: string; now: number }): BootState {
  return {
    ...s,
    pending: { at: opts.now, appVersion: opts.appVersion, mode: 'safe' },
    report: { reason, failures: s.failures, at: opts.now },
  };
}

/** "Try normal start": one normal start, count kept. */
export function requestNormalStart(s: BootState): BootState {
  return { ...s, forceNormalOnce: true, pending: null };
}

/** Take the unreported safe-mode entry, if any. */
export function takeReport(s: BootState): { state: BootState; report: BootState['report'] } {
  return { state: { ...s, report: null }, report: s.report };
}

/**
 * What to do with an in-process failure: relaunch for one more try, or show
 * the safe-mode screen now.
 */
export function inProcessFailureAction(failures: number): 'relaunch' | 'safe' {
  return failures < FAILURE_THRESHOLD ? 'relaunch' : 'safe';
}

/**
 * Judge a clean quit. `readyAt` is when the renderer reported ready (null =
 * never), `startedAt` when this start began.
 */
export function quitVerdict(opts: {
  succeeded: boolean;
  readyAt: number | null;
  startedAt: number;
  now: number;
}): 'success' | 'failure' | 'neutral' {
  if (opts.succeeded || opts.readyAt !== null) return 'success';
  if (opts.now - opts.startedAt >= NEVER_READY_QUIT_MS) return 'failure';
  return 'neutral';
}

/** Env / argv override: force a safe-mode start (support and testing). */
export function safeModeForced(argv: readonly string[], env: NodeJS.ProcessEnv): boolean {
  return env.SEI_SAFE_MODE === '1' || argv.includes('--safe-mode');
}

/* -------------------------------------------------------------------------- */
/*  IO                                                                         */
/* -------------------------------------------------------------------------- */

export function bootStatePath(userData: string): string {
  return path.join(userData, BOOT_STATE_FILE);
}

/** Read the state. A missing, empty or corrupt file reads as a fresh state. */
export function readBootStateSync(file: string): BootState {
  try {
    return normalizeBootState(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return freshBootState();
  }
}

/** Persist the state. Never throws: a guard that cannot write must not break the start. */
export function writeBootStateSync(file: string, s: BootState): boolean {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileDurableSync(file, JSON.stringify(s) + '\n');
    return true;
  } catch (err) {
    console.warn(`[sei] boot guard: could not write state (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
    return false;
  }
}
