import { describe, expect, it } from 'vitest';
import { formatMessage, type UiLanguage } from '@shared/uiLanguage';
import { DICTIONARIES } from './index';

/**
 * Every dictionary against the zh one, which is the reference key set (the
 * English strings the app passes to t(); English itself has no dictionary).
 */
const REFERENCE = DICTIONARIES.zh;
const ADDED = ['ja', 'ru', 'pt-BR', 'es'] as const satisfies readonly UiLanguage[];

/** Placeholders the English key carries that a translation may drop. */
const OPTIONAL: Record<string, readonly string[]> = {
  // The English article in the Draw! caption ("this is a cat"); languages
  // without one, or with a gendered one, word it without it.
  'according to {name}, this is {a} {word}.': ['a'],
};

/** Words for "friend" a companion must never be called (house rule). */
const FRIEND: Record<(typeof ADDED)[number], RegExp> = {
  ja: /友達|友だち|ともだち|フレンド|友人|親友/,
  ru: /(?<![а-яё])(друг|друга|другу|другом|друге|друзья|друзей|друзьям|друзьями|друзьях|дружище|подруг[а-яё]*)(?![а-яё])/iu,
  'pt-BR': /\b(amig[oa]s?|amiguinh[oa]s?|parceir[oa]s?|parças?)\b/iu,
  es: /\b(amig[oa]s?|amiguit[oa]s?|parcer[oa]s?|cuates?|colegas?)\b/iu,
};

/** Every `{name}` placeholder and plural variable, at any depth. */
function placeholderNames(s: string): Set<string> {
  const names = new Set<string>();
  for (const m of s.matchAll(/\{\s*([A-Za-z_]\w*)\s*(?:\}|,\s*plural\s*,)/g)) names.add(m[1]);
  return names;
}

function balanced(s: string): boolean {
  let depth = 0;
  for (const ch of s) {
    if (ch === '{') depth++;
    else if (ch === '}' && --depth < 0) return false;
  }
  return depth === 0;
}

describe.each(ADDED)('%s dictionary', (lang) => {
  const dict = DICTIONARIES[lang];

  it('has exactly the reference key set', () => {
    const missing = Object.keys(REFERENCE).filter((k) => !(k in dict));
    const extra = Object.keys(dict).filter((k) => !(k in REFERENCE));
    expect(missing).toEqual([]);
    expect(extra).toEqual([]);
  });

  it('has no empty values, em dashes or "friend" words', () => {
    const bad: string[] = [];
    for (const [k, v] of Object.entries(dict)) {
      if (!v.trim()) bad.push(`empty: ${k}`);
      if (v.includes('—')) bad.push(`em dash: ${k}`);
      if (FRIEND[lang].test(v) && !/friend/i.test(k)) bad.push(`friend: ${k} -> ${v}`);
    }
    expect(bad).toEqual([]);
  });

  it('keeps every placeholder, and only those', () => {
    const bad: string[] = [];
    for (const [k, v] of Object.entries(dict)) {
      if (!balanced(v)) {
        bad.push(`unbalanced braces: ${k}`);
        continue;
      }
      const want = placeholderNames(k);
      const got = placeholderNames(v);
      const optional = OPTIONAL[k] ?? [];
      for (const n of want) if (!got.has(n) && !optional.includes(n)) bad.push(`missing {${n}}: ${k}`);
      for (const n of got) if (!want.has(n)) bad.push(`extra {${n}}: ${k}`);
    }
    expect(bad).toEqual([]);
    // The Draw! caption's {a} is the English "a"/"an": no other language may print it.
    expect(dict['according to {name}, this is {a} {word}.']).not.toContain('{a}');
  });

  it('formats every value cleanly for sample numbers', () => {
    const bad: string[] = [];
    for (const [k, v] of Object.entries(dict)) {
      const names = placeholderNames(k);
      for (const n of [0, 1, 2, 5, 21]) {
        const params: Record<string, string | number> = {};
        for (const name of names) params[name] = n;
        const out = formatMessage(v, params, lang);
        if (/[{}]/.test(out)) {
          bad.push(`${k} (n=${n}) -> ${out}`);
          break;
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
