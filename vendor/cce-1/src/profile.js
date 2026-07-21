/**
 * Chess profile: the persona config consumed by the engine.
 *
 * Only `elo` is required; every skill parameter derives from it via the
 * paper formulas unless explicitly overridden. `styleNote` is free text the
 * caller can surface to its LLM (aggressive, cautious, loves knights...);
 * the engine itself ignores it — strength is determined here, style is
 * expressed by whoever picks from the candidate set.
 */

import {
  bandHalfWidth,
  blinderProb,
  blunderProb,
  CONSTANTS,
  lookaheadPlies,
  materialShiftWeight,
  temperature,
} from './formulas.js';

export const PROFILE_ELO_MIN = 400;
export const PROFILE_ELO_MAX = 2000;

/**
 * @param {object} input
 * @param {number} input.elo target rating, clamped to 400-2000
 * @param {string} [input.styleNote]
 * @param {number} [input.temperature]
 * @param {number} [input.blunderProb]
 * @param {number} [input.blinderProb]
 * @param {number} [input.lookaheadPlies]
 * @param {number} [input.bandHalfWidth]
 * @param {number} [input.materialShiftWeight]
 * @returns fully resolved profile
 */
export function resolveProfile(input) {
  if (!input || typeof input.elo !== 'number' || Number.isNaN(input.elo)) {
    throw new Error('chess profile requires a numeric elo');
  }
  const elo = Math.min(PROFILE_ELO_MAX, Math.max(PROFILE_ELO_MIN, input.elo));
  const clamp01 = (x) => Math.min(1, Math.max(0, x));
  return {
    elo,
    styleNote: typeof input.styleNote === 'string' ? input.styleNote : '',
    temperature: input.temperature ?? temperature(elo),
    blunderProb: clamp01(input.blunderProb ?? blunderProb(elo)),
    blinderProb: clamp01(input.blinderProb ?? blinderProb(elo)),
    lookaheadPlies: Math.min(
      8,
      Math.max(1, Math.round(input.lookaheadPlies ?? lookaheadPlies(elo))),
    ),
    bandHalfWidth: clamp01(input.bandHalfWidth ?? bandHalfWidth(elo)),
    materialShiftWeight: clamp01(
      input.materialShiftWeight ?? materialShiftWeight(elo),
    ),
    candidateCount: CONSTANTS.candidateCount,
    probFloor: CONSTANTS.probFloor,
  };
}
