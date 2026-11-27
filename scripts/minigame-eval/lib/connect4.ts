/**
 * Four in a Row helpers for the eval: rules on a plain board, the fixed
 * baseline (win, block, never hand over a win, then a window heuristic with
 * center preference; seeded ties), per-move tactics checks, and the
 * player's-eye board for the learner simulator.
 */
import type { CONNECT4Color, CONNECT4GameState, CONNECT4MoveRecord } from '../../../src/shared/connect4Ipc';
import { rng } from './env';

export const ROWS = 6;
export const COLS = 7;
export type Board = Array<Array<CONNECT4Color | null>>;

export const empty = (): Board => Array.from({ length: ROWS }, () => Array<CONNECT4Color | null>(COLS).fill(null));
export const clone = (b: Board): Board => b.map((r) => r.slice());
export const other = (c: CONNECT4Color): CONNECT4Color => (c === 'r' ? 'y' : 'r');

export function dropRow(b: Board, col: number): number {
  for (let r = ROWS - 1; r >= 0; r--) if (b[r][col] === null) return r;
  return -1;
}

export function legal(b: Board): number[] {
  const out: number[] = [];
  for (let c = 0; c < COLS; c++) if (dropRow(b, c) !== -1) out.push(c);
  return out;
}

export function wins(b: Board, row: number, col: number): boolean {
  const color = b[row][col];
  if (!color) return false;
  for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
    let n = 1;
    for (const s of [1, -1]) {
      for (let k = 1; k < 4; k++) {
        const r = row + dr * k * s;
        const c = col + dc * k * s;
        if (r < 0 || r >= ROWS || c < 0 || c >= COLS || b[r][c] !== color) break;
        n++;
      }
    }
    if (n >= 4) return true;
  }
  return false;
}

/** Columns where `color` wins at once. */
export function winningCols(b: Board, color: CONNECT4Color): number[] {
  const out: number[] = [];
  for (const c of legal(b)) {
    const r = dropRow(b, c);
    b[r][c] = color;
    if (wins(b, r, c)) out.push(c);
    b[r][c] = null;
  }
  return out;
}

export function play(b: Board, col: number, color: CONNECT4Color): Board {
  const n = clone(b);
  n[dropRow(n, col)][col] = color;
  return n;
}

function windowScore(b: Board, me: CONNECT4Color): number {
  const opp = other(me);
  let s = 0;
  for (let r = 0; r < ROWS; r++) if (b[r][3] === me) s += 3;
  const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      for (const [dr, dc] of dirs) {
        const er = r + 3 * dr;
        const ec = c + 3 * dc;
        if (er < 0 || er >= ROWS || ec < 0 || ec >= COLS) continue;
        let m = 0;
        let o = 0;
        for (let k = 0; k < 4; k++) {
          const v = b[r + k * dr][c + k * dc];
          if (v === me) m++;
          else if (v === opp) o++;
        }
        if (o === 0) s += m === 3 ? 5 : m === 2 ? 2 : 0;
        if (m === 0 && o === 3) s -= 4;
      }
    }
  }
  return s;
}

/** The baseline's column (0-based). `rand` breaks exact ties only. */
export function baselineMove(b: Board, me: CONNECT4Color, rand: () => number): number {
  const opp = other(me);
  const mine = winningCols(b, me);
  if (mine.length) return mine[0];
  const theirs = winningCols(b, opp);
  if (theirs.length) return theirs[0];
  let cands = legal(b);
  const safe = cands.filter((c) => winningCols(play(b, c, me), opp).length === 0);
  if (safe.length) cands = safe;
  let best = -Infinity;
  let picks: number[] = [];
  for (const c of cands) {
    const s = windowScore(play(b, c, me), me) - Math.abs(3 - c) * 0.5;
    if (s > best + 1e-9) {
      best = s;
      picks = [c];
    } else if (Math.abs(s - best) <= 1e-9) picks.push(c);
  }
  return picks[Math.floor(rand() * picks.length)];
}

/**
 * The stronger fixed baseline: depth-limited negamax with alpha-beta over the
 * same window evaluation (immediate wins/blocks fall out of the search).
 * Ties between equally scored root moves break by `rand`.
 */
export function minimaxMove(b: Board, me: CONNECT4Color, depth: number, rand: () => number): number {
  const order = [3, 2, 4, 1, 5, 0, 6];
  const WIN = 1e6;
  const neg = (bd: Board, side: CONNECT4Color, d: number, alpha: number, beta: number): number => {
    const moves = order.filter((c) => dropRow(bd, c) !== -1);
    if (!moves.length) return 0;
    if (d === 0) return windowScore(bd, side) - windowScore(bd, other(side));
    let best = -Infinity;
    for (const c of moves) {
      const r = dropRow(bd, c);
      bd[r][c] = side;
      const v = wins(bd, r, c) ? WIN + d : -neg(bd, other(side), d - 1, -beta, -alpha);
      bd[r][c] = null;
      if (v > best) best = v;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    return best;
  };
  const work = clone(b);
  let best = -Infinity;
  let picks: number[] = [];
  for (const c of order) {
    const r = dropRow(work, c);
    if (r === -1) continue;
    work[r][c] = me;
    const v = wins(work, r, c) ? WIN + depth : -neg(work, other(me), depth - 1, -Infinity, Infinity);
    work[r][c] = null;
    if (v > best + 1e-9) { best = v; picks = [c]; }
    else if (Math.abs(v - best) <= 1e-9) picks.push(c);
  }
  return picks[Math.floor(rand() * picks.length)];
}

export function baselineRng(seed: number): () => number {
  return rng(seed * 2654435761 + 11);
}

export interface C4MoveCheck {
  ply: number;
  col: number;
  missedWin: boolean;
  missedBlock: boolean;
  /** The opponent threatened an immediate win and this side had no win of its own. */
  blockNeeded: boolean;
  /** Handed the opponent an immediate win when a move that did not existed. */
  gaveWin: boolean;
}

/** Tactics checks for every move of `color` in a finished game. */
export function checkMoves(history: CONNECT4MoveRecord[], color: CONNECT4Color): C4MoveCheck[] {
  let b = empty();
  const out: C4MoveCheck[] = [];
  history.forEach((m, i) => {
    if (m.color === color) {
      const opp = other(color);
      const w = winningCols(b, color);
      const t = winningCols(b, opp);
      const after = play(b, m.column, color);
      const avoidable = legal(b).some((c) => winningCols(play(b, c, color), opp).length === 0);
      out.push({
        ply: i + 1,
        col: m.column,
        missedWin: w.length > 0 && !w.includes(m.column),
        missedBlock: w.length === 0 && t.length > 0 && !t.includes(m.column),
        blockNeeded: w.length === 0 && t.length > 0,
        gaveWin: !wins(after, dropRow(b, m.column), m.column) && winningCols(after, opp).length > 0 && avoidable && t.length === 0,
      });
    }
    b = play(b, m.column, m.color);
  });
  return out;
}

/** The board as the panel shows it, for the learner: R red disc, Y yellow, . empty. */
export function boardView(s: CONNECT4GameState): string {
  const rows = s.board.map((row) => '| ' + row.map((c) => (c === 'r' ? 'R' : c === 'y' ? 'Y' : '.')).join(' ') + ' |');
  return [...rows, '  1 2 3 4 5 6 7'].join('\n');
}
