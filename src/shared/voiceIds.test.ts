/**
 * Own-voice marker (261019): how a pick from the user's own ElevenLabs
 * account is persisted beside metadata.voiceId, and how any other pick
 * clears it.
 */
import { describe, it, expect } from 'vitest';
import {
  NO_VOICE_ID,
  OWN_VOICE_KEY,
  SHARED_VOICE_KEY,
  applySharedVoicePick,
  applyVoicePick,
  isWellFormedVoiceId,
  ownVoiceOf,
  sharedVoiceIdOf,
} from './voiceIds';

const OWN_ID = 'aBcDeFgHiJkLmNoPqRsT';
// Sei pool voices: Josh (current pool) and Sarah (legacy, 260707 cut).
const POOL_JOSH = 'NXaTw4ifg0LAguvKuIwZ';
const LEGACY_SARAH = 'EXAVITQu4vr4xnSDxMaL';

describe('isWellFormedVoiceId', () => {
  it('accepts ElevenLabs-style ids and rejects junk and sentinels', () => {
    expect(isWellFormedVoiceId(OWN_ID)).toBe(true);
    expect(isWellFormedVoiceId(NO_VOICE_ID)).toBe(false);
    expect(isWellFormedVoiceId('short')).toBe(false);
    expect(isWellFormedVoiceId('../../etc')).toBe(false);
    expect(isWellFormedVoiceId('has space here')).toBe(false);
    expect(isWellFormedVoiceId(42)).toBe(false);
    expect(isWellFormedVoiceId(undefined)).toBe(false);
  });
});

describe('ownVoiceOf', () => {
  it('reads the marker only beside a well-formed voiceId', () => {
    expect(ownVoiceOf({ voiceId: OWN_ID, voiceOwn: { name: 'My Clone', gender: 'male' } })).toEqual({
      name: 'My Clone',
      gender: 'male',
    });
    expect(ownVoiceOf({ voiceId: OWN_ID, voiceOwn: { name: 'No gender' } })).toEqual({ name: 'No gender' });
    expect(ownVoiceOf({ voiceId: NO_VOICE_ID, voiceOwn: { name: 'x' } })).toBeNull();
    expect(ownVoiceOf({ voiceOwn: { name: 'x' } })).toBeNull();
    expect(ownVoiceOf({ voiceId: OWN_ID })).toBeNull();
    expect(ownVoiceOf({ voiceId: OWN_ID, voiceOwn: { name: '  ' } })).toBeNull();
    expect(ownVoiceOf({ voiceId: OWN_ID, voiceOwn: 'My Clone' })).toBeNull();
    expect(ownVoiceOf(null)).toBeNull();
    expect(ownVoiceOf(undefined)).toBeNull();
  });

  it('clamps synced junk', () => {
    const own = ownVoiceOf({ voiceId: OWN_ID, voiceOwn: { name: 'n'.repeat(500), gender: 'g'.repeat(50) } });
    expect(own?.name.length).toBe(100);
    expect(own?.gender?.length).toBe(20);
  });
});

describe('applyVoicePick', () => {
  it('an own pick stores voiceId + the marker and keeps other metadata', () => {
    const next = applyVoicePick({ voicePitch: 1.1, other: 'kept' }, OWN_ID, { name: 'My Clone', gender: 'male' });
    expect(next).toEqual({
      voicePitch: 1.1,
      other: 'kept',
      voiceId: OWN_ID,
      [OWN_VOICE_KEY]: { name: 'My Clone', gender: 'male' },
    });
    expect(ownVoiceOf(next)).toEqual({ name: 'My Clone', gender: 'male' });
  });

  it('a pool pick, Auto, or No voice clears the marker', () => {
    const start = { voiceId: OWN_ID, voiceOwn: { name: 'My Clone' } };
    expect(applyVoicePick(start, 'PoolVoice1234567890a')).toEqual({ voiceId: 'PoolVoice1234567890a' });
    expect(applyVoicePick(start, null)).toEqual({});
    expect(applyVoicePick(start, NO_VOICE_ID)).toEqual({ voiceId: NO_VOICE_ID });
    // an own marker cannot ride along with a sentinel or a null id.
    expect(applyVoicePick(start, NO_VOICE_ID, { name: 'x' })).toEqual({ voiceId: NO_VOICE_ID });
    expect(applyVoicePick(start, null, { name: 'x' })).toEqual({});
  });

  it('does not mutate the input', () => {
    const start = { voiceId: OWN_ID, voiceOwn: { name: 'My Clone' } };
    applyVoicePick(start, null);
    expect(start).toEqual({ voiceId: OWN_ID, voiceOwn: { name: 'My Clone' } });
    expect(applyVoicePick(undefined, OWN_ID, { name: 'A' })).toEqual({ voiceId: OWN_ID, voiceOwn: { name: 'A' } });
  });
});

