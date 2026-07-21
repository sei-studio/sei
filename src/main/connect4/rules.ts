/**
 * Connect 4 rules: pure board functions, no state, no deps.
 *
 * Board convention (shared contract, src/shared/connect4Ipc.ts):
 * `board[row][col]`, row 0 = BOTTOM, 6 rows x 7 cols. All functions are
 * immutable (applyMove returns a fresh board) so the engine can search
 * without cloning discipline bugs.
 */
import {
  C4_COLS,
  C4_ROWS,
  type C4Board,
  type C4Color,
} from '../../shared/connect4Ipc';

export { C4_COLS, C4_ROWS };
export type { C4Board, C4Color };

export function createBoard(): C4Board {
  return Array.from({ length: C4_ROWS }, () => Array<C4Color | null>(C4_COLS).fill(null));
}

/** Columns that still have room, center-out order (search-friendly). */
export function legalMoves(board: C4Board): number[] {
  const order = [3, 2, 4, 1, 5, 0, 6];
  return order.filter((col) => board[C4_ROWS - 1][col] === null);
}

/** Row a drop in `col` would land in, or -1 when the column is full. */
export function dropRow(board: C4Board, col: number): number {
  if (col < 0 || col >= C4_COLS) return -1;
  for (let row = 0; row < C4_ROWS; row++) {
    if (board[row][col] === null) return row;
  }
  return -1;
}

/**
 * Apply a drop. Throws on a full/invalid column (callers validate with
 * dropRow/legalMoves first; the throw guards internal misuse).
 */
export function applyMove(
  board: C4Board,
  col: number,
  color: C4Color,
): { board: C4Board; row: number } {
  const row = dropRow(board, col);
  if (row === -1) throw new Error(`illegal connect4 move: column ${col}`);
  const next = board.map((r) => r.slice());
  next[row][col] = color;
  return { board: next, row };
}

const DIRS: Array<[number, number]> = [
  [0, 1], // horizontal
  [1, 0], // vertical
  [1, 1], // diagonal up-right
  [1, -1], // diagonal up-left
];

/**
 * Four-in-a-row detection. Returns the winner and one winning line, or null.
 */
export function checkWin(
  board: C4Board,
): { winner: C4Color; line: Array<{ row: number; col: number }> } | null {
  for (let row = 0; row < C4_ROWS; row++) {
    for (let col = 0; col < C4_COLS; col++) {
      const color = board[row][col];
      if (!color) continue;
      for (const [dr, dc] of DIRS) {
        const line = [{ row, col }];
        for (let k = 1; k < 4; k++) {
          const r = row + dr * k;
          const c = col + dc * k;
          if (r < 0 || r >= C4_ROWS || c < 0 || c >= C4_COLS) break;
          if (board[r][c] !== color) break;
          line.push({ row: r, col: c });
        }
        if (line.length === 4) return { winner: color, line };
      }
    }
  }
  return null;
}

/** Board full with no winner (call checkWin first). */
export function isDraw(board: C4Board): boolean {
  return board[C4_ROWS - 1].every((cell) => cell !== null) && checkWin(board) === null;
}

/**
 * Threat detection: columns where dropping `color` right now wins on the
 * spot. Two or more = a double threat (unanswerable next turn).
 */
export function winningCols(board: C4Board, color: C4Color): number[] {
  const out: number[] = [];
  for (let col = 0; col < C4_COLS; col++) {
    const row = dropRow(board, col);
    if (row === -1) continue;
    const probe = board.map((r) => r.slice());
    probe[row][col] = color;
    if (checkWin(probe)?.winner === color) out.push(col);
  }
  return out;
}

/**
 * Longest run through the last-dropped cell for its color (2 = pair,
 * 3 = three in a row, 4 = win). Used for plain-language move descriptions.
 */
export function runThrough(board: C4Board, row: number, col: number): number {
  const color = board[row][col];
  if (!color) return 0;
  let best = 1;
  for (const [dr, dc] of DIRS) {
    let count = 1;
    for (const sign of [1, -1]) {
      for (let k = 1; k < 4; k++) {
        const r = row + dr * k * sign;
        const c = col + dc * k * sign;
        if (r < 0 || r >= C4_ROWS || c < 0 || c >= C4_COLS) break;
        if (board[r][c] !== color) break;
        count++;
      }
    }
    best = Math.max(best, count);
  }
  return Math.min(best, 4);
}

export function opponentOf(color: C4Color): C4Color {
  return color === 'r' ? 'y' : 'r';
}
