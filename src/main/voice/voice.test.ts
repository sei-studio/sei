/**
 * Voice-call seams (260705).
 *
 * Pins the three pieces of novel main-process logic:
 *   - buildSystemBlocks leads block 0 with the voice-call primer ONLY while a
 *     call is open (the "start of prompts" contract from the feature spec).
 *   - resolveVoiceId: metadata.voiceId wins; legacy characters get a
 *     deterministic fallback (same character id → same voice), persisted to
 *     metadata, honoring the soulcaster gender filter and roster exclusion.
 *   - callState: the trivial set/read used by chat + supervisor.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VOICES } from 'soulcaster';
import { VOICE_CALL_PRIMER } from '../../bot/brain/promptLibrary.js';
import { buildSystemBlocks } from '../chat/chatPrompts';
import { setCallActive, isCallActive } from './callState';
import type { Character } from '../../shared/characterSchema';

const { mockList, mockSave, mockAuth } = vi.hoisted(() => ({
  mockList: vi.fn(async () => [] as unknown[]),
  mockSave: vi.fn(async () => {}),
  mockAuth: vi.fn((): { kind: string; user?: { id: string } } => ({ kind: 'signed_out' })),
}));
vi.mock('../auth/authState', () => ({ getCurrentAuthState: mockAuth }));
vi.mock('../characterStore', () => ({
  listCharacters: mockList,
  saveCharacter: mockSave,
}));

import {
  resolveVoiceId,
  assignedVoiceId,
  personaVoiceHints,
  ownVoicePickOf,
  ownVoiceHonored,
  closeSharedVoiceId,
  sharedVoiceIdFor,
  listPoolVoices,
} from './voiceAssign';

/** The eight voices retired from VOICES on 261119 (now in LEGACY_VOICE_IDS). */
const RETIRED_261119 = [
  'M5E055lOUxMi0kJpGyE9', // Gravel
  '507tTFX0IPtqFzGd1CAL', // Rusty
  'bAq8AI9QURijOtmeFFqT', // Sigma
  'Z9VxF84ucVtzvKlmYFhh', // Ramona
  'SAz9YHcvj6GT2YYXdXww', // River
  'YKlogvnVogI4aFHoGIEw', // Aaron
  '7squ7rvxEIZ2rYy7KYPP', // Malakai
  'YHcCpa6SBWnKDaCPZJQR', // Mora
];

function makeCharacter(overrides: Partial<Character> = {}): Character {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    kind: 'custom',
    public_id: null,
    name: 'Testy',
    persona: { source: 'a test persona', expanded: null },
    is_default: false,
    shared: false,
    slug: null,
    metadata: {},
    created: new Date().toISOString(),
    last_launched: null,
    playtime_ms: 0,
    portrait_image: null,
    skin: { source: 'none', mojang_username: null, png_sha256: null, applied_at: null },
    username: null,
    owner: null,
    ...overrides,
  } as Character;
}

const baseBlockArgs = {
  persona: { source: 'p', expanded: 'expanded persona' },
  name: 'Testy',
  preferredName: 'Player',
  proactiveness: 1,
  memory: '',
  summary: '',
  openWorldDetected: false,
  inGame: false,
  punctuation: 'casual' as const,
};

describe('voice-call prompt primer (idle chat)', () => {
  it('leads block 0 with the primer while a call is open', () => {
    const blocks = buildSystemBlocks({ ...baseBlockArgs, voiceCall: true });
    expect(blocks[0].text.startsWith(`[voice call] ${VOICE_CALL_PRIMER}`)).toBe(true);
    expect(blocks[0].text).toContain('lmao');
  });

  it('is absent with no call open', () => {
    const blocks = buildSystemBlocks({ ...baseBlockArgs, voiceCall: false });
    expect(blocks[0].text).not.toContain(VOICE_CALL_PRIMER);
  });
});

