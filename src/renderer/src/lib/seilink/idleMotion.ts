/**
 * SeiLink idle motion (261104): what her body does in the room while nobody
 * is talking to her. Pure: no DOM, no timers. A driver (RoomAvatar's
 * useIdleMotion) calls `update(now)` once per frame with a clock that only
 * advances while the room is drawing, and applies the returned pose as a
 * transform about her bottom centre.
 *
 * Layers:
 *  - Sway (always, seated or not): slow breathing plus a lean made of
 *    incommensurate sines with random phases, so it never repeats.
 *  - Seat shifts: every so often she settles a little left or right on the
 *    chair (a short eased slide with a lean into it).
 *  - Walk-offs, rarely: stand, walk out of the side of the frame, stay away
 *    10-40 s, walk back in from either side, sit.
 *
 * Event timing is memoryless (exponential gaps) on top of a refractory
 * minimum, so the rhythm cannot be learned: having waited a long time says
 * nothing about when the next one comes. Walk-offs average about one every
 * 15 minutes and never come closer than `walkMinGapMs`.
 *
 * `busy` (she is talking, or the player is interacting) holds her: no new
 * shifts or walk-offs, a walk-off in progress turns round and she comes back
 * to her seat, and the next walk-off is pushed out past `busyHoldMs`.
 *
 * Units: distances in her body heights (the room slot's height), so the pose
 * scales with the room; angles in degrees; time in ms.
 */

export type IdlePhase = 'seated' | 'shifting' | 'standing' | 'walkingOut' | 'away' | 'walkingIn' | 'sitting';

export interface IdlePose {
  /** Horizontal offset from her seat anchor, + right. */
  x: number;
  /** Up from her seated line. Never above `standLift`. */
  lift: number;
  /** Rotation about her bottom centre, + leans right. */
  lean: number;
  /** Uniform scale about her bottom centre (a small step back while up). */
  scale: number;
  /** Vertical breathing scale, about 1. */
  breath: number;
  phase: IdlePhase;
  /** False while she is out of the room. */
  present: boolean;
}

export interface IdleMotionConfig {
  /** Breathing: period and vertical scale amplitude. */
  breathPeriodMs: number;
  breathAmp: number;
  /** Sway lean amplitude (deg) and horizontal drift (heights). */
  swayLeanDeg: number;
  swayDrift: number;
  /** Seat shifts: refractory minimum + exponential mean gap. */
  shiftMinGapMs: number;
  shiftMeanGapMs: number;
  /** How far from the anchor a shift may take her (heights), and a typical step. */
  shiftRange: number;
  shiftStep: number;
  shiftMinMs: number;
  shiftMaxMs: number;
  /** Walk-offs: refractory minimum + exponential mean on top. */
  walkMinGapMs: number;
  walkMeanGapMs: number;
  awayMinMs: number;
  awayMaxMs: number;
  standMs: number;
  sitMs: number;
  /** How high standing lifts her (heights). Keep below the avatar's sink so the cut edge stays hidden. */
  standLift: number;
  /** Scale while up and walking (a step back from the camera). */
  walkScale: number;
  /** Walking speed (heights per second) and step cadence. */
  walkSpeed: number;
  stepHz: number;
  stepBob: number;
  stepLeanDeg: number;
  /** Lean into the direction of travel while walking. */
  travelLeanDeg: number;
  /** After busy ends, no walk-off for at least this long. */
  busyHoldMs: number;
  /** After busy ends, no seat shift for at least this long. */
  busyShiftHoldMs: number;
}

export const DEFAULT_IDLE_CONFIG: IdleMotionConfig = {
  breathPeriodMs: 4_600,
  breathAmp: 0.005,
  swayLeanDeg: 0.7,
  swayDrift: 0.003,
  shiftMinGapMs: 9_000,
  shiftMeanGapMs: 38_000,
  shiftRange: 0.045,
  shiftStep: 0.028,
  shiftMinMs: 1_400,
  shiftMaxMs: 2_300,
  walkMinGapMs: 9 * 60_000,
  walkMeanGapMs: 6 * 60_000,
  awayMinMs: 10_000,
  awayMaxMs: 40_000,
  standMs: 1_100,
  sitMs: 1_300,
  standLift: 0.055,
  walkScale: 0.97,
  walkSpeed: 0.95,
  stepHz: 1.8,
  stepBob: 0.012,
  stepLeanDeg: 0.9,
  travelLeanDeg: 1.3,
  busyHoldMs: 2 * 60_000,
  busyShiftHoldMs: 4_000,
};

/** How far she must go on each side to be fully out of the frame (heights, both positive). */
export interface IdleExits {
  left: number;
  right: number;
}

export interface IdleInput {
  busy: boolean;
  exits: IdleExits;
}

