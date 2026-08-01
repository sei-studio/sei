/**
 * The image-grid geometry is the one thing in backseat that fails SILENTLY if
 * it drifts: an oversized grid is not rejected by the API, it is downscaled
 * server-side, so the only symptom is the companion quietly getting worse at
 * reading the screen. These assertions pin it to what Haiku 4.5 can actually
 * see, and to what IG-VLM (arXiv 2403.18406) found works.
 */
import { describe, it, expect } from 'vitest';
import {
  BUFFER_MS,
  CELL_H,
  CELL_W,
  GRID_COLS,
  GRID_FRAMES,
  GRID_H,
  GRID_OFFSETS_S,
  GRID_ROWS,
  GRID_SPAN_MS,
  GRID_VISUAL_TOKENS,
  GRID_W,
  CAPTURE_H,
  CAPTURE_W,
  IDLE_MAX_MS,
  IDLE_MEAN_EXTRA_MS,
  IDLE_MIN_MS,
  MIN_SPEAK_GAP_MS,
  nextIdleDelayMs,
  SAMPLE_INTERVAL_MS,
} from './backseatIpc';

/** Claude's documented cost: one visual token per 28x28 patch. */
const tokensFor = (w: number, h: number): number => Math.ceil(w / 28) * Math.ceil(h / 28);

/** Haiku 4.5 is a STANDARD-tier vision model. */
const STANDARD_MAX_LONG_EDGE = 1568;
const STANDARD_MAX_TOKENS = 1568;

describe('backseat image grid', () => {
  it('is the 6-frame 3x2 layout IG-VLM found best', () => {
    // N=6 beat 4/9/12/16/20 in the paper's ablation, and near-square grids beat
    // wide ones — which for 16:9 cells means 3 rows of 2, not 2 rows of 3.
    expect(GRID_FRAMES).toBe(6);
    expect(GRID_ROWS).toBe(3);
    expect(GRID_COLS).toBe(2);
    expect(GRID_ROWS * GRID_COLS).toBe(GRID_FRAMES);
  });

  it('stays inside what Haiku can see, so it is never downscaled server-side', () => {
    expect(Math.max(GRID_W, GRID_H)).toBeLessThanOrEqual(STANDARD_MAX_LONG_EDGE);
    expect(tokensFor(GRID_W, GRID_H)).toBeLessThanOrEqual(STANDARD_MAX_TOKENS);
    expect(GRID_VISUAL_TOKENS).toBe(tokensFor(GRID_W, GRID_H));
  });

  it('uses as much of the token budget as the aspect ratio allows', () => {
    // Guards the other direction: a grid well under the cap is throwing away
    // resolution the model was willing to look at for free. Anything smaller
    // than 95% of the budget means the sizing math has drifted.
    expect(GRID_VISUAL_TOKENS).toBeGreaterThan(STANDARD_MAX_TOKENS * 0.95);
  });

  it('lands on exact patch boundaries', () => {
    // A grid whose dimensions are not multiples of 28 pays for a partial patch
    // row/column that carries almost no image.
    expect(GRID_W % 28).toBe(0);
    expect(GRID_H % 28).toBe(0);
  });

  it('tiles the cells exactly, with no rounding gap', () => {
    expect(CELL_W * GRID_COLS).toBe(GRID_W);
    expect(CELL_H * GRID_ROWS).toBe(GRID_H);
  });

  it('keeps cells close to the capture aspect ratio', () => {
    // The compositor letterboxes rather than stretches, so a cell far from the
    // source ratio just wastes pixels on bars.
    const cell = CELL_W / CELL_H;
    const source = CAPTURE_W / CAPTURE_H;
    expect(Math.abs(cell - source) / source).toBeLessThan(0.02);
  });

  it('spans back to its oldest offset', () => {
    expect(GRID_SPAN_MS).toBe(GRID_OFFSETS_S[0] * 1000);
  });
});

