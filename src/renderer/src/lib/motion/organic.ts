/**
 * Organic motion (261116, product call 261116: "movement is jittery, idle
 * feels like a still picture"). Pure building blocks every avatar view uses
 * for its idle life, so a face set, a Live2D model, a layered rig and a
 * portrait all move with the same feel:
 *
 *  - `springStep`: a critically damped spring (exact step, any dt): eases
 *    in and out, never overshoots, never snaps; a moving target is followed
 *    smoothly, so a goal can change any time without a visible jump.
 *  - `Wander`: summed low-frequency sines with random phases and
 *    incommensurate periods, so it never visibly loops.
 *  - `minJerk`: the minimum-jerk profile (quintic smootherstep), the shape
 *    of a real saccade or reach. Nothing here moves linearly.
 *  - `Blinker`: lid closure 0..1 over time: a fast close (65 ms,
 *    accelerating), a short hold, a slower open (105 ms, decelerating);
 *    gaps of a few seconds, sometimes a double, sometimes right after a big
 *    eye movement (as people do).
 *  - `GazeDriver`: where she looks. The eyes move between fixation targets
 *    and hold each for 0.2 to 2.5 s with a tiny drift (261119, product call
 *    261119 "her eyes jitter": a move is a spring glide with a speed limit,
 *    not a tens-of-ms jump, and a cursor she follows is glided and pursued
 *    outside a small dead zone);
 *    most targets are near where she already looks, some are back at the
 *    viewer, some are the cursor (when the view has one) or a point of
 *    interest (things in her room), now and then a bigger glance. The head
 *    follows the gaze on a slow spring with its own layered sway, and the
 *    eyes counter-rotate as it catches up (eye in head = gaze - head), so
 *    the eyes lead and the head settles after, the way people look around.
 *
 * Units: gaze and head are normalised, -1..1 on each axis (x + = toward the
 * viewer's right, y + = down); each view maps them to its own degrees or
 * pixels. Time in ms. Every class takes an injectable rng for tests and
 * allocates nothing per update (the outputs are reused objects).
 */

