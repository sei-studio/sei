/**
 * SeiLink room host supervisor (261104), main side. Spawns the host process,
 * reads its pipe, restarts it when it dies or hangs. Ported from the spike's
 * supervisor.js (exp/seilink-spike), whose numbers it keeps:
 *
 * - Restart on host exit, or when nothing came from the host for
 *   `hbTimeoutMs` (3 s; the spike detected a wedged host in about 2.6 s).
 *   Liveness is any line from the host: its own 1 s heartbeat, and the
 *   `pong` it sends back for main's 1 s `ping`. The pong is the robust one:
 *   it is answered from the pipe read in the host's main process, so App Nap
 *   stretching the host's timers (a covered wallpaper on macOS) does not
 *   stop it. While the host says it is covered or paused the limit is
 *   `pausedHbTimeoutMs` (15 s) anyway.
 * - Sleep: nothing is judged between suspend and resume, and resume or
 *   unlock gives `resumeGraceMs` (15 s) before a silent host counts as hung.
 *   A watchdog tick that comes far too late (main itself was stopped: sleep
 *   without a suspend event, App Nap of main, a stall) gives the same grace.
 * - Backoff 0, 0.5, 1, 2, 4, 8, max 10 s. The first restart is immediate
 *   because the commonest cause (Explorer restarting on Windows) wants the
 *   host back as soon as the shell is. The streak resets once a host has
 *   stayed up for `stableMs` (20 s).
 * - Gives up after `maxRestarts` restarts within `restartWindowMs` (5 in
 *   10 min), attached or not: a broken install, an addon that cannot load,
 *   or a host that attaches and then crashes every time. The status goes to
 *   failed instead of spinning forever. Only a new start() (a user move-in,
 *   an app restart) begins a new count.
 *
 * Process handling is injected (`spawn`, `kill`) so the restart policy is
 * unit-tested without Electron (supervisor.test.ts).
 */
import { EventEmitter } from 'node:events';
import type { FromHost } from './protocol';

export const HOST_STABLE_MS = 20_000;
export const HOST_HEARTBEAT_TIMEOUT_MS = 3_000;
/** Give up after this many restarts within HOST_RESTART_WINDOW_MS. */
export const HOST_MAX_RESTARTS = 5;
export const HOST_RESTART_WINDOW_MS = 10 * 60_000;
/** The limit while the host reports covered or paused (App Nap may throttle it then). */
export const HOST_PAUSED_HEARTBEAT_TIMEOUT_MS = 15_000;
/** After resume, unlock or a stall of main: no host is judged hung for this long. */
export const HOST_RESUME_GRACE_MS = 15_000;
export const HOST_PING_MS = 1_000;
const WATCHDOG_MS = 250;
/** A watchdog tick this late means main's own timers were stopped (sleep, App Nap, a stall). */
const WATCHDOG_STALL_MS = 2_000;
/** A host that never says hello (wedged before its pipe connected) is killed after this. */
export const HOST_HELLO_TIMEOUT_MS = 20_000;

/** Delay before restart number `streak` (0-based): 0, 500, 1000, 2000, ... 10000. */
export function hostBackoffMs(streak: number): number {
  return streak <= 0 ? 0 : Math.min(500 * 2 ** (streak - 1), 10_000);
}

export interface HostChild {
  pid: number;
  /** Resolves once with the exit (code or signal). */
  onExit(cb: (code: number | null, signal: string | null) => void): void;
}

export interface SupervisorDeps {
  spawn(n: number): HostChild;
  kill(pid: number): void;
  /** Send `ping` to the live host (it answers `pong`). */
  ping?(pid: number, seq: number): void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (t: unknown) => void;
  hbTimeoutMs?: number;
  pausedHbTimeoutMs?: number;
  resumeGraceMs?: number;
  pingMs?: number;
  helloTimeoutMs?: number;
  stableMs?: number;
  maxRestarts?: number;
  restartWindowMs?: number;
  log?: (line: string) => void;
}

interface Current {
  n: number;
  child: HostChild;
  spawnedAt: number;
  helloAt: number | null;
  attached: boolean;
  exited: boolean;
}

/**
 * Events: 'message' (FromHost, from the live host only), 'spawn' ({n, pid}),
 * 'exit' ({n, code, signal}), 'restart' ({reason, delay, streak}),
 * 'hung' ({n, gapMs}), 'gave-up' ({reason, restarts, everAttached}).
 */
