import { describe, expect, it } from 'vitest';
import {
  UI_LANGUAGES,
  UI_LANGUAGE_NATIVE_NAMES,
  UI_LANGUAGE_SHORT,
  formatMessage,
  isUiLanguage,
  joinSentences,
  normalizeUiLanguage,
  uiLanguageForLocale,
  uiLocaleTag,
} from './uiLanguage';

describe('UI language list', () => {
  it('names every language in its own language', () => {
    for (const l of UI_LANGUAGES) {
      expect(UI_LANGUAGE_NATIVE_NAMES[l]).toBeTruthy();
      expect(UI_LANGUAGE_SHORT[l]).toBeTruthy();
      expect(() => new Intl.DateTimeFormat(uiLocaleTag(l))).not.toThrow();
    }
    expect(UI_LANGUAGE_NATIVE_NAMES.ja).toBe('日本語');
    expect(UI_LANGUAGE_NATIVE_NAMES.ru).toBe('Русский');
  });

  it('validates and normalizes persisted values', () => {
    expect(isUiLanguage('pt-BR')).toBe(true);
    expect(isUiLanguage('pt')).toBe(false);
    expect(normalizeUiLanguage('es')).toBe('es');
    expect(normalizeUiLanguage('fr')).toBe('en');
    expect(normalizeUiLanguage(undefined)).toBe('en');
  });
});

describe('uiLanguageForLocale', () => {
  it('maps each supported system locale', () => {
    expect(uiLanguageForLocale('zh-TW')).toBe('zh');
    expect(uiLanguageForLocale('ja-JP')).toBe('ja');
    expect(uiLanguageForLocale('ru')).toBe('ru');
    expect(uiLanguageForLocale('es-MX')).toBe('es');
    expect(uiLanguageForLocale('es_419')).toBe('es');
  });

  it('sends every Portuguese locale to pt-BR', () => {
    expect(uiLanguageForLocale('pt-BR')).toBe('pt-BR');
    expect(uiLanguageForLocale('pt-PT')).toBe('pt-BR');
    expect(uiLanguageForLocale('pt_PT')).toBe('pt-BR');
    expect(uiLanguageForLocale('pt')).toBe('pt-BR');
  });

  it('leaves anything else in English', () => {
    expect(uiLanguageForLocale('en-GB')).toBeNull();
    expect(uiLanguageForLocale('fr-FR')).toBeNull();
    expect(uiLanguageForLocale('')).toBeNull();
    expect(uiLanguageForLocale(undefined)).toBeNull();
  });
});

describe('formatMessage', () => {
  it('fills plain placeholders', () => {
    expect(formatMessage('Hi {name}, {name}!', { name: 'Sui' }, 'en')).toBe('Hi Sui, Sui!');
    expect(formatMessage('No params {x}', undefined, 'en')).toBe('No params {x}');
  });

  it('picks Russian plural forms', () => {
    const t = '{n, plural, one {# день} few {# дня} many {# дней} other {# дня}}';
    expect(formatMessage(t, { n: 1 }, 'ru')).toBe('1 день');
    expect(formatMessage(t, { n: 3 }, 'ru')).toBe('3 дня');
    expect(formatMessage(t, { n: 5 }, 'ru')).toBe('5 дней');
    expect(formatMessage(t, { n: 21 }, 'ru')).toBe('21 день');
    expect(formatMessage(t, { n: 1.5 }, 'ru')).toBe('1.5 дня');
  });

  it('picks one/other for pt-BR and es, and =N beats the category', () => {
    const t = '{n, plural, =0 {nenhum} one {# dia} other {# dias}} ({date})';
    expect(formatMessage(t, { n: 0, date: 'x' }, 'pt-BR')).toBe('nenhum (x)');
    expect(formatMessage(t, { n: 1, date: 'x' }, 'pt-BR')).toBe('1 dia (x)');
    expect(formatMessage(t, { n: 4, date: 'x' }, 'es')).toBe('4 dias (x)');
  });

  it('keeps placeholders inside plural forms', () => {
    const t = '{name}: {n, plural, one {# mensaje de {name}} other {# mensajes}}';
    expect(formatMessage(t, { name: 'Lyra', n: 1 }, 'es')).toBe('Lyra: 1 mensaje de Lyra');
  });
});

describe('joinSentences', () => {
  it('joins CJK without a space and everything else with one', () => {
    expect(joinSentences('ja', 'あ。', 'い。')).toBe('あ。い。');
    expect(joinSentences('zh', '甲。', '乙。')).toBe('甲。乙。');
    expect(joinSentences('ru', 'А.', 'Б.')).toBe('А. Б.');
    expect(joinSentences('es', '', 'B.')).toBe('B.');
  });
});
