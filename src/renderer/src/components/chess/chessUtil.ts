/**
 * chessUtil — pure helpers for the renderer-side chess UI.
 *
 * The authoritative game lives in main (src/main/chess/); the renderer uses
 * chess.js only for LOCAL concerns: legality hints (move dots), promotion
 * detection, check highlighting, and applying the not-yet-committed pending AI
 * move to the display board. Nothing here mutates game state.
 */

import { Chess, type Square } from 'chess.js';
import type { ChessColor } from '@shared/chessIpc';

export type { Square };

export const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] as const;
export const RANKS = ['1', '2', '3', '4', '5', '6', '7', '8'] as const;

/** Split a UCI string into chess.js move-object parts. */
export function uciParts(uci: string): { from: Square; to: Square; promotion?: string } {
  return {
    from: uci.slice(0, 2) as Square,
    to: uci.slice(2, 4) as Square,
    ...(uci.length > 4 ? { promotion: uci.slice(4, 5) } : {}),
  };
}

/** FEN after applying a UCI move; falls back to the input FEN when illegal. */
export function fenAfterUci(fen: string, uci: string): string {
  try {
    const c = new Chess(fen);
    c.move(uciParts(uci));
    return c.fen();
  } catch {
    return fen;
  }
}

export interface LegalTarget {
  to: Square;
  capture: boolean;
  promotion: boolean;
}

/** Legal destinations from a square in the given position. */
export function legalTargets(fen: string, from: Square): LegalTarget[] {
  try {
    const c = new Chess(fen);
    return c.moves({ square: from, verbose: true }).map((m) => ({
      to: m.to as Square,
      capture: m.flags.includes('c') || m.flags.includes('e'),
      promotion: m.flags.includes('p'),
    }));
  } catch {
    return [];
  }
}

/** True when from→to is a legal move in the position. */
export function isLegal(fen: string, from: Square, to: Square): boolean {
  return legalTargets(fen, from).some((t) => t.to === to);
}

/** True when from→to is a legal PROMOTION move (needs the piece picker). */
export function isPromotion(fen: string, from: Square, to: Square): boolean {
  return legalTargets(fen, from).some((t) => t.to === to && t.promotion);
}

/** The square of `color`'s king in `fen` (null on a malformed FEN). */
export function kingSquare(fen: string, color: ChessColor): Square | null {
  try {
    const c = new Chess(fen);
    for (const row of c.board()) {
      for (const cell of row) {
        if (cell && cell.type === 'k' && cell.color === color) return cell.square as Square;
      }
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** The checked king's square, or null when the side to move is not in check. */
export function checkedKingSquare(fen: string): Square | null {
  try {
    const c = new Chess(fen);
    return c.inCheck() ? kingSquare(fen, c.turn() as ChessColor) : null;
  } catch {
    return null;
  }
}

export interface BoardPiece {
  square: Square;
  /** 'wp' | 'wn' | ... | 'bk' — color + type. */
  code: string;
}

/** Flat piece list for rendering a FEN. */
export function piecesOf(fen: string): BoardPiece[] {
  const out: BoardPiece[] = [];
  try {
    const c = new Chess(fen);
    for (const row of c.board()) {
      for (const cell of row) {
        if (cell) out.push({ square: cell.square as Square, code: `${cell.color}${cell.type}` });
      }
    }
  } catch {
    /* empty board on malformed FEN */
  }
  return out;
}

/** Column (0-7, left to right) of a square as drawn for the given orientation. */
export function colOf(square: string, orientation: ChessColor): number {
  const file = square.charCodeAt(0) - 97;
  return orientation === 'w' ? file : 7 - file;
}

/** Row (0-7, top to bottom) of a square as drawn for the given orientation. */
export function rowOf(square: string, orientation: ChessColor): number {
  const rank = square.charCodeAt(1) - 49;
  return orientation === 'w' ? 7 - rank : rank;
}

/** Square at drawn (col, row) for the given orientation; null out of bounds. */
export function squareAt(col: number, row: number, orientation: ChessColor): Square | null {
  if (col < 0 || col > 7 || row < 0 || row > 7) return null;
  const file = orientation === 'w' ? col : 7 - col;
  const rank = orientation === 'w' ? 7 - row : row;
  return (FILES[file] + RANKS[rank]) as Square;
}

/** True for a dark square (a1 is dark). */
export function isDarkSquare(square: string): boolean {
  const file = square.charCodeAt(0) - 97;
  const rank = square.charCodeAt(1) - 49;
  return (file + rank) % 2 === 0;
}

/** Material captured FROM each side (pieces missing vs the starting set). */
export function capturedMaterial(fen: string): { w: string[]; b: string[]; diff: number } {
  const START: Record<string, number> = { p: 8, n: 2, b: 2, r: 2, q: 1 };
  const VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9 };
  const count: Record<string, Record<string, number>> = {
    w: { p: 0, n: 0, b: 0, r: 0, q: 0 },
    b: { p: 0, n: 0, b: 0, r: 0, q: 0 },
  };
  const placement = fen.split(' ')[0] ?? '';
  for (const ch of placement) {
    const lower = ch.toLowerCase();
    if (!(lower in START)) continue;
    count[ch === lower ? 'b' : 'w'][lower] += 1;
  }
  const order = ['q', 'r', 'b', 'n', 'p'];
  const missing = (color: 'w' | 'b'): string[] =>
    order.flatMap((t) => Array(Math.max(0, START[t] - count[color][t])).fill(t) as string[]);
  const w = missing('w');
  const b = missing('b');
  const sum = (list: string[]): number => list.reduce((acc, t) => acc + VALUE[t], 0);
  // Positive = white is up material (black lost more).
  return { w, b, diff: sum(b) - sum(w) };
}
