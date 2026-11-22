import { describe, expect, it } from 'vitest';
import { detectSpokenLanguage } from './spokenLanguage';

describe('detectSpokenLanguage (260908, local TTS effective language)', () => {
  it('pure English stays the conversation language', () => {
    expect(detectSpokenLanguage('Hey, want to go mining today?', 'en')).toBe('en');
  });

  it('pure Chinese upgrades to zh regardless of the conversation language', () => {
    expect(detectSpokenLanguage('æˆ‘ä»¬ä»Šå¤©åŽ»æŒ–çŸ¿å§ã€‚', 'en')).toBe('zh');
    expect(detectSpokenLanguage('æˆ‘ä»¬ä»Šå¤©åŽ»æŒ–çŸ¿å§ã€‚', 'fr')).toBe('zh');
  });

  it('a zh conversation is already zh (no work to do)', () => {
    expect(detectSpokenLanguage('ok, sure!', 'zh')).toBe('zh');
  });

  it('mostly-Chinese mixed lines upgrade to zh (Han share past the threshold)', () => {
    expect(detectSpokenLanguage('æˆ‘ä»¬ä»Šå¤©åŽ»æŒ–çŸ¿å§, ok?', 'en')).toBe('zh');
  });

  it('a Han run of 3+ upgrades even inside a longer English sentence', () => {
    // Han share here is under the ratio threshold; the run rule catches it.
    expect(detectSpokenLanguage('she said æˆ‘çˆ±ä½  to me and then just logged off lol', 'en')).toBe(
      'zh',
    );
  });

  it('one or two stray Han chars in an English line stay en', () => {
    expect(detectSpokenLanguage('the character é¾™ means dragon', 'en')).toBe('en');
    expect(detectSpokenLanguage('å˜¿! Hello there æœ‹å‹ã€‚', 'en')).toBe('en');
  });

  it('Japanese kana vetoes the upgrade (kanji in a Japanese line is not Chinese)', () => {
    expect(detectSpokenLanguage('æ±äº¬å¤§å­¦ã«è¡ŒããŸã„ã§ã™', 'en')).toBe('en');
    expect(detectSpokenLanguage('ã‚«ã‚¿ã‚«ãƒŠã¨æ¼¢å­—æ¼¢å­—æ¼¢å­—', 'en')).toBe('en');
  });

  it('hangul never counts as Chinese', () => {
    expect(detectSpokenLanguage('ì•ˆë…•í•˜ì„¸ìš” ë°˜ê°‘ìŠµë‹ˆë‹¤', 'en')).toBe('en');
  });

  it('empty and letterless lines stay the conversation language', () => {
    expect(detectSpokenLanguage('', 'en')).toBe('en');
    expect(detectSpokenLanguage('!?! 123', 'en')).toBe('en');
  });
});




