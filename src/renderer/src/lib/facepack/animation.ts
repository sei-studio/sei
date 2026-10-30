/**
 * FacepackView timing (261028), pure so it can be tested with a fake clock.
 * Numbers from the face-set REPORT.md / EXPRESSIONS_SPEC.md player contract:
 *
 *  - blink every 2.5-6 s: half 40 ms, closed 60 ms, half 40 ms; 15% double;
 *    never on an expression with blink:false
 *  - mouth: viseme from the clip's level + 2 bands, held >= 80 ms
 *  - expression: persists until the next cue; laugh / surprised / excited /
 *    embarrassed decay to neutral after the line ends plus a hold; 60 s
 *    without speech falls back to neutral
 *  - idle pose change every 4-10 s, biased toward the cursor
 */
import type { FacepackEyeState, FacepackViseme } from '@shared/facepack';
import {
  FACE_DECAY_MS,
  FACE_IDLE_NEUTRAL_MS,
  FACE_NEUTRAL,
} from '../../../../bot/brain/faceExpressions.js';

export type Rand = () => number;

// ── Blink ────────────────────────────────────────────────────────────────

export const BLINK_GAP_MIN_MS = 2_500;
export const BLINK_GAP_MAX_MS = 6_000;
export const BLINK_DOUBLE_CHANCE = 0.15;
/** One blink: [state, duration ms]. */
export const BLINK_STEPS: ReadonlyArray<[FacepackEyeState, number]> = [
  ['half', 40],
  ['closed', 60],
  ['half', 40],
];
/** Open gap between the two halves of a double blink. */
export const BLINK_DOUBLE_GAP_MS = 110;

export class BlinkScheduler {
  private nextAt: number;
  /** Absolute [state, until] steps of the blink in progress. */
  private steps: Array<[FacepackEyeState, number]> = [];

  constructor(
    now: number,
    private readonly rand: Rand = Math.random,
  ) {
    this.nextAt = now + 800 + rand() * (BLINK_GAP_MAX_MS - BLINK_GAP_MIN_MS);
  }

  private schedule(now: number): void {
    this.nextAt = now + BLINK_GAP_MIN_MS + this.rand() * (BLINK_GAP_MAX_MS - BLINK_GAP_MIN_MS);
  }

  /** Eye state at `now`. `canBlink` false (blink:false expression) keeps the
   * eyes open, cancels a blink in progress and defers the next one. */
  stateAt(now: number, canBlink: boolean): FacepackEyeState {
    if (!canBlink) {
      this.steps = [];
      if (this.nextAt < now) this.schedule(now);
      return 'open';
    }
    if (this.steps.length === 0 && now >= this.nextAt) {
      let t = now;
      const add = (): void => {
        for (const [s, d] of BLINK_STEPS) {
          t += d;
          this.steps.push([s, t]);
        }
      };
      add();
      if (this.rand() < BLINK_DOUBLE_CHANCE) {
        t += BLINK_DOUBLE_GAP_MS;
        this.steps.push(['open', t]);
        add();
      }
      this.schedule(t);
    }
    while (this.steps.length && now >= this.steps[0][1]) this.steps.shift();
    return this.steps.length ? this.steps[0][0] : 'open';
  }
}

// ── Viseme ───────────────────────────────────────────────────────────────

export interface LevelSample {
  /** 0..1 envelope, same scale as avatarLevelTap (sqrt(meanSquare * 20)). */
  level: number;
  /** Linear power in the low band (about 200-1000 Hz). */
  low: number;
  /** Linear power in the high band (about 1500-4500 Hz). */
  high: number;
}

export const VISEME_HOLD_MS = 80;

/** Spectral tilt in 0..1: high-band share of AMPLITUDE (power ratios are too skewed to threshold). */
export function spectralTilt(s: LevelSample): number {
  const lo = Math.sqrt(Math.max(0, s.low));
  const hi = Math.sqrt(Math.max(0, s.high));
  return hi / (lo + hi + 1e-12);
}

