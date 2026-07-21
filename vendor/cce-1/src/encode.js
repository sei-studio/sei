/**
 * Board encoding for Maia-3 ONNX inference.
 *
 * The model only understands positions from white's perspective: when it is
 * black to move, the FEN is mirrored (ranks flipped, piece colors swapped,
 * castling rights swapped, en-passant square mirrored) and predicted moves
 * are mirrored back. Tokens are a flat (64, 12) one-hot: token index =
 * square * 12 + pieceIndex, with square = rank * 8 + file (a1 = 0) and piece
 * order P N B R Q K p n b r q k. The simplified model has no turn, castling,
 * or en-passant channels.
 */

const PIECE_ORDER = ['P', 'N', 'B', 'R', 'Q', 'K', 'p', 'n', 'b', 'r', 'q', 'k'];

/** Mirror a square name vertically (a2 -> a7). */
export function mirrorSquare(square) {
  return square[0] + String(9 - Number(square[1]));
}

/** Mirror a UCI move vertically, preserving any promotion suffix. */
export function mirrorMove(uci) {
  return (
    mirrorSquare(uci.slice(0, 2)) + mirrorSquare(uci.slice(2, 4)) + uci.slice(4)
  );
}

/**
 * Mirror a FEN vertically while swapping piece colors, so a black-to-move
 * position becomes an equivalent white-to-move position.
 */
export function mirrorFen(fen) {
  const [position, activeColor, castling, enPassant, halfmove, fullmove] =
    fen.split(' ');

  const mirroredRanks = position
    .split('/')
    .reverse()
    .map((rank) =>
      [...rank]
        .map((ch) =>
          /[A-Z]/.test(ch) ? ch.toLowerCase() : /[a-z]/.test(ch) ? ch.toUpperCase() : ch,
        )
        .join(''),
    );

  let mirroredCastling = '-';
  if (castling !== '-') {
    const rights = new Set(castling);
    let out = '';
    if (rights.has('k')) out += 'K';
    if (rights.has('q')) out += 'Q';
    if (rights.has('K')) out += 'k';
    if (rights.has('Q')) out += 'q';
    mirroredCastling = out || '-';
  }

  const mirroredEp = enPassant !== '-' ? mirrorSquare(enPassant) : '-';
  const mirroredActive = activeColor === 'w' ? 'b' : 'w';

  return `${mirroredRanks.join('/')} ${mirroredActive} ${mirroredCastling} ${mirroredEp} ${halfmove} ${fullmove}`;
}

/**
 * Encode a white-to-move FEN into flat (64, 12) Maia-3 tokens.
 * @returns {Float32Array} length 768
 */
export function boardTokens(fen) {
  const tokens = new Float32Array(64 * 12);
  const rows = fen.split(' ')[0].split('/');
  for (let rank = 0; rank < 8; rank++) {
    const row = 7 - rank; // FEN lists rank 8 first
    let file = 0;
    for (const ch of rows[rank]) {
      const n = parseInt(ch, 10);
      if (Number.isNaN(n)) {
        const pieceIdx = PIECE_ORDER.indexOf(ch);
        if (pieceIdx >= 0) tokens[(row * 8 + file) * 12 + pieceIdx] = 1;
        file += 1;
      } else {
        file += n;
      }
    }
  }
  return tokens;
}
