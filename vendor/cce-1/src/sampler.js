/**
 * Gumbel-top-k sampling over the tempered Maia distribution.
 *
 * s(m) = log p(m) / T + g_m, g_m ~ Gumbel(0, 1); keeping the top k equals
 * sequential sampling without replacement from q(m) proportional to p(m)^(1/T).
 * Moves below the raw probability floor are dropped BEFORE tempering so the
 * flattening spreads mass over bad-but-human moves, not the full legal tail.
 */

/** Deterministic 32-bit PRNG for tests and reproducible games. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gumbel(rng) {
  // Inverse CDF; clamp away from 0 to avoid -Infinity.
  const u = Math.max(rng(), 1e-12);
  return -Math.log(-Math.log(u));
}

/**
 * @param {Array<{uci: string, p: number}>} dist move distribution (p sums to 1)
 * @param {object} opts
 * @param {number} opts.k number of moves to keep
 * @param {number} opts.temperature sampling temperature (>= 1 flattens)
 * @param {number} [opts.probFloor] drop moves with raw p below this (default 0.01)
 * @param {() => number} [opts.rng] uniform [0,1) source, default Math.random
 * @returns {Array<{uci: string, p: number}>} k sampled moves, in sampled order
 */
export function gumbelTopK(dist, { k, temperature, probFloor = 0.01, rng = Math.random }) {
  let pool = dist.filter((m) => m.p >= probFloor);
  // A sharp position can leave fewer than k moves above the floor; refill
  // with the best of the rest so the candidate set stays full when possible.
  if (pool.length < k) {
    const rest = dist
      .filter((m) => m.p < probFloor)
      .sort((a, b) => b.p - a.p)
      .slice(0, k - pool.length);
    pool = pool.concat(rest);
  }

  const scored = pool.map((m) => ({
    move: m,
    score: Math.log(Math.max(m.p, 1e-12)) / temperature + gumbel(rng),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.min(k, scored.length)).map((s) => s.move);
}

/**
 * Sample one move from the tempered distribution (used for rollout plies).
 */
export function sampleOne(dist, { temperature, probFloor = 0.01, rng = Math.random }) {
  return gumbelTopK(dist, { k: 1, temperature, probFloor, rng })[0];
}

/**
 * Sample a move from the bottom tail of the distribution (blunder swaps).
 * The tail is the lowest-probability quarter of legal moves, excluding
 * anything in `exclude`; falls back to the least likely non-excluded move.
 */
export function sampleBottomTail(dist, { exclude = new Set(), rng = Math.random }) {
  const eligible = dist.filter((m) => !exclude.has(m.uci));
  if (eligible.length === 0) return null;
  const sorted = [...eligible].sort((a, b) => a.p - b.p);
  const tail = sorted.slice(0, Math.max(1, Math.floor(sorted.length / 4)));
  return tail[Math.floor(rng() * tail.length)];
}
