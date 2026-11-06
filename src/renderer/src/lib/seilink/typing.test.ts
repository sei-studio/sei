import { describe, expect, it, vi } from 'vitest';
import {
  CHAR_IN_MS,
  DOT_STEP_MS,
  TYPE_CHAR_MS,
  TYPE_MAX_MS,
  TYPE_PUNCT_MS,
  TYPE_SPACE_MS,
  TYPE_SPREAD_MS,
  TYPE_START_MS,
  splitEllipsis,
  typeDelays,
  typeLength,
  typeUnits,
  typedAt,
} from './typing';
import { FAILURE_LINE, LINE_DWELL_MS, STATUS_LINES, SUCCESS_LINE, lineDwell } from './worldLink';
import { DICTIONARIES } from '../i18n';

const LINE = 'Initializing WorldLink…';

describe('splitEllipsis', () => {
  it('takes a trailing ellipsis off, in the forms the catalogs use', () => {
    expect(splitEllipsis('Waiting for response…')).toEqual({ body: 'Waiting for response', dot: '.' });
    expect(splitEllipsis('Waiting for response...')).toEqual({ body: 'Waiting for response', dot: '.' });
    expect(splitEllipsis('応答を待っています…')).toEqual({ body: '応答を待っています', dot: '.' });
    expect(splitEllipsis('正在等待回应……')).toEqual({ body: '正在等待回应', dot: '.' });
    expect(splitEllipsis('応答を待っています。。。')).toEqual({ body: '応答を待っています', dot: '。' });
    expect(splitEllipsis('Loading⋯ ')).toEqual({ body: 'Loading', dot: '.' });
  });

  it('leaves a line without one alone', () => {
    expect(splitEllipsis('Signal received.')).toEqual({ body: 'Signal received.', dot: null });
    expect(splitEllipsis('Done..')).toEqual({ body: 'Done..', dot: null });
    expect(splitEllipsis('A… then more')).toEqual({ body: 'A… then more', dot: null });
  });
});

describe('typeUnits', () => {
  it('splits into letters, spaces and punctuation included, and joins back to the text', () => {
    expect(typeUnits('Signal received.')).toEqual(['S', 'i', 'g', 'n', 'a', 'l', ' ', 'r', 'e', 'c', 'e', 'i', 'v', 'e', 'd', '.']);
    expect(typeUnits('"Hi", 42')).toEqual(['"', 'H', 'i', '"', ',', ' ', '4', '2']);
    expect(typeUnits('')).toEqual([]);
  });

  it('keeps emoji, flags, combined letters and CJK whole', () => {
    expect(typeUnits('Hi 👋🏽!')).toEqual(['H', 'i', ' ', '👋🏽', '!']);
    expect(typeUnits('🇯🇵 👨‍👩‍👧')).toEqual(['🇯🇵', ' ', '👨‍👩‍👧']);
    expect(typeUnits('Cafe\u0301')).toEqual(['C', 'a', 'f', 'e\u0301']);
    expect(typeUnits('正在初始化 WorldLink')).toEqual(['正', '在', '初', '始', '化', ' ', 'W', 'o', 'r', 'l', 'd', 'L', 'i', 'n', 'k']);
    expect(typeUnits('応答を待っています')).toHaveLength(9);
    expect(typeUnits('𠮷野家')).toEqual(['𠮷', '野', '家']);
    for (const s of ['Hi 👋🏽!', '🇯🇵 👨‍👩‍👧', 'WorldLinkを初期化しています', '正在初始化 WorldLink', 'Cafe\u0301']) expect(typeUnits(s).join('')).toBe(s);
  });

  it('falls back to code points without Intl.Segmenter (surrogate pairs stay whole)', async () => {
    vi.resetModules();
    const Seg = (Intl as unknown as { Segmenter?: unknown }).Segmenter;
    delete (Intl as unknown as { Segmenter?: unknown }).Segmenter;
    try {
      const fresh = await import('./typing');
      expect(fresh.typeUnits('a😀b𠮷')).toEqual(['a', '😀', 'b', '𠮷']);
      expect(fresh.typedAt('ab…', 10_000)).toMatchObject({ typed: 'a', fresh: 'b', rest: '', done: true });
    } finally {
      (Intl as unknown as { Segmenter?: unknown }).Segmenter = Seg;
      vi.resetModules();
    }
  });
});