describe('resolveVoiceId', () => {
  beforeEach(() => {
    mockList.mockClear();
    mockSave.mockClear();
    mockList.mockResolvedValue([]);
  });

  it('returns metadata.voiceId when it points at a pool voice, without saving', async () => {
    const c = makeCharacter({ metadata: { voiceId: VOICES[0].id } });
    expect(await resolveVoiceId(c)).toBe(VOICES[0].id);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('ignores a voiceId that is not in the pool (stale/corrupt) and re-rolls', async () => {
    const c = makeCharacter({ metadata: { voiceId: 'not-a-real-voice' } });
    const v = await resolveVoiceId(c);
    expect(VOICES.some((e) => e.id === v)).toBe(true);
    expect(v).not.toBe('not-a-real-voice');
  });

  it('fallback is deterministic per character id and persisted to metadata', async () => {
    const c = makeCharacter();
    const first = await resolveVoiceId(c);
    const again = await resolveVoiceId(makeCharacter());
    expect(again).toBe(first);
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ voiceId: first }) }),
    );
  });

  it('honors the soulcaster sheet gender as a hard filter', async () => {
    const c = makeCharacter({
      metadata: { soulcaster_sheet: { gender: 'female', age: 22, background: 'human' } },
    });
    const v = await resolveVoiceId(c);
    const entry = VOICES.find((e) => e.id === v);
    expect(['female', 'neutral']).toContain(entry?.gender);
  });

  it('excludes voices other library characters already use', async () => {
    // Every eligible voice except one is taken → the roll must land on it.
    const c = makeCharacter({
      metadata: { soulcaster_sheet: { gender: 'female', age: 22, background: 'human' } },
    });
    const eligible = VOICES.filter(
      (v) =>
        (v.gender === 'female' || v.gender === 'neutral') &&
        !v.tags.includes('robotic') &&
        v.roll !== false,
    );
    const free = eligible[eligible.length - 1];
    const others = eligible
      .filter((v) => v.id !== free.id)
      .map((v, i) => makeCharacter({ id: `other-${i}`, metadata: { voiceId: v.id } }));
    mockList.mockResolvedValue(others);
    expect(await resolveVoiceId(c)).toBe(free.id);
  });
});

// 260705 — the Marv fix: sheet-less characters derive voice-roll seeds (and
// robot status) from their persona prose instead of rolling personality-blind.
describe('personaVoiceHints', () => {
  it('maps a dead-inside monotone robot to flat/dark seeds + robot', () => {
    const hints = personaVoiceHints(
      'A clinically depressed robot dragged into Minecraft against its will. Monotonous, dead inside.',
    );
    expect(hints.robot).toBe(true);
    expect(hints.seeds).toContain('stoic');
    expect(hints.seeds).toContain('melancholic');
  });

  it('maps a bubbly cheerleader to sunny seeds, no robot', () => {
    const hints = personaVoiceHints('A bubbly, cheerful farmhand who teases everyone.');
    expect(hints.robot).toBe(false);
    expect(hints.seeds[0]).toBe('sunny');
  });

  it('caps at two seeds and returns none for bland personas', () => {
    const many = personaVoiceHints(
      'grumpy, sarcastic, gloomy, fierce, scheming — all of it at once',
    );
    expect(many.seeds).toHaveLength(2);
    expect(personaVoiceHints('a person who exists').seeds).toHaveLength(0);
  });

  it('seed-weighted fallback gives a monotone-robot persona a robotic or deep/dry/calm voice', async () => {
    // Not a determinism re-test — assert the ROLLED voice for a Marv-like
    // persona is either a robotic voice (the robot rule, 261119: robotic
    // voices take a fixed 70% of a robot's roll, and Vector carries no
    // mood tags) or carries one of the tags its seeds weight toward, across
    // a spread of character ids (weights are soft, so allow the roll to
    // disagree occasionally; a majority is the behavioral claim).
    const wantTags = new Set(['deep', 'dry', 'calm', 'steady', 'dark', 'raspy', 'soft']);
    let hits = 0;
    const N = 12;
    for (let i = 0; i < N; i++) {
      const c = makeCharacter({
        id: `aaaaaaa${i}-1111-4111-8111-111111111111`,
        persona: {
          source: 'A clinically depressed robot. Monotonous, dead inside, endlessly gloomy.',
          expanded: 'expanded text',
        },
      });
      const v = await resolveVoiceId(c);
      const entry = VOICES.find((e) => e.id === v);
      if (entry?.tags.some((t) => t === 'robotic' || wantTags.has(t))) hits += 1;
    }
    expect(hits).toBeGreaterThanOrEqual(Math.ceil(N * 0.6));
  });

  it('seed-weighted fallback shifts a monotone HUMAN persona toward deep/dry/calm voices', async () => {
    const wantTags = new Set(['deep', 'dry', 'calm', 'steady', 'dark', 'raspy', 'soft', 'wise']);
    let hits = 0;
    const N = 12;
    for (let i = 0; i < N; i++) {
      const c = makeCharacter({
        id: `ccccccc${i}-3333-4333-8333-333333333333`,
        persona: {
          source: 'A clinically depressed old miner. Monotonous, dead inside, endlessly gloomy.',
          expanded: 'expanded text',
        },
      });
      const v = await resolveVoiceId(c);
      const entry = VOICES.find((e) => e.id === v);
      expect(entry?.tags.includes('robotic')).toBe(false);
      if (entry?.tags.some((t) => wantTags.has(t))) hits += 1;
    }
    expect(hits).toBeGreaterThanOrEqual(Math.ceil(N * 0.6));
  });
});

