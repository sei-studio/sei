import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { boardTokens, mirrorFen, mirrorMove, mirrorSquare } from '../src/encode.js';

const START = new Chess().fen();

test('boardTokens start position spot checks', () => {
  const t = boardTokens(START);
  assert.equal(t.length, 768);
  // a1 = square 0 holds a white rook (piece index 3)
  assert.equal(t[0 * 12 + 3], 1);
  // e1 = square 4 holds the white king (piece index 5)
  assert.equal(t[4 * 12 + 5], 1);
  // e8 = square 60 holds the black king (piece index 11)
  assert.equal(t[60 * 12 + 11], 1);
  // e4 = square 28 is empty
  for (let p = 0; p < 12; p++) assert.equal(t[28 * 12 + p], 0);
  // 32 pieces on the board
  assert.equal(t.reduce((a, b) => a + b, 0), 32);
});

test('mirrorSquare and mirrorMove flip ranks only', () => {
  assert.equal(mirrorSquare('a2'), 'a7');
  assert.equal(mirrorSquare('h8'), 'h1');
  assert.equal(mirrorMove('e7e5'), 'e2e4');
  assert.equal(mirrorMove('a2a1q'), 'a7a8q');
});

test('mirrorFen produces a legal equivalent white-to-move position', () => {
  const c = new Chess();
  c.move('e4');
  const mirrored = mirrorFen(c.fen());
  assert.equal(mirrored.split(' ')[1], 'w');
  // Must parse as a legal position with the same number of legal moves.
  const m = new Chess(mirrored);
  assert.equal(m.moves().length, new Chess(c.fen()).moves().length);
});

test('mirrorFen swaps castling rights and mirrors en passant', () => {
  const fen = 'rnbqkbnr/ppp1pppp/8/3p4/8/8/PPPPPPPP/RNBQKBNR w KQkq d6 0 2';
  const mirrored = mirrorFen(fen);
  const parts = mirrored.split(' ');
  assert.equal(parts[2], 'KQkq');
  assert.equal(parts[3], 'd3');
  // Double mirror is identity.
  assert.equal(mirrorFen(mirrored), fen);
});
