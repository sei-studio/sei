/**
 * App UI languages (260730 en+zh, 261104 + ja, ru, pt-BR, es, it).
 *
 * The ONE list of UI languages, shared by main (config schema, analytics,
 * locale detection, safe mode, the Windows update window) and the renderer
 * (i18n store, Settings picker, onboarding corner menu). Pure: no DOM, no
 * electron, so every process and the tests import it.
 *
 * This is the APP UI language (`UserConfig.ui_language`), not the language a
 * companion talks in (`chat_language` / `metadata.language`, see
 * chatLanguage.ts). Only zh changes companion-side behavior today (character
 * language pin at creation, SenseVoice STT, the zh voice pack); the other
 * added languages translate the interface only.
 */

export const UI_LANGUAGES = ['en', 'zh', 'ja', 'ru', 'pt-BR', 'es', 'it'] as const;
export type UiLanguage = (typeof UI_LANGUAGES)[number];

/** Each language named in its own language, for the pickers. */
export const UI_LANGUAGE_NATIVE_NAMES: Record<UiLanguage, string> = {
  en: 'English',
  zh: '中文',
  ja: '日本語',
  ru: 'Русский',
  'pt-BR': 'Português (Brasil)',
  es: 'Español',
  it: 'Italiano',
};

/** Compact native names for the onboarding corner menu (one short word each). */
export const UI_LANGUAGE_SHORT: Record<UiLanguage, string> = {
  en: 'English',
  zh: '中文',
  ja: '日本語',
  ru: 'Русский',
  'pt-BR': 'Português',
  es: 'Español',
  it: 'Italiano',
};

/**
 * BCP 47 tag for Intl (dates, numbers, plural rules) and <html lang>.
 * Spanish is neutral international Spanish, so the bare 'es' tag: Intl then
 * formats with its default Spanish data, which reads fine on both sides of
 * the Atlantic.
 */
export const UI_LOCALE_TAGS: Record<UiLanguage, string> = {
  en: 'en-US',
  zh: 'zh-CN',
  ja: 'ja-JP',
  ru: 'ru-RU',
  'pt-BR': 'pt-BR',
  es: 'es',
  it: 'it-IT',
};

export function isUiLanguage(v: unknown): v is UiLanguage {
  return typeof v === 'string' && (UI_LANGUAGES as readonly string[]).includes(v);
}

/** A persisted/pushed value to a UI language; anything unknown is English. */
export function normalizeUiLanguage(v: unknown): UiLanguage {
  return isUiLanguage(v) ? v : 'en';
}

export function uiLocaleTag(lang: UiLanguage): string {
  return UI_LOCALE_TAGS[lang] ?? 'en-US';
}

/**
 * The UI language a system locale maps to, or null for "stay English".
 * zh-TW/zh-HK map to zh (Simplified beats English for them, 260816), every
 * Portuguese locale (pt-PT, pt-AO, ...) maps to pt-BR: European Portuguese
 * readers understand Brazilian Portuguese without trouble, and English would
 * serve them worse. Every Spanish locale maps to the neutral es.
 */
export function uiLanguageForLocale(locale: string | null | undefined): UiLanguage | null {
  if (typeof locale !== 'string') return null;
  const base = locale.toLowerCase().replace('_', '-').split('-')[0];
  switch (base) {
    case 'zh':
      return 'zh';
    case 'ja':
      return 'ja';
    case 'ru':
      return 'ru';
    case 'pt':
      return 'pt-BR';
    case 'es':
      return 'es';
    case 'it':
      return 'it';
    default:
      return null;
  }
}

/** Languages whose sentences join with no space between them (CJK). */
export function joinsWithoutSpace(lang: UiLanguage): boolean {
  return lang === 'zh' || lang === 'ja';
}

/** Join two sentences the way the language does ("A. B." vs "A。B。"). */
export function joinSentences(lang: UiLanguage, a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return joinsWithoutSpace(lang) ? `${a}${b}` : `${a} ${b}`;
}

/* -------------------------------------------------------------------------- */
/*  Message formatting: {name} placeholders + ICU-lite plurals                 */
/* -------------------------------------------------------------------------- */

const pluralRulesCache = new Map<string, Intl.PluralRules>();

function pluralCategory(locale: string, n: number): string {
  let rules = pluralRulesCache.get(locale);
  if (!rules) {
    try {
      rules = new Intl.PluralRules(locale);
    } catch {
      rules = new Intl.PluralRules('en-US');
    }
    pluralRulesCache.set(locale, rules);
  }
  return rules.select(n);
}

/** Index of the brace that closes the one at `open`, or -1. */
function matchingBrace(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const PLURAL_HEAD = /^\s*([A-Za-z_]\w*)\s*,\s*plural\s*,/;
const PLURAL_FORM = /\s*(zero|one|two|few|many|other|=\d+)\s*\{/y;

/** Resolve `{n, plural, one {...} other {...}}` blocks; plain `{x}` is left alone. */
function resolvePlurals(s: string, params: Record<string, string | number>, locale: string): string {
  if (!s.includes(', plural,') && !s.includes(',plural,')) return s;
  let out = '';
  let i = 0;
  while (i < s.length) {
    const open = s.indexOf('{', i);
    if (open < 0) {
      out += s.slice(i);
      break;
    }
    const close = matchingBrace(s, open);
    if (close < 0) {
      out += s.slice(i);
      break;
    }
    const inner = s.slice(open + 1, close);
    const head = PLURAL_HEAD.exec(inner);
    if (!head) {
      out += s.slice(i, close + 1);
      i = close + 1;
      continue;
    }
    out += s.slice(i, open);
    const raw = params[head[1]];
    const n = typeof raw === 'number' ? raw : Number(raw);
    const forms = new Map<string, string>();
    const body = inner.slice(head[0].length);
    let pos = 0;
    for (;;) {
      PLURAL_FORM.lastIndex = pos;
      const m = PLURAL_FORM.exec(body);
      if (!m) break;
      const start = PLURAL_FORM.lastIndex - 1;
      const end = matchingBrace(body, start);
      if (end < 0) break;
      forms.set(m[1], body.slice(start + 1, end));
      pos = end + 1;
    }
    let chosen: string | undefined;
    if (Number.isFinite(n)) {
      chosen = forms.get(`=${n}`) ?? forms.get(pluralCategory(locale, n));
    }
    chosen ??= forms.get('other') ?? '';
    const display = raw === undefined ? '#' : String(raw);
    out += resolvePlurals(chosen, params, locale).split('#').join(display);
    i = close + 1;
  }
  return out;
}

/**
 * Fill a message template: plural blocks first (they choose by the RAW
 * value), then every `{key}` placeholder.
 */
export function formatMessage(
  template: string,
  params: Record<string, string | number> | undefined,
  lang: UiLanguage,
): string {
  if (!params) return template;
  let out = resolvePlurals(template, params, uiLocaleTag(lang));
  for (const [k, v] of Object.entries(params)) {
    out = out.split(`{${k}}`).join(String(v));
  }
  return out;
}
