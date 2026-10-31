/**
 * Runtime half of the boot guard (261031, T277): the one place boot.ts (the
 * entry shim) and index.ts (the app) share start-up state.
 *
 * Kept deliberately small and dependency-free (electron + bootGuard only):
 * boot.ts loads it before the app's module graph, and anything it imported
 * would be loaded in safe mode too. It lands in a shared chunk, so boot.ts
 * and the app (crashReporting.ts, index.ts) see the same state.
 *
 * Crash reporting seam (261031, T280): boot-state.json ("did this start
 * work") and session.json (crash analytics, crashReporting.ts) stay separate
 * files, but they must agree on two things. A start judged failed here is
 * recorded there as `start_failed` before Sei relaunches or quits
 * (onStartFailed; boot.ts's fallback writes it when crash reporting never
 * started). An OS shutdown seen there is neutral here (noteOsShutdown).
 */
import type { BrowserWindow, WebContents } from 'electron';
import {
  beginBoot,
  bootStatePath,
  freshBootState,
  inProcessFailureAction,
  markFailure,
  markInProcessSafe,
  markNeutral,
  markSuccess,
  quitVerdict,
  readBootStateSync,
  requestNormalStart,
  KILLED_GRACE_MS,
  rendererGoneVerdict,
  SUCCESS_HOLD_MS,
  takeReport,
  writeBootStateSync,
  type BootMode,
  type BootState,
  type FailureKind,
  type SafeModeReason,
} from './bootGuard';

interface Ctx {
  file: string | null;
  persistent: boolean;
  appVersion: string;
  state: BootState;
  mode: BootMode;
  reason: SafeModeReason | null;
  succeeded: boolean;
  startedAt: number;
  readyAt: number | null;
  successTimer: ReturnType<typeof setTimeout> | null;
  getMainWindow: () => BrowserWindow | null;
  getSafeWindow: () => BrowserWindow | null;
  enterSafeMode: ((reason: SafeModeReason) => void) | null;
  relaunch: (() => void) | null;
  onSuccess: Array<() => void>;
  /** The OS is ending the session (Windows log-off / shutdown, powerMonitor 'shutdown'). */
  osShutdown: boolean;
  killedTimer: ReturnType<typeof setTimeout> | null;
  /** Records a failed start in session.json (crashReporting.ts). */
  startFailedHooks: Array<(kind: FailureKind) => void>;
  /** boot.ts: records it when no hook is registered (crash reporting never started). */
  startFailedFallback: ((kind: FailureKind, startedAt: number) => void) | null;
  startFailedSent: boolean;
  /** A failure judged while the process keeps running (macOS window close); sent at quit. */
  deferredStartFailure: FailureKind | null;
}

const ctx: Ctx = {
  file: null,
  persistent: false,
  appVersion: '0.0.0',
  state: freshBootState(),
  mode: 'normal',
  reason: null,
  succeeded: false,
  startedAt: 0,
  readyAt: null,
  successTimer: null,
  getMainWindow: () => null,
  getSafeWindow: () => null,
  enterSafeMode: null,
  relaunch: null,
  onSuccess: [],
  osShutdown: false,
  killedTimer: null,
  startFailedHooks: [],
  startFailedFallback: null,
  startFailedSent: false,
  deferredStartFailure: null,
};

/** True when the state is on disk (or there is nothing to write). */
function persist(): boolean {
  if (ctx.persistent && ctx.file) return writeBootStateSync(ctx.file, ctx.state);
  return true;
}

function log(line: string): void {
  console.log(`[sei] boot: ${line}`);
}

/**
 * Record this start attempt and decide its mode. Called once from boot.ts,
 * after the single-instance lock and before the app graph loads.
 * `persistent: false` (dev, unless SEI_BOOT_GUARD=1) keeps the state in
 * memory and only LOGS start failures: a developer wants the crash, not the
 * safe-mode screen. A forced safe mode (`--safe-mode`) still works there.
 */
