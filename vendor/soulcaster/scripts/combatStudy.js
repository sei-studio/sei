#!/usr/bin/env node
// Distribution study for the combat stat roller (rollFields's combat block).
//
// Runs a large number of seeded rolls and prints summary statistics so the
// COMBAT_ARCHETYPES bands / weights and COMBAT_SPECIES_MODIFIERS in
// src/tables.js can be tuned by eye. No dependencies beyond the package
// itself.
//
//   node scripts/combatStudy.js [count]
//
// Targets we're tuning for (see CLAUDE.md / task write-up):
//   - every stat's histogram has meaningful mass in every 0.1-wide bucket
//     from 0.0-0.1 through 0.9-1.0 (the full range is reachable)
//   - overall stat stddev >= 0.2 (rolls aren't all clustered mid-pack)
//   - no two stats correlate so strongly that builds feel cloned

import { rollFields, mulberry32 } from '../src/index.js';

const N = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 1000;
const GENDERS = ['male', 'female', 'other'];
const STATS = ['melee', 'ranged', 'defense', 'intelligence'];

function mean(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stddev(xs) {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

function pearson(xs, ys) {
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx2 = 0;
  let dy2 = 0;
  for (let i = 0; i < xs.length; i += 1) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom === 0 ? 0 : num / denom;
}

function histogram(xs, buckets = 10) {
  const counts = new Array(buckets).fill(0);
  for (const x of xs) {
    let idx = Math.floor(x * buckets);
    if (idx >= buckets) idx = buckets - 1;
    if (idx < 0) idx = 0;
    counts[idx] += 1;
  }
  return counts;
}

function printHistogram(counts, total) {
  const width = 40;
  const max = Math.max(...counts, 1);
  for (let i = 0; i < counts.length; i += 1) {
    const lo = (i / counts.length).toFixed(1);
    const hi = ((i + 1) / counts.length).toFixed(1);
    const bar = '#'.repeat(Math.round((counts[i] / max) * width));
    const pct = ((counts[i] / total) * 100).toFixed(1).padStart(5);
    console.log(`  ${lo}-${hi}  ${pct}%  ${bar}`);
  }
}

// --- roll ---

const rolls = [];
for (let i = 0; i < N; i += 1) {
  const gender = GENDERS[i % GENDERS.length];
  const rolled = rollFields({ gender, rng: mulberry32(i) });
  rolls.push(rolled);
}

console.log(`combatStudy: ${N} seeded rolls (mulberry32(0..${N - 1})), genders cycled male/female/other\n`);

// --- per-stat summary + histogram ---

const statSeries = {};
for (const stat of STATS) {
  statSeries[stat] = rolls.map((r) => r.combat[stat]);
}

console.log('=== per-stat summary ===');
let overallStddevs = [];
for (const stat of STATS) {
  const xs = statSeries[stat];
  const mn = Math.min(...xs);
  const mx = Math.max(...xs);
  const mu = mean(xs);
  const sd = stddev(xs);
  overallStddevs.push(sd);
  console.log(`\n${stat}: min=${mn.toFixed(2)} max=${mx.toFixed(2)} mean=${mu.toFixed(3)} stddev=${sd.toFixed(3)}`);
  printHistogram(histogram(xs), xs.length);
}
console.log(`\noverall mean stddev across 4 stats: ${mean(overallStddevs).toFixed(3)} (target >= 0.2)`);

// --- correlation matrix ---

console.log('\n=== stat correlation matrix (pearson r) ===');
const header = '            ' + STATS.map((s) => s.padStart(8)).join(' ');
console.log(header);
for (const a of STATS) {
  const row = STATS.map((b) => pearson(statSeries[a], statSeries[b]).toFixed(2).padStart(8));
  console.log(a.padEnd(12) + row.join(' '));
}

// --- archetype frequency ---

console.log('\n=== archetype frequency ===');
const archCounts = {};
for (const r of rolls) {
  const label = r.combat.archetype;
  archCounts[label] = (archCounts[label] || 0) + 1;
}
for (const [label, count] of Object.entries(archCounts).sort((a, b) => b[1] - a[1])) {
  const pct = ((count / N) * 100).toFixed(1).padStart(5);
  console.log(`  ${label.padEnd(14)} ${count.toString().padStart(5)}  ${pct}%`);
}

// --- per-species mean per stat (shows modifier effect) ---

console.log('\n=== per-species mean per stat ===');
const bySpecies = {};
for (const r of rolls) {
  if (!bySpecies[r.background]) bySpecies[r.background] = { melee: [], ranged: [], defense: [], intelligence: [] };
  for (const stat of STATS) bySpecies[r.background][stat].push(r.combat[stat]);
}
const speciesHeader = 'species'.padEnd(10) + STATS.map((s) => s.padStart(14)).join(' ');
console.log(speciesHeader);
for (const [species, series] of Object.entries(bySpecies)) {
  const row = STATS.map((stat) => mean(series[stat]).toFixed(3).padStart(14));
  console.log(species.padEnd(10) + row.join(' ') + `   (n=${series.melee.length})`);
}

// --- sample characters ---

console.log('\n=== 10 sample characters ===');
for (let i = 0; i < 10; i += 1) {
  const r = rolls[i];
  const c = r.combat;
  console.log(
    `  #${i} ${r.gender.padEnd(6)} ${r.background.padEnd(9)} ${c.archetype.padEnd(14)} ` +
      `melee=${c.melee.toFixed(2)} ranged=${c.ranged.toFixed(2)} defense=${c.defense.toFixed(2)} intelligence=${c.intelligence.toFixed(2)}`,
  );
}
