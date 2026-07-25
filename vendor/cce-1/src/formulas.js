/**
 * Elo-conditioned skill formulas from the CCE-1 paper, adapted to Maia-3.
 *
 * The paper's temperature formula assumed Maia-2's 1100 calibration floor;
 * the Maia-3 export is trained down to 600, so tempering only has to cover
 * 400-600. All constants are empirical placeholders in the paper's spirit
 * ("all constants are tuned empirically") and are centralized here so the
 * calibration harness can sweep them.
 */

export const CONSTANTS = {
  /** Elo below which the sampling temperature rises above 1. */
  tempFloorElo: 600,
  /** Temperature reached at Elo 400. */
  tempAt400: 2,
  /** Raw-probability floor applied before tempering (paper: 1 percent). */
  probFloor: 0.01,
  /** Candidate set size. */
  candidateCount: 4,
  /** Blunder: P(Elo) = bMax * exp(-(Elo - 400) / bLambda). */
  blunderMax: 0.9,
  blunderLambda: 300,
  /** Blinder: P(Elo) = 1 - sigmoid((Elo - mu) / s). */
  blinderMu: 1200,
  blinderS: 200,
  /** Win-probability band half-width: full range at 400, ~5 points at 2000. */
  bandHalfWidthAt400: 0.5,
  bandHalfWidthAt2000: 0.025,
  /** Weight of the naive material-only eval in the band center at Elo 400. */
  materialShiftAt400: 0.8,
  /** Elo at and above which the band center is purely the engine estimate. */
  materialShiftZeroElo: 1600,
};

/** Sampling temperature. 1 inside Maia's calibrated range, rising below it. */
export function temperature(elo, c = CONSTANTS) {
  const slope = (c.tempAt400 - 1) / (c.tempFloorElo - 400);
  return 1 + Math.max(0, (c.tempFloorElo - elo) * slope);
}

/** Probability that one candidate is swapped for a bottom-tail move. */
export function blunderProb(elo, c = CONSTANTS) {
  return Math.min(1, c.blunderMax * Math.exp(-(elo - 400) / c.blunderLambda));
}

/** Probability that a Stockfish-visible tactic is removed from the set. */
export function blinderProb(elo, c = CONSTANTS) {
  const sigmoid = 1 / (1 + Math.exp(-(elo - c.blinderMu) / c.blinderS));
  return 1 - sigmoid;
}

/** Lookahead depth in plies: clip(floor(Elo / 250), 1, 8). */
export function lookaheadPlies(elo) {
  return Math.min(8, Math.max(1, Math.floor(elo / 250)));
}

/** Half-width of the shown win-probability band. */
export function bandHalfWidth(elo, c = CONSTANTS) {
  const t = (elo - 400) / (2000 - 400);
  const clamped = Math.min(1, Math.max(0, t));
  return (
    c.bandHalfWidthAt400 +
    (c.bandHalfWidthAt2000 - c.bandHalfWidthAt400) * clamped
  );
}

/**
 * How far the band center shifts from the engine estimate toward a naive
 * material-only evaluation. Weak players are confidently wrong, not just
 * uncertain.
 * @returns {number} weight in [0, 1] given to the material eval
 */
export function materialShiftWeight(elo, c = CONSTANTS) {
  const t = (c.materialShiftZeroElo - elo) / (c.materialShiftZeroElo - 400);
  return c.materialShiftAt400 * Math.min(1, Math.max(0, t));
}
