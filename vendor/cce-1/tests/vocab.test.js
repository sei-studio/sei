import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moveToIndex, indexToMove, MOVE_VOCAB_SIZE, squareName } from '../src/vocab.js';

test('vocab has 4352 entries', () => {
  assert.equal(MOVE_VOCAB_SIZE, 4352);
});

test('square naming', () => {
  assert.equal(squareName(0), 'a1');
  assert.equal(squareName(7), 'h1');
  assert.equal(squareName(63), 'h8');
});

test('from-to block indices match the maia3 reference layout', () => {
  assert.equal(moveToIndex('a1a1'), 0);
  assert.equal(moveToIndex('a1b1'), 1);
  assert.equal(moveToIndex('e2e4'), (1 * 8 + 4) * 64 + (3 * 8 + 4));
  assert.equal(moveToIndex('h8h8'), 4095);
});

test('promotion block indices match the maia3 reference layout', () => {
  assert.equal(moveToIndex('a7a8q'), 4096);
  assert.equal(moveToIndex('a7a8n'), 4099);
  assert.equal(moveToIndex('a7b8q'), 4100);
  assert.equal(moveToIndex('b7a8q'), 4128);
  assert.equal(moveToIndex('h7h8n'), 4351);
});

test('roundtrip', () => {
  for (const uci of ['a1a1', 'e2e4', 'g1f3', 'a7a8q', 'h7g8n']) {
    assert.equal(indexToMove(moveToIndex(uci)), uci);
  }
});
