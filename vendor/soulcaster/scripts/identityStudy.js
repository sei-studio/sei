#!/usr/bin/env node
// Distribution study for heritage + life_context (the age x category weight
// matrix in src/tables.js: LIFE_CONTEXT_WEIGHTS / HERITAGES).
//
// Runs 1000 seeded rolls per companion_age_range profile and prints:
//   - the life_context distribution per profile (a table)
//   - the heritage distribution overall
//   - 12 sample lines (age, heritage, life_context, species)
//
//   node scripts/identityStudy.js [count]
//
// Sanity targets (see CLAUDE.md / task write-up):
//   - student dominates young-adult (~25-35%) and is rare 46+ (<2%)
//   - academic-professional near-zero at 18-22
//   - every category reachable in every profile where its weight > 0
//   - heritage spread matches the HERITAGES table weights

import { rollFields, mulberry32, HERITAGES, LIFE_CONTEXTS, LIFE_CONTEXT_WEIGHTS } from '../src/index.js';

const N = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 1000;
const GENDERS = ['male', 'female', 'other'];
const CATEGORIES = Object.keys(LIFE_CONTEXT_WEIGHTS);

// null key means "no profile" (default 18-60 range).
const PROFILES = ['young-adult', 'adult', 'mature', 'elder', 'timeless', null];

function pct(count, total) {
  return ((count / total) * 100).toFixed(1).padStart(5);
}

function rollBatch(profileKey, n, seedOffset) {
  const rolls = [];
  for (let i = 0; i < n; i += 1) {
    const gender = GENDERS[i % GENDERS.length];
    const userProfile = profileKey ? { companion_age_range: profileKey } : null;
    const rolled = rollFields({ gender, userProfile, rng: mulberry32(seedOffset + i) });
    rolls.push(rolled);
  }
  return rolls;
}

console.log(`identityStudy: ${N} seeded rolls per profile (mulberry32), genders cycled male/female/other\n`);

// --- life_context distribution per profile ---

console.log('=== life_context distribution per companion_age_range profile ===\n');

const allRollsForHeritage = [];
const allSamples = [];

let seedOffset = 0;
for (const profileKey of PROFILES) {
  const label = profileKey || 'null (default 18-60)';
  const rolls = rollBatch(profileKey, N, seedOffset);
  seedOffset += N;
  allRollsForHeritage.push(...rolls);
  allSamples.push({ profileKey: label, rolls });

  const counts = {};
  for (const c of CATEGORIES) counts[c] = 0;
  for (const r of rolls) counts[r.life_context] += 1;

  console.log(`--- profile: ${label} ---`);
  const ageMin = Math.min(...rolls.map((r) => r.age));
  const ageMax = Math.max(...rolls.map((r) => r.age));
  console.log(`  (age range observed: ${ageMin}-${ageMax}${rolls[0].apparent_only ? ', apparent_only' : ''})`);
  for (const c of CATEGORIES.sort((a, b) => counts[b] - counts[a])) {
    console.log(`  ${c.padEnd(24)} ${counts[c].toString().padStart(4)}  ${pct(counts[c], N)}%`);
  }
  console.log('');
}

// --- heritage distribution overall ---

console.log('=== heritage distribution (all profiles combined, n=' + allRollsForHeritage.length + ') ===\n');

const heritageCounts = {};
for (const h of HERITAGES) heritageCounts[h.value] = 0;
for (const r of allRollsForHeritage) heritageCounts[r.heritage] += 1;

const heritageTotalWeight = HERITAGES.reduce((sum, h) => sum + h.weight, 0);
console.log('  heritage             observed%  table-weight%');
for (const h of HERITAGES.slice().sort((a, b) => heritageCounts[b.value] - heritageCounts[a.value])) {
  const observedPct = ((heritageCounts[h.value] / allRollsForHeritage.length) * 100).toFixed(1).padStart(6);
  const tablePct = ((h.weight / heritageTotalWeight) * 100).toFixed(1).padStart(6);
  console.log(`  ${h.value.padEnd(20)} ${observedPct}%    ${tablePct}%`);
}

// --- 12 sample lines ---

console.log('\n=== 12 sample lines (age, heritage, life_context, species) ===\n');

let shown = 0;
outer: for (const { profileKey, rolls } of allSamples) {
  for (let i = 0; i < rolls.length && shown < 12; i += 1) {
    const r = rolls[i];
    console.log(
      `  [${profileKey.padEnd(22)}] age=${String(r.age).padStart(3)} heritage=${r.heritage.padEnd(16)} ` +
        `life_context=${r.life_context.padEnd(22)} species=${r.background}`,
    );
    shown += 1;
    if (shown >= 12) break outer;
  }
}
console.log('');
