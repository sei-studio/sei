import { describe, expect, it } from 'vitest';
import { VOICES } from 'soulcaster';
import {
  AISHELL3_MALE_REGISTER_SID,
  LOCAL_VOICE_SPEC,
  localVoiceFor,
  pickLocalVoice,
  resolveLocalVoice,
  voiceGenderFor,
} from './localVoice';
import { SPEECH_PACKS } from './packs';

type PoolVoice = { id: string; label: string; gender: string };
const pool = VOICES as PoolVoice[];
const firstOf = (gender: string): PoolVoice => {
  const v = pool.find((p) => p.gender === gender);
  if (!v) throw new Error(`no ${gender} voice in pool`);
  return v;
};

describe('voiceGenderFor', () => {
  it('maps pool voices by their soulcaster gender metadata', () => {
    expect(voiceGenderFor(firstOf('female').id)).toBe('female');
    expect(voiceGenderFor(firstOf('male').id)).toBe('male');
  });

  it('maps neutral pool voices to female (stable default)', () => {
    expect(voiceGenderFor(firstOf('neutral').id)).toBe('female');
  });

  it('maps legacy (260707-curated) ids by the static table', () => {
    expect(voiceGenderFor('EXAVITQu4vr4xnSDxMaL')).toBe('female'); // Sarah
    expect(voiceGenderFor('JBFqnCBsd6RMkjVDRZzb')).toBe('male'); // George
    expect(voiceGenderFor('RcEmXcISaHUgHOU4uNTz')).toBe('male'); // Hansi
  });

  it('falls back to female for unknown / absent ids', () => {
    expect(voiceGenderFor('not-a-voice-id')).toBe('female');
    expect(voiceGenderFor(undefined)).toBe('female');
    expect(voiceGenderFor(null)).toBe('female');
  });
});

describe('localVoiceFor', () => {
  it('zh picks the zh voices by gender', () => {
    expect(localVoiceFor('female', 'zh')).toBe('zh-f');
    expect(localVoiceFor('male', 'zh')).toBe('zh-m');
  });

  it('en (and every non-zh language) picks the en voices by gender', () => {
    expect(localVoiceFor('female', 'en')).toBe('en-f');
    expect(localVoiceFor('male', 'en')).toBe('en-m');
    // Local TTS scope is en+zh; other languages fall back to the en pack.
    expect(localVoiceFor('female', 'ja')).toBe('en-f');
    expect(localVoiceFor('male', 'fr')).toBe('en-m');
  });
});

describe('resolveLocalVoice (end to end)', () => {
  it('male pool voice on a zh call lands the zh male voice', () => {
    expect(resolveLocalVoice(firstOf('male').id, 'zh')).toBe('zh-m');
  });

  it('legacy female id on an en call lands the en female voice', () => {
    expect(resolveLocalVoice('pFZP5JQG7iQjIQuC4Bku', 'en')).toBe('en-f'); // Lily
  });

  it('unknown id defaults female for the call language', () => {
    expect(resolveLocalVoice(undefined, 'zh')).toBe('zh-f');
  });
});

describe('LOCAL_VOICE_SPEC integrity', () => {
  it('every slot points at a real pack and a sane sid/rate', () => {
    for (const spec of Object.values(LOCAL_VOICE_SPEC)) {
      expect(SPEECH_PACKS[spec.packId]).toBeDefined();
      expect(Number.isInteger(spec.sid)).toBe(true);
      expect(spec.sid).toBeGreaterThanOrEqual(0);
      expect(spec.rate).toBeGreaterThan(0.5);
      expect(spec.rate).toBeLessThan(2);
    }
  });

  it('each language is one pack serving both genders via speaker ids (260908)', () => {
    expect(LOCAL_VOICE_SPEC['en-f'].packId).toBe('tts-en');
    expect(LOCAL_VOICE_SPEC['en-m'].packId).toBe('tts-en');
    expect(LOCAL_VOICE_SPEC['en-f'].sid).not.toBe(LOCAL_VOICE_SPEC['en-m'].sid);
    expect(LOCAL_VOICE_SPEC['zh-f'].packId).toBe('tts-zh');
    expect(LOCAL_VOICE_SPEC['zh-m'].packId).toBe('tts-zh');
    expect(LOCAL_VOICE_SPEC['zh-f'].sid).not.toBe(LOCAL_VOICE_SPEC['zh-m'].sid);
  });

  it('zh-m speaks the measured aishell3 male-register speaker (chaowen removed 260908)', () => {
    expect(Number.isInteger(AISHELL3_MALE_REGISTER_SID)).toBe(true);
    expect(AISHELL3_MALE_REGISTER_SID).toBeGreaterThanOrEqual(0);
    expect(LOCAL_VOICE_SPEC['zh-m'].sid).toBe(AISHELL3_MALE_REGISTER_SID);
  });
});

describe('pickLocalVoice (installed-pack-aware resolution, 260908)', () => {
  it('exact slot wins when its pack is installed', () => {
    expect(pickLocalVoice('female', 'zh', ['tts-zh', 'tts-en'])).toEqual({
      voice: 'zh-f',
      missingPreferredPack: null,
    });
    expect(pickLocalVoice('male', 'en', ['tts-en'])).toEqual({
      voice: 'en-m',
      missingPreferredPack: null,
    });
  });

  it('nothing installed picks nothing', () => {
    expect(pickLocalVoice('female', 'zh', [])).toBeNull();
    expect(pickLocalVoice('male', 'en', ['stt-sensevoice'])).toBeNull();
  });

  it('the incident shape: zh conversation, only the en pack installed, speaks en and names the zh pack', () => {
    expect(pickLocalVoice('female', 'zh', ['tts-en'])).toEqual({
      voice: 'en-f',
      missingPreferredPack: 'tts-zh',
    });
    expect(pickLocalVoice('male', 'zh', ['tts-en'])).toEqual({
      voice: 'en-m',
      missingPreferredPack: 'tts-zh',
    });
  });

  it('zh male speaks from the one zh pack (the measured male-register sid rides the slot), no notice', () => {
    expect(pickLocalVoice('male', 'zh', ['tts-zh', 'tts-en'])).toEqual({
      voice: 'zh-m',
      missingPreferredPack: null,
    });
  });

  it('en conversation with only the zh pack speaks zh and names the en pack', () => {
    expect(pickLocalVoice('female', 'en', ['tts-zh'])).toEqual({
      voice: 'zh-f',
      missingPreferredPack: 'tts-en',
    });
    expect(pickLocalVoice('male', 'en', ['tts-zh'])).toEqual({
      voice: 'zh-m',
      missingPreferredPack: 'tts-en',
    });
  });

  it('non-zh languages resolve like en (the en pack is their slot)', () => {
    expect(pickLocalVoice('female', 'ja', ['tts-en'])).toEqual({
      voice: 'en-f',
      missingPreferredPack: null,
    });
    expect(pickLocalVoice('female', 'ja', ['tts-zh'])).toEqual({
      voice: 'zh-f',
      missingPreferredPack: 'tts-en',
    });
  });
});
