/**
 * The adaptive threshold is the reason backseat can aim for "about a quarter of
 * grids are interesting" without hardcoding a rate. These cover the property
 * that matters: the cutoff tracks the DISTRIBUTION it is shown, so a model that
 * answers in a narrow high band and one that spreads out both end up letting
 * roughly the target share through.
 */
import { describe, it, expect } from 'vitest';
import { thresholdFor, scoreFromLogprobs } from './salienceGate';

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

/**
 * Regression: DeepInfra's actual response shape, captured live 260728.
 *
 * It honours `logprobs` but IGNORES `top_logprobs`, so only the CHOSEN token's
 * logprob comes back. The first implementation read `top_logprobs` only and
 * silently fell through to a hard 0/1, which measured as catastrophic: against
 * a matched pair of real grids the model emitted "no" for BOTH, so the gate
 * would have been permanently silent while the underlying scores (0.018 vs
 * 0.148) separated cleanly. The continuous score is the whole feature.
 */
describe('scoreFromLogprobs', () => {
  const di = (token: string, logprob: number) => ({
    message: { content: token },
    logprobs: { content: [{ token, logprob }] },
  });

  it('reads the chosen-token logprob when top_logprobs is absent', () => {
    // Live capture: "Yes" at -0.769 => p 0.463.
    expect(scoreFromLogprobs(di('Yes', -0.7692177891731262))).toBeCloseTo(0.4635, 3);
  });

  it('inverts a "no" so the scale stays oriented toward yes', () => {
    // A confident no must score LOW, not high.
    expect(scoreFromLogprobs(di('no', -0.02))).toBeLessThan(0.05);
    // A hesitant no scores higher than a confident one: the ordering that the
    // adaptive quantile actually consumes.
    expect(scoreFromLogprobs(di('no', -0.16))).toBeGreaterThan(
      scoreFromLogprobs(di('no', -0.02)) as number,
    );
  });

  it('separates the measured static and changing grids', () => {
    // The real numbers from the live run, three repeats each.
    const staticGrid = scoreFromLogprobs(di('no', -0.0188)) as number;
    const changeGrid = scoreFromLogprobs(di('no', -0.1602)) as number;
    expect(changeGrid).toBeGreaterThan(staticGrid);
    // Both emitted "no", so a text-only gate collapses them to the same value
    // and never fires. This is the regression that matters.
    expect(staticGrid).not.toBe(changeGrid);
  });

  it('still prefers top_logprobs when a provider does return them', () => {
    expect(
      scoreFromLogprobs({
        message: { content: 'yes' },
        logprobs: {
          content: [
            {
              token: 'yes',
              logprob: -0.2,
              top_logprobs: [
                { token: 'yes', logprob: Math.log(0.8) },
                { token: 'no', logprob: Math.log(0.2) },
              ],
            },
          ],
        },
      }),
    ).toBeCloseTo(0.8, 5);
  });

  it('falls back to the emitted word when there are no logprobs at all', () => {
    expect(scoreFromLogprobs({ message: { content: 'yes' } })).toBe(1);
    expect(scoreFromLogprobs({ message: { content: 'no' } })).toBe(0);
    expect(scoreFromLogprobs({ message: { content: 'maybe' } })).toBeNull();
  });
});
