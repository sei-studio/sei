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

const { mockList, mockSave } = vi.hoisted(() => ({
  mockList: vi.fn(async () => [] as unknown[]),
  mockSave: vi.fn(async () => {}),
}));
vi.mock('../characterStore', () => ({
  listCharacters: mockList,
  saveCharacter: mockSave,
}));

import { resolveVoiceId, assignedVoiceId, personaVoiceHints } from './voiceAssign';

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
      (v) => (v.gender === 'female' || v.gender === 'neutral') && !v.tags.includes('robotic'),
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

  it('seed-weighted fallback shifts a monotone-robot persona toward deep/dry/calm voices', async () => {
    // Not a determinism re-test — assert the ROLLED voice for a Marv-like
    // persona carries at least one of the tags its seeds weight toward,
    // across a spread of character ids (weights are soft, so allow the roll
    // to disagree occasionally; a majority is the behavioral claim).
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
