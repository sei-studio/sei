import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rollFields,
  mulberry32,
  BACKGROUNDS,
  HAIR_COLORS,
  HAIR_STYLES,
  EYE_COLORS,
  EYE_SPECIAL,
  HEIGHTS,
  BUILDS,
  BUSTS,
  PERSONALITY_SEEDS,
  QUIRK_SEEDS,
  PALETTE_ACCENTS,
  AGE_RANGES,
  DYNAMICS,
} from '../src/index.js';

test('determinism: same seed yields identical rolls', () => {
  const a = rollFields({ gender: 'female', rng: mulberry32(42) });
  const b = rollFields({ gender: 'female', rng: mulberry32(42) });
  assert.deepEqual(a, b);
});

test('determinism: different seeds usually differ', () => {
  const a = rollFields({ gender: 'male', rng: mulberry32(1) });
  const b = rollFields({ gender: 'male', rng: mulberry32(2) });
  assert.notDeepEqual(a, b);
});

test('invalid gender throws', () => {
  assert.throws(() => rollFields({ gender: 'nonbinary' }), /gender must be one of/);
});

test('table coverage: many rolls stay within tables and hit variety', () => {
  const seen = {
    background: new Set(),
    hair_color: new Set(),
    hair_style: new Set(),
    eye_color: new Set(),
    height: new Set(),
    build: new Set(),
    personality: new Set(),
    quirk_seed: new Set(),
    palette_accent: new Set(),
  };
  const bgValues = BACKGROUNDS.map((e) => e.value);
  const eyeAll = [...EYE_COLORS, ...EYE_SPECIAL];

  for (let i = 0; i < 4000; i += 1) {
    const r = rollFields({ gender: 'female', rng: mulberry32(i) });
    assert.ok(bgValues.includes(r.background));
    assert.ok(HAIR_COLORS.includes(r.hair_color));
    assert.ok(HAIR_STYLES.includes(r.hair_style));
    assert.ok(eyeAll.includes(r.eye_color));
    assert.ok(HEIGHTS.includes(r.height));
    assert.ok(BUILDS.includes(r.build));
    assert.ok(BUSTS.includes(r.bust));
    assert.equal(r.personality_seeds.length, 2);
    assert.notEqual(r.personality_seeds[0], r.personality_seeds[1]);
    r.personality_seeds.forEach((p) => assert.ok(PERSONALITY_SEEDS.includes(p)));
    assert.ok(QUIRK_SEEDS.includes(r.quirk_seed));
    assert.ok(PALETTE_ACCENTS.includes(r.palette_accent));

    seen.background.add(r.background);
    seen.hair_color.add(r.hair_color);
    seen.hair_style.add(r.hair_style);
    seen.eye_color.add(r.eye_color);
    seen.height.add(r.height);
    seen.build.add(r.build);
    r.personality_seeds.forEach((p) => seen.personality.add(p));
    seen.quirk_seed.add(r.quirk_seed);
    seen.palette_accent.add(r.palette_accent);
  }

  // Every option in each table should appear at least once over 4000 rolls.
  assert.equal(seen.background.size, bgValues.length);
  assert.equal(seen.hair_color.size, HAIR_COLORS.length);
  assert.equal(seen.hair_style.size, HAIR_STYLES.length);
  assert.equal(seen.height.size, HEIGHTS.length);
  assert.equal(seen.build.size, BUILDS.length);
  assert.equal(seen.personality.size, PERSONALITY_SEEDS.length);
  assert.equal(seen.quirk_seed.size, QUIRK_SEEDS.length);
  assert.equal(seen.palette_accent.size, PALETTE_ACCENTS.length);
  // Eyes: all normal colors, plus at least one heterochromia special.
  EYE_COLORS.forEach((c) => assert.ok(seen.eye_color.has(c), `missing eye color ${c}`));
  assert.ok(EYE_SPECIAL.some((c) => seen.eye_color.has(c)), 'heterochromia never rolled');
});

