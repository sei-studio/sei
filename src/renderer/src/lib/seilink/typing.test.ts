import { describe, expect, it } from 'vitest';
import {
  DOT_STEP_MS,
  TYPE_MAX_MS,
  TYPE_SPREAD_MS,
  TYPE_START_MS,
  TYPE_WORD_MS,
  WORD_IN_MS,
  splitEllipsis,
  typeLength,
  typeUnits,
  typedAt,
  wordDelays,
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
  it('splits by word, each with what follows it, and joins back to the text', () => {
    expect(typeUnits('Signal received.')).toEqual(['Signal ', 'received.']);
    expect(typeUnits('WorldLink established between World 0 and World 42.')).toEqual([
      'WorldLink ',
      'established ',
      'between ',
      'World ',
      '0 ',
      'and ',
      'World ',
      '42.',
    ]);
    expect(typeUnits('"Hi", she said')).toEqual(['"Hi", ', 'she ', 'said']);
    expect(typeUnits('')).toEqual([]);
  });

  it('splits CJK, which has no spaces, into more than one piece', () => {
    for (const s of ['WorldLinkを初期化しています', '正在初始化 WorldLink']) {
      const u = typeUnits(s);
      expect(u.length).toBeGreaterThan(1);
      expect(u.join('')).toBe(s);
    }
  });
});

describe('wordDelays', () => {
  it('gives each word 90 to 130 ms, the same every time, not all equal', () => {
    const u = typeUnits('WorldLink established between World 0 and World 42.');
    const d = wordDelays(u);
    expect(d).toEqual(wordDelays(u));
    for (const x of d) {
      expect(x).toBeGreaterThanOrEqual(TYPE_WORD_MS - TYPE_SPREAD_MS);
      expect(x).toBeLessThanOrEqual(TYPE_WORD_MS + TYPE_SPREAD_MS);
    }
    expect(new Set(d).size).toBeGreaterThan(1);
  });

  it('types a very long line faster, within TYPE_MAX_MS', () => {
    const long = typeUnits(Array.from({ length: 40 }, (_, i) => `word${i}`).join(' '));
    const total = wordDelays(long).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(TYPE_MAX_MS, 6);
  });
});

describe('typedAt', () => {
  it('shows nothing before typing starts, then word after word, never moving the full body', () => {
    const body = 'Initializing WorldLink';
    expect(typedAt(LINE, 0)).toMatchObject({ typed: '', fresh: '', rest: body, done: false, dots: 0 });
    expect(typedAt(LINE, TYPE_START_MS - 1).fresh).toBe('');
    const first = typedAt(LINE, TYPE_START_MS);
    expect(first).toMatchObject({ typed: '', fresh: 'Initializing ', rest: 'WorldLink', freshIn: 0 });
    expect(typedAt(LINE, TYPE_START_MS + WORD_IN_MS).freshIn).toBe(1);
    for (let age = 0; age < 3000; age += 37) {
      const s = typedAt(LINE, age);
      expect(s.typed + s.fresh + s.rest).toBe(body);
    }
  });

  it('cycles the dots once the words are in: 1, 2, 3, 1 ... every DOT_STEP_MS', () => {
    const end = typeLength(LINE);
    expect(typedAt(LINE, end - 1)).toMatchObject({ done: false, dots: 0 });
    const at = (k: number) => typedAt(LINE, end + k * DOT_STEP_MS + 1);
    expect([0, 1, 2, 3, 4, 5].map((k) => at(k).dots)).toEqual([1, 2, 3, 1, 2, 3]);
    expect(at(0)).toMatchObject({ typed: 'Initializing ', fresh: 'WorldLink', rest: '', done: true, dot: '.' });
  });

  it('a line with no ellipsis just ends', () => {
    const s = typedAt('Signal received.', 5000);
    expect(s).toMatchObject({ typed: 'Signal ', fresh: 'received.', rest: '', done: true, dots: 0, dot: null });
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
