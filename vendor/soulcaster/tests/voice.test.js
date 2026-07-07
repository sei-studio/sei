import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rollFields,
  rollVoice,
  resolveVoiceAgeBand,
  castSoul,
  mulberry32,
  VOICES,
  VOICE_TAGS,
  SEED_VOICE_TAGS,
  PERSONALITY_SEEDS,
} from '../src/index.js';

test('table sanity: unique ids, valid genders/ages/tags, shared entries carry owners', () => {
  const ids = new Set();
  for (const v of VOICES) {
    assert.equal(typeof v.id, 'string');
    assert.ok(!ids.has(v.id), `duplicate voice id ${v.id}`);
    ids.add(v.id);
    assert.ok(['female', 'male', 'neutral'].includes(v.gender), v.id);
    assert.ok(['young', 'adult', 'elder'].includes(v.age), v.id);
    assert.ok(v.tags.length >= 1, v.id);
    for (const t of v.tags) assert.ok(VOICE_TAGS.includes(t), `${v.id} unknown tag ${t}`);
    assert.ok(typeof v.vibe === 'string' && v.vibe.length > 0, v.id);
    // premade voices have owner null; shared voices need the owner for syncVoices
    assert.ok(v.owner === null || /^[0-9a-f]{64}$/.test(v.owner), `${v.id} bad owner`);
  }
});

test('every personality seed has a voice-tag affinity mapping', () => {
  for (const seed of PERSONALITY_SEEDS) {
    const tags = SEED_VOICE_TAGS[seed];
    assert.ok(Array.isArray(tags) && tags.length > 0, `missing SEED_VOICE_TAGS for ${seed}`);
    for (const t of tags) assert.ok(VOICE_TAGS.includes(t), `${seed} maps to unknown tag ${t}`);
  }
});

test('pool depth: each gender x age band has at least 3 eligible voices', () => {
  for (const gender of ['female', 'male']) {
    for (const age of ['young', 'adult', 'elder']) {
      const n = VOICES.filter(
        (v) => (v.gender === gender || v.gender === 'neutral') && v.age === age && !v.tags.includes('robotic'),
      ).length;
      assert.ok(n >= 3, `${gender}/${age} pool too small: ${n}`);
    }
  }
});

test('age band edges', () => {
  assert.equal(resolveVoiceAgeBand(18), 'young');
  assert.equal(resolveVoiceAgeBand(27), 'young');
  assert.equal(resolveVoiceAgeBand(28), 'adult');
  assert.equal(resolveVoiceAgeBand(50), 'adult');
  assert.equal(resolveVoiceAgeBand(51), 'elder');
});

test('gender is a hard filter (with neutral allowed)', () => {
  const rng = mulberry32(7);
  for (let i = 0; i < 500; i += 1) {
    const v = rollVoice({ gender: 'female', age: 25, background: 'human', personality_seeds: ['sunny', 'timid'] }, { rng });
    const entry = VOICES.find((e) => e.id === v.id);
    assert.ok(['female', 'neutral'].includes(entry.gender), `female char got ${entry.gender} voice`);
  }
});

test('robotic voices only ever roll for robot characters', () => {
  const rng = mulberry32(11);
  for (let i = 0; i < 800; i += 1) {
    const v = rollVoice({ gender: 'male', age: 30, background: 'human', personality_seeds: ['stoic', 'blunt'] }, { rng });
    const entry = VOICES.find((e) => e.id === v.id);
    assert.ok(!entry.tags.includes('robotic'), 'human rolled a robotic voice');
  }
  // and robots usually get one
  let robotic = 0;
  for (let i = 0; i < 400; i += 1) {
    const v = rollVoice({ gender: 'male', age: 30, background: 'robot', personality_seeds: ['stoic', 'blunt'] }, { rng });
    const entry = VOICES.find((e) => e.id === v.id);
    if (entry.tags.includes('robotic')) robotic += 1;
  }
  assert.ok(robotic > 100, `robots rarely rolled robotic voices (${robotic}/400)`);
});

test('young and elder never cross', () => {
  const rng = mulberry32(13);
  for (let i = 0; i < 500; i += 1) {
    const v = rollVoice({ gender: 'female', age: 19, background: 'human', personality_seeds: ['playful', 'curious'] }, { rng });
    const entry = VOICES.find((e) => e.id === v.id);
    assert.notEqual(entry.age, 'elder', 'a 19-year-old rolled an elder voice');
  }
  for (let i = 0; i < 500; i += 1) {
    const v = rollVoice({ gender: 'male', age: 70, background: 'human', personality_seeds: ['stoic', 'serene'] }, { rng });
    const entry = VOICES.find((e) => e.id === v.id);
    assert.notEqual(entry.age, 'young', 'a 70-year-old rolled a young voice');
  }
});

test('takenVoiceIds are excluded until the pool would empty', () => {
  const rng = mulberry32(17);
  const args = { gender: 'female', age: 25, background: 'human', personality_seeds: ['sunny', 'gentle'] };
  const eligible = VOICES.filter((v) => ['female', 'neutral'].includes(v.gender) && !v.tags.includes('robotic'));
  const someTaken = eligible.slice(0, 5).map((v) => v.id);
  for (let i = 0; i < 300; i += 1) {
    const v = rollVoice(args, { takenVoiceIds: someTaken, rng });
    assert.ok(!someTaken.includes(v.id), 'rolled a taken voice');
  }
  // taking EVERY eligible voice falls back to ignoring the exclusion
  const allTaken = eligible.map((v) => v.id);
  const v = rollVoice(args, { takenVoiceIds: allTaken, rng });
  assert.ok(typeof v.id === 'string' && v.id.length > 0);
});

test('rollFields carries the voice and stays deterministic per seed', () => {
  const a = rollFields({ gender: 'female', rng: mulberry32(42) });
  const b = rollFields({ gender: 'female', rng: mulberry32(42) });
  assert.deepEqual(a.voice, b.voice);
  assert.ok(VOICES.some((v) => v.id === a.voice.id));
  assert.equal(typeof a.voice.vibe, 'string');
});

test('castSoul stamps voice_id from the roll and tells the model the voice', async () => {
  let seenUser = null;
  const llm = async ({ user }) => {
    seenUser = user;
    return JSON.stringify({
      name: 'Test',
      gender: 'female',
      age: 24,
      age_note: null,
      background: 'human',
      setting: 'modern',
      species_detail: 'light skin, freckles',
      heritage: 'anglo',
      occupation: 'barista',
      personality: { tone: 'warm', values: ['a', 'b', 'c'], quirks: ['q1', 'q2'], fears: ['f1'] },
      backstory: 'words '.repeat(40).trim(),
      player_dynamic: null,
      voice_style: 'soft and warm',
      combat: { archetype: 'balanced', melee: 0.5, ranged: 0.5, defense: 0.5, intelligence: 0.5 },
      appearance: {
        overall: 'x', hair: 'brown bob', eyes: 'hazel', skin: 'light', height: 'average',
        build: 'slender', bust: 'small', outfit: 'apron over shirt', accessories: [],
        distinguishing_features: ['freckles'],
      },
      image_prompt: 'a barista',
    });
  };
  const { sheet, rolled } = await castSoul({ gender: 'female', llm, rng: mulberry32(5) });
  assert.equal(sheet.voice_id, rolled.voice.id);
  assert.match(seenUser, /voice: /);
  assert.ok(seenUser.includes(rolled.voice.vibe));
});
