/**
 * App UI i18n (260730). English and Simplified Chinese; 261104 adds Japanese,
 * Russian, Brazilian Portuguese and Spanish (the list lives in
 * src/shared/uiLanguage.ts).
 *
 * Design: the KEY IS THE ENGLISH STRING. `t('Delete')` looks the string up in
 * the zh dictionary when the UI language is 'zh' and falls back to the English
 * key when there is no entry, so untranslated strings degrade to English
 * rather than to a broken token. This keeps the sweep incremental and means
 * no behavior change at all while the language is 'en'.
 *
 * Interpolation: keys may carry `{name}`-style placeholders. Call
 * `t('Welcome back, {name}!', { name })` — the lookup happens on the raw key,
 * the substitution afterwards, so one dictionary entry covers every value.
 * A translation may also carry an ICU-lite plural block,
 * `{n, plural, one {# день} few {# дня} many {# дней} other {# дня}}`, chosen
 * with Intl.PluralRules for the UI locale (Russian needs it; the English key
 * never does). See formatMessage in src/shared/uiLanguage.ts.
 *
 * Reactivity: components MUST get their translator from `useT()` (a hook that
 * subscribes to the language) so a Settings toggle re-renders them. The bare
 * `t()` export exists for call sites that run during a subscribed component's
 * render (helpers receiving strings, list-building functions) and for
 * one-shot code like toasts, where a stale language for one frame is fine.
 *
 * The language is persisted as config.ui_language (main, Zod-validated) and
 * hydrated into this store at boot by App.tsx / the onboarding entry.
 */
import { create } from 'zustand';
import { formatMessage, uiLocaleTag, type UiLanguage } from '@shared/uiLanguage';
import { ZH } from './zh';
import { JA } from './ja';
import { RU } from './ru';
import { PT_BR } from './pt-BR';
import { ES } from './es';

export type { UiLanguage } from '@shared/uiLanguage';

/** Every non-English dictionary, keyed by the English string. */
export const DICTIONARIES: Record<Exclude<UiLanguage, 'en'>, Record<string, string>> = {
  zh: ZH,
  ja: JA,
  ru: RU,
  'pt-BR': PT_BR,
  es: ES,
};

interface LangState {
  lang: UiLanguage;
  setLang: (lang: UiLanguage) => void;
}

/** Mirror the UI language onto <html lang>. Without it the page stays
 *  lang="en" and the browser picks its CJK fallback font by guesswork (on
 *  Linux and Windows often a Japanese face: centered full-width punctuation,
 *  "什么 ？" with a gap, and Japanese glyph forms for some Han characters). */
function applyDocumentLang(lang: UiLanguage): void {
  try {
    if (typeof document !== 'undefined' && document.documentElement) {
      document.documentElement.lang = lang === 'en' ? 'en' : uiLocaleTag(lang);
    }
  } catch {
    /* no DOM (tests) */
  }
}

export const useLangStore = create<LangState>((set) => ({
  lang: 'en',
  setLang: (lang) => {
    applyDocumentLang(lang);
    set({ lang });
  },
}));

function translate(lang: UiLanguage, en: string, params?: Record<string, string | number>): string {
  const out = lang === 'en' ? en : (DICTIONARIES[lang]?.[en] ?? en);
  return formatMessage(out, params, lang);
}

/** Translate with the CURRENT language. Safe inside subscribed renders. */
export function t(en: string, params?: Record<string, string | number>): string {
  return translate(useLangStore.getState().lang, en, params);
}

/**
 * The subscribed translator. Components use this so a language toggle
 * re-renders them: `const t = useT();`.
 */
export function useT(): (en: string, params?: Record<string, string | number>) => string {
  const lang = useLangStore((s) => s.lang);
  return (en, params) => translate(lang, en, params);
}

/** Current language, for non-string switches (fonts, date formats, prompts). */
export function uiLanguage(): UiLanguage {
  return useLangStore.getState().lang;
}

/** BCP 47 tag of the current UI language, for Intl date/number formatting. */
export function uiLocale(): string {
  return uiLocaleTag(useLangStore.getState().lang);
}
