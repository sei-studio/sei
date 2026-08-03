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
 * How far back the colour comparison reaches, and why there are two (260802).
 *
 * A single one-second lookback misses the change it most needs to catch. A hard
 * scene cut repaints everything between one frame and the next, so it clears any
 * threshold at any lookback; walking through a doorway takes one to three
 * seconds, and inside any single one-second window it never looks like more than
 * ordinary panning. Reviewing the Valorant run showed exactly that split: the
 * colour arm fired on the compilation's edit cuts and on nothing inside a scene.
 *
 * So the delta is the LARGER of the distance to ~1 s ago and to ~2.5 s ago. The
 * short arm keeps cuts and full-screen abilities instant; the long arm is what
 * sees a transition that was always too gradual for the short one.
 *
 * (The old single COLOR_LOOKBACK_MS was 1000 and did not do what it said: the
 * trace was pruned at 3x the lookback and the lookup took the FIRST entry at
 * least a second old, which is always the oldest one retained. The effective
 * comparison was therefore against ~3 s ago, not 1 s. `thumbAt` below resolves
 * a target age properly, so these numbers now mean what they say.)
 */
export const COLOR_LOOKBACKS_MS = [1000, 2500];

/**
 * The colour delta is a MAX OVER BLOCKS, not a mean over the frame (260802).
 *
 * Averaging per-pixel distance across the whole thumbnail is what made this arm
 * only see scene cuts. A change has to cover most of the screen to survive the
 * average, so a doorway, a new room filling half the frame, a full-screen
 * banner or a kill feed are all divided down into the noise floor. Splitting the
 * 32x18 thumbnail into a 4x3 grid and taking the largest block's distance means
 * a change is measured against the area it actually covers: a cut lights all
 * twelve blocks, a localised event lights one, and both become visible.
 *
 * 4x3 over a 32x18 thumbnail is 8x6 = 48 pixels per block, small enough to
 * localise and large enough that a handful of noisy pixels cannot carry a block
 * on their own.
 *
 * A finer split was measured and rejected (260803). On a screen recording of
 * Instagram Reels in a browser the portrait video occupies about a sixth of a
 * landscape screen's width, far narrower than one 4x3 block, so a swipe to the
 * next reel reads only 0.18 to 0.28 while ordinary motion inside a video reads
 * up to 0.22: in isolation the two are not separable. Splitting 8x6 instead
 * separates them well by itself, 3.7% of background samples above the weakest
 * swipe peak against 18.0% at 4x3, because more ROWS means a block can sit
 * entirely inside the reel column and see the whole vertical translation.
 *
 * Running it end to end made the detector WORSE, 3 of 6 verified swipes against
 * 5 of 6 at 4x3. The bar is median + k*MAD over the arm's OWN recent output, so
 * it scales by exactly the factor the signal does and the extra separation is
 * handed straight back; what does not come back is the variance, because a
 * 12-pixel block is noisier sample to sample, and a MAD inflated by one swipe
 * then hid the next (the bar reached 0.805 at 00:14 against a peak of 0.625).
 * A self-referential threshold makes the split a scale choice rather than a
 * sensitivity one, so the useful dials are the refractory and the floor.
 */
export const COLOR_BLOCK_COLS = 4;
export const COLOR_BLOCK_ROWS = 3;

/**
 * How much loudness history the gain baseline is drawn from. Independent of
 * BUFFER_MS despite sharing its value: frame retention and the loudness
 * baseline answer different questions and should be able to move apart.
 */
export const GAIN_BASELINE_MS = 9_000;

/** The furthest back any colour comparison reaches. */
const MAX_LOOKBACK_MS = Math.max(...COLOR_LOOKBACKS_MS);

/** Thumbnails are kept a second past the longest lookback, so the sample
 *  nearest that target is always still resident. */
const THUMB_TRACE_MS = MAX_LOOKBACK_MS + 1_000;

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
const WARMUP_MS = MAX_LOOKBACK_MS + 500;

/**
 * How much colour-delta history the colour baseline is drawn from. Longer than
 * the gain baseline because it is estimating a spread rather than a level, and
 * a shooter's deltas swing hard between a firefight and a walk.
 */