describe('frame offsets', () => {
  it('has exactly one offset per cell', () => {
    expect(GRID_OFFSETS_S).toHaveLength(GRID_FRAMES);
  });

  it('runs oldest to newest, which is the order the prompt describes', () => {
    // The compositor fills row-first from GRID_OFFSETS_S[0], and the contract
    // tells the model the top-left is the oldest. A table that is not strictly
    // descending would make that sentence a lie.
    for (let i = 1; i < GRID_OFFSETS_S.length; i++) {
      expect(GRID_OFFSETS_S[i]).toBeLessThan(GRID_OFFSETS_S[i - 1]);
    }
  });

  it('is resolvable at the ring sample rate', () => {
    // The whole point of log spacing is that consecutive cells are
    // distinguishable. If the tightest gap ever drops below the sample
    // interval, two cells can resolve to the SAME sample and the grid silently
    // shows five moments instead of six.
    let tightest = Infinity;
    for (let i = 1; i < GRID_OFFSETS_S.length; i++) {
      tightest = Math.min(tightest, (GRID_OFFSETS_S[i - 1] - GRID_OFFSETS_S[i]) * 1000);
    }
    expect(tightest).toBeGreaterThan(SAMPLE_INTERVAL_MS);
  });

  it('fits inside the ring, with slack for composite latency', () => {
    expect(GRID_SPAN_MS).toBeLessThan(BUFFER_MS);
  });
});

describe('nextIdleDelayMs', () => {
  /** Deterministic uniforms for the inverse-CDF draw. */
  const seq = (...xs: number[]): (() => number) => {
    let i = 0;
    return () => xs[i++ % xs.length];
  };

  it('never draws outside the configured range', () => {
    // Including the endpoints of the uniform, where the inverse CDF blows up:
    // u=0 gives the floor exactly, u->1 gives infinity and must be clamped.
    for (const u of [0, 0.001, 0.5, 0.999, 0.999999]) {
      const d = nextIdleDelayMs(seq(u));
      expect(d).toBeGreaterThanOrEqual(IDLE_MIN_MS);
      expect(d).toBeLessThanOrEqual(IDLE_MAX_MS);
    }
    expect(nextIdleDelayMs(seq(0))).toBe(IDLE_MIN_MS);
  });

  it('is memoryless past the floor, not uniform', () => {
    // The property the distribution was chosen for: a constant hazard rate, so
    // the player cannot learn the rhythm. Under a uniform draw the median would
    // sit at the midpoint of the range; under this one it sits far below it.
    const draws: number[] = [];
    let state = 12345;
    for (let i = 0; i < 20_000; i++) {
      // xorshift, so the assertion below is deterministic across machines.
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      draws.push(nextIdleDelayMs(() => ((state >>> 0) % 1_000_000) / 1_000_000));
    }
    draws.sort((a, b) => a - b);
    const median = draws[Math.floor(draws.length / 2)];
    const mean = draws.reduce((a, b) => a + b, 0) / draws.length;
    const midpoint = (IDLE_MIN_MS + IDLE_MAX_MS) / 2;

    expect(median).toBeLessThan(midpoint);
    // Mean of a shifted exponential is floor + scale, pulled down a little by
    // the clamp at the ceiling.
    expect(mean).toBeGreaterThan(IDLE_MIN_MS + IDLE_MEAN_EXTRA_MS * 0.8);
    expect(mean).toBeLessThan(IDLE_MIN_MS + IDLE_MEAN_EXTRA_MS * 1.1);
    // And the tail is real: some looks genuinely wait the full ceiling.
    expect(draws.filter((d) => d === IDLE_MAX_MS).length).toBeGreaterThan(0);
  });

  it('cannot fire faster than the companion is allowed to speak', () => {
    // An idle look sooner than MIN_SPEAK_GAP_MS would be composited, sent, and
    // dropped by the service for nothing.
    expect(IDLE_MIN_MS).toBeGreaterThan(MIN_SPEAK_GAP_MS);
  });
});
