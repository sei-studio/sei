/** Connect 4 rules — pure board functions. */
import { describe, it, expect } from 'vitest';
import {
  applyMove,
  checkWin,
  createBoard,
  dropRow,
  isDraw,
  legalMoves,
  opponentOf,
  runThrough,
  winningCols,
  type C4Board,
  type C4Color,
} from './rules';

/** Play out a sequence of (col,color) drops. */
function play(moves: Array<[number, C4Color]>): C4Board {
  let board = createBoard();
  for (const [col, color] of moves) {
    board = applyMove(board, col, color).board;
  }
  return board;
}

describe('createBoard / applyMove / dropRow', () => {
  it('creates an empty 6x7 board', () => {
    const b = createBoard();
    expect(b).toHaveLength(6);
    expect(b[0]).toHaveLength(7);
    expect(b.flat().every((c) => c === null)).toBe(true);
  });

  it('gravity: discs stack from the bottom row up', () => {
    const b = play([[3, 'r'], [3, 'y'], [3, 'r']]);
    expect(b[0][3]).toBe('r');
    expect(b[1][3]).toBe('y');
    expect(b[2][3]).toBe('r');
    expect(b[3][3]).toBeNull();
  });

  it('applyMove is immutable', () => {
    const b = createBoard();
    const { board: next } = applyMove(b, 0, 'r');
    expect(b[0][0]).toBeNull();
    expect(next[0][0]).toBe('r');
  });

  it('dropRow reports the landing row and -1 for a full column', () => {
    let b = createBoard();
    expect(dropRow(b, 2)).toBe(0);
    for (let i = 0; i < 6; i++) b = applyMove(b, 2, i % 2 === 0 ? 'r' : 'y').board;
    expect(dropRow(b, 2)).toBe(-1);
    expect(() => applyMove(b, 2, 'r')).toThrow(/illegal/);
    expect(dropRow(b, -1)).toBe(-1);
    expect(dropRow(b, 7)).toBe(-1);
  });

  it('legalMoves excludes full columns and prefers the center first', () => {
    let b = createBoard();
    expect(legalMoves(b)[0]).toBe(3);
    expect(legalMoves(b)).toHaveLength(7);
    for (let i = 0; i < 6; i++) b = applyMove(b, 3, i % 2 === 0 ? 'r' : 'y').board;
    expect(legalMoves(b)).not.toContain(3);
    expect(legalMoves(b)).toHaveLength(6);
  });
});

describe('checkWin', () => {
  it('detects a horizontal four', () => {
    const b = play([[0, 'r'], [0, 'y'], [1, 'r'], [1, 'y'], [2, 'r'], [2, 'y'], [3, 'r']]);
    const win = checkWin(b);
    expect(win?.winner).toBe('r');
    expect(win?.line).toHaveLength(4);
    expect(win?.line.every((c) => c.row === 0)).toBe(true);
  });

  it('detects a vertical four', () => {
    const b = play([[5, 'y'], [5, 'y'], [5, 'y'], [5, 'y']]);
    expect(checkWin(b)?.winner).toBe('y');
  });

  it('detects a rising diagonal', () => {
    const b = play([
      [0, 'r'],
      [1, 'y'], [1, 'r'],
      [2, 'y'], [2, 'y'], [2, 'r'],
      [3, 'y'], [3, 'y'], [3, 'y'], [3, 'r'],
    ]);
    expect(checkWin(b)?.winner).toBe('r');
  });

  it('detects a falling diagonal', () => {
    const b = play([
      [6, 'r'],
      [5, 'y'], [5, 'r'],
      [4, 'y'], [4, 'y'], [4, 'r'],
      [3, 'y'], [3, 'y'], [3, 'y'], [3, 'r'],
    ]);
    expect(checkWin(b)?.winner).toBe('r');
  });

  it('three in a row is not a win', () => {
    const b = play([[0, 'r'], [1, 'r'], [2, 'r']]);
    expect(checkWin(b)).toBeNull();
  });
});

describe('isDraw', () => {
  it('empty and mid-game boards are not draws', () => {
    expect(isDraw(createBoard())).toBe(false);
    expect(isDraw(play([[0, 'r'], [1, 'y']]))).toBe(false);
  });

  it('a full board with no four is a draw', () => {
    // color(row,col) = rowBase XOR colParity with rowBase pairs rryyrr:
    // horizontals alternate every cell, verticals run at most 2, and every
    // diagonal 4-window comes out as a 2+2 split (checked by construction).
    const rowBase = ['r', 'r', 'y', 'y', 'r', 'r'] as const;
    const flip = (c: C4Color): C4Color => (c === 'r' ? 'y' : 'r');
    let board = createBoard();
    for (let row = 0; row < 6; row++) {
      for (let col = 0; col < 7; col++) {
        const color = col % 2 === 0 ? rowBase[row] : flip(rowBase[row]);
        board = applyMove(board, col, color).board;
      }
    }
    expect(checkWin(board)).toBeNull();
    expect(isDraw(board)).toBe(true);
  });
});

describe('threat detection', () => {
  it('winningCols finds immediate winning drops', () => {
    // Red has three on the floor (cols 1-3): both ends win.
    const b = play([[1, 'r'], [1, 'y'], [2, 'r'], [2, 'y'], [3, 'r']]);
    expect(winningCols(b, 'r').sort()).toEqual([0, 4]);
    expect(winningCols(b, 'y')).toEqual([]);
  });

  it('winningCols sees vertical threats', () => {
    const b = play([[6, 'y'], [6, 'y'], [6, 'y']]);
    expect(winningCols(b, 'y')).toEqual([6]);
  });

  it('runThrough measures the longest run through a cell', () => {
    const b = play([[0, 'r'], [1, 'r'], [2, 'r']]);
    expect(runThrough(b, 0, 1)).toBe(3);
    expect(runThrough(b, 0, 0)).toBe(3);
    const single = play([[5, 'y']]);
    expect(runThrough(single, 0, 5)).toBe(1);
  });

  it('opponentOf flips colors', () => {
    expect(opponentOf('r')).toBe('y');
    expect(opponentOf('y')).toBe('r');
  });
});