export type Rng = () => number;

/** Exponential sample (memoryless) with the given mean. */
export function expSample(mean: number, rng: Rng): number {
  const u = Math.min(1 - 1e-12, Math.max(0, rng()));
  return -Math.log(1 - u) * mean;
}

/** A gap with a refractory minimum and a memoryless tail. */
export function eventGap(minMs: number, meanExtraMs: number, rng: Rng): number {
  return minMs + expSample(meanExtraMs, rng);
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const smoother = (u: number): number => {
  const t = clamp(u, 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
};

/**
 * Position along a walk with eased ends: accelerate over the first `accel`
 * fraction when `easeIn`, decelerate over the last when `easeOut`, constant
 * speed between. Returns 0..1 of the distance.
 */
export function walkProgress(u: number, easeIn: boolean, easeOut: boolean, accel = 0.22): number {
  const t = clamp(u, 0, 1);
  const a = easeIn ? accel : 0;
  const d = easeOut ? accel : 0;
  // Trapezoid velocity: area = 1 with peak v where v * (1 - a/2 - d/2) = 1.
  const v = 1 / (1 - a / 2 - d / 2);
  if (a > 0 && t < a) return (v * t * t) / (2 * a);
  const atA = (v * a) / 2;
  if (d > 0 && t > 1 - d) {
    const r = 1 - t;
    return 1 - (v * r * r) / (2 * d);
  }
  return atA + v * (t - a);
}

/** Slow seated sway at time t: breathing and lean. Pure of (t, phases). */
export function swayAt(t: number, phases: readonly number[], cfg: IdleMotionConfig): { lean: number; drift: number; breath: number } {
  const TAU = Math.PI * 2;
  // Breath period wanders by about ±10% so it never ticks like a metronome.
  const bPhase = (TAU * t) / cfg.breathPeriodMs + 0.55 * Math.sin((TAU * t) / 29_300 + phases[0]);
  const breath = 1 + cfg.breathAmp * (0.5 - 0.5 * Math.cos(bPhase + phases[1]));
  const lean =
    cfg.swayLeanDeg *
    (0.55 * Math.sin((TAU * t) / 13_700 + phases[2]) +
      0.32 * Math.sin((TAU * t) / 21_300 + phases[3]) +
      0.13 * Math.sin((TAU * t) / 7_900 + phases[4]));
  const drift = cfg.swayDrift * Math.sin((TAU * t) / 17_300 + phases[5]);
  return { lean, drift, breath };
}

interface Segment {
  phase: IdlePhase;
  start: number;
  end: number;
  fromX: number;
  toX: number;
  /** Her pose when the segment began: walks blend out of it, so an interrupted walk never jumps. Null: no blend (she enters unseen). */
  from: IdlePose | null;
  /** Direction of travel for walks and shifts: -1 left, 1 right. */
  dir: -1 | 1;
}

/** Walk segments ease out of the previous pose over this long (a turn, a step phase reset). */
const BLEND_MS = 700;

function lerpPose(a: IdlePose, b: IdlePose, t: number): IdlePose {
  const m = (x: number, y: number): number => x + (y - x) * t;
  return { ...b, x: m(a.x, b.x), lift: m(a.lift, b.lift), lean: m(a.lean, b.lean), scale: m(a.scale, b.scale), breath: m(a.breath, b.breath) };
}

export class IdleScheduler {
  readonly cfg: IdleMotionConfig;
  private readonly rng: Rng;
  private readonly phases: number[];
  private seg: Segment;
  /** Where she sits (heights from the anchor). */
  private seatX = 0;
  private nextShiftAt: number;
  private nextWalkAt: number;
  private wasBusy = false;
  private lastPose: IdlePose;

  constructor(now: number, cfg: Partial<IdleMotionConfig> = {}, rng: Rng = Math.random) {
    this.cfg = { ...DEFAULT_IDLE_CONFIG, ...cfg };
    this.rng = rng;
    this.phases = Array.from({ length: 6 }, () => rng() * Math.PI * 2);
    this.lastPose = { ...REST_POSE };
    this.seg = { phase: 'seated', start: now, end: Infinity, fromX: 0, toX: 0, from: this.lastPose, dir: 1 };
    this.nextShiftAt = now + eventGap(this.cfg.shiftMinGapMs, this.cfg.shiftMeanGapMs, rng);
    this.nextWalkAt = now + eventGap(this.cfg.walkMinGapMs, this.cfg.walkMeanGapMs, rng);
  }

  get phase(): IdlePhase {
    return this.seg.phase;
  }

  /** When the next walk-off is due (for tests and dev readouts). */
  get walkDueAt(): number {
    return this.nextWalkAt;
  }

  get shiftDueAt(): number {
    return this.nextShiftAt;
  }

  /** Dev knob: start a walk-off now if she is seated (or settling). Returns whether it started. */
  forceWalk(now: number, exits: IdleExits, awayMs?: number): boolean {
    if (this.seg.phase !== 'seated' && this.seg.phase !== 'shifting') return false;
    this.beginStand(now, exits, awayMs);
    return true;
  }

  update(now: number, input: IdleInput): IdlePose {
    const { busy, exits } = input;
    const c = this.cfg;
    if (busy) {
      // Hold: nothing new starts, and the next events wait past the hold.
      this.nextWalkAt = Math.max(this.nextWalkAt, now + c.busyHoldMs);
      this.nextShiftAt = Math.max(this.nextShiftAt, now + c.busyShiftHoldMs);
      this.recall(now, exits);
    } else if (this.wasBusy) {
      this.nextShiftAt = Math.max(this.nextShiftAt, now + c.busyShiftHoldMs);
    }
    this.wasBusy = busy;

    // Advance through finished segments (a long gap between frames may skip several).
    for (let guard = 0; guard < 8 && now >= this.seg.end; guard++) this.advance(this.seg.end, exits);

    if (!busy && this.seg.phase === 'seated') {
      if (now >= this.nextWalkAt) this.beginStand(now, exits);
      else if (now >= this.nextShiftAt) this.beginShift(now);
    }

    const pose = this.poseAt(now);
    this.lastPose = pose;
    return pose;
  }

  // ── segments ────────────────────────────────────────────────────────────

  private set(phase: IdlePhase, start: number, dur: number, fromX: number, toX: number, dir: -1 | 1, blend = true): void {
    this.seg = { phase, start, end: start + dur, fromX, toX, from: blend ? this.lastPose : null, dir };
  }

  private awayFor = 0;

  private beginStand(now: number, exits: IdleExits, awayMs?: number): void {
    const c = this.cfg;
    const x = this.lastPose.x;
    // Leave by the nearer side more often, but not always.
    const towardRight = exits.right - x < exits.left + x;
    const dir: -1 | 1 = this.rng() < 0.7 === towardRight ? 1 : -1;
    this.awayFor = awayMs ?? c.awayMinMs + this.rng() * (c.awayMaxMs - c.awayMinMs);
    this.set('standing', now, c.standMs, x, x, dir);
  }

  private beginShift(now: number): void {
    const c = this.cfg;
    const from = this.seatX;
    // A step from where she is, pulled back toward the middle so she never camps at an edge.
    const step = (this.rng() * 2 - 1) * c.shiftStep * 1.6;
    let to = clamp(from * 0.45 + step, -c.shiftRange, c.shiftRange);
    if (Math.abs(to - from) < c.shiftStep * 0.35) to = clamp(from + (from > 0 ? -1 : 1) * c.shiftStep * 0.6, -c.shiftRange, c.shiftRange);
    const dur = c.shiftMinMs + this.rng() * (c.shiftMaxMs - c.shiftMinMs);
    this.set('shifting', now, dur, from, to, to >= from ? 1 : -1);
    this.seatX = to;
  }

  private walkDur(dist: number): number {
    // A short way back (busy caught her a step out) still takes an unhurried beat.
    return Math.max(900, (Math.abs(dist) / this.cfg.walkSpeed) * 1000);
  }

  /** The segment that follows the one ending at `t`. */
  private advance(t: number, exits: IdleExits): void {
    const c = this.cfg;
    const s = this.seg;
    switch (s.phase) {
      case 'shifting':
        this.set('seated', t, Infinity, this.seatX, this.seatX, s.dir);
        this.nextShiftAt = t + eventGap(c.shiftMinGapMs, c.shiftMeanGapMs, this.rng);
        break;
      case 'standing': {
        const out = s.dir > 0 ? exits.right : -exits.left;
        this.set('walkingOut', t, this.walkDur(out - s.fromX), s.fromX, out, s.dir);
        break;
      }
      case 'walkingOut':
        this.set('away', t, this.awayFor, s.toX, s.toX, s.dir);
        break;
      case 'away': {
        // Back in from either side: memoryless, unrelated to where she left.
        const fromRight = this.rng() < 0.5;
        const from = fromRight ? exits.right : -exits.left;
        const seat = clamp((this.rng() * 2 - 1) * c.shiftStep, -c.shiftRange, c.shiftRange);
        this.set('walkingIn', t, this.walkDur(seat - from), from, seat, fromRight ? -1 : 1, false);
        break;
      }
      case 'walkingIn':
        this.seatX = s.toX;
        this.set('sitting', t, c.sitMs, s.toX, s.toX, s.dir);
        break;
      case 'sitting':
        this.set('seated', t, Infinity, this.seatX, this.seatX, s.dir);
        this.nextWalkAt = t + eventGap(c.walkMinGapMs, c.walkMeanGapMs, this.rng);
        this.nextShiftAt = Math.max(this.nextShiftAt, t + c.shiftMinGapMs);
        break;
      default:
        this.seg = { ...s, end: Infinity };
    }
  }

  /** Busy: bring her back to her seat from wherever the walk-off has got to. */
  private recall(now: number, exits: IdleExits): void {
    const s = this.seg;
    const p = this.lastPose;
    if (s.phase === 'standing') {
      // Not up yet: sit back down from the current lift.
      this.set('sitting', now, this.cfg.sitMs * clamp(p.lift / this.cfg.standLift, 0.3, 1), p.x, p.x, s.dir);
      this.seatX = p.x;
    } else if (s.phase === 'walkingOut') {
      const seat = this.seatX;
      this.set('walkingIn', now, this.walkDur(seat - p.x), p.x, seat, seat >= p.x ? 1 : -1);
    } else if (s.phase === 'away') {
      // Come back by the side she left.
      const from = s.dir > 0 ? exits.right : -exits.left;
      const seat = this.seatX;
      this.set('walkingIn', now, this.walkDur(seat - from), from, seat, seat >= from ? 1 : -1, false);
    }
  }

  // ── pose ────────────────────────────────────────────────────────────────

  private poseAt(now: number): IdlePose {
    const c = this.cfg;
    const s = this.seg;
    const sway = swayAt(now, this.phases, c);
    const seated: IdlePose = { x: this.seatX + sway.drift, lift: 0, lean: sway.lean, scale: 1, breath: sway.breath, phase: s.phase, present: true };
    const u = s.end === Infinity ? 0 : clamp((now - s.start) / Math.max(1, s.end - s.start), 0, 1);
    const tau = (now - s.start) / 1000;
    const blendIn = (p: IdlePose): IdlePose => {
      const b = clamp((now - s.start) / Math.min(BLEND_MS, Math.max(1, s.end - s.start)), 0, 1);
      return b >= 1 || !s.from ? p : lerpPose(s.from, p, smoother(b));
    };
    switch (s.phase) {
      case 'seated':
        return seated;
      case 'shifting': {
        const e = smoother(u);
        const arc = Math.sin(Math.PI * u);
        return { ...seated, x: s.fromX + (s.toX - s.fromX) * e + sway.drift, lift: 0.006 * arc, lean: sway.lean + s.dir * 1.1 * arc };
      }
      case 'standing': {
        const up: IdlePose = { ...seated, x: s.fromX, lift: c.standLift, lean: s.dir * c.travelLeanDeg, scale: c.walkScale, breath: 1 };
        return s.from ? lerpPose(s.from, up, smoother(u)) : up;
      }
      case 'walkingOut':
      case 'walkingIn': {
        const out = s.phase === 'walkingOut';
        const prog = walkProgress(u, out, !out);
        // Steps ramp in over the first stride and fade out before she stops.
        const k = out ? clamp(tau / 0.35, 0, 1) : clamp((s.end - now) / 1000 / 0.35, 0, 1);
        const phase = Math.PI * c.stepHz * tau;
        // A few steps lean less than a long walk.
        const travel = c.travelLeanDeg * clamp(Math.abs(s.toX - s.fromX) / 0.6, 0.3, 1);
        return blendIn({
          ...seated,
          x: s.fromX + (s.toX - s.fromX) * prog,
          lift: c.standLift - c.stepBob * Math.abs(Math.sin(phase)) * k,
          lean: s.dir * travel + c.stepLeanDeg * Math.sin(phase) * k,
          scale: c.walkScale,
          breath: 1,
        });
      }
      case 'away':
        return { ...seated, x: s.toX, lift: c.standLift, lean: 0, scale: c.walkScale, breath: 1, present: false };
      case 'sitting':
        return s.from ? lerpPose(s.from, seated, smoother(u)) : seated;
    }
  }
}

/** Her rest pose, for reduced motion and a still room. */
export const REST_POSE: IdlePose = { x: 0, lift: 0, lean: 0, scale: 1, breath: 1, phase: 'seated', present: true };

/** CSS transform for a pose, about her bottom centre, in px of a slot `height` tall. */
export function poseTransform(p: IdlePose, height: number): string {
  const tx = p.x * height;
  const ty = -p.lift * height;
  return `translate3d(${tx.toFixed(2)}px, ${ty.toFixed(2)}px, 0) rotate(${p.lean.toFixed(3)}deg) scale(${p.scale.toFixed(4)}, ${(p.scale * p.breath).toFixed(4)})`;
}
