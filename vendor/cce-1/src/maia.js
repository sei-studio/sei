/**
 * Maia-3 ONNX runner: Elo-conditioned human move distributions.
 *
 * The model is exported from the official Maia-3 release (CSSLab/maia3,
 * AGPL-3.0; checkpoints at huggingface.co/UofTCSSLab) by
 * scripts/export-maia3.py, which bakes the reference engine's
 * repeat-current-position history padding into the graph. Contract:
 *   inputs  tokens f32 [batch, 64, 12], elo_self f32 [batch], elo_oppo f32 [batch]
 *   outputs logits_move [batch, 4352], logits_value [batch, 3] (L/D/W, side to move)
 * Elo is a raw continuous float (the model interpolates between two learned
 * embeddings); we clamp to the 600-2600 range the deployment is rated for.
 */

import { Chess } from 'chess.js';
import { boardTokens, mirrorFen, mirrorMove } from './encode.js';
import { moveToIndex, MOVE_VOCAB_SIZE } from './vocab.js';

/** The Elo range the model has actually seen; outside it we clamp. */
export const MAIA_ELO_MIN = 600;
export const MAIA_ELO_MAX = 2600;

export function clampMaiaElo(elo) {
  return Math.min(MAIA_ELO_MAX, Math.max(MAIA_ELO_MIN, elo));
}

export class MaiaModel {
  /** @param {object} session an onnxruntime InferenceSession */
  /** @param {object} ort the onnxruntime module (for Tensor construction) */
  constructor(ort, session) {
    this.ort = ort;
    this.session = session;
  }

  /**
   * Load the model from a file path.
   * onnxruntime-node is imported lazily so consumers that never run
   * inference (e.g. the calibration report reader) don't pay for it.
   */
  static async load(modelPath) {
    const ort = await import('onnxruntime-node');
    const session = await ort.InferenceSession.create(modelPath);
    return new MaiaModel(ort, session);
  }

  /**
   * Human move probability distribution for the side to move.
   *
   * @param {string} fen position to evaluate
   * @param {number} eloSelf rating of the side to move (clamped to 600-2600)
   * @param {number} [eloOppo] rating of the opponent, defaults to eloSelf
   * @returns {Promise<{moves: Array<{uci: string, p: number}>, win: number}>}
   *   moves sorted by probability descending, in the ORIGINAL orientation
   *   (mirrored back for black); win = P(side that owns the fen's move wins),
   *   expressed for white like the rest of the engine: P(white wins) + 0.5 draws.
   */
  async policy(fen, eloSelf, eloOppo = eloSelf) {
    const blackToMove = fen.split(' ')[1] === 'b';
    const whiteFen = blackToMove ? mirrorFen(fen) : fen;

    const chess = new Chess(whiteFen);
    const legal = chess.moves({ verbose: true });
    if (legal.length === 0) throw new Error(`no legal moves in ${fen}`);

    const feeds = {
      tokens: new this.ort.Tensor('float32', boardTokens(whiteFen), [1, 64, 12]),
      elo_self: new this.ort.Tensor(
        'float32',
        Float32Array.from([clampMaiaElo(eloSelf)]),
        [1],
      ),
      elo_oppo: new this.ort.Tensor(
        'float32',
        Float32Array.from([clampMaiaElo(eloOppo)]),
        [1],
      ),
    };

    const out = await this.session.run(feeds);
    const logits = out.logits_move.data;
    if (logits.length !== MOVE_VOCAB_SIZE) {
      throw new Error(`unexpected logits_move size ${logits.length}`);
    }
    const wdl = out.logits_value.data; // [loss, draw, win] for side to move

    // Softmax over legal moves only.
    const entries = legal.map((m) => {
      const uci = m.from + m.to + (m.promotion ?? '');
      return { uci, logit: logits[moveToIndex(uci)] };
    });
    const maxLogit = Math.max(...entries.map((e) => e.logit));
    let sum = 0;
    for (const e of entries) {
      e.exp = Math.exp(e.logit - maxLogit);
      sum += e.exp;
    }
    const moves = entries
      .map((e) => ({
        uci: blackToMove ? mirrorMove(e.uci) : e.uci,
        p: e.exp / sum,
      }))
      .sort((a, b) => b.p - a.p);

    const maxWdl = Math.max(wdl[0], wdl[1], wdl[2]);
    const [eL, eD, eW] = [wdl[0], wdl[1], wdl[2]].map((x) => Math.exp(x - maxWdl));
    let win = (eW + 0.5 * eD) / (eL + eD + eW);
    if (blackToMove) win = 1 - win; // express as P(white)

    return { moves, win };
  }

  async dispose() {
    await this.session.release?.();
  }
}
