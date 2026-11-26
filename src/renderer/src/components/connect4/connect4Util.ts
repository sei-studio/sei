/**
 * Pure board helpers for the Four in a Row view (no three.js, no React).
 *
 * The authoritative game lives in main (src/main/connect4/); these only answer
 * view questions: where a disc would land, which discs are new since the last
 * push (so they can be animated dropping in), and which four cells won (the
 * state carries the winner but not the line, so the view finds it).
 */

import type { CONNECT4Color, CONNECT4GameState } from '@shared/connect4Ipc';

export type Board = CONNECT4GameState['board'];

export const ROWS = 6;
export const COLS = 7;

export interface Cell {
  r: number;
  c: number;
}

/** The row a disc dropped in `col` would land in, or -1 when the column is full. */
export function landingRow(board: Board, col: number): number {
  for (let r = board.length - 1; r >= 0; r--) if (board[r]?.[col] === null) return r;
  return -1;
}

export function columnFull(board: Board, col: number): boolean {
  return landingRow(board, col) < 0;
}

/** Discs present in `next` that were not in `prev` (in drop order: bottom first). */
export function newDiscs(prev: Board | null, next: Board): Array<Cell & { color: CONNECT4Color }> {
  const out: Array<Cell & { color: CONNECT4Color }> = [];
  for (let r = next.length - 1; r >= 0; r--) {
    for (let c = 0; c < (next[r]?.length ?? 0); c++) {
      const v = next[r][c];
      if (v && prev?.[r]?.[c] !== v) out.push({ r, c, color: v });
    }
  }
  return out;
}

const DIRS: Array<[number, number]> = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
];

/**
 * Every cell that is part of a run of four or more of `color` (several lines
 * can win at once). Empty when there is none.
 */
export function winningCells(board: Board, color: CONNECT4Color): Cell[] {
  const hit = new Set<string>();
  const rows = board.length;
  for (let r = 0; r < rows; r++) {
    const cols = board[r].length;
    for (let c = 0; c < cols; c++) {
      if (board[r][c] !== color) continue;
      for (const [dr, dc] of DIRS) {
        // Only start a run at its first cell.
        const pr = r - dr;
        const pc = c - dc;
        if (board[pr]?.[pc] === color) continue;
        const run: Cell[] = [];
        let rr = r;
        let cc = c;
        while (board[rr]?.[cc] === color) {
          run.push({ r: rr, c: cc });
          rr += dr;
          cc += dc;
        }
        if (run.length >= 4) for (const cell of run) hit.add(`${cell.r},${cell.c}`);
      }
    }
  }
  return [...hit].map((k) => {
    const [r, c] = k.split(',').map(Number);
    return { r, c };
  });
}

/** Discs of each color still "in hand" (21 each on a 6x7 board). */
export function discsInHand(board: Board): Record<CONNECT4Color, number> {
  const half = (ROWS * COLS) / 2;
  let red = 0;
  let yellow = 0;
  for (const row of board) for (const v of row) {
    if (v === 'r') red++;
    else if (v === 'y') yellow++;
  }
  return { r: Math.max(0, half - red), y: Math.max(0, half - yellow) };
}
