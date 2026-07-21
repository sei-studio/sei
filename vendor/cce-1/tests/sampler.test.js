import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gumbelTopK, mulberry32, sampleBottomTail, sampleOne } from '../src/sampler.js';

const dist = [
  { uci: 'e2e4', p: 0.5 },
  { uci: 'd2d4', p: 0.3 },
  { uci: 'g1f3', p: 0.1 },
  { uci: 'c2c4', p: 0.05 },
  { uci: 'b1c3', p: 0.03 },
  { uci: 'a2a3', p: 0.015 },
  { uci: 'h2h4', p: 0.005 }, // below the 1% floor
];

test('gumbelTopK is deterministic under a seeded rng', () => {
  const a = gumbelTopK(dist, { k: 4, temperature: 1, rng: mulberry32(7) });
  const b = gumbelTopK(dist, { k: 4, temperature: 1, rng: mulberry32(7) });
  assert.deepEqual(a.map((m) => m.uci), b.map((m) => m.uci));
  assert.equal(a.length, 4);
});

test('sub-floor moves are excluded when enough moves remain', () => {
  for (let seed = 0; seed < 50; seed++) {
    const picks = gumbelTopK(dist, { k: 4, temperature: 2, rng: mulberry32(seed) });
    assert.ok(!picks.some((m) => m.uci === 'h2h4'), `seed ${seed} sampled a sub-floor move`);
  }
});

test('pool refills from below the floor when k exceeds it', () => {
  const tiny = [
    { uci: 'e2e4', p: 0.99 },
    { uci: 'd2d4', p: 0.006 },
    { uci: 'g1f3', p: 0.004 },
  ];
  const picks = gumbelTopK(tiny, { k: 3, temperature: 1, rng: mulberry32(1) });
  assert.equal(picks.length, 3);
});

test('higher temperature flattens the pick distribution', () => {
  const counts = { cold: 0, hot: 0 };
  for (let seed = 0; seed < 300; seed++) {
    if (gumbelTopK(dist, { k: 1, temperature: 1, rng: mulberry32(seed) })[0].uci === 'e2e4') counts.cold++;
    if (gumbelTopK(dist, { k: 1, temperature: 4, rng: mulberry32(seed) })[0].uci === 'e2e4') counts.hot++;
  }
  assert.ok(counts.cold > counts.hot, `cold=${counts.cold} hot=${counts.hot}`);
});

test('sampleOne returns a single move', () => {
  const m = sampleOne(dist, { temperature: 1, rng: mulberry32(3) });
  assert.ok(dist.some((d) => d.uci === m.uci));
});

test('sampleBottomTail avoids excluded moves and prefers the tail', () => {
  const exclude = new Set(['e2e4', 'd2d4']);
  for (let seed = 0; seed < 50; seed++) {
    const m = sampleBottomTail(dist, { exclude, rng: mulberry32(seed) });
    assert.ok(!exclude.has(m.uci));
    assert.ok(m.p <= 0.05, `picked ${m.uci} with p=${m.p}`);
  }
});
