/**
 * SeiLink host telemetry (261105), main side, pure. Shape only: enums,
 * counts, durations, buckets. No paths, no text, no window titles.
 *
 *  - ShownWatchdog: did the wallpaper actually show? `seilink_shown` at the
 *    first verified, uncovered frame of a session; `seilink_not_shown` with a
 *    reason when none came within SHOWN_DEADLINE_MS (then `seilink_shown`
 *    still fires later, with `late: true`, if it ever does show).
 *  - HealthSampler: fps percentiles while visible, % of time visible /
 *    covered / paused / detached, heartbeat gaps, host memory, a dropped
 *    frame estimate, from the host's 1 s heartbeats. A window view for the
 *    periodic `seilink_health` and a whole-session view for `seilink_ended`.
 *  - reattachCause: why the host attached again (Explorer restart, display
 *    change, WorkerW lost, a host restart...), from the host's reason string.
 *  - Counters: per-session counts (clicks, pokes, idle lines, power events,
 *    re-attaches, verify failures), flattened into the end and health events.
 *
 * Event table and questions: docs/agents/seilink-analytics.md.
 */
import type { SeilinkHostFailure } from '../../../shared/seilinkHost';

/** No verified frame this long after a session opened = seilink_not_shown. */
export const SHOWN_DEADLINE_MS = 20_000;
/** seilink_health cadence (at most one per window per session). */
export const HEALTH_INTERVAL_MS = 30 * 60_000;
/** A heartbeat gap longer than this counts as a miss (the host beats every 1 s). */
export const HEARTBEAT_GAP_MS = 2_500;
/** At most this many seilink_reattached events per cause per session; the rest are counts only. */
export const REATTACH_EVENTS_PER_CAUSE = 3;

// ── Small shapes ────────────────────────────────────────────────────────────

/** How she is attached: Windows layered child of Progman (24H2 raised), child of the WorkerW (classic), mac desktop level. */
export type AttachMode = 'progman' | 'workerw' | 'mac_desktop_level' | 'fake' | 'other';

export function attachMode(layout: unknown): AttachMode {
  const l = String(layout ?? '');
  if (l === 'raised') return 'progman';
  if (l === 'classic') return 'workerw';
  if (l.startsWith('mac')) return 'mac_desktop_level';
  if (l === 'fake') return 'fake';
  return 'other';
}

/** Primary display resolution bucket, by its PHYSICAL pixel height (short side for portrait). */
export function resolutionBucket(widthPx: unknown, heightPx: unknown): string {
  const w = Number(widthPx);
  const h = Number(heightPx);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return 'unknown';
  const short = Math.min(w, h);
  if (short < 900) return 'lt_900p';
  if (short < 1200) return '1080p';
  if (short < 1600) return '1440p';
  if (short < 2100) return '1800p';
  if (short < 2900) return '4k';
  return 'gt_4k';
}

/** Scale factor rounded to 0.25 (1, 1.25, 1.5, 2...). */
export function scaleBucket(scale: unknown): number | null {
  const s = Number(scale);
  if (!Number.isFinite(s) || s <= 0) return null;
  return Math.round(s * 4) / 4;
}

/** Host process memory (all its processes), MB. */
export function memoryBucket(mb: unknown): string {
  const m = Number(mb);
  if (!Number.isFinite(m) || m <= 0) return 'unknown';
  if (m < 150) return 'lt_150';
  if (m < 300) return '150_300';
  if (m < 500) return '300_500';
  if (m < 800) return '500_800';
  if (m < 1200) return '800_1200';
  return 'gt_1200';
}

/** Chromium's gpu_compositing feature status -> on / off. */
export function gpuState(compositing: unknown): 'on' | 'off' | 'unknown' {
  const s = String(compositing ?? '');
  if (!s) return 'unknown';
  if (s.startsWith('enabled')) return 'on';
  if (s.includes('disabled') || s.includes('unavailable') || s.includes('software')) return 'off';
  return 'unknown';
}

/** The host's validate() reasons (closed set from win.cc / hostEntry), anything else is 'other'. */
const VERIFY_REASONS = new Set([
  'no-progman',
  'no-defview',
  'own-window-gone',
  'parent-not-progman',
  'not-directly-below-defview',
  'no-workerw',
  'workerw-not-bottom',
  'parent-not-wallpaper-workerw',
  'size-mismatch',
  'hidden',
  'not-visible',
  'level-mismatch',
]);

