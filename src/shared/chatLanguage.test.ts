/**
 * chatLanguage — the Scribe-code mapping used by the voice language
 * auto-switch (src/main/voice/languageAutoSwitch.ts). The input is an
 * untrusted upstream string (ElevenLabs Scribe, or the proxy relaying it), so
 * the table lookup must never resolve to an inherited Object.prototype member.
 */
import { describe, it, expect } from 'vitest';
import { clampChatLanguage, detectedToChatLanguage } from './chatLanguage';

describe('detectedToChatLanguage', () => {
  it('maps 639-1, 639-3 and region-suffixed codes', () => {
    expect(detectedToChatLanguage('en')).toBe('en');
    expect(detectedToChatLanguage('eng')).toBe('en');
    expect(detectedToChatLanguage('ZH-Hans')).toBe('zh');
    expect(detectedToChatLanguage('cmn')).toBe('zh');
    expect(detectedToChatLanguage('ja_JP')).toBe('ja');
    expect(detectedToChatLanguage('fre')).toBe('fr');
    expect(detectedToChatLanguage('spa')).toBe('es');
  });

  it('returns null for unsupported / non-string input', () => {
    expect(detectedToChatLanguage('de')).toBeNull();
    expect(detectedToChatLanguage('')).toBeNull();
    expect(detectedToChatLanguage(null)).toBeNull();
    expect(detectedToChatLanguage(42)).toBeNull();
  });

  it('260725: prototype-inherited keys resolve to null, not to Object members', () => {
    for (const evil of [
      'constructor',
      'toString',
      '__proto__',
      'hasOwnProperty',
      'valueOf',
      'isPrototypeOf',
      '__proto__-x', // region-split still lands on the bare key
    ]) {
      expect(detectedToChatLanguage(evil)).toBeNull();
    }
  });
});

describe('clampChatLanguage', () => {
  it('passes supported codes and falls back to English otherwise', () => {
    expect(clampChatLanguage('ko')).toBe('ko');
    expect(clampChatLanguage('de')).toBe('en');
    expect(clampChatLanguage(undefined)).toBe('en');
    expect(clampChatLanguage('constructor')).toBe('en');
  });
});