describe('assignedVoiceId', () => {
  it('null for missing/invalid, id for valid', () => {
    expect(assignedVoiceId(makeCharacter())).toBeNull();
    expect(assignedVoiceId(makeCharacter({ metadata: { voiceId: 42 as unknown as string } }))).toBeNull();
    expect(assignedVoiceId(makeCharacter({ metadata: { voiceId: VOICES[3].id } }))).toBe(VOICES[3].id);
  });

  // 260707 pool trim: ids removed from the assignment pool stay valid for
  // characters that already persisted them — the voice must never re-roll.
  it('keeps a legacy (pre-trim) voice id instead of re-rolling', async () => {
    mockSave.mockClear();
    const legacy = 'EXAVITQu4vr4xnSDxMaL'; // Sarah, cut from the pool 260707
    expect(VOICES.some((v) => v.id === legacy)).toBe(false);
    const c = makeCharacter({ metadata: { voiceId: legacy } });
    expect(assignedVoiceId(c)).toBe(legacy);
    expect(await resolveVoiceId(c)).toBe(legacy);
    expect(mockSave).not.toHaveBeenCalled();
    expect(assignedVoiceId(makeCharacter({ metadata: { voiceId: 'not-a-voice-anywhere' } }))).toBeNull();
  });

  // 261119 voice library refresh: the retired voices left VOICES but every
  // character that already speaks with one keeps it.
  it('keeps a 261119-retired voice id instead of re-rolling', async () => {
    for (const id of RETIRED_261119) {
      mockSave.mockClear();
      expect(VOICES.some((v) => v.id === id)).toBe(false);
      const c = makeCharacter({ metadata: { voiceId: id } });
      expect(assignedVoiceId(c)).toBe(id);
      expect(await resolveVoiceId(c)).toBe(id);
      expect(mockSave).not.toHaveBeenCalled();
    }
  });

  // 261119: picker-only voices (roll: false, e.g. Lyan = Sui's voice) are
  // never handed out by the fallback roll, whatever the character.
  it('the fallback roll never lands on a picker-only voice', async () => {
    const pickerOnly = new Set(VOICES.filter((v) => v.roll === false).map((v) => v.id));
    expect(pickerOnly.size).toBeGreaterThan(0);
    const sheets = [
      { gender: 'female', age: 22, background: 'human' },
      { gender: 'female', age: 35, background: 'human' },
      { gender: 'male', age: 20, background: 'human' },
      { gender: 'male', age: 40, background: 'human' },
      { gender: 'other', age: 24, background: 'human' },
    ];
    for (let i = 0; i < 200; i++) {
      const c = makeCharacter({
        id: `bbbbbbb${i}-2222-4222-8222-222222222222`,
        metadata: { soulcaster_sheet: sheets[i % sheets.length] },
      });
      expect(pickerOnly.has(await resolveVoiceId(c))).toBe(false);
    }
  });

  // 261019: a voice from the user's own ElevenLabs account is outside the
  // pool, but the voiceOwn marker makes it a deliberate pick that must never
  // be re-rolled or "repaired" into a pool voice.
  it('keeps an own-account voice pick (voiceOwn marker) instead of re-rolling', async () => {
    mockSave.mockClear();
    const ownId = 'aBcDeFgHiJkLmNoPqRsT';
    const c = makeCharacter({ metadata: { voiceId: ownId, voiceOwn: { name: 'My Clone' } } });
    expect(assignedVoiceId(c)).toBe(ownId);
    expect(await resolveVoiceId(c)).toBe(ownId);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('an unknown id WITHOUT the marker still re-rolls as before', async () => {
    mockSave.mockClear();
    const c = makeCharacter({ metadata: { voiceId: 'aBcDeFgHiJkLmNoPqRsT' } });
    expect(assignedVoiceId(c)).toBeNull();
    const v = await resolveVoiceId(c);
    expect(VOICES.some((p) => p.id === v)).toBe(true);
    // a malformed id cannot hide behind a marker either
    expect(
      assignedVoiceId(makeCharacter({ metadata: { voiceId: '../bad id', voiceOwn: { name: 'x' } } })),
    ).toBeNull();
  });

  it('a re-roll drops the stale voiceOwn marker with the id it described', async () => {
    mockSave.mockClear();
    const c = makeCharacter({ metadata: { voiceId: 'bad-id!', voiceOwn: { name: 'Gone' }, voicePitch: 1.1 } });
    const v = await resolveVoiceId(c);
    expect(VOICES.some((p) => p.id === v)).toBe(true);
    const saved = (mockSave.mock.calls as unknown as Array<[Character]>)[0][0];
    expect(saved.metadata.voiceId).toBe(v);
    expect(saved.metadata).not.toHaveProperty('voiceOwn');
    expect(saved.metadata.voicePitch).toBe(1.1);
  });

  it('ownVoicePickOf: a pool id is never an own voice, even with a stale marker', () => {
    const pool = (VOICES as Array<{ id: string }>)[0].id;
    expect(ownVoicePickOf(makeCharacter({ metadata: { voiceId: pool, voiceOwn: { name: 'Old' } } }))).toBeNull();
    expect(
      ownVoicePickOf(makeCharacter({ metadata: { voiceId: 'aBcDeFgHiJkLmNoPqRsT', voiceOwn: { name: 'Mine', gender: 'male' } } })),
    ).toEqual({ name: 'Mine', gender: 'male' });
  });
});

describe('callState', () => {
  it('set / read / clear', () => {
    expect(isCallActive('a')).toBe(false);
    setCallActive('a', true);
    expect(isCallActive('a')).toBe(true);
    expect(isCallActive('b')).toBe(false);
    setCallActive('a', false);
    expect(isCallActive('a')).toBe(false);
  });
});

// 261019 review: a shared (World) character is cached with its AUTHOR's
// metadata verbatim, so an adopter would inherit a voice from the author's own
// ElevenLabs account that nobody else can speak and they cannot change.
describe('own ElevenLabs voice on shared characters', () => {
  const ME = '11111111-1111-4111-8111-111111111111';
  const AUTHOR = '22222222-2222-4222-8222-222222222222';
  const OWN_ID = 'aBcDeFgHiJkLmNoPqRsT';
  const ownMeta = (gender?: string) => ({ voiceId: OWN_ID, voiceOwn: { name: 'Author Clone', ...(gender ? { gender } : {}) } });

  beforeEach(() => {
    mockSave.mockClear();
    mockList.mockClear();
    mockAuth.mockReturnValue({ kind: 'signed_in', user: { id: ME } });
  });

  it('own character (owner = me, or legacy null owner) keeps its own voice', async () => {
    for (const owner of [ME, null]) {
      const c = makeCharacter({ owner, metadata: ownMeta('male') });
      expect(ownVoiceHonored(c)).toBe(true);
      expect(await resolveVoiceId(c)).toBe(OWN_ID);
      expect(ownVoicePickOf(c)).toEqual({ name: 'Author Clone', gender: 'male' });
    }
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("adopted character with the author's own voice: a pool voice, nothing persisted", async () => {
    const c = makeCharacter({ owner: AUTHOR, kind: 'world', metadata: ownMeta() });
    expect(ownVoiceHonored(c)).toBe(false);
    expect(assignedVoiceId(c)).toBeNull();
    expect(ownVoicePickOf(c)).toBeNull(); // so tts never raises VOICE_OWN_NEEDS_KEY for it
    const v = await resolveVoiceId(c);
    expect(VOICES.some((p) => p.id === v)).toBe(true);
    expect(mockSave).not.toHaveBeenCalled();
    // stable across calls without reading the library (the roll is never saved)
    expect(await resolveVoiceId(c)).toBe(v);
    expect(mockList).not.toHaveBeenCalled();
    // the author's metadata is untouched
    expect(c.metadata).toEqual(ownMeta());
  });

  it("the borrowed pool voice keeps the author's voice gender", async () => {
    const pool = VOICES as Array<{ id: string; gender: string }>;
    for (const gender of ['male', 'female']) {
      const c = makeCharacter({ owner: AUTHOR, metadata: ownMeta(gender) });
      const v = await resolveVoiceId(c);
      expect(pool.find((p) => p.id === v)?.gender).toBe(gender);
    }
  });

  it('signed out, an owner-stamped row is not treated as mine (matches CharacterPage)', async () => {
    mockAuth.mockReturnValue({ kind: 'signed_out' });
    const c = makeCharacter({ owner: ME, metadata: ownMeta() });
    expect(ownVoiceHonored(c)).toBe(false);
    expect(VOICES.some((p) => p.id === c.metadata.voiceId)).toBe(false);
    await resolveVoiceId(c);
    expect(mockSave).not.toHaveBeenCalled();
    // a bundled default is never an own-voice owner either
    expect(ownVoiceHonored({ owner: null, is_default: true })).toBe(false);
  });

  it('adopted character with a pool voice is unchanged', async () => {
    const c = makeCharacter({ owner: AUTHOR, metadata: { voiceId: VOICES[2].id } });
    expect(assignedVoiceId(c)).toBe(VOICES[2].id);
    expect(await resolveVoiceId(c)).toBe(VOICES[2].id);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("other people's own voices are not 'taken' when rolling for my characters", async () => {
    mockList.mockResolvedValue([makeCharacter({ id: '33333333-3333-4333-8333-333333333333', owner: AUTHOR, metadata: ownMeta() })]);
    const mine = makeCharacter({ owner: ME });
    await resolveVoiceId(mine);
    expect(mockSave).toHaveBeenCalledTimes(1);
    mockList.mockResolvedValue([]);
  });
});

describe('voice for others (metadata.voiceShared, 261019)', () => {
  const ME = '11111111-1111-4111-8111-111111111111';
  const AUTHOR = '22222222-2222-4222-8222-222222222222';
  const OWN_ID = 'aBcDeFgHiJkLmNoPqRsT';
  const pool = VOICES as Array<{ id: string; gender: string }>;
  const ownMeta = (extra: Record<string, unknown> = {}, gender = 'female') => ({
    voiceId: OWN_ID,
    voiceOwn: { name: 'Author Clone', gender },
    ...extra,
  });

  beforeEach(() => {
    mockSave.mockClear();
    mockList.mockClear();
    mockAuth.mockReturnValue({ kind: 'signed_in', user: { id: ME } });
  });

  it('an adopter speaks with the voice the author chose, nothing persisted', async () => {
    const chosen = pool.find((p) => p.gender === 'male')!.id; // any pool voice, even off-gender
    const c = makeCharacter({ owner: AUTHOR, kind: 'world', metadata: ownMeta({ voiceShared: chosen }) });
    expect(await resolveVoiceId(c)).toBe(chosen);
    expect(mockSave).not.toHaveBeenCalled();
    expect(mockList).not.toHaveBeenCalled();
  });

  it('missing, junk, legacy or own-account ids fall back to the close match', async () => {
    const base = makeCharacter({ owner: AUTHOR, metadata: ownMeta() });
    const fallback = closeSharedVoiceId(base);
    expect(pool.find((p) => p.id === fallback)?.gender).toBe('female');
    expect(await resolveVoiceId(base)).toBe(fallback);
    for (const bad of [
      undefined,
      '',
      42,
      'not a voice id!',
      'EXAVITQu4vr4xnSDxMaL', // legacy Sarah: not in the chooser, so not honored
      'zZyYxXwWvVuUtTsSrRqQ', // well-formed but someone's own-account id
      OWN_ID,
    ]) {
      const c = makeCharacter({ owner: AUTHOR, metadata: ownMeta({ voiceShared: bad }) });
      expect(sharedVoiceIdFor(c)).toBeNull();
      expect(await resolveVoiceId(c)).toBe(fallback);
    }
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('the close match is the same roll the adopter makes and follows the own gender', () => {
    const c = makeCharacter({ owner: AUTHOR, metadata: ownMeta({}, 'male') });
    const v = closeSharedVoiceId(c);
    expect(pool.find((p) => p.id === v)?.gender).toBe('male');
    // an unsaved own pick: the override gender wins over the stored marker
    const asFemale = closeSharedVoiceId(c, 'female');
    expect(pool.find((p) => p.id === asFemale)?.gender).toBe('female');
    // deterministic from the character alone
    expect(closeSharedVoiceId(makeCharacter({ owner: ME, metadata: ownMeta({}, 'male') }))).toBe(v);
  });

  it('the author keeps their own voice even with a voice for others set', async () => {
    const chosen = pool[0].id;
    for (const owner of [ME, null]) {
      const c = makeCharacter({ owner, metadata: ownMeta({ voiceShared: chosen }) });
      expect(await resolveVoiceId(c)).toBe(OWN_ID);
    }
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('a pool voice ignores a stale voiceShared', async () => {
    const c = makeCharacter({ owner: AUTHOR, metadata: { voiceId: pool[1].id, voiceShared: pool[0].id } });
    expect(await resolveVoiceId(c)).toBe(pool[1].id);
  });

  it('a re-roll over an unusable voice drops voiceShared with the stale marker', async () => {
    mockList.mockResolvedValue([]);
    // my own character whose own voice lost its marker shape: re-rolled + persisted
    const c = makeCharacter({ owner: ME, metadata: { voiceId: OWN_ID, voiceShared: pool[0].id } });
    await resolveVoiceId(c);
    expect(mockSave).toHaveBeenCalledTimes(1);
    const saved = (mockSave.mock.calls[0] as unknown as [Character])[0];
    expect(saved.metadata.voiceShared).toBeUndefined();
    expect(saved.metadata.voiceOwn).toBeUndefined();
    expect(pool.some((p) => p.id === saved.metadata.voiceId)).toBe(true);
  });
});

// 261119: the picker lists every VOICES entry (picker-only ones too) and
// never a retired voice; a retired voice shows as the "Current voice" row.
describe('listPoolVoices', () => {
  it('lists picker-only voices and no retired ones', () => {
    const ids = listPoolVoices().map((v) => v.id);
    expect(ids).toHaveLength(VOICES.length);
    for (const v of VOICES.filter((e) => e.roll === false)) expect(ids).toContain(v.id);
    for (const id of RETIRED_261119) expect(ids).not.toContain(id);
  });
});
