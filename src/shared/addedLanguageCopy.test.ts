import { describe, expect, it } from 'vitest';
import { SAFE_MODE_ADDED, UPDATE_WINDOW_ADDED, FREE_PLAY_RESET_ADDED, VELOPACK_SPLASH_ADDED, DST_GRANT_ADDED } from './addedLanguageCopy';
import { formatMessage } from './uiLanguage';

describe.each([
  ['safe mode', SAFE_MODE_ADDED],
  ['update window', UPDATE_WINDOW_ADDED],
  ['credit resets', FREE_PLAY_RESET_ADDED],
  ['update splash', VELOPACK_SPLASH_ADDED],
  ['mod setup', DST_GRANT_ADDED],
] as const)('Italian %s copy', (_name, table) => {
  it('covers the existing keys and preserves interpolation through formatting', () => {
    const italian: Record<string, string> = table.it;
    const reference: Record<string, string> = table.es;
    const names = (s: string) => [...s.matchAll(/\{\s*(\w+)\s*(?:\}|,\s*plural\s*,)/g)].map(m => m[1]).sort();
    expect(Object.keys(italian).sort()).toEqual(Object.keys(reference).sort());
    for (const [key, value] of Object.entries(italian)) {
      expect(value.trim(), key).not.toBe('');
      expect(value, key).not.toContain('—');
      expect(names(value), key).toEqual(names(reference[key]));
      for (const n of [0, 1, 2, 5]) {
        const params = Object.fromEntries(names(value).map(name => [name, n]));
        expect(formatMessage(value, params, 'it'), key).not.toMatch(/[{}#]/);
      }
    }
  });
});