export function initBootGuard(opts: {
  userData: string;
  appVersion: string;
  persistent: boolean;
  forceSafe: boolean;
  now?: number;
}): {
  mode: BootMode;
  reason: SafeModeReason | null;
  failures: number;
  /** The previous NORMAL start never finished (counted as unclean_exit): when it began, on which version. */
  unfinished: { at: number; appVersion: string } | null;
} {
  ctx.persistent = opts.persistent;
  ctx.appVersion = opts.appVersion;
  ctx.file = bootStatePath(opts.userData);
  ctx.startedAt = opts.now ?? Date.now();
  const prev = opts.persistent ? readBootStateSync(ctx.file) : freshBootState();
  const unfinished =
    prev.pending && prev.pending.mode === 'normal' ? { at: prev.pending.at, appVersion: prev.pending.appVersion } : null;
  const r = beginBoot(prev, { appVersion: opts.appVersion, now: ctx.startedAt, forceSafe: opts.forceSafe });
  ctx.state = r.state;
  ctx.mode = r.mode;
  ctx.reason = r.reason;
  persist();
  log(`mode=${r.mode}${r.reason ? ` reason=${r.reason}` : ''} failures=${r.state.failures}`);
  return { mode: r.mode, reason: r.reason, failures: r.state.failures, unfinished };
}

export function getBootMode(): BootMode {
  return ctx.mode;
}

export function getSafeModeReason(): SafeModeReason | null {
  return ctx.reason;
}

export function getFailureCount(): number {
  return ctx.state.failures;
}

/* ---------------------------- windows ------------------------------------ */

/** index.ts registers its main-window getter. */
export function setMainWindowGetter(fn: () => BrowserWindow | null): void {
  ctx.getMainWindow = fn;
}

/** boot.ts registers the safe-mode window getter. */
export function setSafeWindowGetter(fn: () => BrowserWindow | null): void {
  ctx.getSafeWindow = fn;
}

/** The window the updater talks to: the safe-mode screen while it is up, else the main window. */
export function updaterWindow(): BrowserWindow | null {
  const safe = ctx.getSafeWindow();
  if (safe && !safe.isDestroyed()) return safe;
  return ctx.getMainWindow();
}

/** The window a second launch should bring forward. */
export function focusableWindow(): BrowserWindow | null {
  return updaterWindow();
}

export function isMainWindowSender(sender: WebContents): boolean {
  const win = ctx.getMainWindow();
  return !!win && !win.isDestroyed() && win.webContents.id === sender.id;
}

/* ------------------------- profile scope gate ----------------------------- */

let resolveScopeReady: () => void = () => {};
/**
 * Resolves once bootstrap has picked the profile scope (or given up). The
 * updater's startup check waits on it so the beta-channel preference is read
 * from the right profile's config.
 */
export const profileScopeReady: Promise<void> = new Promise<void>((r) => {
  resolveScopeReady = r;
});
export function markProfileScopeReady(): void {
  resolveScopeReady();
}

/* ------------------------------ hooks ------------------------------------- */

/** How to show the safe-mode screen in this process when there is no relaunch hook. */
export function setSafeModeEntry(fn: (reason: SafeModeReason) => void): void {
  ctx.enterSafeMode = fn;
}

/** boot.ts: how to start again (app.relaunch + exit). */
export function setRelaunch(fn: () => void): void {
  ctx.relaunch = fn;
}

/**
 * Crash reporting (crashReporting.ts): record a failed start in session.json.
 * Called just before Sei relaunches after a failed start, opens safe mode in
 * this process, or quits with a start judged failed, so that session is not
 * read as a clean quit next launch. At most once per process.
 */
export function onStartFailed(fn: (kind: FailureKind) => void): void {
  ctx.startFailedHooks.push(fn);
}

/** boot.ts: how to record a failed start when crash reporting never started (the app failed to load). */
export function setStartFailedFallback(fn: (kind: FailureKind, startedAt: number) => void): void {
  ctx.startFailedFallback = fn;
}

function sendStartFailed(kind: FailureKind): void {
  if (ctx.startFailedSent) return;
  ctx.startFailedSent = true;
  ctx.deferredStartFailure = null;
  const hooks = ctx.startFailedHooks;
  try {
    if (hooks.length > 0) for (const fn of hooks) fn(kind);
    else ctx.startFailedFallback?.(kind, ctx.startedAt);
  } catch {
    /* a hook never breaks the guard */
  }
}

/** Run once when the start is judged successful. */
export function onBootSuccess(fn: () => void): void {
  if (ctx.succeeded) fn();
  else ctx.onSuccess.push(fn);
}

