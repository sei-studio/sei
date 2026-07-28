/**
 * The adaptive threshold is the reason backseat can aim for "about a quarter of
 * grids are interesting" without hardcoding a rate. These cover the property
 * that matters: the cutoff tracks the DISTRIBUTION it is shown, so a model that
 * answers in a narrow high band and one that spreads out both end up letting
 * roughly the target share through.
 */
import { describe, it, expect } from 'vitest';
import { thresholdFor } from './salienceGate';

/** Share of `scores` that would pass the threshold derived from them. */
function passRate(scores: number[]): number {
  const t = thresholdFor(scores);
  return scores.filter((s) => s >= t).length / scores.length;
}

describe('salience gate threshold', () => {
  it('uses the warmup cutoff until it has seen enough', () => {
    expect(thresholdFor([])).toBe(0.55);
    expect(thresholdFor([0.9, 0.9, 0.9])).toBe(0.55);
  });

  it('passes roughly a quarter of a well-spread distribution', () => {
    const scores = Array.from({ length: 40 }, (_, i) => i / 40);
    expect(passRate(scores)).toBeGreaterThan(0.15);
    expect(passRate(scores)).toBeLessThan(0.35);
  });

  it('still separates when the model crowds every score into a narrow band', () => {
    // The documented small-VLM failure: verbalized confidence sits at 0.87-0.90
    // whatever the truth. An absolute cutoff either passes all of these or none;
    // a quantile of the observed window keeps picking the top slice.
    const scores = Array.from({ length: 40 }, (_, i) => 0.87 + (i / 40) * 0.03);
    const t = thresholdFor(scores);
    expect(t).toBeGreaterThan(0.87);
    expect(t).toBeLessThan(0.9);
    expect(passRate(scores)).toBeGreaterThan(0.15);
    expect(passRate(scores)).toBeLessThan(0.35);
  });

  it('adapts when the activity changes rather than staying pinned', () => {
    const calm = Array.from({ length: 40 }, () => 0.1 + Math.random() * 0.1);
    const frantic = Array.from({ length: 40 }, () => 0.7 + Math.random() * 0.2);
    expect(thresholdFor(calm)).toBeLessThan(thresholdFor(frantic));
  });

  it('clamps so a degenerate window cannot wedge the gate open or shut', () => {
    // A static menu screen: every grid scores identically.
    expect(thresholdFor(Array(40).fill(1))).toBeLessThanOrEqual(0.95);
    expect(thresholdFor(Array(40).fill(0))).toBeGreaterThanOrEqual(0.15);
  });
});
