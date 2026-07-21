import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { describeCandidate } from '../src/translate.js';

const START = new Chess().fen();

test('quiet pawn move', () => {
  const d = describeCandidate(START, 'e2e4');
  assert.equal(d.san, 'e4');
  assert.match(d.sentence, /pawn from e2 to e4/);
  assert.equal(d.line, null);
});

test('capture with threat tags', () => {
  // White knight takes a queen parked on d5.
  const fen = 'rnb1kbnr/pppp1ppp/8/3q4/8/2N5/PPPP1PPP/R1BQKBNR w KQkq - 0 4';
  const d = describeCandidate(fen, 'c3d5');
  assert.match(d.sentence, /take the queen on d5/);
  assert.ok(d.tags.includes('capture'));
});

test('checkmate is tagged and described', () => {
  // Fool's mate: after 1.f3 e5 2.g4, Qh4 is mate.
  const c = new Chess();
  c.move('f3');
  c.move('e5');
  c.move('g4');
  const d = describeCandidate(c.fen(), 'd8h4');
  assert.ok(d.tags.includes('checkmate'));
  assert.match(d.sentence, /checkmate/);
});

test('rollout line renders sentences and a material verdict', () => {
  // 1.e4 d5 2.exd5: white ends a pawn up in the imagined line.
  const d = describeCandidate(START, 'e2e4', ['d7d5', 'e4d5']);
  assert.ok(d.line);
  assert.deepEqual(d.line.sans, ['e4', 'd5', 'exd5']);
  assert.match(d.line.sentence, /^You imagine: /);
  assert.match(d.line.sentence, /1 point of material ahead/);
});

test('hanging piece is called out', () => {
  // Queen moves to h5 where it can be taken... use a simple hang:
  // 1.e4 e5 2.Qh5 g6 — now if white plays Qxe5?? no; instead test a move
  // onto an attacked, undefended square: 1.e4 e5 2.Nf3 Nc6 3.Bb5 a6 4.Ba4 b5
  // then Bb3 is safe; simpler: from start after 1.e4 e5, White Qg4 hangs to nothing.
  // Use: white queen to g4 after 1.e4 d5 — Bc8 attacks g4, queen undefended there.
  const c = new Chess();
  c.move('e4');
  c.move('d5');
  const d = describeCandidate(c.fen(), 'd1g4');
  assert.ok(d.tags.includes('hangs'), `tags: ${d.tags}`);
  assert.match(d.sentence, /could be taken/);
});

test('en passant capture is described', () => {
  const c = new Chess();
  c.move('e4');
  c.move('a6');
  c.move('e5');
  c.move('d5');
  const d = describeCandidate(c.fen(), 'e5d6');
  assert.ok(d.tags.includes('en-passant'));
  assert.match(d.sentence, /en passant/);
});