test('bust is rolled only for female', () => {
  for (let i = 0; i < 200; i += 1) {
    const f = rollFields({ gender: 'female', rng: mulberry32(i) });
    assert.ok('bust' in f, 'female should have bust');
    const m = rollFields({ gender: 'male', rng: mulberry32(i) });
    assert.ok(!('bust' in m), 'male should not have bust');
    const o = rollFields({ gender: 'other', rng: mulberry32(i) });
    assert.ok(!('bust' in o), 'other should not have bust');
  }
});

test('age-range mapping respects profile bounds', () => {
  for (const [key, range] of Object.entries(AGE_RANGES)) {
    for (let i = 0; i < 300; i += 1) {
      const r = rollFields({
        gender: 'other',
        userProfile: { companion_age_range: key },
        rng: mulberry32(i * 7 + 1),
      });
      assert.ok(r.age >= range.min && r.age <= range.max, `${key}: age ${r.age} out of [${range.min},${range.max}]`);
      if (range.apparent_only) {
        assert.equal(r.apparent_only, true, 'timeless should flag apparent_only');
      } else {
        assert.equal(r.apparent_only, false);
      }
    }
  }
});

test('no profile: age falls within default 18-60', () => {
  for (let i = 0; i < 500; i += 1) {
    const r = rollFields({ gender: 'male', rng: mulberry32(i) });
    assert.ok(r.age >= 18 && r.age <= 60, `age ${r.age} out of default range`);
    assert.equal(r.apparent_only, false);
  }
});

// ---------------------------------------------------------------------------
// Relationship dynamics
// ---------------------------------------------------------------------------

test('every DYNAMICS seed_pool entry exists in PERSONALITY_SEEDS', () => {
  for (const [key, d] of Object.entries(DYNAMICS)) {
    assert.ok(Array.isArray(d.seed_pool) && d.seed_pool.length >= 3, `${key} pool too small`);
    for (const seed of d.seed_pool) {
      assert.ok(PERSONALITY_SEEDS.includes(seed), `${key} pool entry not a personality seed: ${seed}`);
    }
    assert.ok(typeof d.label === 'string' && d.label.length > 0);
    assert.ok(typeof d.hint === 'string' && d.hint.length > 0);
  }
});

test('invalid dynamic throws', () => {
  assert.throws(() => rollFields({ gender: 'female', dynamic: 'soulmate' }), /dynamic must be one of/);
});

test('no dynamic: rolled.dynamic is null and both seeds free-roll', () => {
  const r = rollFields({ gender: 'male', rng: mulberry32(11) });
  assert.equal(r.dynamic, null);
  assert.equal(r.personality_seeds.length, 2);
});

test('dynamic biases seed 1 into the pool; seed 2 stays free and distinct', () => {
  for (const [key, d] of Object.entries(DYNAMICS)) {
    const outsidePoolSeen = new Set();
    for (let i = 0; i < 400; i += 1) {
      const r = rollFields({ gender: 'female', dynamic: key, rng: mulberry32(i * 7 + 1) });
      assert.equal(r.dynamic, key);
      const [first, second] = r.personality_seeds;
      assert.ok(d.seed_pool.includes(first), `${key}: seed 1 "${first}" not in pool`);
      assert.ok(PERSONALITY_SEEDS.includes(second));
      assert.notEqual(first, second);
      if (!d.seed_pool.includes(second)) outsidePoolSeen.add(second);
    }
    // Seed 2 must be a FREE roll: across 400 casts it must escape the pool
    // sometimes, or two same-dynamic companions would all feel alike.
    assert.ok(outsidePoolSeen.size > 0, `${key}: seed 2 never left the pool`);
  }
});

test('dynamic rolls stay deterministic under the same seed', () => {
  const a = rollFields({ gender: 'other', dynamic: 'challenger', rng: mulberry32(99) });
  const b = rollFields({ gender: 'other', dynamic: 'challenger', rng: mulberry32(99) });
  assert.deepEqual(a, b);
});