export const COLOR_BASELINE_MS = 15_000;

/**
 * The colour arm's own refractory period, shorter than the gain arm's (260803).
 *
 * It lives here rather than beside JOLT_REFRACTORY_MS in backseatIpc because
 * its lower bound is a property of the lookback table above, not a taste
 * setting. A transition stays inside the 2.5 s window for 2.5 s after it
 * finishes, so the delta is still elevated well after the event, and a
 * refractory shorter than that plus margin counts one change twice. Measured on
 * the Reels recording: at 5 s the 00:28 swipe fired again at 00:32, at 3 s
 * again at 00:30. 6 s is 2.4x the longest lookback and produced no repeats.
 *
 * The upper bound is what the arm is for. It answers "the picture is showing
 * something else now", and two of those in a row are two different subjects,
 * not one event seen twice. The Reels recording has six swipes, confirmed by
 * reading the reel id out of the URL bar frame by frame, and their gaps are 14,
 * 6, 16, 3 and 11 s: EVERY gap is under the 20 s the two arms used to share, so
 * at 20 s the refractory clock decided which swipes were noticed rather than
 * the picture did, and at most 3 of the 6 could fire however sensitive the
 * threshold was made. Measured on that clip, 2/6 at 20 s and 3/6 at 6 s with no
 * other change; with the floor moved too (see JOLT_COLOR_FLOOR) 5/6, while
 * either change alone reaches only 3/6. The two are complementary because they
 * fix different misses: the refractory fixes swipes whose delta CLEARED the bar
 * and was suppressed, the floor fixes swipes whose delta never reached it.
 *
 * The gain arm keeps the longer period and there is no measurement here saying
 * it should move. A loudness spike is loudness inside a scene that is still
 * going, and one firefight produces many; there is no equivalent boundary that
 * makes the next spike a different subject.
 *
 * This is a wake, not a line. MIN_SPEAK_GAP_MS governs how often the companion
 * is allowed to actually say something and is unchanged, so a shorter
 * refractory buys a look at the right moment, not more talking. It also means
 * the 3 s gap in this clip can never produce two lines whatever this is set to.
 *
 * The cost was measured on the other clip to hand. On the Valorant montage the
 * colour arm goes from 5 jolts to 11 over 3:07, one per 17 s against one per
 * 37 s; the four gain jolts are unchanged and all five original colour jolts
 * survive, so the six new ones are additions rather than displacements. That
 * footage is an edited compilation whose extra fires are its edit cuts, which
 * are real scene changes, and the curve is flat past this point: 10 s gives 13
 * jolts and 8 s gives 14, so the last 4 s of period buys 2 jolts there and a
 * whole marked swipe here.
 */
export const COLOR_REFRACTORY_MS = 6_000;

export interface JoltState {
  /** Trailing loudness samples: [t, dBFS]. */
  gainTrace: Array<[number, number]>;
  /** Trailing thumbnails: [t, RGBA bytes]. */
  thumbTrace: Array<[number, Uint8ClampedArray]>;
  /** Trailing colour deltas: [t, delta]. The colour arm's own baseline. */
  colorTrace: Array<[number, number]>;
  /** Latest loudness reading, whatever the source most recently reported. */
  currentGain: number;
  /**
   * Refractory clocks, one PER ARM (260802).
   *
   * They used to share one. Measured on the Valorant clip that meant whichever
   * arm happened to fire first swallowed the other's next 20 seconds, and with
   * the colour arm made more sensitive it started eating confirmed kills: a
   * colour jolt at 01:41 suppressed the +18.9 dB gain spike at 01:55, which is
   * the single clearest real event in the footage. The two arms answer
   * different questions ("the scene changed" and "something loud happened"), so
   * neither has any business silencing the other.
   */
  lastGainAt: number;
  lastColorAt: number;
}