export class HostSupervisor extends EventEmitter {
  private cur: Current | null = null;
  private n = 0;
  private streak = 0;
  /** When each restart of this run was scheduled (pruned to the window). */
  private restartTimes: number[] = [];
  /** Some host of this run attached. */
  private everAttached = false;
  /** Last line from the live host (0: none expected, e.g. it was just killed). */
  private lastHb = 0;
  /** Its last heartbeat said covered or paused. */
  private hostIdle = false;
  /** No host is judged hung before this (resume, unlock, a stall of main). */
  private graceUntil = 0;
  private suspended = false;
  private lastTick = 0;
  private lastPing = 0;
  private pingSeq = 0;
  private stopped = true;
  private pendingRestart: unknown = null;
  private watchdog: unknown = null;
  private readonly d: Required<Omit<SupervisorDeps, 'log' | 'ping'>> & Pick<SupervisorDeps, 'ping'> & { log: (line: string) => void };

  constructor(deps: SupervisorDeps) {
    super();
    this.d = {
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (t) => clearInterval(t as ReturnType<typeof setInterval>),
      hbTimeoutMs: HOST_HEARTBEAT_TIMEOUT_MS,
      pausedHbTimeoutMs: HOST_PAUSED_HEARTBEAT_TIMEOUT_MS,
      resumeGraceMs: HOST_RESUME_GRACE_MS,
      pingMs: HOST_PING_MS,
      helloTimeoutMs: HOST_HELLO_TIMEOUT_MS,
      stableMs: HOST_STABLE_MS,
      maxRestarts: HOST_MAX_RESTARTS,
      restartWindowMs: HOST_RESTART_WINDOW_MS,
      log: () => {},
      ...deps,
    } as SupervisorDeps & Required<Omit<SupervisorDeps, 'log' | 'ping'>> & { log: (line: string) => void };
  }

  get running(): boolean {
    return !this.stopped;
  }

  get pid(): number | null {
    return this.cur && !this.cur.exited ? this.cur.child.pid : null;
  }

  get restartStreak(): number {
    return this.streak;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.streak = 0;
    this.restartTimes = [];
    this.everAttached = false;
    this.graceUntil = 0;
    this.suspended = false;
    this.lastTick = this.d.now();
    this.watchdog = this.d.setInterval(() => this.checkHeartbeat(), WATCHDOG_MS);
    this.spawn('initial');
  }

  /**
   * Stop supervising: no more restarts. Kills the live host unless `kill` is false (main sends
   * it `quit` first and kills it itself if it lingers; see seilinkHost.ts). Returns the live
   * host's pid, or null.
   */
  stop(opts?: { kill?: boolean }): number | null {
    if (this.stopped) return null;
    this.stopped = true;
    if (this.pendingRestart !== null) this.d.clearTimer(this.pendingRestart);
    this.pendingRestart = null;
    if (this.watchdog !== null) this.d.clearInterval(this.watchdog);
    this.watchdog = null;
    const cur = this.cur;
    this.cur = null;
    const live = cur && !cur.exited ? cur.child.pid : null;
    if (live !== null && opts?.kill !== false) this.safeKill(live);
    return live;
  }

  /** The pid that said hello on a connection: is it the live host? */
  acceptHello(pid: number): boolean {
    const cur = this.cur;
    if (!cur || cur.exited || cur.child.pid !== pid) return false;
    cur.helloAt = this.d.now();
    this.lastHb = this.d.now();
    return true;
  }

  /** The machine is going to sleep: judge nothing until it resumes. */
  noteSuspend(): void {
    this.suspended = true;
  }

  /** Resume from sleep or a screen unlock: the gap is not a hang; give the host a grace period. */
  noteResume(why = 'resume'): void {
    this.suspended = false;
    this.grace(why);
  }

  private grace(why: string): void {
    if (this.stopped) return;
    this.graceUntil = this.d.now() + this.d.resumeGraceMs;
    this.d.log(`seilink host: ${why}, no hang check for ${this.d.resumeGraceMs} ms`);
  }

  /** A message from the live host's connection (after acceptHello). */
  onHostMessage(pid: number, m: FromHost): void {
    const cur = this.cur;
    if (!cur || cur.exited || cur.child.pid !== pid) return;
    // Any line proves the host's main process is running (a heartbeat, a pong, a click...).
    if (this.lastHb !== 0) this.lastHb = this.d.now();
    if (m.type === 'heartbeat') this.hostIdle = m.covered === true || m.paused === true;
    if (m.type === 'pong') return;
    // Attaching does NOT reset the restart count: a host that attaches and then crashes every
    // time would otherwise restart forever (about every 10 s at the backoff cap).
    if (m.type === 'attached') {
      cur.attached = true;
      this.everAttached = true;
    }
    this.emit('message', m);
  }

