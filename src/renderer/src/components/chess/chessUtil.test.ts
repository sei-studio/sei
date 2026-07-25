import { describe, it, expect } from 'vitest';
import {
  fenAfterUci,
  legalTargets,
  isLegal,
  isPromotion,
  checkedKingSquare,
  piecesOf,
  colOf,
  rowOf,
  squareAt,
  capturedMaterial,
  replayHistory,
  START_FEN,
} from './chessUtil';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

describe('replayHistory', () => {
  it('rebuilds per-ply FENs from recorded moves (fool\'s mate)', () => {
    const records = replayHistory([
      { san: 'f3', uci: 'f2f3' },
      { san: 'e5', uci: 'e7e5' },
      { san: 'g4', uci: 'g2g4' },
      { san: 'Qh4#', uci: 'd8h4' },
    ]);
    expect(records).toHaveLength(4);
    expect(records[0].fen).toBe(fenAfterUci(START_FEN, 'f2f3'));
    expect(records[3].san).toBe('Qh4#');
    // Final position is checkmate: the white king is in check.
    expect(checkedKingSquare(records[3].fen)).toBe('e1');
  });

  it('truncates at the first move that fails to apply', () => {
    const records = replayHistory([
      { san: 'e4', uci: 'e2e4' },
      { san: '??', uci: 'e2e5' }, // illegal from this position
      { san: 'Nf3', uci: 'g1f3' },
    ]);
    expect(records).toHaveLength(1);
    expect(records[0].san).toBe('e4');
  });

  it('returns an empty list for no moves', () => {
    expect(replayHistory([])).toEqual([]);
  });
});

describe('fenAfterUci', () => {
  it('applies a legal move', () => {
    const next = fenAfterUci(START, 'e2e4');
    expect(next).toContain(' b '); // black to move
    expect(next.startsWith('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR')).toBe(true);
  });

  it('applies a promotion move', () => {
    const fen = '8/P7/8/8/8/8/8/K1k5 w - - 0 1';
    const next = fenAfterUci(fen, 'a7a8q');
    expect(next.startsWith('Q7/8/')).toBe(true);
  });

  it('returns the input FEN for an illegal move', () => {
    expect(fenAfterUci(START, 'e2e5')).toBe(START);
  });
});

describe('legality helpers', () => {
  it('lists pawn double-step and single-step from the start', () => {
    const targets = legalTargets(START, 'e2').map((t) => t.to);
    expect(targets.sort()).toEqual(['e3', 'e4']);
  });

  it('flags captures', () => {
    const fen = 'k7/8/8/3p4/4P3/8/8/K7 w - - 0 1';
    const cap = legalTargets(fen, 'e4').find((t) => t.to === 'd5');
    expect(cap?.capture).toBe(true);
  });

  it('detects promotion moves', () => {
    const fen = '8/P7/8/8/8/8/8/K1k5 w - - 0 1';
    expect(isPromotion(fen, 'a7', 'a8')).toBe(true);
    expect(isLegal(fen, 'a7', 'a8')).toBe(true);
    expect(isPromotion(START, 'e2', 'e4')).toBe(false);
  });
});

describe('checkedKingSquare', () => {
  it('finds the checked king', () => {
    // White king on e1 checked by a rook on e8.
    const fen = '4r2k/8/8/8/8/8/8/4K3 w - - 0 1';
    expect(checkedKingSquare(fen)).toBe('e1');
  });

  it('is null when not in check', () => {
    expect(checkedKingSquare(START)).toBeNull();
  });
});

describe('board geometry', () => {
  it('maps squares for the white orientation', () => {
    expect(colOf('a1', 'w')).toBe(0);
    expect(rowOf('a1', 'w')).toBe(7);
    expect(colOf('h8', 'w')).toBe(7);
    expect(rowOf('h8', 'w')).toBe(0);
    expect(squareAt(0, 7, 'w')).toBe('a1');
  });

  it('mirrors both axes for the black orientation', () => {
    expect(colOf('a1', 'b')).toBe(7);
    expect(rowOf('a1', 'b')).toBe(0);
    expect(squareAt(7, 0, 'b')).toBe('a1');
    expect(squareAt(0, 0, 'b')).toBe('h1');
  });

  it('round-trips every square in both orientations', () => {
    for (const orientation of ['w', 'b'] as const) {
      for (let col = 0; col < 8; col++) {
        for (let row = 0; row < 8; row++) {
          const sq = squareAt(col, row, orientation)!;
          expect(colOf(sq, orientation)).toBe(col);
          expect(rowOf(sq, orientation)).toBe(row);
        }
      }
    }
  });

  it('returns null out of bounds', () => {
    expect(squareAt(-1, 0, 'w')).toBeNull();
    expect(squareAt(8, 3, 'w')).toBeNull();
  });
});

describe('piecesOf', () => {
  it('lists all 32 starting pieces with codes', () => {
    const pieces = piecesOf(START);
    expect(pieces).toHaveLength(32);
    expect(pieces.find((p) => p.square === 'e1')?.code).toBe('wk');
    expect(pieces.find((p) => p.square === 'd8')?.code).toBe('bq');
  });
});

describe('capturedMaterial', () => {
  it('is empty at the start', () => {
    const { w, b, diff } = capturedMaterial(START);
    expect(w).toHaveLength(0);
    expect(b).toHaveLength(0);
    expect(diff).toBe(0);
  });

  it('counts missing pieces and the point diff', () => {
    // Black is missing the queen and a pawn; white is missing a knight.
    const fen = 'rnb1kbnr/ppppppp1/8/8/8/8/PPPPPPPP/R1BQKBNR w KQkq - 0 1';
    const { w, b, diff } = capturedMaterial(fen);
    expect(b.sort()).toEqual(['p', 'q']);
    expect(w).toEqual(['n']);
    expect(diff).toBe(10 - 3);
  });
});
