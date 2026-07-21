/**
 * Macro context: material count plus a win/draw/loss assessment shown as a
 * probability RANGE, not a confidence score. The band narrows with Elo, and
 * at low Elo its center drifts toward a naive material-only evaluation:
 * weak players are confidently wrong, not just uncertain.
 */

import { Chess } from 'chess.js';

const PIECE_POINTS = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

/** @returns {{ white: number, black: number, diff: number }} points on the board */
export function materialCount(fen) {
  const chess = new Chess(fen);
  let white = 0;
  let black = 0;
  for (const row of chess.board()) {
    for (const cell of row) {
      if (!cell) continue;
      if (cell.color === 'w') white += PIECE_POINTS[cell.type];
      else black += PIECE_POINTS[cell.type];
    }
  }
  return { white, black, diff: white - black };
}

/** Naive win probability for white from material difference alone. */
export function naiveMaterialWin(diff) {
  return 1 / (1 + Math.exp(-diff / 3));
}

/** Centipawns (white perspective) -> P(white wins), lichess curve. */
export function cpToWin(cp) {
  return 0.5 + 0.5 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}

/**
 * Build the shown assessment band.
 *
 * @param {object} opts
 * @param {number} opts.engineWin engine's P(white wins) in [0,1]
 * @param {number} opts.materialDiff white points minus black points
 * @param {number} opts.bandHalfWidth from the resolved profile
 * @param {number} opts.materialShiftWeight from the resolved profile
 * @param {'w'|'b'} opts.perspective whose eyes the band is seen through
 * @returns {{ lo: number, hi: number, center: number }} percentages 0-100,
 *   from `perspective`'s point of view
 */
export function winBand({
  engineWin,
  materialDiff,
  bandHalfWidth,
  materialShiftWeight,
  perspective,
}) {
  const naive = naiveMaterialWin(materialDiff);
  let center = (1 - materialShiftWeight) * engineWin + materialShiftWeight * naive;
  if (perspective === 'b') center = 1 - center;
  // A half-width of 0.5 means total cluelessness: the paper's 400 sees the
  // full 0-100 range regardless of where the center drifted.
  if (bandHalfWidth >= 0.5) {
    return { lo: 0, hi: 100, center: Math.round(center * 100) };
  }
  const lo = Math.max(0, center - bandHalfWidth);
  const hi = Math.min(1, center + bandHalfWidth);
  const pct = (x) => Math.round(x * 20) * 5; // 5-point grid
  return { lo: pct(lo), hi: pct(hi), center: Math.round(center * 100) };
}

/**
 * Render the macro block as plain text for the LLM.
 * @param {string} fen current position
 * @param {{lo: number, hi: number}} band
 * @param {'w'|'b'} perspective
 */
export function macroText(fen, band, perspective) {
  const { white, black } = materialCount(fen);
  const mine = perspective === 'w' ? white : black;
  const theirs = perspective === 'w' ? black : white;
  const materialLine =
    mine === theirs
      ? `Material is even (${mine} points each).`
      : mine > theirs
        ? `You are ahead ${mine - theirs} point${mine - theirs === 1 ? '' : 's'} of material (${mine} vs ${theirs}).`
        : `You are behind ${theirs - mine} point${theirs - mine === 1 ? '' : 's'} of material (${mine} vs ${theirs}).`;
  const bandLine =
    band.lo === 0 && band.hi === 100
      ? 'You honestly cannot tell who is winning.'
      : `Your sense of your winning chances: somewhere between ${band.lo}% and ${band.hi}%.`;
  return `${materialLine} ${bandLine}`;
}
