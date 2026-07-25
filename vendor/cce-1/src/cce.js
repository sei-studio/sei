/**
 * Character Chess Engine: skill-conditioned candidate generation.
 *
 * Pipeline per position (the paper's architecture):
 *   Elo-adjusted Maia -> tempered Gumbel-top-4 sampler -> Blunder swap ->
 *   Blinder (Stockfish-detected tactic removal) -> per-candidate lookahead
 *   rollouts (alternating Maia at persona Elo/temperature) -> translation
 *   to plain sentences + macro context band.
 *
 * Strength is fully determined here; the LLM downstream can only express
 * style by choosing among rating-appropriate candidates.
 */

import { Chess } from 'chess.js';
import { MaiaModel } from './maia.js';
import { StockfishEngine } from './stockfish.js';
import { resolveProfile } from './profile.js';
import { gumbelTopK, sampleBottomTail, sampleOne } from './sampler.js';
import { describeCandidate } from './translate.js';
import { cpToWin, macroText, materialCount, winBand } from './macro.js';

/** A forced mate this short, or an eval gap this wide, counts as a tactic. */
const TACTIC_MATE_PLIES = 3;
const TACTIC_CP_GAP = 250;
const SF_DEPTH = 12;

export class CharacterChessEngine {
  constructor({ maia, stockfish, rng }) {
    this.maia = maia;
    this.stockfish = stockfish;
    this.rng = rng ?? Math.random;
  }

  /**
   * @param {object} opts
   * @param {string} opts.maiaModelPath path to maia3-5m.onnx
   * @param {() => number} [opts.rng] uniform [0,1) source (seedable for tests)
   */
  static async create({ maiaModelPath, rng }) {
    const [maia, stockfish] = await Promise.all([
      MaiaModel.load(maiaModelPath),
      StockfishEngine.create(),
    ]);
    return new CharacterChessEngine({ maia, stockfish, rng });
  }

  /**
   * Generate the 4-move natural-language candidate set for a position.
   *
   * @param {string} fen position with the character to move
   * @param {object} profileInput at minimum { elo }
   * @returns {Promise<{
   *   profile: object,
   *   toMove: 'w'|'b',
   *   macro: { text: string, band: {lo: number, hi: number} },
   *   candidates: Array<{
   *     uci: string, san: string, sentence: string, tags: string[],
   *     line: { sans: string[], sentence: string } | null
   *   }>,
   *   think: { top1P: number, entropy: number, evalGapCp: number|null },
   * }>}
   */
  async candidateSet(fen, profileInput) {
    const profile = resolveProfile(profileInput);
    const chess = new Chess(fen);
    if (chess.isGameOver()) throw new Error('game is already over');
    const toMove = chess.turn();

    // 1. Elo-adjusted Maia distribution (elo_oppo = elo_self, per the paper).
    const { moves: dist } = await this.maia.policy(fen, profile.elo);

    // 2. Tempered Gumbel-top-k candidate sample.
    const sampleOpts = {
      temperature: profile.temperature,
      probFloor: profile.probFloor,
      rng: this.rng,
    };
    let candidates = gumbelTopK(dist, {
      k: Math.min(profile.candidateCount, dist.length),
      ...sampleOpts,
    });

    // 3. Blunder: swap one candidate for a bottom-tail move.
    if (this.rng() < profile.blunderProb && dist.length > candidates.length) {
      const swap = sampleBottomTail(dist, {
        exclude: new Set(candidates.map((c) => c.uci)),
        rng: this.rng,
      });
      if (swap) {
        const slot = Math.floor(this.rng() * candidates.length);
        candidates = candidates.map((c, i) => (i === slot ? swap : c));
      }
    }

    // 4. Stockfish look (shared by the blinder and the macro band).
    const analysis = await this.stockfish.analyze(fen, {
      multipv: 2,
      depth: SF_DEPTH,
    });
    const best = analysis[0];
    const second = analysis[1];

    // 5. Blinder: with Elo-scaled probability, fail to see the tactic.
    if (best) {
      const isTactic =
        (best.mate !== null && best.mate > 0 && best.mate <= TACTIC_MATE_PLIES) ||
        (best.cp !== null &&
          second?.cp !== null &&
          second !== undefined &&
          best.cp - second.cp >= TACTIC_CP_GAP);
      const seen = candidates.some((c) => c.uci === best.uci);
      if (isTactic && seen && this.rng() < profile.blinderProb) {
        const replacement = gumbelTopK(
          dist.filter(
            (m) => m.uci !== best.uci && !candidates.some((c) => c.uci === m.uci),
          ),
          { k: 1, ...sampleOpts },
        )[0];
        candidates = candidates
          .filter((c) => c.uci !== best.uci)
          .concat(replacement ? [replacement] : []);
      }
    }

    // 6. Lookahead: one rollout per candidate, alternating Maia, both sides
    //    conditioned on the persona's Elo and sampled at its temperature.
    //    Depth counts the candidate itself as ply 1.
    const rollouts = [];
    for (const candidate of candidates) {
      const line = [];
      const sim = new Chess(fen);
      sim.move(uciToMoveArg(candidate.uci));
      for (let ply = 1; ply < profile.lookaheadPlies; ply++) {
        if (sim.isGameOver()) break;
        const { moves } = await this.maia.policy(sim.fen(), profile.elo);
        const pick = sampleOne(moves, sampleOpts);
        if (!pick) break;
        line.push(pick.uci);
        sim.move(uciToMoveArg(pick.uci));
      }
      rollouts.push(line);
    }

    // 7. Translation to plain sentences.
    const described = candidates.map((c, i) => ({
      uci: c.uci,
      ...describeCandidate(fen, c.uci, rollouts[i]),
    }));

    // 8. Macro context band.
    const engineWinWhite = best
      ? best.mate !== null
        ? sideWinFromMate(best.mate, toMove)
        : cpToWin(toMove === 'w' ? best.cp : -best.cp)
      : 0.5;
    const band = winBand({
      engineWin: engineWinWhite,
      materialDiff: materialCount(fen).diff,
      bandHalfWidth: profile.bandHalfWidth,
      materialShiftWeight: profile.materialShiftWeight,
      perspective: toMove,
    });

    return {
      profile,
      toMove,
      macro: { text: macroText(fen, band, toMove), band },
      candidates: described,
      think: {
        top1P: dist[0]?.p ?? 0,
        entropy: normalizedEntropy(dist),
        evalGapCp:
          best?.cp !== null && best !== undefined && second?.cp !== null && second !== undefined
            ? Math.abs(best.cp - second.cp)
            : null,
      },
    };
  }

  async dispose() {
    this.stockfish.dispose();
    await this.maia.dispose();
  }
}

/**
 * Shannon entropy of the human move distribution, normalized to 0..1 by the
 * uniform-distribution maximum. High = a human genuinely has many plausible
 * choices here (long think); low = one move dominates (quick reply). Consumed
 * by hosts simulating human thinking time (`think` in candidateSet output).
 */
function normalizedEntropy(dist) {
  const ps = dist.map((m) => m.p).filter((p) => p > 0);
  if (ps.length <= 1) return 0;
  const h = -ps.reduce((sum, p) => sum + p * Math.log(p), 0);
  return Math.min(1, h / Math.log(ps.length));
}

function uciToMoveArg(uci) {
  return {
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    promotion: uci.length > 4 ? uci[4] : undefined,
  };
}

/** Mate score (side to move perspective) -> P(white wins). */
function sideWinFromMate(mate, toMove) {
  const sideWins = mate > 0 ? 0.99 : 0.01;
  return toMove === 'w' ? sideWins : 1 - sideWins;
}