  /** Kill the live host and let the restart policy bring a new one (e.g. it reported attach-failed). */
  recycle(reason: string): void {
    const cur = this.cur;
    if (!cur || cur.exited) return;
    this.d.log(`seilink host ${cur.n}: recycle (${reason})`);
    this.safeKill(cur.child.pid);
  }

  private spawn(cause: string): void {
    if (this.stopped) return;
    const n = ++this.n;
    let child: HostChild;
    try {
      child = this.d.spawn(n);
    } catch (err) {
      this.d.log(`seilink host ${n}: spawn failed (${(err as Error).message})`);
      this.emit('spawn-failed', { n });
      this.scheduleRestart('spawn-failed', this.d.now());
      return;
    }
    const cur: Current = { n, child, spawnedAt: this.d.now(), helloAt: null, attached: false, exited: false };
    this.cur = cur;
    this.lastHb = 0;
    this.hostIdle = false;
    this.d.log(`seilink host ${n}: spawned pid ${child.pid} (${cause})`);
    this.emit('spawn', { n, pid: child.pid, cause });
    child.onExit((code, signal) => {
      cur.exited = true;
      this.emit('exit', { n, code, signal });
      if (this.cur !== cur) return;
      this.cur = null;
      this.d.log(`seilink host ${n}: exited (${code ?? signal})`);
      this.scheduleRestart(`exit ${code ?? signal}`, cur.spawnedAt);
    });
  }

  private scheduleRestart(reason: string, spawnedAt: number): void {
    if (this.stopped || this.pendingRestart !== null) return;
    const now = this.d.now();
    this.restartTimes = this.restartTimes.filter((t) => now - t < this.d.restartWindowMs);
    if (this.restartTimes.length >= this.d.maxRestarts) {
      const restarts = this.restartTimes.length;
      this.d.log(`seilink host: giving up after ${restarts} restarts in ${Math.round(this.d.restartWindowMs / 60_000)} min (${reason})`);
      this.emit('gave-up', { reason, restarts, everAttached: this.everAttached });
      this.stop();
      return;
    }
    this.restartTimes.push(now);
    if (this.d.now() - spawnedAt > this.d.stableMs) this.streak = 0;
    const delay = hostBackoffMs(this.streak);
    this.streak++;
    this.emit('restart', { reason, delay, streak: this.streak });
    this.pendingRestart = this.d.setTimer(() => {
      this.pendingRestart = null;
      this.spawn(reason);
    }, delay);
  }

  private checkHeartbeat(): void {
    const now = this.d.now();
    const sinceTick = now - this.lastTick;
    this.lastTick = now;
    // Main's own timers were stopped: the host had no chance to be heard either.
    if (sinceTick > WATCHDOG_STALL_MS) this.grace(`watchdog tick ${sinceTick} ms apart`);
    if (this.suspended) return;
    const cur = this.cur;
    if (!cur || cur.exited) return;
    if (cur.helloAt === null) {
      // Not connected yet: the exit handler covers a host that dies on the way up; this one
      // covers a host that wedged before it could.
      if (now - Math.max(cur.spawnedAt, this.graceUntil) > this.d.helloTimeoutMs) {
        this.d.log(`seilink host ${cur.n}: no hello after ${this.d.helloTimeoutMs} ms, killing it`);
        cur.helloAt = -1;
        this.emit('hung', { n: cur.n, gapMs: this.d.now() - cur.spawnedAt });
        this.safeKill(cur.child.pid);
      }
      return;
    }
    if (!this.lastHb) return;
    if (cur.helloAt > 0 && this.d.ping && now - this.lastPing >= this.d.pingMs) {
      this.lastPing = now;
      try {
        this.d.ping(cur.child.pid, ++this.pingSeq);
      } catch {
        /* the pipe is going away; the exit handler follows */
      }
    }
    const gap = now - Math.max(this.lastHb, this.graceUntil);
    const limit = this.hostIdle ? this.d.pausedHbTimeoutMs : this.d.hbTimeoutMs;
    if (gap > limit) {
      this.d.log(`seilink host ${cur.n}: nothing heard for ${gap} ms (limit ${limit}), killing it`);
      this.lastHb = 0;
      this.emit('hung', { n: cur.n, gapMs: gap });
      this.safeKill(cur.child.pid);
    }
  }

  private safeKill(pid: number): void {
    try {
      this.d.kill(pid);
    } catch (err) {
      this.d.log(`seilink host: kill ${pid} failed (${(err as Error).message})`);
    }
  }
}
