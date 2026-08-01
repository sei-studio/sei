/**
 * Backseat local signals (260801) — the arithmetic behind the jolt wake.
 *
 * Pure functions over explicit state, no canvases and no DOM, matching the
 * pcm.ts / transcriptRing.ts convention in this folder. captureWorker.ts owns
 * the pixels and calls in here; nothing in this file knows what a VideoFrame
 * is.
 *
 * That split is not tidying. With the salience gate gone (260801) these two
 * detectors are the only thing that can put a look ON the moment that matters
 * rather than up to a minute later, and they have never been measured. Being
 * pure is what lets scripts/backseat-sim.ts run THIS code over recorded
 * footage, so the thresholds get tuned against the same implementation that
 * ships rather than a re-derivation of it that may or may not agree.
 *
 * Both arms are measured against a rolling baseline rather than an absolute,
 * so a loud game and a quiet game behave alike.
 */

/** Thumbnail grid for the colour signal. Tiny on purpose: this is a "did the
 *  screen repaint" detector, not a motion estimator. */
export const THUMB_W = 32;
export const THUMB_H = 18;

/**
 * How far back the colour comparison reaches. A second is long enough that
 * ordinary panning cannot clear the threshold but a room change always does.
 */
export const COLOR_LOOKBACK_MS = 1000;

/**
 * How much loudness history the gain baseline is drawn from. Independent of
 * BUFFER_MS despite sharing its value: frame retention and the loudness
 * baseline answer different questions and should be able to move apart.
 */
export const GAIN_BASELINE_MS = 9_000;

/** Thumbnails are only kept long enough to reach back past the lookback. */
const THUMB_TRACE_MS = COLOR_LOOKBACK_MS * 3;

/**
 * Minimum history before either arm may fire. Without it the first moments of
 * every session read as a jolt against an empty baseline.
 *
 * Time-based rather than sample-count based (which is what the worker used
 * before this was extracted): the app pushes gain at capture rate, the offline
 * sim pushes it at 10 Hz, and a count threshold would mean completely
 * different amounts of history in the two. The whole point of sharing this
 * code is that they agree.
 */
const WARMUP_MS = COLOR_LOOKBACK_MS * 2;

export interface JoltState {
  /** Trailing loudness samples: [t, dBFS]. */
  gainTrace: Array<[number, number]>;
  /** Trailing thumbnails: [t, RGBA bytes]. */
  thumbTrace: Array<[number, Uint8ClampedArray]>;
  /** Latest loudness reading, whatever the source most recently reported. */
  currentGain: number;
  lastJoltAt: number;
}

export function createJoltState(): JoltState {
  // -Infinity, not 0. The refractory check is `now - lastJoltAt`, so a 0 here
  // means "a jolt just fired at the epoch" and silences the first
  // refractoryMs of any clock that starts near zero. Harmless in the app,
  // where `now` is Date.now(), and fatal for the offline sim's virtual clock,
  // which starts at 0 — the kind of latent coupling to wall time that only
  // shows up once the same code has to run in two places.
  return { gainTrace: [], thumbTrace: [], currentGain: -100, lastJoltAt: -Infinity };
}

/** Record a loudness reading. Called at capture rate in the app. */
export function pushGain(st: JoltState, now: number, db: number): void {
  st.currentGain = db;
  st.gainTrace.push([now, db]);
  while (st.gainTrace.length && now - st.gainTrace[0][0] > GAIN_BASELINE_MS) st.gainTrace.shift();
}

/**
 * Record a thumbnail. Callers should throttle to ~10 Hz: at capture rate this
 * would retain 60 a second to answer a question about one second ago.
 */
export function pushThumb(st: JoltState, now: number, thumb: Uint8ClampedArray): void {
  st.thumbTrace.push([now, thumb]);
  while (st.thumbTrace.length && now - st.thumbTrace[0][0] > THUMB_TRACE_MS) st.thumbTrace.shift();
}

/** True once there is enough history for a baseline to mean anything. */
export function warmedUp(st: JoltState, now: number): boolean {
  const first = st.gainTrace[0]?.[0] ?? st.thumbTrace[0]?.[0];
  return first !== undefined && now - first >= WARMUP_MS;
}

/** Median of a copy of `xs`. Median, not mean, so a single prior bang cannot
 *  raise the bar it is about to be measured against. */
export function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const v = [...xs].sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)];
}

/** The trailing loudness a gain jump is measured against. */
export function baselineGain(st: JoltState): number {
  if (!st.gainTrace.length) return -100;
  return median(st.gainTrace.map((g) => g[1]));
}

/** How far the current loudness sits above its own baseline, in dB. */
export function gainJump(st: JoltState): number {
  return st.currentGain - baselineGain(st);
}

/** Mean absolute per-channel difference between two RGBA thumbnails, 0..1. */
export function thumbDelta(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let sum = 0;
  // Stride 4 skips alpha; the source is opaque so it is always 255.
  for (let i = 0; i < a.length; i += 4) {
    sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
  }
  return sum / ((a.length / 4) * 3 * 255);
}

/**
 * Distance between `thumb` and the screen COLOR_LOOKBACK_MS ago, or null when
 * the trace does not reach back that far yet.
 */
export function colorDelta(
  st: JoltState,
  now: number,
  thumb: Uint8ClampedArray,
): number | null {
  const past = st.thumbTrace.find(([t]) => now - t >= COLOR_LOOKBACK_MS);
  return past ? thumbDelta(thumb, past[1]) : null;
}

export interface JoltThresholds {
  /** dB above the trailing median. */
  gainDb: number;
  /** thumbDelta, 0..1. */
  colorDelta: number;
  /** Minimum gap between two jolts. */
  refractoryMs: number;
}

/**
 * The local wake: a discontinuity large enough that no model is needed to
 * confirm it. Returns the arm that fired and stamps the refractory period, or
 * null.
 *
 * Order matters only in that gain is checked first; the two are not ranked
 * against each other in any principled way, and a moment loud AND bright
 * enough to trip both is one event either way.
 */
export function decideJolt(
  st: JoltState,
  now: number,
  thumb: Uint8ClampedArray,
  th: JoltThresholds,
): 'gain' | 'color' | null {
  if (now - st.lastJoltAt < th.refractoryMs) return null;
  if (!warmedUp(st, now)) return null;

  if (gainJump(st) >= th.gainDb) {
    st.lastJoltAt = now;
    return 'gain';
  }
  const delta = colorDelta(st, now, thumb);
  if (delta !== null && delta >= th.colorDelta) {
    st.lastJoltAt = now;
    return 'color';
  }
  return null;
}
