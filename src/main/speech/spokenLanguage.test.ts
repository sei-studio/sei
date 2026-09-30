import { describe, expect, it } from 'vitest';
import { detectSpokenLanguage } from './spokenLanguage';

describe('detectSpokenLanguage (260908, local TTS effective language)', () => {
  it('pure English stays the conversation language', () => {
    expect(detectSpokenLanguage('Hey, want to go mining today?', 'en')).toBe('en');
  });

  it('pure Chinese upgrades to zh regardless of the conversation language', () => {
    expect(detectSpokenLanguage('我们今天去挖矿吧。', 'en')).toBe('zh');
    expect(detectSpokenLanguage('我们今天去挖矿吧。', 'fr')).toBe('zh');
  });

  it('a zh conversation is already zh (no work to do)', () => {
    expect(detectSpokenLanguage('ok, sure!', 'zh')).toBe('zh');
  });

  it('mostly-Chinese mixed lines upgrade to zh (Han share past the threshold)', () => {
    expect(detectSpokenLanguage('我们今天去挖矿吧, ok?', 'en')).toBe('zh');
  });

  it('a Han run of 3+ upgrades even inside a longer English sentence', () => {
    // Han share here is under the ratio threshold; the run rule catches it.
    expect(detectSpokenLanguage('she said 我爱你 to me and then just logged off lol', 'en')).toBe(
      'zh',
    );
  });

  it('one or two stray Han chars in an English line stay en', () => {
    expect(detectSpokenLanguage('the character 龙 means dragon', 'en')).toBe('en');
    expect(detectSpokenLanguage('嘿! Hello there 朋友。', 'en')).toBe('en');
  });

  it('Japanese kana vetoes the upgrade (kanji in a Japanese line is not Chinese)', () => {
    expect(detectSpokenLanguage('東京大学に行きたいです', 'en')).toBe('en');
    expect(detectSpokenLanguage('カタカナと漢字漢字漢字', 'en')).toBe('en');
  });

  it('hangul never counts as Chinese', () => {
    expect(detectSpokenLanguage('안녕하세요 반갑습니다', 'en')).toBe('en');
  });

  it('empty and letterless lines stay the conversation language', () => {
    expect(detectSpokenLanguage('', 'en')).toBe('en');
    expect(detectSpokenLanguage('!?! 123', 'en')).toBe('en');
  });
});
