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

function describePoints(points) {
  if (points === 0) return 'material stays even';
  const abs = Math.abs(points);
  const noun = abs === 1 ? 'point' : 'points';
  return points > 0
    ? `you come out ${abs} ${noun} of material ahead`
    : `you end up ${abs} ${noun} of material behind`;
}

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
  let line = null;
  if (rolloutUcis.length > 0 && !chess.isGameOver()) {
    let mine = false; // rollout starts with the opponent's reply
    let net = 0;
    const sans = [first.san];
    const parts = [];
    for (const uci of rolloutUcis) {
      if (chess.isGameOver()) break;
      const ply = describePly(chess, uci, mine);
      sans.push(ply.san);
      parts.push(ply.sentence);
      net += mine ? ply.points : -ply.points;
      tags.push(...ply.tags.map((t) => `line:${t}`));
      mine = !mine;
    }
    // Include the candidate's own capture in the running material picture.
    net += first.points;
    if (parts.length > 0) {
      const outcome = chess.isCheckmate()
        ? tagsEndInMyMate(parts.length)
          ? 'ending in checkmate in your favor'
          : 'ending in you getting checkmated'
        : describePoints(net);
      line = {
        sans,
        sentence: `You imagine: ${parts.join('; ')}; ${outcome}.`,
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