/** Starting tilt baseline before a speaker's own has been learned. */
export const TILT_BASE_DEFAULT = 0.09;
/** The baseline follows the speaker's voiced frames with this time constant. */
const TILT_BASE_TAU_MS = 3_000;

/**
 * Mouth shape from loudness and spectral tilt. Rough on purpose: two bands
 * cannot tell vowels apart, but they do separate the open loud vowels (aa),
 * the bright front ones and sibilants (ee, ii: energy high up) and the dark
 * rounded ones (oo, uu: energy low down), which is what reads on a 2D face.
 *
 * Both inputs are RELATIVE to the speaker. `peak` is the recent loudness
 * peak (VisemeDriver's AGC), so a loud clip and a quiet one open the mouth
 * alike. `tiltBase` is the speaker's typical tilt (a running geometric mean
 * over voiced frames): measured 261028 on Piper voices in Chromium (44.1 kHz,
 * fftSize 512), the median voiced tilt was 0.13 for Sui's voice and 0.055 for
 * Marv's, so any fixed threshold gave one of them no round vowels at all.
 * Against each speaker's own median the quantiles line up (p25 about 0.6x,
 * p75 about 1.6x, p90 2.1-3.3x), which is where the cuts sit.
 */
export function pickViseme(s: LevelSample, peak = 1, tiltBase = TILT_BASE_DEFAULT): FacepackViseme {
  const rel = s.level / Math.max(0.2, peak);
  if (!(rel > 0.18)) return 'rest';
  const r = spectralTilt(s) / Math.max(1e-3, tiltBase);
  if (r > 2.6) return 'ii';
  if (r > 1.6) return 'ee';
  if (r < 0.6) return rel > 0.55 ? 'oo' : 'uu';
  return rel > 0.42 ? 'aa' : 'ee';
}

/** AGC: the loudness peak decays with this time constant. */
const PEAK_DECAY_MS = 1_500;

const PSEUDO: FacepackViseme[] = ['aa', 'ee', 'oo', 'aa', 'ii', 'rest', 'ee', 'uu'];

export class VisemeDriver {
  private current: FacepackViseme = 'rest';
  private changedAt = -Infinity;
  private pseudoNextAt = 0;
  private peak = 0.2;
  private logTiltBase = Math.log(TILT_BASE_DEFAULT);
  private lastAt = -1;

  constructor(
    private readonly substitutions: Partial<Record<FacepackViseme, FacepackViseme>> = {},
    private readonly rand: Rand = Math.random,
  ) {}

  /**
   * `sample` null while speaking = no level feed (tap unavailable): a
   * pseudo-syllable cycle keeps the mouth moving, like RigView's envelope.
   */
  update(now: number, speaking: boolean, sample: LevelSample | null): FacepackViseme {
    const dt = this.lastAt < 0 ? 0 : Math.max(0, now - this.lastAt);
    this.lastAt = now;
    this.peak = Math.max(0.2, this.peak * Math.exp(-dt / PEAK_DECAY_MS));
    if (sample && sample.level > this.peak) this.peak = sample.level;
    if (speaking && sample && sample.level / this.peak > 0.18 && dt > 0) {
      const t = spectralTilt(sample);
      if (t > 0) {
        const k = 1 - Math.exp(-dt / TILT_BASE_TAU_MS);
        this.logTiltBase += (Math.log(t) - this.logTiltBase) * k;
      }
    }
    let want: FacepackViseme;
    if (!speaking) want = 'rest';
    else if (sample) want = pickViseme(sample, this.peak, Math.exp(this.logTiltBase));
    else {
      if (now >= this.pseudoNextAt) {
        this.pseudoNextAt = now + 90 + this.rand() * 70;
        want = PSEUDO[Math.floor(this.rand() * PSEUDO.length)];
      } else want = this.current;
    }
    want = this.substitutions[want] ?? want;
    if (want !== this.current && now - this.changedAt >= VISEME_HOLD_MS) {
      this.current = want;
      this.changedAt = now;
    }
    return this.current;
  }
}

// ── Expression timeline ──────────────────────────────────────────────────

