/**
 * Maia-3 move vocabulary: 4352 indices.
 *
 * Layout (matches get_all_possible_moves() in the official CSSLab/maia3
 * repo, and verified byte-identical to the reference deployment's ordering):
 *   [0, 4096)    from-square * 64 + to-square, for every from/to pair
 *                (identity pairs included), square index = rank * 8 + file
 *                (a1 = 0, h8 = 63).
 *   [4096, 4352) white promotions, 7th -> 8th rank, full from-file x to-file
 *                8x8 cartesian (illegal jumps included), pieces in order
 *                q, r, b, n. Black promotions are handled by mirroring the
 *                board to white's perspective before encoding.
 */

const FILES = 'abcdefgh';
const PROMO_PIECES = ['q', 'r', 'b', 'n'];

/** @param {number} i square index 0..63 (rank*8+file) */
export function squareName(i) {
  return FILES[i % 8] + (Math.floor(i / 8) + 1);
}

function buildVocab() {
  /** @type {Record<string, number>} */
  const toIndex = {};
  /** @type {string[]} */
  const toUci = new Array(4352);
  let idx = 0;
  for (let from = 0; from < 64; from++) {
    for (let to = 0; to < 64; to++) {
      const uci = squareName(from) + squareName(to);
      toIndex[uci] = idx;
      toUci[idx] = uci;
      idx++;
    }
  }
  for (let fromFile = 0; fromFile < 8; fromFile++) {
    for (let toFile = 0; toFile < 8; toFile++) {
      for (const p of PROMO_PIECES) {
        const uci = FILES[fromFile] + '7' + FILES[toFile] + '8' + p;
        toIndex[uci] = idx;
        toUci[idx] = uci;
        idx++;
      }
    }
  }
  return { toIndex, toUci, size: idx };
}

const vocab = buildVocab();

export const MOVE_VOCAB_SIZE = vocab.size;

/** UCI move string -> vocab index (white-perspective moves only). */
export function moveToIndex(uci) {
  return vocab.toIndex[uci];
}

/** Vocab index -> UCI move string (white perspective). */
export function indexToMove(index) {
  return vocab.toUci[index];
}