describe('typeDelays', () => {
  // Short enough to type at its natural pace (the success line, 51 letters, is scaled a little to fit TYPE_MAX_MS).
  const SUCCESS = 'Signal received. Syncing world clocks.';

  it('gives each letter 28 to 40 ms, more after a space or punctuation, the same every time, not all equal', () => {
    const u = typeUnits(SUCCESS);
    const d = typeDelays(u);
    expect(d).toEqual(typeDelays(typeUnits(SUCCESS)));
    expect(d).toHaveLength(u.length);
    u.forEach((c, i) => {
      const extra = c === ' ' ? TYPE_SPACE_MS : c === '.' ? TYPE_PUNCT_MS : 0;
      expect(d[i]).toBeGreaterThanOrEqual(TYPE_CHAR_MS - TYPE_SPREAD_MS + extra);
      expect(d[i]).toBeLessThanOrEqual(TYPE_CHAR_MS + TYPE_SPREAD_MS + extra);
    });
    const letters = d.filter((_, i) => /\p{L}/u.test(u[i]));
    expect(new Set(letters).size).toBeGreaterThan(3);
    expect(TYPE_CHAR_MS - TYPE_SPREAD_MS).toBeGreaterThanOrEqual(28);
    expect(TYPE_CHAR_MS + TYPE_SPREAD_MS).toBeLessThanOrEqual(45);
  });

  it('pauses a little longer after spaces and punctuation, including CJK punctuation', () => {
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const u = typeUnits('Lost contact, come back later.');
    const d = typeDelays(u);
    const spaces = d.filter((_, i) => u[i] === ' ');
    const letters = d.filter((_, i) => /\p{L}/u.test(u[i]));
    expect(avg(spaces)).toBeGreaterThan(avg(letters));
    expect(d[u.indexOf(',')]).toBeGreaterThan(Math.max(...letters));
    const cjk = typeUnits('同期中、しばらく。');
    const dc = typeDelays(cjk);
    expect(dc[cjk.indexOf('、')]).toBeGreaterThanOrEqual(TYPE_CHAR_MS - TYPE_SPREAD_MS + TYPE_PUNCT_MS);
  });

  it('differs between lines but not between runs', () => {
    expect(typeDelays(typeUnits('Syncing world clocks'))).not.toEqual(typeDelays(typeUnits('Syncing world clockz')).slice(0));
    expect(typeLength('Syncing world clocks…')).toBe(typeLength('Syncing world clocks…'));
  });

  it('types a very long line faster, within TYPE_MAX_MS', () => {
    const long = typeUnits(Array.from({ length: 40 }, (_, i) => `word${i}`).join(' '));
    const d = typeDelays(long);
    expect(d.reduce((a, b) => a + b, 0)).toBeCloseTo(TYPE_MAX_MS, 6);
    expect(Math.max(...d)).toBeLessThan(TYPE_CHAR_MS);
    expect(typeLength(long.join(''))).toBeCloseTo(TYPE_START_MS + TYPE_MAX_MS, 6);
  });

  it('leaves a short line at its natural pace', () => {
    const d = typeDelays(typeUnits('Signal received.'));
    expect(d.reduce((a, b) => a + b, 0)).toBeLessThan(TYPE_MAX_MS);
  });
});

