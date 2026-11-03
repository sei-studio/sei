import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPreferredSystemLanguages: () => [], getLocale: () => 'en-US' } }));
vi.mock('./configStore', () => ({ loadConfig: vi.fn(), updateConfig: vi.fn() }));

import { detectUiLanguage } from './localeDetect';

describe('detectUiLanguage', () => {
  it('switches to Chinese when ui_language is unset and the primary system language is Chinese', () => {
    expect(detectUiLanguage(undefined, ['zh-CN', 'en-US'])).toBe('zh');
    expect(detectUiLanguage(undefined, ['zh-Hans-CN'])).toBe('zh');
    expect(detectUiLanguage(undefined, ['zh-TW'])).toBe('zh');
    expect(detectUiLanguage(undefined, ['ZH-HK'])).toBe('zh');
  });

  it('switches to the 261104 languages the same way', () => {
    expect(detectUiLanguage(undefined, ['ja-JP', 'en-US'])).toBe('ja');
    expect(detectUiLanguage(undefined, ['ja'])).toBe('ja');
    expect(detectUiLanguage(undefined, ['ru-RU'])).toBe('ru');
    expect(detectUiLanguage(undefined, ['ru'])).toBe('ru');
    expect(detectUiLanguage(undefined, ['pt-BR'])).toBe('pt-BR');
    expect(detectUiLanguage(undefined, ['es-ES'])).toBe('es');
    expect(detectUiLanguage(undefined, ['es-419'])).toBe('es');
    expect(detectUiLanguage(undefined, ['es-MX'])).toBe('es');
  });

  it('maps European Portuguese to Brazilian Portuguese', () => {
    expect(detectUiLanguage(undefined, ['pt-PT'])).toBe('pt-BR');
    expect(detectUiLanguage(undefined, ['pt'])).toBe('pt-BR');
    expect(detectUiLanguage(undefined, ['pt_PT'])).toBe('pt-BR');
  });

  it('never overrides an explicit choice, any value', () => {
    expect(detectUiLanguage('en', ['zh-CN'])).toBeNull();
    expect(detectUiLanguage('zh', ['zh-CN'])).toBeNull();
    expect(detectUiLanguage('en', ['ja-JP'])).toBeNull();
    expect(detectUiLanguage('es', ['ru-RU'])).toBeNull();
  });

  it('stays English for every other locale, and only the primary language counts', () => {
    expect(detectUiLanguage(undefined, ['en-US'])).toBeNull();
    expect(detectUiLanguage(undefined, ['ko-KR'])).toBeNull();
    expect(detectUiLanguage(undefined, ['ko-KR', 'zh-CN'])).toBeNull(); // primary wins
    expect(detectUiLanguage(undefined, ['de-DE', 'es-ES'])).toBeNull();
    expect(detectUiLanguage(undefined, [])).toBeNull();
  });
});