describe('voice for others (voiceShared)', () => {
  const POOL_ID = 'pFZP5JQG7iQjIQuC4Bku';
  const OTHER_POOL = 'Xb7hH8MSUJpSbSDYk0k2';
  const own = { voiceId: OWN_ID, [OWN_VOICE_KEY]: { name: 'Clone' }, [SHARED_VOICE_KEY]: POOL_ID };

  it('a non-own pick clears it with the own marker', () => {
    for (const pick of [OTHER_POOL, NO_VOICE_ID, null]) {
      const next = applyVoicePick(own, pick, null);
      expect(next[SHARED_VOICE_KEY]).toBeUndefined();
      expect(next[OWN_VOICE_KEY]).toBeUndefined();
    }
  });

  it('an own pick keeps it', () => {
    const next = applyVoicePick(own, 'zZyYxXwWvVuUtTsSrRqQ', { name: 'Other clone' });
    expect(next[SHARED_VOICE_KEY]).toBe(POOL_ID);
  });

  it('applySharedVoicePick stores a choice only beside an own voice, null clears', () => {
    const base = { voiceId: OWN_ID, [OWN_VOICE_KEY]: { name: 'Clone' } };
    expect(applySharedVoicePick(base, OTHER_POOL)[SHARED_VOICE_KEY]).toBe(OTHER_POOL);
    expect(applySharedVoicePick(own, null)[SHARED_VOICE_KEY]).toBeUndefined();
    expect(applySharedVoicePick(base, 'not an id')[SHARED_VOICE_KEY]).toBeUndefined();
    expect(applySharedVoicePick({ voiceId: POOL_ID }, OTHER_POOL)[SHARED_VOICE_KEY]).toBeUndefined();
    // input untouched
    expect(own[SHARED_VOICE_KEY]).toBe(POOL_ID);
  });

  it('sharedVoiceIdOf reads only well-formed ids', () => {
    expect(sharedVoiceIdOf(own)).toBe(POOL_ID);
    expect(sharedVoiceIdOf({ [SHARED_VOICE_KEY]: 7 })).toBeNull();
    expect(sharedVoiceIdOf({ [SHARED_VOICE_KEY]: '../x' })).toBeNull();
    expect(sharedVoiceIdOf(undefined)).toBeNull();
  });
});

// 261024: v0.6.9 tagged a pool voice as an own voice when the user's
// ElevenLabs library held a copy of it ("Sei — Josh").
describe('a pool voice is never an own voice', () => {
  it('ownVoiceOf ignores a stale marker beside a pool or legacy id', () => {
    expect(ownVoiceOf({ voiceId: POOL_JOSH, voiceOwn: { name: 'Sei — Josh', gender: 'male' } })).toBeNull();
    expect(ownVoiceOf({ voiceId: LEGACY_SARAH, voiceOwn: { name: 'Sarah' } })).toBeNull();
    expect(ownVoiceOf({ voiceId: OWN_ID, voiceOwn: { name: 'Mine' } })).toEqual({ name: 'Mine' });
  });

  it('applyVoicePick never stamps the marker on a pool id', () => {
    expect(applyVoicePick({}, POOL_JOSH, { name: 'Sei — Josh', gender: 'male' })).toEqual({ voiceId: POOL_JOSH });
  });

  it('re-saving a stale-tagged pool voice clears the marker and the voice for others', () => {
    const stale = { voiceId: POOL_JOSH, [OWN_VOICE_KEY]: { name: 'Sei — Josh' }, [SHARED_VOICE_KEY]: 'SOYHLrjzK2X1ezoPC6cr' };
    expect(applyVoicePick(stale, POOL_JOSH, ownVoiceOf(stale))).toEqual({ voiceId: POOL_JOSH });
  });

  it('applySharedVoicePick ignores a stale-tagged pool voice', () => {
    const stale = { voiceId: POOL_JOSH, [OWN_VOICE_KEY]: { name: 'Sei — Josh' } };
    expect(applySharedVoicePick(stale, 'SOYHLrjzK2X1ezoPC6cr')[SHARED_VOICE_KEY]).toBeUndefined();
  });
});
