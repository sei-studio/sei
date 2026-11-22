/**
 * chatLanguage â€” the Scribe-code mapping used by the voice language
 * auto-switch (src/main/voice/languageAutoSwitch.ts). The input is an
 * untrusted upstream string (ElevenLabs Scribe, or the proxy relaying it), so
 * the table lookup must never resolve to an inherited Object.prototype member.
 */
import { describe, it, expect } from 'vitest';
import {
  chatLanguageForUi,
  clampChatLanguage,
  companionLanguage,
  detectedToChatLanguage,
  isOwnCharacter,
  userChatLanguage,
} from './chatLanguage';

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

// 261116 (product call 261116): a companion defaults to the player's UI
// language; a World companion (someone else's character) never inherits her
// creator's language pin and is flagged so the prompt can override her
// description's language instructions.
describe('chatLanguageForUi', () => {
  it('maps every UI language onto its conversation language', () => {
    expect(chatLanguageForUi('en')).toBe('en');
    expect(chatLanguageForUi('es')).toBe('es');
    expect(chatLanguageForUi('ja')).toBe('ja');
    expect(chatLanguageForUi('ru')).toBe('ru');
    expect(chatLanguageForUi('pt-BR')).toBe('pt');
    expect(chatLanguageForUi('it')).toBe('it');
    expect(chatLanguageForUi('zh')).toBe('zh');
  });
  it('returns null for unknown or junk input', () => {
    expect(chatLanguageForUi('de')).toBeNull();
    expect(chatLanguageForUi(undefined)).toBeNull();
    expect(chatLanguageForUi(42)).toBeNull();
    expect(chatLanguageForUi('constructor')).toBeNull();
  });
});

describe('userChatLanguage', () => {
  it('prefers the language heard on calls', () => {
    expect(userChatLanguage({ chat_language: 'fr', ui_language: 'ja' })).toBe('fr');
  });
  it('falls back to the UI language, then English', () => {
    expect(userChatLanguage({ ui_language: 'ja' })).toBe('ja');
    expect(userChatLanguage({ ui_language: 'pt-BR' })).toBe('pt');
    expect(userChatLanguage({ ui_language: 'ru' })).toBe('ru');
    expect(userChatLanguage({ ui_language: 'it' })).toBe('it');
    expect(userChatLanguage({ ui_language: 'de' })).toBe('en');
    expect(userChatLanguage({})).toBe('en');
    expect(userChatLanguage(null)).toBe('en');
  });
  it('ignores a junk chat_language', () => {
    expect(userChatLanguage({ chat_language: 'xx', ui_language: 'es' })).toBe('es');
  });
});

describe('isOwnCharacter', () => {
  it('own, legacy owner-less and built-in characters', () => {
    expect(isOwnCharacter({ owner: 'me' }, 'me')).toBe(true);
    expect(isOwnCharacter({ owner: null }, 'me')).toBe(true);
    expect(isOwnCharacter({}, 'local')).toBe(true);
    expect(isOwnCharacter({ owner: 'someone-else' }, 'me')).toBe(false);
    expect(isOwnCharacter({ owner: null, is_default: true }, 'me')).toBe(false);
  });
});

describe('companionLanguage', () => {
  // Aria (#M5IR): someone else's character whose persona says "Speak
  // primarily in natural, casual Spanish".
  const aria = { owner: 'creator-uuid', metadata: {} };

  it('a World companion speaks the player UI language and is flagged adopted', () => {
    expect(companionLanguage(aria, { ui_language: 'en' }, 'me')).toEqual({ language: 'en', adopted: true });
    expect(companionLanguage(aria, { ui_language: 'ja' }, 'me')).toEqual({ language: 'ja', adopted: true });
  });

  it("ignores the creator's language pin on a World companion", () => {
    const pinned = { owner: 'creator-uuid', metadata: { language: 'zh' } };
    expect(companionLanguage(pinned, { ui_language: 'en' }, 'me')).toEqual({ language: 'en', adopted: true });
  });

  it("keeps the player's own pin", () => {
    const mine = { owner: 'me', metadata: { language: 'zh' } };
    expect(companionLanguage(mine, { ui_language: 'en' }, 'me')).toEqual({ language: 'zh', adopted: false });
  });

  it('own companion without a pin follows chat_language, then the UI language', () => {
    const mine = { owner: 'me', metadata: {} };
    expect(companionLanguage(mine, { chat_language: 'ko', ui_language: 'en' }, 'me').language).toBe('ko');
    expect(companionLanguage(mine, { ui_language: 'pt-BR' }, 'me').language).toBe('pt');
  });

  it('built-in companions follow the player and are not flagged adopted', () => {
    const sui = { is_default: true, owner: null, metadata: {} };
    expect(companionLanguage(sui, { ui_language: 'es' }, 'me')).toEqual({ language: 'es', adopted: false });
  });
});