/** A typed-chat line has no clip; treat it as "spoken" for this long. */
export const TEXT_LINE_MS = 2_000;

export class ExpressionTimeline {
  current: string = FACE_NEUTRAL;
  /** Bumped on every set(), so a repeated cue re-triggers the crossfade/decay. */
  seq = 0;
  private speaking = false;
  private lineEndAt: number | null = null;
  private lastActivityAt: number;

  constructor(now: number) {
    this.lastActivityAt = now;
  }

  set(name: string, now: number): void {
    this.current = name;
    this.seq++;
    this.lastActivityAt = now;
    // A cue that lands while nothing is playing (typed chat) gets a nominal
    // line length; while speaking, the line ends when speech stops.
    this.lineEndAt = this.speaking ? null : now + TEXT_LINE_MS;
  }

  setSpeaking(on: boolean, now: number): void {
    if (on === this.speaking) return;
    this.speaking = on;
    this.lastActivityAt = now;
    this.lineEndAt = on ? null : now;
  }

  /** Apply decay rules; true when the current expression changed. */
  tick(now: number): boolean {
    if (this.current === FACE_NEUTRAL) return false;
    const hold = FACE_DECAY_MS[this.current];
    if (hold !== undefined && this.lineEndAt !== null && now >= this.lineEndAt + hold) {
      this.toNeutral(now);
      return true;
    }
    if (!this.speaking && now - this.lastActivityAt >= FACE_IDLE_NEUTRAL_MS) {
      this.toNeutral(now);
      return true;
    }
    return false;
  }

  private toNeutral(now: number): void {
    this.current = FACE_NEUTRAL;
    this.seq++;
    this.lineEndAt = null;
    this.lastActivityAt = now;
  }
}

// ── Idle pose ────────────────────────────────────────────────────────────

export const POSE_GAP_MIN_MS = 4_000;
export const POSE_GAP_MAX_MS = 10_000;

/** Head poses next to each other: a change moves one step, never c → l2. */
const POSE_NEIGHBORS: Record<string, string[]> = {
  c: ['l1', 'r1', 'tl', 'tr'],
  l1: ['c', 'l2'],
  l2: ['l1'],
  r1: ['c', 'r2'],
  r2: ['r1'],
  tl: ['c'],
  tr: ['c'],
};

/**
 * The next idle pose. `cursorX` in [-1, 1] (viewer's left negative; the
 * packs' l* poses turn toward the viewer's left), or null when there is no
 * fresh cursor. Returns `current` to hold still this round.
 */
export function nextPose(current: string, available: readonly string[], cursorX: number | null, rand: Rand = Math.random): string {
  const has = (p: string): boolean => available.includes(p);
  const options = (POSE_NEIGHBORS[current] ?? ['c']).filter(has);
  if (options.length === 0) return has('c') ? 'c' : current;
  const weights = new Map<string, number>();
  weights.set(current, current === 'c' ? 1.2 : 0.5);
  for (const p of options) {
    let w = 1;
    if (p === 'c') w = 1.6; // drift home
    if (p === 'l2' || p === 'r2') w = 0.45;
    if (p === 'tl' || p === 'tr') w = 0.6;
    if (cursorX !== null) {
      const side = p.startsWith('l') || p === 'tl' ? -1 : p.startsWith('r') || p === 'tr' ? 1 : 0;
      if (side !== 0) w *= side * cursorX > 0.2 ? 3 : side * cursorX < -0.2 ? 0.25 : 1;
      if (p === 'c' && Math.abs(cursorX) < 0.2) w *= 2;
    }
    weights.set(p, w);
  }
  const total = [...weights.values()].reduce((a, b) => a + b, 0);
  let r = rand() * total;
  for (const [p, w] of weights) {
    r -= w;
    if (r <= 0) return p;
  }
  return current;
}

export function nextPoseDelay(rand: Rand = Math.random): number {
  return POSE_GAP_MIN_MS + rand() * (POSE_GAP_MAX_MS - POSE_GAP_MIN_MS);
}