export function verifyReasonList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const r of raw) out.add(VERIFY_REASONS.has(String(r)) ? String(r).replace(/-/g, '_') : 'other');
  return [...out].sort();
}

// ── Re-attach cause ─────────────────────────────────────────────────────────

export type ReattachCause =
  | 'explorer_restart'
  | 'display_change'
  | 'session_change'
  | 'resume'
  | 'periodic_check'
  | 'window_lost'
  | 'host_restart'
  | 'other';

export type ReattachDetail =
  | 'workerw_lost'
  | 'parent_lost'
  | 'z_order'
  | 'size_mismatch'
  | 'level_drift'
  | 'window_gone'
  | 'host_crash'
  | 'host_hung'
  | 'host_recycled'
  | 'other';

/**
 * hostEntry's attach reasons: 'window-closed', 'own-window-gone',
 * `validate:<trigger>[+1500]:<reasons joined by +>` and (mac)
 * `validate:<trigger>:level`. Triggers: timer, session, taskbarCreated,
 * displayChange, settingChange, display, resume.
 */
export function reattachCause(reason: unknown): { cause: ReattachCause; detail: ReattachDetail } {
  const r = String(reason ?? '');
  if (r === 'window-closed' || r === 'own-window-gone') return { cause: 'window_lost', detail: 'window_gone' };
  if (!r.startsWith('validate:')) return { cause: 'other', detail: 'other' };
  const [, triggerRaw = '', what = ''] = r.split(':');
  const trigger = triggerRaw.split('+')[0];
  const cause: ReattachCause =
    trigger === 'taskbarCreated'
      ? 'explorer_restart'
      : trigger === 'displayChange' || trigger === 'settingChange' || trigger === 'display'
        ? 'display_change'
        : trigger === 'session'
          ? 'session_change'
          : trigger === 'resume'
            ? 'resume'
            : trigger === 'timer'
              ? 'periodic_check'
              : 'other';
  const parts = what.split('+');
  const detail: ReattachDetail =
    what === 'level'
      ? 'level_drift'
      : parts.some((p) => p === 'no-workerw' || p === 'parent-not-wallpaper-workerw' || p === 'workerw-not-bottom')
        ? 'workerw_lost'
        : parts.includes('parent-not-progman')
          ? 'parent_lost'
          : parts.includes('not-directly-below-defview')
            ? 'z_order'
            : parts.includes('size-mismatch')
              ? 'size_mismatch'
              : 'other';
  return { cause, detail };
}

// ── Counters ────────────────────────────────────────────────────────────────

/** Named per-session counts. Keys are snake_case and flattened as props as is. */
export class Counters {
  private m = new Map<string, number>();

  add(key: string, n = 1): void {
    if (!/^[a-z][a-z0-9_]*$/.test(key)) return;
    this.m.set(key, (this.m.get(key) ?? 0) + n);
  }

  get(key: string): number {
    return this.m.get(key) ?? 0;
  }

  /** The counts as props (only the non-zero ones). */
  props(): Record<string, number> {
    return Object.fromEntries([...this.m.entries()].filter(([, v]) => v !== 0));
  }

  /** The difference since `since` (for a health window). */
  diff(since: Map<string, number>): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of this.m) {
      const d = v - (since.get(k) ?? 0);
      if (d) out[k] = d;
    }
    return out;
  }

  snapshot(): Map<string, number> {
    return new Map(this.m);
  }
}

// ── Shown watchdog ──────────────────────────────────────────────────────────

export type NotShownReason =
  /** The host never connected (spawn or boot trouble). */
  | 'no_hello'
  /** Connected, but no attach and no attach failure (stuck waiting for the shell, or creating its window). */
  | 'no_attach'
  /** Every attach failed so far (see failure_class). */
  | 'attach_failed'
  /** Attached, but the page never drew a frame. */
  | 'no_frame'
  /** A frame, but the room window is hidden. */
  | 'window_hidden'
  /** A frame, but the attach did not verify (wrong parent, level, size). */
  | 'not_verified'
  /** Drawn and attached, but covered by windows the whole time. */
  | 'wallpaper_occluded_at_start'
  /** Drawn and attached, but the screen was locked or the machine asleep. */
  | 'paused_at_start';

export interface FrameReport {
  verified: boolean;
  hidden: boolean;
  covered: boolean;
  paused: boolean;
  reasons: string[];
}

export interface WatchdogEmit {
  event: 'seilink_shown' | 'seilink_not_shown';
  props: Record<string, string | number | boolean | null>;
}