/* ------------------------------ events ------------------------------------ */

function succeed(): void {
  if (ctx.succeeded) return;
  ctx.succeeded = true;
  if (ctx.successTimer) clearTimeout(ctx.successTimer);
  ctx.successTimer = null;
  if (ctx.mode === 'normal') {
    ctx.state = markSuccess(ctx.state);
    persist();
    log('start succeeded');
  }
  for (const fn of ctx.onSuccess.splice(0)) {
    try { fn(); } catch { /* a hook never breaks the guard */ }
  }
}

/** The main window's renderer mounted. Success after SUCCESS_HOLD_MS without a crash. */
export function noteRendererReady(now = Date.now()): void {
  if (ctx.succeeded || ctx.mode !== 'normal') return;
  if (ctx.readyAt === null) ctx.readyAt = now;
  if (ctx.successTimer) return;
  ctx.successTimer = setTimeout(succeed, SUCCESS_HOLD_MS);
  ctx.successTimer.unref?.();
}

/**
 * A start-up failure seen in this process. Before success it counts, and Sei
 * starts again (the next start is safe mode once the count reaches the
 * threshold). After success it is an ordinary runtime problem and is left
 * alone.
 */
export function reportStartupFailure(kind: FailureKind, err?: unknown): void {
  if (ctx.succeeded || ctx.mode !== 'normal') return;
  if (ctx.successTimer) clearTimeout(ctx.successTimer);
  ctx.successTimer = null;
  ctx.readyAt = null;
  const now = Date.now();
  ctx.state = markFailure(ctx.state, kind, { appVersion: ctx.appVersion, now });
  // Only the error's class, never its message: messages can carry paths or data.
  const cls = err instanceof Error ? err.name : typeof err;
  log(`start failed (${kind}${err !== undefined ? `, ${cls}` : ''}), failures=${ctx.state.failures}`);
  if (!ctx.persistent) return; // dev: log only (see initBootGuard)
  const saved = persist();
  // Start again in a fresh process: one more normal start after the first
  // failure, the safe-mode screen after the second (beginBoot decides from
  // the count just written). Safe mode never shares a process with the app
  // that just failed. Only when the count reached the disk: with boot-state
  // unwritable (read-only userData, disk full, a locked file) the next
  // process would read the same old count, fail the same way and relaunch
  // again, forever. Then this process keeps the pre-guard behaviour.
  if (ctx.relaunch && saved) {
    ctx.succeeded = true; // judged; the quit that follows must not re-judge it
    // relaunch() ends in app.exit(0): without this, session.json would read
    // as a clean quit and the failed start would vanish from crash-free numbers.
    sendStartFailed(kind);
    ctx.relaunch();
    return;
  }
  // No relaunch hook (tests, or a host that cannot relaunch): stay in this
  // process, and on the second failure show the safe-mode screen here.
  if (inProcessFailureAction(ctx.state.failures) === 'relaunch') return;
  ctx.mode = 'safe';
  ctx.reason = kind;
  ctx.state = markInProcessSafe(ctx.state, kind, { appVersion: ctx.appVersion, now });
  persist();
  sendStartFailed(kind);
  if (ctx.enterSafeMode) ctx.enterSafeMode(kind);
}

/**
 * The main window's renderer went away (render-process-gone) before the
 * start was judged. See rendererGoneVerdict: a clean exit says nothing, a
 * kill during an OS shutdown is neutral, a kill otherwise counts after
 * KILLED_GRACE_MS unless an OS shutdown shows up first, anything else counts.
 */
export function noteRendererGone(reason: string): void {
  if (ctx.succeeded || ctx.mode !== 'normal') return;
  const verdict = rendererGoneVerdict(reason, ctx.osShutdown);
  if (verdict === 'ignore') return;
  if (verdict === 'failure') {
    reportStartupFailure('renderer_gone');
    return;
  }
  if (ctx.killedTimer) return;
  ctx.killedTimer = setTimeout(() => {
    ctx.killedTimer = null;
    if (!ctx.osShutdown) reportStartupFailure('renderer_gone');
  }, KILLED_GRACE_MS);
  ctx.killedTimer.unref?.();
}

/**
 * The OS is ending the session (crashReporting.ts: Windows `session-end`,
 * powerMonitor `shutdown`). Whatever happens to the start after this says
 * nothing about the build: neutral, and nothing later re-judges it.
 */
