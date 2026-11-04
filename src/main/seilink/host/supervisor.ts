/**
 * SeiLink room host supervisor (261104), main side. Spawns the host process,
 * reads its pipe, restarts it when it dies or hangs. Ported from the spike's
 * supervisor.js (exp/seilink-spike), whose numbers it keeps:
 *
 * - Restart on host exit, or when no heartbeat came for `hbTimeoutMs`
 *   (3 s; the host beats every second, the spike detected a wedged host in
 *   about 2.6 s).
 * - Backoff 0, 0.5, 1, 2, 4, 8, max 10 s. The first restart is immediate
 *   because the commonest cause (Explorer restarting on Windows) wants the
 *   host back as soon as the shell is. The streak resets once a host has
 *   stayed up for `stableMs` (20 s).
 * - Gives up after `maxFailures` restarts in a row whose host never got
 *   attached (a broken install, an addon that cannot load): the status goes
 *   to failed instead of spinning forever.
 *
 * Process handling is injected (`spawn`, `kill`) so the restart policy is
 * unit-tested without Electron (supervisor.test.ts).
 */
import { EventEmitter } from 'node:events';
import type { FromHost } from './protocol';

export const HOST_STABLE_MS = 20_000;
export const HOST_HEARTBEAT_TIMEOUT_MS = 3_000;
export const HOST_MAX_FAILURES = 6;
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
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (t: unknown) => void;
  hbTimeoutMs?: number;
  helloTimeoutMs?: number;
  stableMs?: number;
  maxFailures?: number;
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
 * 'hung' ({n, gapMs}), 'gave-up' ({reason}).
 */
export class HostSupervisor extends EventEmitter {
  private cur: Current | null = null;
  private n = 0;
  private streak = 0;
  /** Restarts in a row whose host never attached. */
  private failures = 0;
  private lastHb = 0;
  private stopped = true;
  private pendingRestart: unknown = null;
  private watchdog: unknown = null;
  private readonly d: Required<Omit<SupervisorDeps, 'log'>> & { log: (line: string) => void };

  constructor(deps: SupervisorDeps) {
    super();
    this.d = {
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (t) => clearInterval(t as ReturnType<typeof setInterval>),
      hbTimeoutMs: HOST_HEARTBEAT_TIMEOUT_MS,
      helloTimeoutMs: HOST_HELLO_TIMEOUT_MS,
      stableMs: HOST_STABLE_MS,
      maxFailures: HOST_MAX_FAILURES,
      log: () => {},
      ...deps,
    } as SupervisorDeps & Required<Omit<SupervisorDeps, 'log'>> & { log: (line: string) => void };
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
    this.failures = 0;
    this.watchdog = this.d.setInterval(() => this.checkHeartbeat(), 250);
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

  /** A message from the live host's connection (after acceptHello). */
  onHostMessage(pid: number, m: FromHost): void {
    const cur = this.cur;
    if (!cur || cur.exited || cur.child.pid !== pid) return;
    if (m.type === 'heartbeat') this.lastHb = this.d.now();
    if (m.type === 'attached') {
      cur.attached = true;
      this.failures = 0;
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
      this.failures++;
      this.emit('spawn-failed', { n });
      this.scheduleRestart('spawn-failed', this.d.now());
      return;
    }
    const cur: Current = { n, child, spawnedAt: this.d.now(), helloAt: null, attached: false, exited: false };
    this.cur = cur;
    this.lastHb = 0;
    this.d.log(`seilink host ${n}: spawned pid ${child.pid} (${cause})`);
    this.emit('spawn', { n, pid: child.pid, cause });
    child.onExit((code, signal) => {
      cur.exited = true;
      this.emit('exit', { n, code, signal });
      if (this.cur !== cur) return;
      this.cur = null;
      if (!cur.attached) this.failures++;
      this.d.log(`seilink host ${n}: exited (${code ?? signal})`);
      this.scheduleRestart(`exit ${code ?? signal}`, cur.spawnedAt);
    });
  }

  private scheduleRestart(reason: string, spawnedAt: number): void {
    if (this.stopped || this.pendingRestart !== null) return;
    if (this.failures >= this.d.maxFailures) {
      this.d.log(`seilink host: giving up after ${this.failures} failed starts (${reason})`);
      this.emit('gave-up', { reason });
      this.stop();
      return;
    }
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
    const cur = this.cur;
    if (!cur || cur.exited) return;
    if (cur.helloAt === null) {
      // Not connected yet: the exit handler covers a host that dies on the way up; this one
      // covers a host that wedged before it could.
      if (this.d.now() - cur.spawnedAt > this.d.helloTimeoutMs) {
        this.d.log(`seilink host ${cur.n}: no hello after ${this.d.helloTimeoutMs} ms, killing it`);
        cur.helloAt = -1;
        this.emit('hung', { n: cur.n, gapMs: this.d.now() - cur.spawnedAt });
        this.safeKill(cur.child.pid);
      }
      return;
    }
    if (!this.lastHb) return;
    const gap = this.d.now() - this.lastHb;
    if (gap > this.d.hbTimeoutMs) {
      this.d.log(`seilink host ${cur.n}: no heartbeat for ${gap} ms, killing it`);
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