/**
 * One per session. Feed it what the host says; it returns an event to send
 * (at most one seilink_shown and one seilink_not_shown per session).
 */
export class ShownWatchdog {
  private helloAt: number | null = null;
  private attachedAt: number | null = null;
  private attachMs = 0;
  private mode: AttachMode = 'other';
  private failure: SeilinkHostFailure | null = null;
  private frame: FrameReport | null = null;
  private shownAt: number | null = null;
  private notShownSent = false;
  private coveredAtStart = false;
  private pausedAtStart = false;

  constructor(
    private readonly openedAt: number,
    private readonly deadlineMs = SHOWN_DEADLINE_MS,
  ) {}

  get shown(): boolean {
    return this.shownAt !== null;
  }

  /** ms from session open to the verified frame, or null. */
  get firstFrameMs(): number | null {
    return this.shownAt === null ? null : this.shownAt - this.openedAt;
  }

  get late(): boolean {
    return this.notShownSent;
  }

  hello(now: number): void {
    this.helloAt ??= now;
  }

  attached(now: number, layout: unknown, attachMs: unknown): void {
    this.attachedAt = now;
    this.attachMs = Math.round(Number(attachMs) || 0);
    this.mode = attachMode(layout);
    this.failure = null;
  }

  attachFailed(failure: SeilinkHostFailure): void {
    if (this.attachedAt === null) this.failure = failure;
  }

  /** The host lost the attach (restart, recover): a later frame must come from a new attach. */
  detached(): void {
    this.attachedAt = null;
    this.frame = null;
  }

  /** The host drew its first frame after an attach, with what it verified. */
  onFrame(now: number, f: FrameReport): WatchdogEmit | null {
    this.frame = f;
    if (this.shownAt !== null) return null;
    if (f.covered && f.verified && !f.hidden) this.coveredAtStart = true;
    if (f.paused && f.verified && !f.hidden) this.pausedAtStart = true;
    return this.maybeShown(now);
  }

  /** Coverage changed (activity / heartbeat): an uncovered verified frame shows her. */
  onActivity(now: number, a: { covered: boolean; paused: boolean }): WatchdogEmit | null {
    if (!this.frame || this.shownAt !== null) return null;
    this.frame = { ...this.frame, covered: a.covered, paused: a.paused };
    return this.maybeShown(now);
  }

  private maybeShown(now: number): WatchdogEmit | null {
    const f = this.frame;
    if (!f || this.attachedAt === null || !f.verified || f.hidden || f.covered || f.paused) return null;
    this.shownAt = now;
    return {
      event: 'seilink_shown',
      props: {
        first_frame_ms: now - this.openedAt,
        attach_ms: this.attachMs,
        attach_mode: this.mode,
        late: this.notShownSent,
        covered_at_start: this.coveredAtStart,
        paused_at_start: this.pausedAtStart,
      },
    };
  }

  /** Watchdog tick: past the deadline with nothing shown = seilink_not_shown (once). */
  tick(now: number): WatchdogEmit | null {
    if (this.shownAt !== null || this.notShownSent || now - this.openedAt < this.deadlineMs) return null;
    this.notShownSent = true;
    return { event: 'seilink_not_shown', props: { reason: this.reason(), waited_ms: now - this.openedAt, ...this.detail() } };
  }

  reason(): NotShownReason {
    const f = this.frame;
    if (this.attachedAt !== null && f) {
      if (f.hidden) return 'window_hidden';
      if (!f.verified) return 'not_verified';
      if (f.covered) return 'wallpaper_occluded_at_start';
      if (f.paused) return 'paused_at_start';
    }
    if (this.attachedAt !== null) return 'no_frame';
    if (this.failure) return 'attach_failed';
    if (this.helloAt === null) return 'no_hello';
    return 'no_attach';
  }

  private detail(): Record<string, string | number | boolean | null> {
    const out: Record<string, string | number | boolean | null> = {};
    if (this.failure) out.failure_class = this.failure;
    if (this.attachedAt !== null) out.attach_mode = this.mode;
    if (this.frame?.reasons.length) out.verify_reasons = this.frame.reasons.join('+');
    return out;
  }
}

// ── Health ──────────────────────────────────────────────────────────────────

export interface HeartbeatSample {
  /** Frame cap the host is at (0 = still). */
  fps: number;
  /** Frames actually drawn in the last second. */
  effectiveFps: number;
  covered: boolean;
  paused: boolean;
  attached: boolean;
  cpu: number;
  ramMB: number;
}

const FPS_BINS = 121;

