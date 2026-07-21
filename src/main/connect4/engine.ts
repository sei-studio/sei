/**
 * Connect 4 candidate engine — same philosophy as cce-1 for chess: the ENGINE
 * fixes STRENGTH, the LLM only expresses STYLE. Every AI turn produces a
 * strength-conditioned top-4 candidate set with plain-language rationale
 * sentences; the character picks among them and can only flavor the choice,
 * never out-play its profile.
 *
 * Strength (1-5, from the connect4 profile) scales three levers:
 *   - search depth (alpha-beta minimax over a positional heuristic)
 *   - eval noise (gaussian, larger at low strength: the board is seen fuzzily)
 *   - a blunder layer (low strength sometimes fails to SEE the best move,
 *     including a forced block, so it drops out of the candidate set)
 *
 * Pure JS, no deps, fully synchronous (a 7x6 board is tiny).
 */
import {
  applyMove,
  checkWin,
  legalMoves,
  opponentOf,
  runThrough,
  winningCols,
  C4_COLS,
  type C4Board,
  type C4Color,
} from './rules';

export interface C4Candidate {
  col: number;
  /** Plain-language rationale, addressed to the character ("their" = player). */
  sentence: string;
  /** Machine tags: win | block | double-threat | build | poisoned | center | quiet */
  tags: string[];
  /** Search score from the AI's viewpoint (positive = good for the AI). */
  score: number;
}

export interface C4CandidateOut {
  macro: { text: string };
  candidates: C4Candidate[];
  /** Difficulty signals for the prethink sampler (chess: cce-1 `think`). */
  think: {
    /** 0-1: how close the top two candidates score (1 = a coin flip). */
    closeness: number;
    /** True when the top move is forced (only move, a win, or a block). */
    forced: boolean;
  };
}

const WIN_SCORE = 100_000;

/** Depth per strength 1-5. Depth 7 plays a sharp tactical game on 7x6 while
 * keeping the synchronous search under ~1s in the worst (early-midgame)
 * positions; the search runs on the main process, so latency is a budget. */
const DEPTH_BY_STRENGTH = [0, 2, 3, 4, 6, 7];
/** Eval noise sigma per strength (heuristic-score units). */
const NOISE_BY_STRENGTH = [0, 120, 70, 35, 14, 4];
/** Chance the best move simply is not seen (dropped from candidates). */
const BLUNDER_BY_STRENGTH = [0, 0.22, 0.1, 0.04, 0.01, 0];

/** Positional weight per column (center is gold). */
const COL_WEIGHT = [1, 2, 3, 5, 3, 2, 1];

function gaussian(rng: () => number): number {
  const u = rng() || 1e-9;
  const v = rng() || 1e-9;
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Static evaluation from `color`'s viewpoint: window counting (every 4-cell
 * line scored by disc majority) + center-column weighting.
 */
export function evaluate(board: C4Board, color: C4Color): number {
  const opp = opponentOf(color);
  let score = 0;
  const rows = board.length;
  const cols = board[0].length;
  const at = (r: number, c: number): C4Color | null =>
    r >= 0 && r < rows && c >= 0 && c < cols ? board[r][c] : undefined as never;

  // Center preference.
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (board[r][c] === color) score += COL_WEIGHT[c];
      else if (board[r][c] === opp) score -= COL_WEIGHT[c];
    }
  }

  // All 4-windows.
  const dirs: Array<[number, number]> = [[0, 1], [1, 0], [1, 1], [1, -1]];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      for (const [dr, dc] of dirs) {
        const er = r + dr * 3;
        const ec = c + dc * 3;
        if (er < 0 || er >= rows || ec < 0 || ec >= cols) continue;
        let mine = 0;
        let theirs = 0;
        for (let k = 0; k < 4; k++) {
          const cell = at(r + dr * k, c + dc * k);
          if (cell === color) mine++;
          else if (cell === opp) theirs++;
        }
        if (mine > 0 && theirs > 0) continue; // dead window
        if (mine === 3) score += 60;
        else if (mine === 2) score += 8;
        if (theirs === 3) score -= 70;
        else if (theirs === 2) score -= 8;
      }
    }
  }
  return score;
}

/**
 * Alpha-beta minimax; returns the score for `color` (the side to move).
 * Invariant: the position passed in has NO four on the board (each ply is
 * checked at make-move time via the targeted runThrough test, which is far
 * cheaper than a full-board scan per node and prunes winning lines on the
 * spot).
 */
