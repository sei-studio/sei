/**
 * App UI i18n (260730). Two languages: English and Simplified Chinese.
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
import { ZH } from './zh';

export type UiLanguage = 'en' | 'zh';

interface LangState {
  lang: UiLanguage;
  setLang: (lang: UiLanguage) => void;
}

export const useLangStore = create<LangState>((set) => ({
  lang: 'en',
  setLang: (lang) => set({ lang }),
}));

function translate(lang: UiLanguage, en: string, params?: Record<string, string | number>): string {
  let out = lang === 'zh' ? (ZH[en] ?? en) : en;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      out = out.split(`{${k}}`).join(String(v));
    }
  }
  return out;
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