class HealthWindow {
  start: number;
  visibleMs = 0;
  coveredMs = 0;
  pausedMs = 0;
  detachedMs = 0;
  gaps = 0;
  /** fps histogram while visible (one sample per heartbeat). */
  bins = new Array<number>(FPS_BINS).fill(0);
  samples = 0;
  dropped = 0;
  ramMax = 0;
  cpuSum = 0;
  cpuN = 0;

  constructor(now: number) {
    this.start = now;
  }
}

/** p in 0..100 over a histogram of integer fps values; null with no samples. */
export function histPercentile(bins: number[], p: number): number | null {
  const total = bins.reduce((a, b) => a + b, 0);
  if (!total) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * total));
  let seen = 0;
  for (let i = 0; i < bins.length; i++) {
    seen += bins[i];
    if (seen >= rank) return i;
  }
  return bins.length - 1;
}

/**
 * Health from heartbeats. `heartbeat(now, hb)` per host heartbeat; `suspend()`
 * so a sleep is not counted as a heartbeat miss. The time between two beats is
 * booked to the state the earlier beat reported (capped at 5 s, so a long gap
 * is not booked to anything but counted as a miss).
 */
export class HealthSampler {
  private session: HealthWindow;
  private window: HealthWindow;
  private last: { t: number; hb: HeartbeatSample } | null = null;
  private suspended = false;

  constructor(now: number) {
    this.session = new HealthWindow(now);
    this.window = new HealthWindow(now);
  }

  /** The host process went away (restart): the next beat starts a new run, the gap is not a miss. */
  hostGone(): void {
    this.last = null;
  }

  suspend(): void {
    this.suspended = true;
    this.last = null;
  }

  resume(): void {
    this.suspended = false;
    this.last = null;
  }

  heartbeat(now: number, hb: HeartbeatSample): void {
    if (this.suspended) return;
    const prev = this.last;
    this.last = { t: now, hb };
    if (!prev) return;
    const gap = now - prev.t;
    for (const w of [this.session, this.window]) {
      if (gap > HEARTBEAT_GAP_MS) w.gaps++;
      const dt = Math.min(gap, 5_000);
      const p = prev.hb;
      if (!p.attached) w.detachedMs += dt;
      else if (p.paused) w.pausedMs += dt;
      else if (p.covered) w.coveredMs += dt;
      else w.visibleMs += dt;
      const ram = Number(hb.ramMB) || 0;
      if (ram > w.ramMax) w.ramMax = ram;
      // fps only counts when both beats saw her visible: the second measured a whole visible second.
      const visible = (s: HeartbeatSample): boolean => s.attached && !s.covered && !s.paused && s.fps > 0;
      if (visible(p) && visible(hb)) {
        const eff = Math.max(0, Math.min(FPS_BINS - 1, Math.round(Number(hb.effectiveFps) || 0)));
        w.bins[eff]++;
        w.samples++;
        w.dropped += Math.max(0, hb.fps - eff) * (dt / 1000);
        w.cpuSum += Number(hb.cpu) || 0;
        w.cpuN++;
      }
    }
  }

  /** The whole session so far. */
  sessionProps(now: number): Record<string, number | string | null> {
    return props(this.session, now);
  }

  /** The window since the last call, then a new window starts. */
  takeWindow(now: number): Record<string, number | string | null> {
    const out = props(this.window, now);
    this.window = new HealthWindow(now);
    return out;
  }
}

function pct(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 1000) / 10 : 0;
}

function props(w: HealthWindow, now: number): Record<string, number | string | null> {
  const booked = w.visibleMs + w.coveredMs + w.pausedMs + w.detachedMs;
  return {
    window_ms: Math.max(0, now - w.start),
    fps_p50: histPercentile(w.bins, 50),
    fps_p95: histPercentile(w.bins, 95),
    fps_p5: histPercentile(w.bins, 5),
    fps_samples: w.samples,
    visible_pct: pct(w.visibleMs, booked),
    covered_pct: pct(w.coveredMs, booked),
    paused_pct: pct(w.pausedMs, booked),
    detached_pct: pct(w.detachedMs, booked),
    heartbeat_misses: w.gaps,
    mem_mb_max: Math.round(w.ramMax / 10) * 10,
    mem_bucket: memoryBucket(w.ramMax),
    dropped_frames_est: Math.round(w.dropped),
    cpu_avg: w.cpuN ? Math.round((w.cpuSum / w.cpuN) * 10) / 10 : null,
  };
}