export function createJoltState(): JoltState {
  // -Infinity, not 0. The refractory check is `now - lastGainAt`, so a 0 here
  // means "a jolt just fired at the epoch" and silences the first
  // refractoryMs of any clock that starts near zero. Harmless in the app,
  // where `now` is Date.now(), and fatal for the offline sim's virtual clock,
  // which starts at 0 — the kind of latent coupling to wall time that only
  // shows up once the same code has to run in two places.
  return {
    gainTrace: [],
    thumbTrace: [],
    colorTrace: [],
    currentGain: -100,
    lastGainAt: -Infinity,
    lastColorAt: -Infinity,
  };
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

/**
 * Mean absolute per-channel difference between two RGBA thumbnails, 0..1.
 *
 * Kept because it is the honest whole-frame number and the block version is
 * defined against it, but it is NOT what the jolt arm reads any more: see
 * COLOR_BLOCK_COLS for why averaging over the frame was the bug.
 */
export function thumbDelta(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let sum = 0;
  // Stride 4 skips alpha; the source is opaque so it is always 255.
  for (let i = 0; i < a.length; i += 4) {
    sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
  }
  return sum / ((a.length / 4) * 3 * 255);
}

/**
 * Per-block mean distance, COLOR_BLOCK_ROWS x COLOR_BLOCK_COLS of them, in
 * row-major order. Exported so the offline sim can report WHERE a colour jolt
 * came from rather than only that one fired.
 */
export function blockDeltas(a: Uint8ClampedArray, b: Uint8ClampedArray): number[] {
  const out: number[] = [];
  const bw = Math.floor(THUMB_W / COLOR_BLOCK_COLS);
  const bh = Math.floor(THUMB_H / COLOR_BLOCK_ROWS);
  for (let br = 0; br < COLOR_BLOCK_ROWS; br++) {
    for (let bc = 0; bc < COLOR_BLOCK_COLS; bc++) {
      let sum = 0;
      let n = 0;
      // The last block in each direction absorbs the remainder, so a thumbnail
      // whose size is not divisible by the block count still covers every pixel.
      const x1 = bc === COLOR_BLOCK_COLS - 1 ? THUMB_W : (bc + 1) * bw;
      const y1 = br === COLOR_BLOCK_ROWS - 1 ? THUMB_H : (br + 1) * bh;
      for (let y = br * bh; y < y1; y++) {
        for (let x = bc * bw; x < x1; x++) {
          const i = (y * THUMB_W + x) * 4;
          sum +=
            Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
          n++;
        }
      }
      out.push(n ? sum / (n * 3 * 255) : 0);
    }
  }
  return out;
}

/** The largest block distance between two thumbnails, 0..1. */
export function blockMaxDelta(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  return Math.max(...blockDeltas(a, b));
}

/**
 * The retained thumbnail closest to `ageMs` before `now`, or null when the
 * trace does not reach back that far.
 *
 * Nearest, not first-past-the-post. The old lookup took the first entry at
 * least the lookback old, which in a pruned trace is always the OLDEST one
 * held, so the comparison drifted to whatever the retention happened to be.
 */
export function thumbAt(st: JoltState, now: number, ageMs: number): Uint8ClampedArray | null {
  const target = now - ageMs;
  let best: Uint8ClampedArray | null = null;
  let bestGap = Infinity;
  let reaches = false;
  for (const [t, thumb] of st.thumbTrace) {
    if (t <= target) reaches = true;
    const gap = Math.abs(t - target);
    if (gap < bestGap) {
      bestGap = gap;
      best = thumb;
    }
  }
  // Only answer once the trace actually spans the target: without this the
  // first moments of a session compare against a sample barely older than the
  // current one and report a near-zero delta as if it meant something.
  return reaches ? best : null;
}

/**
 * How much the screen has changed: the largest block distance against EITHER
 * lookback in COLOR_LOOKBACKS_MS, or null while the trace is still short.
 *
 * Taking the max over both windows rather than one fixed window is what lets a
 * gradual transition register: it is small in every one-second slice and large
 * across two and a half seconds, and only the second measurement sees it.
 */
export function colorDelta(
  st: JoltState,
  now: number,
  thumb: Uint8ClampedArray,
): number | null {
  let best: number | null = null;
  for (const ageMs of COLOR_LOOKBACKS_MS) {
    const past = thumbAt(st, now, ageMs);
    if (!past) continue;
    const d = blockMaxDelta(thumb, past);
    if (best === null || d > best) best = d;
  }
  return best;
}

/** Median absolute deviation: the median distance from the median. Robust to
 *  the very outliers this is trying to detect, which a standard deviation is
 *  not — one big change would inflate sigma and hide the next one. */
export function mad(xs: number[]): number {
  if (!xs.length) return NaN;
  const m = median(xs);
  return median(xs.map((x) => Math.abs(x - m)));
}

/** Record a colour delta. Null deltas (trace too short) are not recorded. */
export function pushColor(st: JoltState, now: number, delta: number | null): void {
  if (delta === null) return;
  st.colorTrace.push([now, delta]);
  while (st.colorTrace.length && now - st.colorTrace[0][0] > COLOR_BASELINE_MS) {
    st.colorTrace.shift();
  }
}

/**
 * The colour delta a jolt has to beat right now: `median + k * MAD` over the
 * trailing window, floored so a near-static screen cannot jolt on noise.
 *
 * This replaced a fixed 0.34 (260802) because a fixed number cannot be right
 * for two games at once, and measurement showed how badly. Over the Valorant
 * clip the block-max delta has a MEDIAN of 0.313 and a p95 of 0.520: continuous
 * camera movement in a shooter sits exactly where a room change sits in a calm
 * game. At 0.34 the arm was over threshold on 38% of steps and every "event" it
 * raised was really just the refractory period expiring, six of them spaced
 * almost exactly 20 s apart. Any absolute number low enough to catch a doorway
 * in a quiet game is a number this footage clears constantly.
 *
 * Measuring against the screen's OWN recent behaviour fixes both ends: in a
 * frantic scene the bar rises with the noise, and in a calm one it drops far
 * enough that walking into a different room is a large change again.
 */
export function colorThreshold(st: JoltState, th: JoltThresholds): number {
  if (st.colorTrace.length < 8) return th.colorFloor;
  const xs = st.colorTrace.map((c) => c[1]);
  return Math.max(th.colorFloor, median(xs) + th.colorMad * mad(xs));
}

export interface JoltThresholds {
  /** dB above the trailing median. */
  gainDb: number;
  /** How many MADs above the trailing median colour delta counts as a jolt. */
  colorMad: number;
  /** Absolute floor for the colour threshold, 0..1. */
  colorFloor: number;
  /** Minimum gap between two GAIN jolts. The colour arm has its own, below. */
  refractoryMs: number;
  /**
   * Minimum gap between two COLOUR jolts. Defaults to COLOR_REFRACTORY_MS,
   * which is where the reasoning is; it is a field at all so the offline sim
   * can sweep it without editing this file.
   *
   * Optional rather than required so the one caller that builds this from the
   * shared constants keeps compiling, and so the two arms are not accidentally
   * re-coupled by a caller that fills in the same number for both.
   */
  colorRefractoryMs?: number;
}

/**
 * The local wake: a discontinuity large enough that no model is needed to
 * confirm it. Returns the arm that fired and stamps THAT arm's refractory
 * period, or null.
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
  const delta = colorDelta(st, now, thumb);
  // The bar is read BEFORE the current sample joins the trace, so a change
  // cannot raise the threshold it is about to be judged against, and the trace
  // is updated BEFORE any early return, so the baseline keeps tracking the
  // screen through a refractory period. Get either of those backwards and the
  // first decision after a jolt is made against a 20-second-old idea of what
  // this screen normally does.
  const bar = colorThreshold(st, th);
  pushColor(st, now, delta);

  if (!warmedUp(st, now)) return null;

  // Two clocks and two periods. The per-arm clocks stop the arms silencing each
  // other; the per-arm periods are because "the picture changed" recurs on a
  // different timescale from "something was loud", and one number for both made
  // the colour arm's rate a property of the gain arm's taste.
  const colorRefractory = th.colorRefractoryMs ?? COLOR_REFRACTORY_MS;

  if (now - st.lastGainAt >= th.refractoryMs && gainJump(st) >= th.gainDb) {
    st.lastGainAt = now;
    return 'gain';
  }
  if (now - st.lastColorAt >= colorRefractory && delta !== null && delta >= bar) {
    st.lastColorAt = now;
    return 'color';
  }
  return null;
}
