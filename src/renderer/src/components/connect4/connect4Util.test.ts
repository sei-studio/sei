import { describe, expect, it } from 'vitest';
import { COLS, ROWS, discsInHand, landingRow, newDiscs, winningCells, type Board } from './connect4Util';

function board(rows: string[]): Board {
  // Rows top to bottom; '.' empty, 'r' red, 'y' yellow.
  const padded = [...Array(ROWS - rows.length).fill('.'.repeat(COLS)), ...rows];
  return padded.map((line) => [...line].map((ch) => (ch === '.' ? null : (ch as 'r' | 'y'))));
}

const key = (cells: Array<{ r: number; c: number }>): string[] => cells.map((x) => `${x.r},${x.c}`).sort();

describe('landingRow', () => {
  it('lands on the floor, on top of a stack, and refuses a full column', () => {
    const b = board(['r......', 'y......', 'r......', 'y......', 'r......', 'y.....r']);
    expect(landingRow(b, 1)).toBe(5);
    expect(landingRow(b, 6)).toBe(4);
    expect(landingRow(b, 0)).toBe(-1);
  });
});

describe('newDiscs', () => {
  it('lists only the discs that appeared, bottom first', () => {
    const a = board(['r......']);
    const b = board(['y......', 'r.....y']);
    expect(newDiscs(a, b)).toEqual([
      { r: 5, c: 6, color: 'y' },
      { r: 4, c: 0, color: 'y' },
    ]);
    expect(newDiscs(b, b)).toEqual([]);
  });
});

describe('winningCells', () => {
  it('finds a horizontal four', () => {
    const b = board(['yyy....', 'rrrr...']);
    expect(key(winningCells(b, 'r'))).toEqual(['5,0', '5,1', '5,2', '5,3']);
    expect(winningCells(b, 'y')).toEqual([]);
  });

  it('finds a diagonal four and keeps a run longer than four whole', () => {
    const diag = board(['...r...', '..ry...', '.ryy...', 'ryyr...']);
    expect(key(winningCells(diag, 'r'))).toEqual(['2,3', '3,2', '4,1', '5,0']);
    const five = board(['rrrrr..']);
    expect(winningCells(five, 'r')).toHaveLength(5);
  });

  it('finds a vertical four', () => {
    const b = board(['y......', 'y......', 'y.r....', 'y.r....']);
    expect(key(winningCells(b, 'y'))).toEqual(['2,0', '3,0', '4,0', '5,0']);
  });
});

describe('discsInHand', () => {
  it('counts down from 21 per color', () => {
    const b = board(['yr.....', 'rr.....']);
    expect(discsInHand(b)).toEqual({ r: 18, y: 20 });
  });
});