function search(
  board: C4Board,
  color: C4Color,
  depth: number,
  alpha: number,
  beta: number,
): number {
  const moves = legalMoves(board);
  if (moves.length === 0) return 0; // full board, no four: draw
  if (depth === 0) return evaluate(board, color);
  let best = -Infinity;
  for (const col of moves) {
    const { board: next, row } = applyMove(board, col, color);
    const val =
      runThrough(next, row, col) === 4
        ? WIN_SCORE + depth // this move wins immediately
        : -search(next, opponentOf(color), depth - 1, -beta, -alpha);
    if (val > best) best = val;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

/** Rationale sentence + tags for a candidate drop, before it is played. */
function describeCandidate(
  board: C4Board,
  col: number,
  aiColor: C4Color,
): { sentence: string; tags: string[] } {
  const opp = opponentOf(aiColor);
  const tags: string[] = [];
  const parts: string[] = [];
  const oppWins = winningCols(board, opp);
  const { board: after, row } = applyMove(board, col, aiColor);

  if (checkWin(after)?.winner === aiColor) {
    return { sentence: 'Wins the game: four in a row, right now.', tags: ['win'] };
  }
  if (oppWins.includes(col)) {
    tags.push('block');
    parts.push(`Blocks their winning spot in column ${col + 1}.`);
  }
  const myWinsAfter = winningCols(after, aiColor);
  if (myWinsAfter.length >= 2) {
    tags.push('double-threat');
    parts.push('Builds a double threat: two winning spots at once, they can only stop one.');
  } else if (myWinsAfter.length === 1) {
    tags.push('build');
    parts.push(`Threatens to win in column ${myWinsAfter[0] + 1} next turn.`);
  } else if (runThrough(after, row, col) === 3) {
    tags.push('build');
    parts.push('Makes three in a row.');
  }
  // Poisoned drop: the cell directly above becomes a win for them.
  if (row + 1 < after.length) {
    const probe = after.map((r) => r.slice());
    probe[row + 1][col] = opp;
    if (checkWin(probe)?.winner === opp) {
      tags.push('poisoned');
      parts.push('Careful: it hands them a winning spot right on top.');
    }
  }
  if (parts.length === 0) {
    if (col === 3) {
      tags.push('center');
      parts.push('Takes the center column, the strongest real estate.');
    } else {
      tags.push('quiet');
      parts.push('A quiet move; keeps your options open.');
    }
  }
  return { sentence: parts.join(' '), tags };
}

/** One-line position summary for the prompt (chess: the CCE macro). */
function macroText(board: C4Board, aiColor: C4Color): string {
  const opp = opponentOf(aiColor);
  const myWins = winningCols(board, aiColor);
  const oppWins = winningCols(board, opp);
  if (myWins.length > 0) {
    return `You can WIN right now in column ${myWins[0] + 1}.`;
  }
  if (oppWins.length >= 2) {
    return `They have TWO winning spots (columns ${oppWins.map((c) => c + 1).join(' and ')}); you can only block one.`;
  }
  if (oppWins.length === 1) {
    return `They are threatening to win in column ${oppWins[0] + 1}; ignoring it loses the game.`;
  }
  const filled = board.flat().filter(Boolean).length;
  if (filled < 6) return 'The board is young; the fight is over the center.';
  return 'No immediate threats on the board.';
}

/**
 * Strength-conditioned candidate set for the position (AI to move).
 * Deterministic given `rng`; pass Math.random in production.
 */
export function candidateSet(
  board: C4Board,
  aiColor: C4Color,
  strength: number,
  rng: () => number = Math.random,
): C4CandidateOut {
  const s = Math.max(1, Math.min(5, Math.round(strength)));
  const depth = DEPTH_BY_STRENGTH[s];
  const sigma = NOISE_BY_STRENGTH[s];
  const legal = legalMoves(board);
  if (legal.length === 0) throw new Error('no legal connect4 moves');

  const scored = legal.map((col) => {
    const { board: next } = applyMove(board, col, aiColor);
    // Immediate win: score it cleanly (no noise strips a mate-in-1) and above
    // every depth-bonused DEFERRED win the search can report.
    const won = checkWin(next)?.winner === aiColor;
    const raw = won
      ? WIN_SCORE * 2
      : -search(next, opponentOf(aiColor), depth, -Infinity, Infinity);
    const noisy = won ? raw : raw + gaussian(rng) * sigma;
    return { col, raw, noisy };
  });
  scored.sort((a, b) => b.noisy - a.noisy);

  // Blunder layer: at low strength the best move is sometimes not SEEN at
  // all (it vanishes from the candidate set), unless it is the only move.
  let visible = scored;
  if (scored.length > 1 && rng() < BLUNDER_BY_STRENGTH[s]) {
    visible = scored.slice(1);
  }

  const top = visible.slice(0, 4);
  const candidates: C4Candidate[] = top.map(({ col, noisy }) => {
    const { sentence, tags } = describeCandidate(board, col, aiColor);
    return { col, sentence, tags, score: Math.round(noisy) };
  });

  const gap = top.length > 1 ? Math.abs(top[0].noisy - top[1].noisy) : Infinity;
  const forced =
    legal.length === 1 ||
    candidates[0]?.tags.includes('win') === true ||
    (candidates[0]?.tags.includes('block') === true && winningCols(board, opponentOf(aiColor)).length > 0);
  const closeness = gap === Infinity ? 0 : 1 - Math.min(gap / 150, 1);

  return {
    macro: { text: macroText(board, aiColor) },
    candidates,
    think: { closeness, forced },
  };
}

/** Number of columns (re-export convenience for prompt code). */
export const COLS = C4_COLS;