describe('typedAt', () => {
  it('shows nothing before typing starts, then letter after letter, never moving the full body', () => {
    const body = 'Initializing WorldLink';
    expect(typedAt(LINE, 0)).toMatchObject({ typed: '', fresh: '', rest: body, done: false, dots: 0 });
    expect(typedAt(LINE, TYPE_START_MS - 1).fresh).toBe('');
    const first = typedAt(LINE, TYPE_START_MS);
    expect(first).toMatchObject({ typed: '', fresh: 'I', rest: 'nitializing WorldLink', freshIn: 0 });
    expect(typedAt(LINE, TYPE_START_MS + CHAR_IN_MS).freshIn).toBe(1);
    const d = typeDelays(typeUnits(body));
    expect(typedAt(LINE, TYPE_START_MS + d[0])).toMatchObject({ typed: 'I', fresh: 'n', rest: 'itializing WorldLink' });
    let shown = 0;
    for (let age = 0; age < 3000; age += 7) {
      const s = typedAt(LINE, age);
      expect(s.typed + s.fresh + s.rest).toBe(body);
      expect([...s.fresh].length).toBeLessThanOrEqual(1);
      const now = s.typed.length + s.fresh.length;
      expect(now).toBeGreaterThanOrEqual(shown);
      expect(now - shown).toBeLessThanOrEqual(1);
      shown = now;
    }
    expect(shown).toBe(body.length);
  });

  it('types CJK and emoji one whole grapheme at a time', () => {
    const text = '同期中 🇯🇵👋🏽…';
    const body = '同期中 🇯🇵👋🏽';
    const seen: string[] = [];
    for (let age = 0; age < 3000; age += 5) {
      const s = typedAt(text, age);
      expect(s.typed + s.fresh + s.rest).toBe(body);
      if (s.fresh && seen[seen.length - 1] !== s.fresh) seen.push(s.fresh);
    }
    expect(seen).toEqual(['同', '期', '中', ' ', '🇯🇵', '👋🏽']);
    expect(typedAt(text, 3000)).toMatchObject({ done: true, dot: '.' });
  });

  it('cycles the dots once the last letter is in: 1, 2, 3, 1 ... every DOT_STEP_MS', () => {
    const end = typeLength(LINE);
    const d = typeDelays(typeUnits('Initializing WorldLink'));
    expect(end).toBeCloseTo(TYPE_START_MS + d.reduce((a, b) => a + b, 0), 6);
    expect(typedAt(LINE, end - d[d.length - 1])).toMatchObject({ fresh: 'k', rest: '', done: false, dots: 0 });
    expect(typedAt(LINE, end - 1)).toMatchObject({ done: false, dots: 0 });
    const at = (k: number) => typedAt(LINE, end + k * DOT_STEP_MS + 1);
    expect([0, 1, 2, 3, 4, 5].map((k) => at(k).dots)).toEqual([1, 2, 3, 1, 2, 3]);
    expect(at(0)).toMatchObject({ typed: 'Initializing WorldLin', fresh: 'k', freshIn: 1, rest: '', done: true, dot: '.' });
  });

  it('a line with no ellipsis just ends', () => {
    const s = typedAt('Signal received.', 5000);
    expect(s).toMatchObject({ typed: 'Signal received', fresh: '.', rest: '', done: true, dots: 0, dot: null });
  });

  it('reduced motion: the whole line at once, ellipsis as written, no dots', () => {
    expect(typedAt(LINE, 0, true)).toEqual({ typed: LINE, fresh: '', freshIn: 1, rest: '', done: true, dots: 0, dot: null });
  });
});

describe('typing fits every line', () => {
  it('every status, success and failure line in every catalog types in well inside the shortest dwell', () => {
    const shortest = Math.min(LINE_DWELL_MS, ...STATUS_LINES.map((_, i) => lineDwell(i)));
    const keys = [...STATUS_LINES.map((l) => l.key), SUCCESS_LINE, FAILURE_LINE];
    const catalogs = [{} as Record<string, string>, ...Object.values(DICTIONARIES).filter(Boolean)] as Array<Record<string, string>>;
    for (const cat of catalogs) {
      for (const k of keys) {
        const text = (cat[k] ?? k).replace(/\{world\}/g, '42').replace(/\{name\}/g, 'Sui');
        expect(typeLength(text)).toBeLessThanOrEqual(TYPE_START_MS + TYPE_MAX_MS);
        expect(TYPE_START_MS + TYPE_MAX_MS).toBeLessThan(shortest - 400);
        expect(typeUnits(splitEllipsis(text).body).join('')).toBe(splitEllipsis(text).body);
      }
    }
  });

  it('every status line in every catalog that ends in an ellipsis is found', () => {
    const catalogs = Object.values(DICTIONARIES).filter(Boolean) as Array<Record<string, string>>;
    for (const l of STATUS_LINES) {
      if (!l.key.endsWith('…')) continue;
      for (const cat of catalogs) if (cat[l.key]) expect(splitEllipsis(cat[l.key]).dot, cat[l.key]).not.toBeNull();
    }
  });
});
