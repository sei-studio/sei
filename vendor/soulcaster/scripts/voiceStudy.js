// Voice roll distribution + collision study.
//
//   node scripts/voiceStudy.js
//
// Answers the question the voice table exists for: how often do two
// characters end up with the same voice? Reports, per gender:
//   - the voice distribution over N independent rolls (spot flat vs spiky)
//   - pairwise collision probability for two INDEPENDENT rolls (sum of p^2)
//   - roster collision rate: rolling a 4-companion roster (the app's slot
//     cap) WITHOUT takenVoiceIds vs WITH takenVoiceIds threaded through.
// With takenVoiceIds the roster rate must be exactly 0 — the exclusion is a
// hard filter until the pool empties, and 4 slots never exhaust any pool.

import { rollFields, mulberry32 } from '../src/index.js';

const N = 20_000;
const ROSTERS = 5_000;
const GENDERS = ['female', 'male', 'other'];

function rollOne(gender, rng, takenVoiceIds = []) {
  return rollFields({ gender, takenVoiceIds, rng }).voice;
}

const rng = mulberry32(20260705);

for (const gender of GENDERS) {
  const counts = new Map();
  for (let i = 0; i < N; i += 1) {
    const v = rollOne(gender, rng);
    counts.set(v.label, (counts.get(v.label) || 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const pairwise = sorted.reduce((s, [, c]) => s + (c / N) ** 2, 0);

  console.log(`\n=== ${gender} (${N} rolls, ${sorted.length} distinct voices) ===`);
  for (const [label, c] of sorted) {
    const pct = ((100 * c) / N).toFixed(1).padStart(5);
    console.log(`${pct}%  ${label}  ${'#'.repeat(Math.round((200 * c) / N))}`);
  }
  console.log(`independent pairwise collision: ${(100 * pairwise).toFixed(1)}%`);

  // Roster study: 4 companions, mixed genders would collide even less, so use
  // the worst case — all four the same gender.
  let naiveCollisions = 0;
  let excludedCollisions = 0;
  for (let i = 0; i < ROSTERS; i += 1) {
    const naive = new Set();
    let naiveTotal = 0;
    const taken = [];
    for (let k = 0; k < 4; k += 1) {
      naive.add(rollOne(gender, rng).id);
      naiveTotal += 1;
      taken.push(rollOne(gender, rng, taken).id);
    }
    if (naive.size < naiveTotal) naiveCollisions += 1;
    if (new Set(taken).size < taken.length) excludedCollisions += 1;
  }
  console.log(`4-companion roster with a repeat: naive ${((100 * naiveCollisions) / ROSTERS).toFixed(1)}%  |  with takenVoiceIds ${((100 * excludedCollisions) / ROSTERS).toFixed(1)}%`);
}
