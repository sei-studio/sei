/**
 * Translation layer: deterministic chess.js tagger that renders moves and
 * imagined lines as plain sentences. The consuming LLM receives these
 * sentences (plus SAN so it can name its move); it never has to parse FEN
 * or long algebraic strings.
 *
 * Known limitation (from the paper): the tags are literal, move-by-move.
 * They do not yet surface strategic texture (aggressive, simplifying,
 * cramping, risky).
 */

import { Chess } from 'chess.js';

const PIECE_NAMES = {
  p: 'pawn',
  n: 'knight',
  b: 'bishop',
  r: 'rook',
  q: 'queen',
  k: 'king',
};

const PIECE_POINTS = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

/**
 * Squares of `color` pieces attacked by the piece now sitting on `square`.
 */
function attackedEnemies(chess, square, byColor) {
  const targets = [];
  for (const row of chess.board()) {
    for (const cell of row) {
      if (!cell || cell.color === byColor) continue;
      if (chess.attackers(cell.square, byColor).includes(square)) {
        targets.push(cell);
      }
    }
  }
  return targets;
}

/** Is the piece on `square` (owned by `color`) capturable favorably? */
function isHanging(chess, square, color) {
  const enemy = color === 'w' ? 'b' : 'w';
  const attackers = chess.attackers(square, enemy);
  if (attackers.length === 0) return false;
  const defenders = chess.attackers(square, color);
  if (defenders.length === 0) return true;
  const victim = chess.get(square);
  const cheapest = Math.min(
    ...attackers.map((sq) => PIECE_POINTS[chess.get(sq)?.type ?? 'q']),
  );
  return cheapest < PIECE_POINTS[victim.type];
}

/**
 * Describe one ply. `mine` is true when the side the candidate belongs to
 * is moving. Mutates `chess` by applying the move.
 * @returns {{ san: string, sentence: string, tags: string[], points: number }}
 *   points = material captured this ply (positive numbers, uncredited side)
 */
function describePly(chess, uci, mine) {
  const subject = mine ? 'you' : 'they';
  const move = chess.move({
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    promotion: uci.length > 4 ? uci[4] : undefined,
  });

  const tags = [];
  const bits = [];
  const piece = PIECE_NAMES[move.piece];

  if (move.san === 'O-O') {
    bits.push(`${subject} castle kingside, tucking the king safe`);
    tags.push('castle');
  } else if (move.san === 'O-O-O') {
    bits.push(`${subject} castle queenside`);
    tags.push('castle');
  } else if (move.captured) {
    const victim = PIECE_NAMES[move.captured];
    const enPassant = move.flags.includes('e');
    bits.push(
      `${subject} take the ${victim}${enPassant ? ' en passant' : ` on ${move.to}`} with ${mine ? 'your' : 'their'} ${piece}`,
    );
    tags.push('capture');
    if (enPassant) tags.push('en-passant');
  } else {
    bits.push(`${subject} move ${mine ? 'your' : 'their'} ${piece} from ${move.from} to ${move.to}`);
  }

  if (move.promotion) {
    bits.push(`promoting to a ${PIECE_NAMES[move.promotion]}`);
    tags.push('promotion');
  }

  if (chess.isCheckmate()) {
    bits.push('delivering checkmate');
    tags.push('checkmate');
  } else if (chess.isCheck()) {
    bits.push('giving check');
    tags.push('check');
  }

  return {
    san: move.san,
    sentence: bits.join(', '),
    tags,
    points: move.captured ? PIECE_POINTS[move.captured] : 0,
  };
}

/**
 * Describe a candidate move plus its imagined continuation.
 *
 * @param {string} fen position the candidate is played from
 * @param {string} candidateUci
 * @param {string[]} rolloutUcis plies AFTER the candidate (alternating sides)
 * @returns {{
 *   san: string, sentence: string, tags: string[],
 *   line: { sans: string[], sentence: string } | null
 * }}
 */
export function describeCandidate(fen, candidateUci, rolloutUcis = []) {
  const chess = new Chess(fen);
  const myColor = chess.turn();

  const first = describePly(chess, candidateUci, true);
  const tags = [...first.tags];
  let sentence = capitalize(first.sentence) + '.';

  // Immediate consequences of the candidate itself.
  if (!tags.includes('checkmate')) {
    const threats = attackedEnemies(chess, candidateUci.slice(2, 4), myColor)
      .filter((cell) => PIECE_POINTS[cell.type] >= 3)
      .sort((a, b) => PIECE_POINTS[b.type] - PIECE_POINTS[a.type]);
    if (threats.length > 0) {
      sentence += ` It threatens their ${PIECE_NAMES[threats[0].type]} on ${threats[0].square}.`;
      tags.push('threat');
    }
    if (isHanging(chess, candidateUci.slice(2, 4), myColor)) {
      sentence += ' The piece could be taken there.';
      tags.push('hangs');
    }
  }

  // Imagined continuation.
  //
  // 260724: this line NO LONGER states a material outcome. It used to end with
  // describePoints(net) — "you come out 6 points of material ahead" — asserted
  // as fact from a SINGLE rollout whose opponent reply was sampled from Maia at
  // the persona's own Elo. It was wrong often and expensively: in a live 850
  // game the model was told Nxe3 came out "6 points ahead" (the sampled reply
  // missed the bishop capture that wins the queen) and played it, and told
  // Bc5 left it "1 point behind" versus fxe6 at "4 points behind" and played
  // Bc5, which loses on the spot. Measured over the moves where the game was
  // still live, choosing on those numbers gave up ~60% MORE win probability
  // than blindly taking the first candidate.
  //
  // The architecture already fixes strength upstream (Elo-conditioned Maia +
  // blunder/blinder); the LLM is only supposed to express STYLE. A confident
  // fake number turned a style choice into a strength choice. So the line now
  // describes what she pictures happening and stops there — no score, nothing
  // to maximize. Checkmate stays, because a mate at the end of a line is
  // something a player of any strength would actually notice.
  let line = null;
  if (rolloutUcis.length > 0 && !chess.isGameOver()) {
    let mine = false; // rollout starts with the opponent's reply
    const sans = [first.san];
    const parts = [];
    for (const uci of rolloutUcis) {
      if (chess.isGameOver()) break;
      const ply = describePly(chess, uci, mine);
      sans.push(ply.san);
      parts.push(ply.sentence);
      tags.push(...ply.tags.map((t) => `line:${t}`));
      mine = !mine;
    }
    if (parts.length > 0) {
      const mate = chess.isCheckmate()
        ? tagsEndInMyMate(parts.length)
          ? '; ending in checkmate in your favor'
          : '; ending in you getting checkmated'
        : '';
      line = {
        sans,
        sentence: `You imagine: ${parts.join('; ')}${mate}.`,
      };
    }
  }

  return { san: first.san, sentence, tags, line };

  // Rollout plies alternate starting with the opponent, so an odd count of
  // described plies means the last mover was the opponent.
  function tagsEndInMyMate(described) {
    return described % 2 === 0;
  }
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