export function noteOsShutdown(): void {
  ctx.osShutdown = true;
  if (ctx.killedTimer) clearTimeout(ctx.killedTimer);
  ctx.killedTimer = null;
  noteNeutralExit();
}

/**
 * The main window closed. Before the start was judged, judge it now, from
 * the time the window went away: on macOS Sei stays running with no window,
 * and a quit hours later must not read as "never came up"
 * (renderer_never_ready). Same rule as a quit (quitVerdict). A failure here
 * is recorded in boot-state.json now and in session.json at the quit, since
 * the process keeps running.
 */
export function noteMainWindowClosed(now = Date.now()): void {
  if (ctx.succeeded || ctx.mode !== 'normal') return;
  judgeQuitLike(now, false);
}

/** The app is quitting. Judge the start if it has not been judged yet. */
export function noteQuitting(now = Date.now()): void {
  if (ctx.succeeded) {
    // Judged failed earlier while the process kept running (macOS window close).
    if (ctx.deferredStartFailure) sendStartFailed(ctx.deferredStartFailure);
    return;
  }
  if (ctx.mode !== 'normal') {
    ctx.state = markNeutral(ctx.state);
    persist();
    return;
  }
  judgeQuitLike(now, true);
}

function judgeQuitLike(now: number, quitting: boolean): void {
  if (ctx.killedTimer) clearTimeout(ctx.killedTimer);
  ctx.killedTimer = null;
  const verdict = quitVerdict({ succeeded: ctx.succeeded, readyAt: ctx.readyAt, startedAt: ctx.startedAt, now });
  if (verdict === 'success') {
    succeed();
    return;
  }
  if (verdict === 'failure') {
    ctx.state = markFailure(ctx.state, 'renderer_never_ready', { appVersion: ctx.appVersion, now });
    ctx.succeeded = true; // judged; nothing later may re-judge it
    persist();
    log(`${quitting ? 'quit' : 'main window closed'} before the window came up; counted as a failed start`);
    if (!ctx.persistent) return;
    if (quitting) sendStartFailed('renderer_never_ready');
    else ctx.deferredStartFailure = 'renderer_never_ready';
    return;
  }
  ctx.state = markNeutral(ctx.state);
  ctx.succeeded = true;
  persist();
}

/** This launch is handing over to an update (or another exit that says nothing about the start). */
export function noteNeutralExit(): void {
  if (ctx.succeeded) return;
  if (ctx.successTimer) clearTimeout(ctx.successTimer);
  ctx.successTimer = null;
  if (ctx.killedTimer) clearTimeout(ctx.killedTimer);
  ctx.killedTimer = null;
  ctx.state = markNeutral(ctx.state);
  ctx.succeeded = true; // judged; the quit that follows must not count it
  persist();
}

/** "Try normal start" from the safe-mode screen. */
export function requestNormalStartNext(): void {
  ctx.state = requestNormalStart(ctx.state);
  persist();
}

/** The unreported safe-mode entry (consumed). Normal starts send it once analytics is up. */
export function takeSafeModeReport(): BootState['report'] {
  const r = takeReport(ctx.state);
  if (!r.report) return null;
  ctx.state = r.state;
  persist();
  return r.report;
}

/** TEST-ONLY. */
export function _resetBootContextForTests(): void {
  if (ctx.successTimer) clearTimeout(ctx.successTimer);
  if (ctx.killedTimer) clearTimeout(ctx.killedTimer);
  Object.assign(ctx, {
    file: null,
    persistent: false,
    appVersion: '0.0.0',
    state: freshBootState(),
    mode: 'normal',
    reason: null,
    succeeded: false,
    startedAt: 0,
    readyAt: null,
    successTimer: null,
    getMainWindow: () => null,
    getSafeWindow: () => null,
    enterSafeMode: null,
    relaunch: null,
    onSuccess: [],
    osShutdown: false,
    killedTimer: null,
    startFailedHooks: [],
    startFailedFallback: null,
    startFailedSent: false,
    deferredStartFailure: null,
  } satisfies Ctx);
}

/** TEST-ONLY: current in-memory state. */
export function _bootStateForTests(): BootState {
  return ctx.state;
}
