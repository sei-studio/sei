import { describe, expect, it } from 'vitest';
import {
  FISH_TTS_MODEL,
  FISH_VOICES,
  clampFishSpeed,
  parseFishVoiceRef,
  pickFishVoice,
} from './fishVoices';

const ID = '0123456789abcdef0123456789abcdef';

describe('Fish Audio voice table', () => {
  it('pins the free model name', () => {
    expect(FISH_TTS_MODEL).toBe('s2.1-pro-free');
  });

  it('maps gender and line language to the curated voices', () => {
    expect(pickFishVoice('female', 'en').name).toBe('Akari');
    expect(pickFishVoice('male', 'en').name).toBe('ivish');
    expect(pickFishVoice('female', 'ja').name).toBe('Akari');
    expect(pickFishVoice('male', 'ja').name).toBe('Satoru');
    expect(pickFishVoice('female', 'zh').name).toBe('桃桃');
    expect(pickFishVoice('male', 'zh').name).toBe('温柔沉稳男声');
    // Region tags and case do not matter.
    expect(pickFishVoice('male', 'zh-CN').id).toBe(FISH_VOICES.zh.male.id);
    expect(pickFishVoice('female', 'JA_jp').id).toBe(FISH_VOICES.ja.female.id);
  });

  it('uses the English voice of that gender for languages without a row', () => {
    for (const lang of ['ko', 'fr', 'es', 'de', '']) {
      expect(pickFishVoice('female', lang)).toBe(FISH_VOICES.en.female);
      expect(pickFishVoice('male', lang)).toBe(FISH_VOICES.en.male);
    }
  });

  it('every row is a well-formed voice with a sane speed and a small trim', () => {
    for (const row of Object.values(FISH_VOICES)) {
      for (const v of Object.values(row)) {
        expect(v.id).toMatch(/^[0-9a-f]{32}$/);
        expect(v.speed).toBeGreaterThanOrEqual(0.5);
        expect(v.speed).toBeLessThanOrEqual(2);
        expect(Math.abs(v.volume)).toBeLessThanOrEqual(3);
      }
    }
  });
});

describe('clampFishSpeed', () => {
  it('clamps to 0.5..2 and falls back for junk', () => {
    expect(clampFishSpeed(1.1)).toBe(1.1);
    expect(clampFishSpeed(9)).toBe(2);
    expect(clampFishSpeed(0.1)).toBe(0.5);
    expect(clampFishSpeed(undefined)).toBe(1.3);
    expect(clampFishSpeed(Number.NaN)).toBe(1.3);
    expect(clampFishSpeed('1.2')).toBe(1.3);
    expect(clampFishSpeed(undefined, 1)).toBe(1);
  });
});

describe('parseFishVoiceRef', () => {
  it('accepts a raw id in any case, trimmed', () => {
    expect(parseFishVoiceRef(ID)).toBe(ID);
    expect(parseFishVoiceRef(`  ${ID.toUpperCase()}\n`)).toBe(ID);
  });

  it('accepts fish.audio voice links in their common shapes', () => {
    for (const link of [
      `https://fish.audio/m/${ID}`,
      `https://fish.audio/m/${ID}/`,
      `fish.audio/m/${ID}`,
      `http://fish.audio/m/${ID}?from=share#top`,
      `https://fish.audio/zh-CN/m/${ID}/`,
      `https://www.fish.audio/app/m/${ID}`,
    ]) {
      expect(parseFishVoiceRef(link)).toBe(ID);
    }
  });

  it('rejects other sites, other paths, bad ids and non-strings', () => {
    for (const bad of [
      `https://evil.example/m/${ID}`,
      `https://fish.audio.evil.example/m/${ID}`,
      `https://notfish.audio/m/${ID}`,
      `https://fish.audio/app/api-keys/`,
      `https://fish.audio/m/${ID.slice(0, 31)}`,
      `https://fish.audio/m/${ID}zz`,
      `javascript:alert(1)`,
      `ftp://fish.audio/m/${ID}`,
      '',
      '   ',
      'x'.repeat(301),
      `${ID}0`,
    ]) {
      expect(parseFishVoiceRef(bad)).toBeNull();
    }
    expect(parseFishVoiceRef(null)).toBeNull();
    expect(parseFishVoiceRef(42)).toBeNull();
  });
});
