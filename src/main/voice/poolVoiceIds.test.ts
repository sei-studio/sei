/**
 * Pool voice ids (261024, shared/poolVoiceIds.ts): the one set main and the
 * renderer both use to tell Sei's voices apart from a user's own ElevenLabs
 * voices. Lives under main so it can compare against the soulcaster package.
 */
import { describe, it, expect } from 'vitest';
import { VOICES } from 'soulcaster';
import { LEGACY_VOICE_IDS, POOL_VOICE_IDS, isPoolVoiceId } from '../../shared/poolVoiceIds';

describe('pool voice ids', () => {
  it('the current pool is exactly soulcaster VOICES', () => {
    const ids = (VOICES as Array<{ id: string }>).map((v) => v.id);
    expect([...POOL_VOICE_IDS].sort()).toEqual([...ids].sort());
  });

  it('legacy ids never overlap the current pool', () => {
    for (const id of LEGACY_VOICE_IDS) expect(POOL_VOICE_IDS.has(id)).toBe(false);
  });

  // 261119 voice library refresh: retired voices are legacy, so characters
  // that have them keep passing assignedVoiceId and the IPC preview check.
  it('the 261119-retired voices are legacy, not pool', () => {
    const retired = [
      'M5E055lOUxMi0kJpGyE9', // Gravel
      '507tTFX0IPtqFzGd1CAL', // Rusty
      'bAq8AI9QURijOtmeFFqT', // Sigma
      'Z9VxF84ucVtzvKlmYFhh', // Ramona
      'SAz9YHcvj6GT2YYXdXww', // River
      'YKlogvnVogI4aFHoGIEw', // Aaron
      '7squ7rvxEIZ2rYy7KYPP', // Malakai
      'YHcCpa6SBWnKDaCPZJQR', // Mora
    ];
    for (const id of retired) {
      expect(LEGACY_VOICE_IDS.has(id)).toBe(true);
      expect(POOL_VOICE_IDS.has(id)).toBe(false);
      expect(isPoolVoiceId(id)).toBe(true);
    }
  });

  it('picker-only voices (roll: false) stay in the pool', () => {
    const pickerOnly = (VOICES as Array<{ id: string; roll?: boolean }>).filter((v) => v.roll === false);
    expect(pickerOnly.length).toBeGreaterThan(0);
    for (const v of pickerOnly) expect(POOL_VOICE_IDS.has(v.id)).toBe(true);
  });

  it('isPoolVoiceId: current and legacy pool ids, nothing else', () => {
    expect(isPoolVoiceId('NXaTw4ifg0LAguvKuIwZ')).toBe(true); // Josh
    expect(isPoolVoiceId('EXAVITQu4vr4xnSDxMaL')).toBe(true); // Sarah (legacy)
    expect(isPoolVoiceId('aBcDeFgHiJkLmNoPqRsT')).toBe(false);
    expect(isPoolVoiceId('none')).toBe(false);
    expect(isPoolVoiceId(null)).toBe(false);
    expect(isPoolVoiceId(42)).toBe(false);
  });
});




