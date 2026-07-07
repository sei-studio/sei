import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rollFields,
  mulberry32,
  resolveLifeContextBand,
  HERITAGES,
  LIFE_CONTEXTS,
  LIFE_CONTEXT_AGE_BANDS,
  LIFE_CONTEXT_WEIGHTS,
} from '../src/index.js';

const CATEGORIES = Object.keys(LIFE_CONTEXT_WEIGHTS);
const HERITAGE_VALUES = HERITAGES.map((h) => h.value);

test('determinism: same seed yields identical heritage + life_context', () => {
  const a = rollFields({ gender: 'female', rng: mulberry32(42) });
  const b = rollFields({ gender: 'female', rng: mulberry32(42) });
  assert.equal(a.heritage, b.heritage);
  assert.equal(a.life_context, b.life_context);
});

test('rolled output includes heritage and life_context from their tables', () => {
  for (let i = 0; i < 500; i += 1) {
    const r = rollFields({ gender: 'other', rng: mulberry32(i) });
    assert.ok(HERITAGE_VALUES.includes(r.heritage), `unknown heritage ${r.heritage}`);
    assert.ok(CATEGORIES.includes(r.life_context), `unknown life_context ${r.life_context}`);
    assert.ok(Object.prototype.hasOwnProperty.call(LIFE_CONTEXTS, r.life_context));
    assert.equal(typeof LIFE_CONTEXTS[r.life_context].hint, 'string');
  }
});

test('LIFE_CONTEXT_AGE_BANDS has exactly 4 bands matching the weight columns', () => {
  assert.equal(LIFE_CONTEXT_AGE_BANDS.length, 4);
  for (const weights of Object.values(LIFE_CONTEXT_WEIGHTS)) {
    assert.equal(weights.length, 4);
  }
});

test('age-band selection: edge ages resolve to the correct column (22/23, 29/30, 45/46)', () => {
  assert.equal(resolveLifeContextBand(18), 0);
  assert.equal(resolveLifeContextBand(22), 0);
  assert.equal(resolveLifeContextBand(23), 1);
  assert.equal(resolveLifeContextBand(29), 1);
  assert.equal(resolveLifeContextBand(30), 2);
  assert.equal(resolveLifeContextBand(45), 2);
  assert.equal(resolveLifeContextBand(46), 3);
  assert.equal(resolveLifeContextBand(75), 3);
  assert.equal(resolveLifeContextBand(200), 3);
});

test('matrix coverage: every category with weight > 0 in a band is reachable when rolls are confined to that band', () => {
  // young-adult (18-25) mixes bands 0 and 1; adult (26-35) mixes 1 and 2;
  // elder (51-75) is pure band 3. Use elder for a clean single-band check,
  // and young-adult for a 0/1 check, over enough seeds that every non-zero
  // weight in the sampled bands should surface at least once.
  const seenElder = new Set();
  for (let i = 0; i < 4000; i += 1) {
    const r = rollFields({
      gender: 'other',
      userProfile: { companion_age_range: 'elder' },
      rng: mulberry32(i),
    });
    assert.equal(resolveLifeContextBand(r.age), 3);
    seenElder.add(r.life_context);
  }
  for (const category of CATEGORIES) {
    if (LIFE_CONTEXT_WEIGHTS[category][3] > 0) {
      assert.ok(seenElder.has(category), `band 3: "${category}" never rolled in 4000 tries`);
    }
  }

  const seenYoungAdult = new Set();
  for (let i = 0; i < 4000; i += 1) {
    const r = rollFields({
      gender: 'other',
      userProfile: { companion_age_range: 'young-adult' },
      rng: mulberry32(i * 3 + 1),
    });
    assert.ok(resolveLifeContextBand(r.age) === 0 || resolveLifeContextBand(r.age) === 1);
    seenYoungAdult.add(r.life_context);
  }
  for (const category of CATEGORIES) {
    if (LIFE_CONTEXT_WEIGHTS[category][0] > 0 || LIFE_CONTEXT_WEIGHTS[category][1] > 0) {
      assert.ok(seenYoungAdult.has(category), `bands 0/1: "${category}" never rolled in 4000 tries`);
    }
  }
});

test('heritage coverage: every heritage in HERITAGES is reachable over many rolls', () => {
  const seen = new Set();
  for (let i = 0; i < 4000; i += 1) {
    const r = rollFields({ gender: 'male', rng: mulberry32(i) });
    seen.add(r.heritage);
  }
  for (const value of HERITAGE_VALUES) {
    assert.ok(seen.has(value), `heritage "${value}" never rolled in 4000 tries`);
  }
});

test('heritage weights: no single heritage exceeds ~20% and fantasy-invented stays a modest minority', () => {
  const total = HERITAGES.reduce((sum, h) => sum + h.weight, 0);
  for (const h of HERITAGES) {
    assert.ok(h.weight / total <= 0.2, `${h.value} exceeds 20% of the heritage table (${h.weight}/${total})`);
  }
  const fantasy = HERITAGES.find((h) => h.value === 'fantasy-invented');
  assert.ok(fantasy, 'fantasy-invented missing from HERITAGES');
  assert.ok(fantasy.weight / total <= 0.15, 'fantasy-invented should stay a modest minority (~10%)');
});

test('timeless characters band on the APPARENT age (18-35), never a "true" elder age', () => {
  for (let i = 0; i < 500; i += 1) {
    const r = rollFields({
      gender: 'female',
      userProfile: { companion_age_range: 'timeless' },
      rng: mulberry32(i),
    });
    assert.ok(r.age >= 18 && r.age <= 35);
    assert.ok(r.apparent_only);
    assert.ok([0, 1, 2].includes(resolveLifeContextBand(r.age)));
  }
});

test('student dominates young-adult and is rare 46+ (elder)', () => {
  const N = 2000;
  let studentYoungAdult = 0;
  for (let i = 0; i < N; i += 1) {
    const r = rollFields({
      gender: 'other',
      userProfile: { companion_age_range: 'young-adult' },
      rng: mulberry32(i),
    });
    if (r.life_context === 'student') studentYoungAdult += 1;
  }
  const youngAdultPct = studentYoungAdult / N;
  assert.ok(youngAdultPct >= 0.2, `student share of young-adult too low: ${youngAdultPct}`);

  let studentElder = 0;
  for (let i = 0; i < N; i += 1) {
    const r = rollFields({
      gender: 'other',
      userProfile: { companion_age_range: 'elder' },
      rng: mulberry32(i * 5 + 2),
    });
    if (r.life_context === 'student') studentElder += 1;
  }
  const elderPct = studentElder / N;
  assert.ok(elderPct < 0.02, `student share of elder too high: ${elderPct}`);
});

test('academic-professional is near-zero at the youngest band (18-22)', () => {
  // band 0 weight for academic-professional is tiny by design; assert the
  // table value directly (structural check, independent of sampling noise).
  const band0Weight = LIFE_CONTEXT_WEIGHTS['academic-professional'][0];
  const band0Total = Object.values(LIFE_CONTEXT_WEIGHTS).reduce((sum, w) => sum + w[0], 0);
  assert.ok(band0Weight / band0Total < 0.02, 'academic-professional should be near-zero at 18-22');
});
