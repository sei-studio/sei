import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  temperature,
  blunderProb,
  blinderProb,
  lookaheadPlies,
  bandHalfWidth,
  materialShiftWeight,
} from '../src/formulas.js';

test('temperature is 1 in the calibrated range, 2 at Elo 400', () => {
  assert.equal(temperature(400), 2);
  assert.equal(temperature(600), 1);
  assert.equal(temperature(1500), 1);
  assert.equal(temperature(2000), 1);
  assert.ok(temperature(500) > 1 && temperature(500) < 2);
});

test('blunder probability decays exponentially with Elo', () => {
  assert.ok(blunderProb(400) >= 0.85);
  assert.ok(blunderProb(1000) < 0.15);
  assert.ok(blunderProb(2000) < 0.01);
  assert.ok(blunderProb(400) > blunderProb(800));
});

test('blinder probability is a reversed sigmoid', () => {
  assert.ok(blinderProb(400) > 0.95);
  assert.ok(Math.abs(blinderProb(1200) - 0.5) < 1e-9);
  assert.ok(blinderProb(2000) < 0.05);
});

test('lookahead plies scale with Elo, clipped to 1..8', () => {
  assert.equal(lookaheadPlies(400), 1);
  assert.equal(lookaheadPlies(1000), 4);
  assert.equal(lookaheadPlies(2000), 8);
  assert.equal(lookaheadPlies(3000), 8);
});

test('band half-width shrinks from full range to five points', () => {
  assert.equal(bandHalfWidth(400), 0.5);
  assert.ok(Math.abs(bandHalfWidth(2000) - 0.025) < 1e-9);
  assert.ok(bandHalfWidth(1200) < 0.5 && bandHalfWidth(1200) > 0.025);
});

test('material shift fades to zero by Elo 1600', () => {
  assert.ok(materialShiftWeight(400) > 0.7);
  assert.equal(materialShiftWeight(1600), 0);
  assert.equal(materialShiftWeight(2000), 0);
});
