import { test } from 'node:test';
import assert from 'node:assert/strict';
import { castSoul, mulberry32, stripFences, CharacterSheetSchema, SoulcasterError } from '../src/index.js';

// A minimal valid character sheet, as JSON text an LLM would return.
function validSheet(overrides = {}) {
  const sheet = {
    name: 'Rilla Fenwick',
    gender: 'female',
    age: 27,
    age_note: null,
    background: 'beastkin',
    setting: 'modern',
    species_detail: 'fox-person with tall russet ears and a full brush tail',
    heritage: 'japanese',
    occupation: 'night-shift convenience store clerk',
    personality: {
      tone: 'dry-witted yet devoted',
      values: ['loyalty', 'craft', 'honesty'],
      quirks: ['names every tool she owns', 'collects river stones'],
      fears: ['being abandoned'],
    },
    backstory: 'A long enough backstory for the test.',
    player_dynamic: 'The friend who talks you into trouble, then gets you back out of it.',
    voice_style: 'clipped, wry, warms up over time',
    punctuation: 'casual',
    combat: {
      archetype: 'skirmisher',
      melee: 0.3,
      ranged: 0.55,
      defense: 0.7,
      intelligence: 0.55,
    },
    appearance: {
      overall: 'a short lithe figure',
      hair: 'auburn side braid',
      eyes: 'amber',
      skin: 'sun-freckled fair',
      height: 'short',
      build: 'lithe',
      bust: 'small',
      outfit: 'a canvas field jacket with crimson trim over dark trousers',
      accessories: ['a worn leather satchel', 'brass ear cuff'],
      distinguishing_features: ['a nicked left ear'],
    },
    image_prompt: 'Full-body fox-beastkin woman, auburn braid, amber eyes, canvas jacket with crimson trim, standing forward.',
    ...overrides,
  };
  return JSON.stringify(sheet);
}

test('stripFences removes json code fences', () => {
  const wrapped = '```json\n{"a":1}\n```';
  assert.equal(stripFences(wrapped), '{"a":1}');
  const bare = '```\n{"b":2}\n```';
  assert.equal(stripFences(bare), '{"b":2}');
  const chatty = 'Here you go:\n{"c":3}\nHope that helps!';
  assert.equal(stripFences(chatty), '{"c":3}');
});

test('the sample valid sheet actually passes the schema', () => {
  const parsed = JSON.parse(validSheet());
  assert.ok(CharacterSheetSchema.safeParse(parsed).success);
});

test('castSoul happy path: valid JSON on first try', async () => {
  let calls = 0;
  const llm = async () => {
    calls += 1;
    return validSheet();
  };
  const { sheet, rolled } = await castSoul({ gender: 'female', llm, rng: mulberry32(1) });
  assert.equal(calls, 1);
  assert.equal(sheet.name, 'Rilla Fenwick');
  assert.ok(rolled.background);
  assert.ok('bust' in rolled);
});

test('castSoul happy path: fenced output is accepted', async () => {
  const llm = async () => '```json\n' + validSheet() + '\n```';
  const { sheet } = await castSoul({ gender: 'female', llm, rng: mulberry32(2) });
  assert.equal(sheet.background, 'beastkin');
});

test('castSoul retry: invalid then valid succeeds and passes the error along', async () => {
  const responses = ['this is not json at all', validSheet()];
  let calls = 0;
  const seenUsers = [];
  const llm = async ({ user }) => {
    seenUsers.push(user);
    return responses[calls++];
  };
  const { sheet } = await castSoul({ gender: 'male', llm, rng: mulberry32(3) });
  assert.equal(calls, 2);
  assert.equal(sheet.name, 'Rilla Fenwick');
  // The retry prompt should carry the validation error.
  assert.match(seenUsers[1], /previous response was rejected/i);
});

test('castSoul throws typed error after two failures', async () => {
  let calls = 0;
  const llm = async () => {
    calls += 1;
    return 'still not json';
  };
  await assert.rejects(
    () => castSoul({ gender: 'other', llm, rng: mulberry32(4) }),
    (err) => {
      assert.ok(err instanceof SoulcasterError);
      assert.match(err.message, /invalid after retry/);
      assert.equal(err.raw, 'still not json');
      return true;
    },
  );
  assert.equal(calls, 2);
});

test('castSoul retry: schema failure (valid JSON, wrong shape) then valid', async () => {
  const bad = JSON.stringify({ name: 'X' }); // missing required fields
  const responses = [bad, validSheet()];
  let calls = 0;
  const llm = async () => responses[calls++];
  const { sheet } = await castSoul({ gender: 'female', llm, rng: mulberry32(5) });
  assert.equal(calls, 2);
  assert.equal(sheet.gender, 'female');
});

test('castSoul requires an llm function', async () => {
  await assert.rejects(() => castSoul({ gender: 'female' }), /requires an `llm` function/);
});

test('castSoul with a dynamic: prompt carries the relationship line, rolled echoes the key', async () => {
  const seenUsers = [];
  const llm = async ({ user }) => {
    seenUsers.push(user);
    return validSheet();
  };
  const { rolled } = await castSoul({ gender: 'female', dynamic: 'caretaker', llm, rng: mulberry32(6) });
  assert.equal(rolled.dynamic, 'caretaker');
  assert.match(seenUsers[0], /relationship_dynamic: someone who looks after you/);
});

test('castSoul without a dynamic: no relationship line in the prompt', async () => {
  const seenUsers = [];
  const llm = async ({ user }) => {
    seenUsers.push(user);
    return validSheet();
  };
  const { rolled } = await castSoul({ gender: 'female', llm, rng: mulberry32(7) });
  assert.equal(rolled.dynamic, null);
  assert.doesNotMatch(seenUsers[0], /relationship_dynamic/);
});

test('CharacterSheetSchema requires player_dynamic (nullable, not omittable)', () => {
  const missing = JSON.parse(validSheet());
  delete missing.player_dynamic;
  assert.equal(CharacterSheetSchema.safeParse(missing).success, false);

  const nulled = JSON.parse(validSheet({ player_dynamic: null }));
  assert.ok(CharacterSheetSchema.safeParse(nulled).success);
});

test('CharacterSheetSchema punctuation: defaults casual when omitted, accepts deliberate, rejects junk', () => {
  const omitted = JSON.parse(validSheet());
  delete omitted.punctuation;
  const parsed = CharacterSheetSchema.safeParse(omitted);
  assert.ok(parsed.success);
  assert.equal(parsed.data.punctuation, 'casual');

  const deliberate = JSON.parse(validSheet({ punctuation: 'deliberate' }));
  assert.ok(CharacterSheetSchema.safeParse(deliberate).success);

  const junk = JSON.parse(validSheet({ punctuation: 'formal' }));
  assert.equal(CharacterSheetSchema.safeParse(junk).success, false);
});

test('CharacterSheetSchema rejects a missing or invalid setting', () => {
  const missing = JSON.parse(validSheet());
  delete missing.setting;
  assert.equal(CharacterSheetSchema.safeParse(missing).success, false);

  const invalid = JSON.parse(validSheet({ setting: 'cyberpunk' }));
  assert.equal(CharacterSheetSchema.safeParse(invalid).success, false);
});

test('CharacterSheetSchema accepts every valid setting value', () => {
  for (const setting of ['fantasy', 'modern', 'futuristic', 'historical']) {
    const sheet = JSON.parse(validSheet({ setting }));
    assert.ok(CharacterSheetSchema.safeParse(sheet).success);
  }
});
