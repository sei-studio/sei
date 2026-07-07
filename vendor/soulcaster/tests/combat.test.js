import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rollFields, mulberry32, COMBAT_ARCHETYPES, COMBAT_SPECIES_MODIFIERS } from '../src/index.js';

const STATS = ['melee', 'ranged', 'defense', 'intelligence'];
const BACKGROUNDS = ['human', 'elf', 'robot', 'beastkin'];

test('determinism: same seed yields identical combat rolls', () => {
  const a = rollFields({ gender: 'female', rng: mulberry32(42) });
  const b = rollFields({ gender: 'female', rng: mulberry32(42) });
  assert.deepEqual(a.combat, b.combat);
});

test('quantization: every stat lands on a 0.05 step', () => {
  for (let i = 0; i < 2000; i += 1) {
    const r = rollFields({ gender: 'other', rng: mulberry32(i) });
    for (const stat of STATS) {
      const v = r.combat[stat];
      // v / 0.05 should be (very close to) an integer.
      const steps = v / 0.05;
      assert.ok(
        Math.abs(steps - Math.round(steps)) < 1e-9,
        `${stat}=${v} is not on a 0.05 step (seed ${i})`,
      );
    }
  }
});

test('bounds: every stat stays within [0,1]', () => {
  for (let i = 0; i < 4000; i += 1) {
    const r = rollFields({ gender: 'male', rng: mulberry32(i) });
    for (const stat of STATS) {
      const v = r.combat[stat];
      assert.ok(v >= 0 && v <= 1, `${stat}=${v} out of [0,1] (seed ${i})`);
    }
  }
});

test('archetype coverage: every archetype appears over 4000 rolls', () => {
  const seen = new Set();
  const labels = COMBAT_ARCHETYPES.map((e) => e.value.label);
  for (let i = 0; i < 4000; i += 1) {
    const r = rollFields({ gender: 'female', rng: mulberry32(i) });
    assert.ok(labels.includes(r.combat.archetype), `unknown archetype ${r.combat.archetype}`);
    seen.add(r.combat.archetype);
  }
  for (const label of labels) {
    assert.ok(seen.has(label), `archetype "${label}" never rolled in 4000 tries`);
  }
});

test('species modifier clamp: modified stats never exceed [0,1] even at the top of a band', () => {
  // Species modifiers are additive bumps on top of an archetype band; the
  // roller must clamp the result. We can't force a specific archetype/band
  // combination through the public API, so we sweep many seeds per species
  // and assert the invariant holds everywhere rather than constructing one.
  for (const background of BACKGROUNDS) {
    for (let i = 0; i < 1000; i += 1) {
      const r = rollFields({ gender: 'other', userProfile: null, rng: mulberry32(i * 13 + 1) });
      // rollFields doesn't let us force a background, so just check bounds on
      // whatever background comes up; over 1000 seeds all four appear.
      for (const stat of STATS) {
        assert.ok(r.combat[stat] >= 0 && r.combat[stat] <= 1);
      }
    }
  }
});

test('species modifiers are documented for every background used by rollFields', () => {
  for (const background of BACKGROUNDS) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(COMBAT_SPECIES_MODIFIERS, background),
      `no COMBAT_SPECIES_MODIFIERS entry for ${background}`,
    );
  }
});

test('species modifier direction: elf/beastkin/robot show a higher mean than human on their specialty stats', () => {
  const N = 3000;
  const sums = { human: {}, elf: {}, beastkin: {}, robot: {} };
  const counts = { human: 0, elf: 0, beastkin: 0, robot: 0 };
  for (const b of BACKGROUNDS) for (const s of STATS) sums[b][s] = 0;

  for (let i = 0; i < N; i += 1) {
    const r = rollFields({ gender: 'female', rng: mulberry32(i) });
    counts[r.background] += 1;
    for (const stat of STATS) sums[r.background][stat] += r.combat[stat];
  }

  const mean = (b, s) => sums[b][s] / counts[b];

  assert.ok(mean('elf', 'ranged') > mean('human', 'ranged'), 'elf should out-range human on average');
  assert.ok(mean('elf', 'defense') > mean('human', 'defense'), 'elf should out-defense human on average');
  assert.ok(mean('beastkin', 'melee') > mean('human', 'melee'), 'beastkin should out-melee human on average');
  assert.ok(mean('beastkin', 'defense') > mean('human', 'defense'), 'beastkin should out-defense human on average');
  assert.ok(mean('robot', 'ranged') > mean('human', 'ranged'), 'robot should out-range human on average');
  assert.ok(mean('robot', 'intelligence') > mean('human', 'intelligence'), 'robot should out-intelligence human on average');
});

test('combat object always has exactly the four stats plus archetype', () => {
  const r = rollFields({ gender: 'male', rng: mulberry32(7) });
  assert.deepEqual(Object.keys(r.combat).sort(), ['archetype', 'defense', 'intelligence', 'melee', 'ranged']);
  assert.equal(typeof r.combat.archetype, 'string');
});
