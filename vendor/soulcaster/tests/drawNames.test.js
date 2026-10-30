import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_UNISEX_FOR_OTHER,
  NAME_POOL,
  buildExcludeSet,
  drawNameCandidates,
  nameMatchesCandidates,
  normalizeName,
} from '../src/drawNames.js';
import { HERITAGES } from '../src/tables.js';

test('pool covers every rolled heritage with deep per-gender lists', () => {
  let total = 0;
  for (const { value } of HERITAGES) {
    const e = NAME_POOL[value];
    assert.ok(e, value);
    assert.ok(e.female.length >= 80 && e.male.length >= 80 && e.unisex.length >= 8, value);
    total += e.female.length + e.male.length + e.unisex.length;
  }
  assert.deepEqual(Object.keys(NAME_POOL).sort(), HERITAGES.map((h) => h.value).sort());
  assert.ok(total > 2500);
});

test('no name twice within a heritage; single given names only', () => {
  for (const [h, e] of Object.entries(NAME_POOL)) {
    const all = [...e.female, ...e.male, ...e.unisex];
    assert.equal(new Set(all.map(normalizeName)).size, all.length, h);
    for (const n of all) assert.doesNotMatch(n, /\s|—/);
  }
});

test('every name survives the Minecraft username sanitizer intact', () => {
  // A generated character has no username, so its MC name is
  // name.replace(/[^A-Za-z0-9_]/g, ''), which must be 3-16 chars. Only hyphens may drop.
  for (const [h, e] of Object.entries(NAME_POOL)) {
    for (const n of [...e.female, ...e.male, ...e.unisex]) {
      assert.match(n, /^[A-Za-z][A-Za-z'-]*[A-Za-z]$/, `${h}: ${n}`);
      const mc = n.replace(/[^A-Za-z0-9_]/g, '');
      assert.equal(mc, n.replace(/[-' ]/g, ''), `${h}: ${n}`);
      // Minecraft usernames are 3-16 characters; vanilla/LAN servers reject shorter.
      assert.ok(mc.length >= 3 && mc.length <= 16, `${h}: ${n} sanitizes to ${mc.length} chars`);
    }
  }
});

test('draws 8 distinct names from the heritage and gender lists', () => {
  for (const { value: h } of HERITAGES) {
    for (const g of ['female', 'male', 'other']) {
      const names = drawNameCandidates({ heritage: h, gender: g });
      assert.equal(names.length, 8);
      assert.equal(new Set(names).size, 8);
      const e = NAME_POOL[h];
      const other = e.unisex.length < MIN_UNISEX_FOR_OTHER ? [...e.unisex, ...e.female, ...e.male] : e.unisex;
      const allowed = new Set(g === 'female' ? [...e.female, ...e.unisex] : g === 'male' ? [...e.male, ...e.unisex] : other);
      for (const n of names) assert.ok(allowed.has(n), `${h}/${g}: ${n}`);
    }
  }
});

test('public names are never offered; every word of a full name blocks', () => {
  const blocked = buildExcludeSet(['Chen Wei', 'Tanaka Akane', 'Seo-yeon']);
  for (const k of ['chen', 'wei', 'chenwei', 'akane', 'tanaka', 'seoyeon']) assert.ok(blocked.has(k), k);
  assert.ok(!blocked.has('seo'));
  for (let i = 0; i < 100; i++) {
    const names = drawNameCandidates({ heritage: 'japanese', gender: 'female', count: 40, exclude: new Set(['Hana', 'Tanaka Mei']) });
    assert.ok(!names.includes('Hana') && !names.includes('Mei'), 'raw Set is normalized');
  }
  for (let i = 0; i < 200; i++) {
    const names = drawNameCandidates({ heritage: 'chinese', gender: 'other', exclude: ['Chen Wei', 'Wei'] });
    assert.ok(!names.includes('Chen') && !names.includes('Wei'));
  }
});

test('own names are dropped only when the pool would run dry', () => {
  const pool = { tiny: { female: ['Ana', 'Bea', 'Cora', 'Dina', 'Eva'], male: ['Abe'], unisex: ['Kit'] } };
  const names = drawNameCandidates({ pool, heritage: 'tiny', gender: 'female', count: 5, softExclude: ['Ana', 'Bea', 'Cora'] });
  assert.equal(names.length, 5);
  for (const n of ['Dina', 'Eva', 'Kit']) assert.ok(names.includes(n));
  const few = drawNameCandidates({ pool, heritage: 'tiny', gender: 'female', count: 3, softExclude: ['Ana', 'Bea', 'Cora'] });
  assert.deepEqual(few.sort(), ['Dina', 'Eva', 'Kit']);
});

test('falls back across heritages when exclusions leave too few', () => {
  const e = NAME_POOL.nordic;
  const all = [...e.male, ...e.unisex];
  const names = drawNameCandidates({ heritage: 'nordic', gender: 'male', exclude: all.slice(3) });
  assert.equal(names.length, 8);
  for (const n of all.slice(0, 3)) assert.ok(names.includes(n));
  assert.equal(drawNameCandidates({ heritage: 'martian', gender: 'female' }).length, 8);
});

test('"other" uses the whole heritage list when unisex is short', () => {
  const pool = { t: { female: ['Ana', 'Bea', 'Cora'], male: ['Abe', 'Cal', 'Dov'], unisex: ['Kit', 'Lee'] } };
  const seen = new Set();
  for (let i = 0; i < 100; i++) for (const n of drawNameCandidates({ pool, heritage: 't', gender: 'other', count: 3 })) seen.add(n);
  assert.deepEqual([...seen].sort(), ['Abe', 'Ana', 'Bea', 'Cal', 'Cora', 'Dov', 'Kit', 'Lee']);
  assert.equal(drawNameCandidates({ heritage: 'slavic', gender: 'other' }).length, 8);
});

test('fallback never repeats a name that exists under several heritages', () => {
  const pool = {
    a: { female: ['Ana'], male: [], unisex: [] },
    b: { female: ['Ana', 'Mira'], male: [], unisex: [] },
    c: { female: ['ana', 'Mira', 'Zoe'], male: [], unisex: [] },
  };
  for (let i = 0; i < 200; i++) {
    const names = drawNameCandidates({ pool, heritage: 'a', gender: 'female', count: 5 });
    assert.equal(names.length, 3);
    assert.equal(new Set(names.map(normalizeName)).size, 3);
  }
  const e = NAME_POOL.romance;
  for (let i = 0; i < 50; i++) {
    const names = drawNameCandidates({ heritage: 'romance', gender: 'female', count: 60, exclude: e.female.slice(5) });
    assert.equal(new Set(names.map(normalizeName)).size, 60);
  }
});

test('draws are really random', () => {
  const draws = new Set();
  for (let i = 0; i < 20; i++) draws.add(drawNameCandidates({ heritage: 'japanese', gender: 'female' }).join(','));
  assert.ok(draws.size > 15);
});

test('nameMatchesCandidates accepts picks and robot suffixes, rejects inventions', () => {
  const c = ['Sigrid', 'Seo-yeon'];
  assert.ok(nameMatchesCandidates('Sigrid-7', c));
  assert.ok(nameMatchesCandidates('seoyeon', c));
  assert.ok(!nameMatchesCandidates('Akane', c));
});

test('data matches the proxy copy shape (spot check)', () => {
  assert.ok(NAME_POOL.korean.female.includes('Seo-yeon'));
  assert.ok(NAME_POOL['fantasy-invented'].unisex.includes('Ember'));
});