export type Rng = () => number;

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Minimum-jerk position profile on 0..1 (zero velocity and acceleration at both ends). */
export function minJerk(u: number): number {
  const t = clamp(u, 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

export interface SpringState {
  x: number;
  v: number;
}

/**
 * Advance a critically damped spring toward `target` by `dtMs`. `omega` is
 * its angular frequency in rad/s: it settles (within about 2%) in about
 * 5.8 / omega seconds. Exact for any step, so a dropped frame changes
 * nothing.
 */
export function springStep(s: SpringState, target: number, omega: number, dtMs: number): void {
  const dt = Math.max(0, dtMs) / 1000;
  if (dt === 0) return;
  const y = s.x - target;
  const c = s.v + omega * y;
  const e = Math.exp(-omega * dt);
  const k = y + c * dt;
  s.x = target + k * e;
  s.v = (c - omega * k) * e;
}

/** Summed sines with random phases: smooth, aperiodic-looking noise in about -1..1. */
export class Wander {
  private readonly w: Float64Array;
  private readonly p: Float64Array;
  private readonly ph: Float64Array;
  private readonly norm: number;

  /** `periodsMs[i]` with weight `weights[i]` (default 1). */
  constructor(periodsMs: readonly number[], rng: Rng = Math.random, weights?: readonly number[]) {
    const n = periodsMs.length;
    this.w = new Float64Array(n);
    this.p = new Float64Array(n);
    this.ph = new Float64Array(n);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      this.w[i] = weights?.[i] ?? 1;
      this.p[i] = (Math.PI * 2) / periodsMs[i];
      this.ph[i] = rng() * Math.PI * 2;
      sum += Math.abs(this.w[i]);
    }
    this.norm = sum > 0 ? 1 / sum : 0;
  }

  value(tMs: number): number {
    let v = 0;
    for (let i = 0; i < this.w.length; i++) v += this.w[i] * Math.sin(tMs * this.p[i] + this.ph[i]);
    return v * this.norm;
  }
}

// ── Blink ───────────────────────────────────────────────────────────────────

export const BLINK_CLOSE_MS = 65;
export const BLINK_HOLD_MS = 45;
export const BLINK_OPEN_MS = 105;
export const BLINK_MS = BLINK_CLOSE_MS + BLINK_HOLD_MS + BLINK_OPEN_MS;
/** The open gap inside a double blink. */
export const BLINK_DOUBLE_GAP_MS = 70;
export const BLINK_DOUBLE_CHANCE = 0.15;
/** Gap between blinks: a refractory minimum plus a memoryless tail, capped. */
export const BLINK_GAP_MIN_MS = 1_800;
export const BLINK_GAP_MEAN_MS = 2_600;
export const BLINK_GAP_MAX_MS = 9_000;
/** A big eye movement brings the next blink forward this often. */
export const BLINK_ON_SACCADE_CHANCE = 0.3;

/** Lid closure (0 open .. 1 shut) `t` ms into one blink: accelerate shut, hold, decelerate open. */
export function lidCurve(t: number): number {
  if (t <= 0) return 0;
  if (t < BLINK_CLOSE_MS) {
    const u = t / BLINK_CLOSE_MS;
    return u * u;
  }
  if (t < BLINK_CLOSE_MS + BLINK_HOLD_MS) return 1;
  if (t < BLINK_MS) {
    const u = (t - BLINK_CLOSE_MS - BLINK_HOLD_MS) / BLINK_OPEN_MS;
    return (1 - u) * (1 - u);
  }
  return 0;
}

export class Blinker {
  private startAt = -1;
  private double = false;
  private nextAt: number;

  constructor(
    now: number,
    private readonly rng: Rng = Math.random,
  ) {
    this.nextAt = now + 600 + rng() * 2_400;
  }

  private gap(): number {
    const u = Math.min(1 - 1e-9, Math.max(0, this.rng()));
    return Math.min(BLINK_GAP_MAX_MS, BLINK_GAP_MIN_MS - Math.log(1 - u) * BLINK_GAP_MEAN_MS);
  }

  /** Ask for a blink soon (after a big eye movement); ignored mid-blink. */
  nudge(now: number): void {
    if (this.startAt >= 0) return;
    this.nextAt = Math.min(this.nextAt, now + 20 + this.rng() * 80);
  }

  /** True while a blink is running. */
  get blinking(): boolean {
    return this.startAt >= 0;
  }

  /** Lid closure at `now`. `allowed` false (eyes already shut in this face) ends a blink and defers the next. */
  lid(now: number, allowed = true): number {
    if (!allowed) {
      this.startAt = -1;
      if (this.nextAt < now) this.nextAt = now + this.gap();
      return 0;
    }
    if (this.startAt < 0 && now >= this.nextAt) {
      this.startAt = now;
      this.double = this.rng() < BLINK_DOUBLE_CHANCE;
    }
    if (this.startAt < 0) return 0;
    const t = now - this.startAt;
    const span = this.double ? BLINK_MS * 2 + BLINK_DOUBLE_GAP_MS : BLINK_MS;
    if (t >= span) {
      this.startAt = -1;
      this.nextAt = now + this.gap();
      return 0;
    }
    if (this.double && t >= BLINK_MS + BLINK_DOUBLE_GAP_MS) return lidCurve(t - BLINK_MS - BLINK_DOUBLE_GAP_MS);
    return lidCurve(t);
  }
}

// ── Gaze ────────────────────────────────────────────────────────────────────

export interface GazePoint {
  x: number;
  y: number;
}

export interface GazeInput {
  /** Where the cursor is, in gaze units, when the view has a fresh cursor; else null. */
  cursor?: GazePoint | null;
  /** Things worth a glance (her room's objects), in gaze units. */
  interests?: readonly GazePoint[] | null;
  /** She is talking or being talked to: mostly at the viewer, smaller looks away. */
  engaged?: boolean;
}

export interface GazeOutput {
  /** Gaze direction (eyes + head), -1..1. */
  gazeX: number;
  gazeY: number;
  /** Eyes within the head, -1..1: what an iris or ParamEyeBall should show. */
  eyeX: number;
  eyeY: number;
  /** Head direction, -1..1 (yaw, pitch) and roll -1..1 (+ = tilts toward the viewer's right). */
  headX: number;
  headY: number;
  headRoll: number;
  /** performance time of the last saccade bigger than BIG_SACCADE (for a blink nudge). */
  bigSaccadeAt: number;
}

export interface GazeConfig {
  /** Fixation length: log-normal around this median, clamped. */
  fixMedianMs: number;
  fixMinMs: number;
  fixMaxMs: number;
  /** Target choice weights. */
  homeChance: number;
  cursorChance: number;
  interestChance: number;
  glanceChance: number;
  /** Usual saccade step and the bigger glance. */
  stepMin: number;
  stepMax: number;
  glanceMin: number;
  glanceMax: number;
  /** Vertical looks are smaller than horizontal ones. */
  yScale: number;
  /** Head follows this share of a small gaze shift, more for a big one. */
  headShareSmall: number;
  headShareBig: number;
  /** Head spring (rad/s): about 5.8 / omega seconds to settle. */
  headOmega: number;
  /** Head sway on top (normalised amplitude) and roll sway. */
  headSway: number;
  rollSway: number;
  /** Eye fixational drift amplitude. */
  drift: number;
  /**
   * 261119: the eyes travel to each new target on a critically damped spring
   * (rad/s): an eased glide that starts and ends at rest and stays smooth when
   * the target moves mid-way. About 4.7 / omega seconds to arrive.
   */
  gazeOmega: number;
  /** Fastest the gaze may move, units per second. */
  maxSpeed: number;
  /** The cursor feed comes in steps (the host polls it every 150 ms): this spring (rad/s) turns them into a glide. */
  cursorOmega: number;
  /** While following the cursor, moves smaller than this are not followed (a hand resting on the mouse). */
  deadZone: number;
  /** A cursor that moved in the last `cursorActiveMs` has her attention: she looks at it this often. */
  activeCursorChance: number;
  cursorActiveMs: number;
  /** A cursor that starts moving pulls her eyes to it once the current look has lasted this long. */
  cursorReactMs: number;
}

export const DEFAULT_GAZE: GazeConfig = {
  fixMedianMs: 750,
  fixMinMs: 200,
  fixMaxMs: 2_600,
  homeChance: 0.3,
  cursorChance: 0.2,
  interestChance: 0.12,
  glanceChance: 0.12,
  stepMin: 0.08,
  stepMax: 0.32,
  glanceMin: 0.45,
  glanceMax: 0.8,
  yScale: 0.6,
  headShareSmall: 0.3,
  headShareBig: 0.65,
  headOmega: 4.2,
  // 261119 (product call 261119, "the swaying"): the head's own sway and tilt were a visible pendulum.
  headSway: 0.05,
  rollSway: 0.22,
  drift: 0.012,
  gazeOmega: 17,
  maxSpeed: 4,
  cursorOmega: 12,
  deadZone: 0.025,
  activeCursorChance: 0.85,
  cursorActiveMs: 1_800,
  cursorReactMs: 260,
};

/** A saccade at least this big counts as big (blink nudge, head share). */
export const BIG_SACCADE = 0.35;

/** How far the cursor must move (gaze units) to count as moving. */
const CURSOR_MOVE_EPS = 0.01;

export class GazeDriver {
  readonly cfg: GazeConfig;
  readonly out: GazeOutput = {
    gazeX: 0,
    gazeY: 0,
    eyeX: 0,
    eyeY: 0,
    headX: 0,
    headY: 0,
    headRoll: 0,
    bigSaccadeAt: -Infinity,
  };
  private readonly rng: Rng;
  /** The point she looks at (a fixation, or the cursor she pursues). */
  private tx = 0;
  private ty = 0;
  private fixStart: number;
  private fixUntil: number;
  private headShare: number;
  /** The eyes on their way to (tx, ty). */
  private readonly gx: SpringState = { x: 0, v: 0 };
  private readonly gy: SpringState = { x: 0, v: 0 };
  private readonly hx: SpringState = { x: 0, v: 0 };
  private readonly hy: SpringState = { x: 0, v: 0 };
  /** The cursor feed, glided. */
  private readonly cx: SpringState = { x: 0, v: 0 };
  private readonly cy: SpringState = { x: 0, v: 0 };
  private hasCursor = false;
  private cursorMovedAt = -Infinity;
  /** When the cursor last went from still to moving. */
  private cursorWokeAt = -Infinity;
  private cursorWasActive = false;
  private lastCurX = 0;
  private lastCurY = 0;
  private readonly swayX: Wander;
  private readonly swayY: Wander;
  private readonly swayR: Wander;
  private readonly driftX: Wander;
  private readonly driftY: Wander;
  private last = -1;
  /** The current fixation is the cursor: the eyes pursue it while it moves. */
  private following = false;

  constructor(now: number, cfg: Partial<GazeConfig> = {}, rng: Rng = Math.random) {
    this.cfg = { ...DEFAULT_GAZE, ...cfg };
    this.rng = rng;
    this.fixStart = now;
    this.fixUntil = now + 300 + rng() * 900;
    this.headShare = this.cfg.headShareSmall;
    this.swayX = new Wander([9_100, 14_300, 23_900], rng, [0.5, 0.33, 0.17]);
    this.swayY = new Wander([7_700, 12_900, 19_300], rng, [0.5, 0.3, 0.2]);
    this.swayR = new Wander([11_300, 17_900, 29_700], rng, [0.5, 0.3, 0.2]);
    this.driftX = new Wander([1_300, 2_100, 3_700], rng);
    this.driftY = new Wander([1_700, 2_900, 4_100], rng);
  }

  private fixDuration(engaged: boolean): number {
    const c = this.cfg;
    // Log-normal: Box-Muller from two uniforms.
    const u1 = Math.max(1e-9, this.rng());
    const u2 = this.rng();
    const n = Math.sqrt(-2 * Math.log(u1)) * Math.cos(Math.PI * 2 * u2);
    const d = c.fixMedianMs * Math.exp(0.55 * n) * (engaged ? 1.35 : 1);
    return clamp(d, c.fixMinMs, c.fixMaxMs);
  }

  private pickTarget(now: number, input: GazeInput, cursorActive: boolean, forceCursor: boolean): void {
    const c = this.cfg;
    const r = this.rng();
    const engaged = input.engaged === true;
    const home = forceCursor ? 0 : engaged ? 0.6 : cursorActive ? c.homeChance * 0.3 : c.homeChance;
    const cursor = input.cursor ? (forceCursor ? 1 : cursorActive ? c.activeCursorChance : c.cursorChance) : 0;
    const interest = input.interests && input.interests.length && !engaged ? c.interestChance : 0;
    let x: number;
    let y: number;
    this.following = false;
    if (r < home) {
      x = (this.rng() * 2 - 1) * 0.06;
      y = (this.rng() * 2 - 1) * 0.05;
    } else if (r < home + cursor && input.cursor) {
      x = this.cx.x;
      y = this.cy.x;
      this.following = true;
    } else if (r < home + cursor + interest && input.interests) {
      const p = input.interests[Math.floor(this.rng() * input.interests.length) % input.interests.length];
      x = p.x + (this.rng() * 2 - 1) * 0.04;
      y = p.y + (this.rng() * 2 - 1) * 0.04;
    } else {
      const glance = !engaged && this.rng() < c.glanceChance;
      const amp = glance ? c.glanceMin + this.rng() * (c.glanceMax - c.glanceMin) : c.stepMin + this.rng() * (c.stepMax - c.stepMin) * (engaged ? 0.6 : 1);
      const a = this.rng() * Math.PI * 2;
      // From near where she looks, pulled a little toward the middle.
      x = this.tx * 0.65 + Math.cos(a) * amp;
      y = this.ty * 0.65 + Math.sin(a) * amp * c.yScale;
    }
    // Inside a comfortable ellipse.
    const rr = Math.hypot(x / 0.85, y / 0.6);
    if (rr > 1) {
      x /= rr;
      y /= rr;
    }
    const amp = Math.hypot(x - this.gx.x, y - this.gy.x);
    this.tx = x;
    this.ty = y;
    this.headShare = amp >= BIG_SACCADE ? c.headShareBig : c.headShareSmall;
    if (amp >= BIG_SACCADE) this.out.bigSaccadeAt = now;
    this.fixStart = now;
    // The glide there, then the hold; following the cursor holds longer than a look at a still point.
    this.fixUntil = now + 4_700 / c.gazeOmega + this.fixDuration(engaged) * (this.following ? 2.2 : 1);
  }

  /** Advance to `now` and return the (reused) output. */
  update(now: number, input: GazeInput = {}): GazeOutput {
    const c = this.cfg;
    const dt = this.last < 0 ? 0 : Math.min(250, Math.max(0, now - this.last));
    this.last = now;
    // The cursor feed, glided (it arrives in steps), and whether it is moving.
    const cur = input.cursor ?? null;
    if (cur) {
      if (!this.hasCursor) {
        this.cx.x = cur.x;
        this.cx.v = 0;
        this.cy.x = cur.y;
        this.cy.v = 0;
        this.lastCurX = cur.x;
        this.lastCurY = cur.y;
        this.hasCursor = true;
      } else {
        springStep(this.cx, cur.x, c.cursorOmega, dt);
        springStep(this.cy, cur.y, c.cursorOmega, dt);
      }
      if (Math.hypot(cur.x - this.lastCurX, cur.y - this.lastCurY) > CURSOR_MOVE_EPS) {
        this.cursorMovedAt = now;
        this.lastCurX = cur.x;
        this.lastCurY = cur.y;
      }
    } else this.hasCursor = false;
    const cursorActive = cur !== null && now - this.cursorMovedAt < c.cursorActiveMs;
    if (cursorActive && !this.cursorWasActive) this.cursorWokeAt = now;
    this.cursorWasActive = cursorActive;
    const engaged = input.engaged === true;
    // A cursor that starts moving catches her eye once (unless she is talking); after that she
    // mostly keeps following it but may still glance away and back.
    const react =
      cursorActive && !engaged && !this.following && this.cursorWokeAt > this.fixStart && now - this.fixStart >= c.cursorReactMs;
    if (react || now >= this.fixUntil) this.pickTarget(now, input, cursorActive, react);
    // Following the cursor: the eyes pursue its glided position, outside a small dead zone.
    if (this.following) {
      if (!cur) this.following = false;
      else {
        const px = clamp(this.cx.x, -0.85, 0.85);
        const py = clamp(this.cy.x, -0.6, 0.6);
        const dx = px - this.tx;
        const dy = py - this.ty;
        const d = Math.hypot(dx, dy);
        if (d > c.deadZone) {
          const k = (d - c.deadZone) / d;
          this.tx += dx * k;
          this.ty += dy * k;
        }
      }
    }
    // The eyes glide to the target on a spring, no faster than maxSpeed.
    const x0 = this.gx.x;
    const y0 = this.gy.x;
    springStep(this.gx, this.tx, c.gazeOmega, dt);
    springStep(this.gy, this.ty, c.gazeOmega, dt);
    const lim = (c.maxSpeed * dt) / 1000;
    const step = Math.hypot(this.gx.x - x0, this.gy.x - y0);
    if (lim > 0 && step > lim) {
      const k = lim / step;
      this.gx.x = x0 + (this.gx.x - x0) * k;
      this.gy.x = y0 + (this.gy.x - y0) * k;
      this.gx.v *= k;
      this.gy.v *= k;
    }
    const o = this.out;
    o.gazeX = this.gx.x + c.drift * this.driftX.value(now);
    o.gazeY = this.gy.x + c.drift * this.driftY.value(now) * 0.8;
    // Head: a spring after the gaze target (it starts when the eyes do and lags behind), plus its own sway.
    springStep(this.hx, this.tx * this.headShare, c.headOmega, dt);
    springStep(this.hy, this.ty * this.headShare * 0.8, c.headOmega, dt);
    const sx = c.headSway * this.swayX.value(now);
    const sy = c.headSway * 0.7 * this.swayY.value(now);
    o.headX = this.hx.x + sx;
    o.headY = this.hy.x + sy;
    o.headRoll = clamp(c.rollSway * this.swayR.value(now) - 0.35 * this.hx.x, -1, 1);
    // Eyes in the head: what is left of the gaze once the head has turned (the head's sway is not
    // compensated, so the eyes ride on it like a real head's micro-motion).
    o.eyeX = clamp(o.gazeX - this.hx.x, -1, 1);
    o.eyeY = clamp(o.gazeY - this.hy.x, -1, 1);
    return o;
  }
}
