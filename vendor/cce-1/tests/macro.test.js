import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { cpToWin, macroText, materialCount, naiveMaterialWin, winBand } from '../src/macro.js';

const START = new Chess().fen();

test('material count at the start position', () => {
  const m = materialCount(START);
  assert.equal(m.white, 39);
  assert.equal(m.black, 39);
  assert.equal(m.diff, 0);
});

test('cpToWin is monotonic and centered', () => {
  assert.ok(Math.abs(cpToWin(0) - 0.5) < 1e-9);
  assert.ok(cpToWin(200) > 0.6);
  assert.ok(cpToWin(-200) < 0.4);
});

test('naive material win is centered and monotonic', () => {
  assert.equal(naiveMaterialWin(0), 0.5);
  assert.ok(naiveMaterialWin(3) > 0.7);
});

test('a 400 sees the full range', () => {
  const band = winBand({
    engineWin: 0.9,
    materialDiff: 0,
    bandHalfWidth: 0.5,
    materialShiftWeight: 0.8,
    perspective: 'w',
  });
  assert.equal(band.lo, 0);
  assert.equal(band.hi, 100);
});

test('a 2000 sees a tight band around the engine estimate', () => {
  const band = winBand({
    engineWin: 0.7,
    materialDiff: 0,
    bandHalfWidth: 0.025,
    materialShiftWeight: 0,
    perspective: 'w',
  });
  assert.ok(band.hi - band.lo <= 10);
  assert.ok(band.lo >= 60 && band.hi <= 80);
});

test('low-Elo band center drifts toward material', () => {
  // Engine sees white winning (0.9) but material is even: a weak player
  // should NOT be confident.
  const weak = winBand({
    engineWin: 0.9,
    materialDiff: 0,
    bandHalfWidth: 0.1,
    materialShiftWeight: 0.8,
    perspective: 'w',
  });
  assert.ok(weak.center < 70, `center ${weak.center}`);
});

test('perspective flips for black', () => {
  const band = winBand({
    engineWin: 0.8,
    materialDiff: 0,
    bandHalfWidth: 0.05,
    materialShiftWeight: 0,
    perspective: 'b',
  });
  assert.ok(band.center <= 25);
});

test('macro text mentions material and the band', () => {
  const text = macroText(START, { lo: 30, hi: 70 }, 'w');
  assert.match(text, /Material is even/);
  assert.match(text, /between 30% and 70%/);
});
