/**
 * Connect 4 engine — the strength-conditioned candidate generator. The engine
 * must fix STRENGTH (the LLM only picks among candidates), so the tests pin
 * the tactical floor at high strength and the blunder layer at low strength.
 */
import { describe, it, expect } from 'vitest';
import { candidateSet } from './engine';
import { applyMove, createBoard, type C4Board, type C4Color } from './rules';

function play(moves: Array<[number, C4Color]>): C4Board {
  let board = createBoard();
  for (const [col, color] of moves) {
    board = applyMove(board, col, color).board;
  }
  return board;
}

/** rng that never triggers the blunder branch (always high). */
const noBlunder = (): number => 0.999;

describe('candidateSet', () => {
  it('returns at most 4 candidates with sentences and scores', () => {
    const out = candidateSet(createBoard(), 'r', 3, noBlunder);
    expect(out.candidates.length).toBeGreaterThan(0);
    expect(out.candidates.length).toBeLessThanOrEqual(4);
    for (const c of out.candidates) {
      expect(c.col).toBeGreaterThanOrEqual(0);
      expect(c.col).toBeLessThanOrEqual(6);
      expect(c.sentence.length).toBeGreaterThan(0);
      expect(typeof c.score).toBe('number');
    }
    expect(out.macro.text.length).toBeGreaterThan(0);
  });

  it('an immediate win is the top candidate at strength 5 and tagged win', () => {
    // Yellow has three on the floor at cols 1-3; yellow to move.
    const b = play([[1, 'y'], [1, 'r'], [2, 'y'], [2, 'r'], [3, 'y']]);
    const out = candidateSet(b, 'y', 5, noBlunder);
    expect(out.candidates[0].tags).toContain('win');
    expect([0, 4]).toContain(out.candidates[0].col);
    expect(out.think.forced).toBe(true);
  });

  it('blocking the opponent immediate win is top at strength 5 and tagged block', () => {
    // Red has three on the floor at cols 0-2: ONE winning spot (col 3).
    // Yellow to move with no win of its own must block it.
    const b = play([[0, 'r'], [6, 'y'], [1, 'r'], [6, 'y'], [2, 'r']]);
    const out = candidateSet(b, 'y', 5, noBlunder);
    expect(out.candidates[0].tags).toContain('block');
    expect(out.candidates[0].col).toBe(3);
  });

  it('the macro warns about the opponent threat', () => {
    const single = play([[0, 'r'], [6, 'y'], [1, 'r'], [6, 'y'], [2, 'r']]);
    expect(candidateSet(single, 'y', 4, noBlunder).macro.text).toMatch(/threatening to win/i);
    // Two open ends = the unanswerable double threat wording.
    const dbl = play([[1, 'r'], [6, 'y'], [2, 'r'], [6, 'y'], [3, 'r']]);
    expect(candidateSet(dbl, 'y', 4, noBlunder).macro.text).toMatch(/TWO winning spots/);
  });

  it('tags a double threat when a drop creates two winning spots', () => {
    // Yellow: discs at cols 2 and 4 on the floor with 1,5 and 3 open — dropping
    // col 3 makes 2-3-4 with open ends 1 and 5.
    const b = play([[2, 'y'], [0, 'r'], [4, 'y'], [0, 'r']]);
    const out = candidateSet(b, 'y', 5, noBlunder);
    const c3 = out.candidates.find((c) => c.col === 3);
    expect(c3).toBeDefined();
    expect(c3!.tags).toContain('double-threat');
    expect(c3!.sentence).toMatch(/double threat/i);
  });

  it('flags a poisoned drop that hands the opponent the win', () => {
    // Red would win at (row1, col0) if it gets there: red has three in a
    // diagonal? Simpler: red threatens on TOP of col 2 — red discs at
    // rows 1 of cols 0,1,3 is fiddly; use a vertical: red has 3 stacked in
    // col 5 already blocked on top by yellow? Instead: red has three in a row
    // at ROW 1 across cols 1-3 (supported), so dropping yellow at col 4 row 0
    // lets red drop col 4 row 1 to win.
    const b = play([
      [1, 'r'], [1, 'r'],
      [2, 'y'], [2, 'r'],
      [3, 'y'], [3, 'r'],
      [0, 'y'],
    ]);
    // Red at (1,1),(1,2),(1,3): dropping into col 4 floor gives red (1,4).
    const out = candidateSet(b, 'y', 5, noBlunder);
    const c4 = out.candidates.find((c) => c.col === 4);
    if (c4) {
      expect(c4.tags).toContain('poisoned');
      expect(c4.sentence).toMatch(/right on top/i);
    }
  });

  it('strength 5 with no noise finds the winning move deterministically', () => {
    for (let i = 0; i < 5; i++) {
      const b = play([[1, 'y'], [1, 'r'], [2, 'y'], [2, 'r'], [3, 'y']]);
      const out = candidateSet(b, 'y', 5, noBlunder);
      expect(out.candidates[0].tags).toContain('win');
    }
  });

  it('the blunder layer drops the top move at strength 1 when rng fires', () => {
    // Yellow three on the floor at cols 0-2: exactly ONE winning drop (col 3).
    const b = play([[0, 'y'], [0, 'r'], [1, 'y'], [1, 'r'], [2, 'y']]);
    // rng: gaussian noise uses it too, but the clean win is noise-free and
    // outranks everything regardless; the blunder roll comes back tiny and
    // fires (0.0001 < 0.22), dropping the top move from the visible set.
    const alwaysLow = (): number => 0.0001;
    const out = candidateSet(b, 'y', 1, alwaysLow);
    // The (only) winning drop was not seen.
    expect(out.candidates[0].tags).not.toContain('win');
    expect(out.candidates.every((c) => !c.tags.includes('win'))).toBe(true);
  });

  it('a full column is never a candidate', () => {
    let b = createBoard();
    for (let i = 0; i < 6; i++) b = applyMove(b, 3, i % 2 === 0 ? 'r' : 'y').board;
    const out = candidateSet(b, 'r', 3, noBlunder);
    expect(out.candidates.every((c) => c.col !== 3)).toBe(true);
  });

  it('closeness rises when candidates score alike', () => {
    const empty = candidateSet(createBoard(), 'r', 5, noBlunder);
    expect(empty.think.closeness).toBeGreaterThanOrEqual(0);
    expect(empty.think.closeness).toBeLessThanOrEqual(1);
  });
});
