/**
 * noticesStore — coercion tests (260725).
 *
 * The feed is remote and hand-authored, and the state file is on the user's
 * disk, so both are treated as hostile input: every field is coerced, and a
 * defective entry is dropped rather than crashing the inbox.
 */
import { describe, it, expect } from 'vitest';
import { coerceNotice, coerceNotices } from './noticesStore';

describe('coerceNotice', () => {
  it('keeps a well-formed entry', () => {
    expect(
      coerceNotice({ id: 'a', title: 'T', date: '2026-07-25', body: 'hi' }),
    ).toEqual({ id: 'a', title: 'T', date: '2026-07-25', body: 'hi' });
  });

  it('defaults a missing date to empty rather than dropping the notice', () => {
    expect(coerceNotice({ id: 'a', title: 'T', body: 'hi' })).toEqual({
      id: 'a',
      title: 'T',
      date: '',
      body: 'hi',
    });
  });

  it('drops entries missing id, title or body', () => {
    expect(coerceNotice({ title: 'T', body: 'x' })).toBeNull();
    expect(coerceNotice({ id: 'a', body: 'x' })).toBeNull();
    expect(coerceNotice({ id: 'a', title: 'T' })).toBeNull();
    expect(coerceNotice({ id: '', title: 'T', body: 'x' })).toBeNull();
    expect(coerceNotice(null)).toBeNull();
    expect(coerceNotice('nope')).toBeNull();
  });

  it('drops non-string fields instead of coercing them', () => {
    expect(coerceNotice({ id: 1, title: 'T', body: 'x' })).toBeNull();
    expect(coerceNotice({ id: 'a', title: 'T', body: { x: 1 } })).toBeNull();
  });
});

describe('coerceNotices', () => {
  it('drops bad entries and de-dupes ids, keeping the first', () => {
    const out = coerceNotices([
      { id: 'a', title: 'A', body: '1' },
      { nope: true },
      { id: 'a', title: 'A duplicate', body: '2' },
      { id: 'b', title: 'B', body: '3' },
    ]);
    expect(out.map((n) => n.id)).toEqual(['a', 'b']);
    expect(out[0].title).toBe('A');
  });

  it('returns empty for a non-array', () => {
    expect(coerceNotices({ notices: [] })).toEqual([]);
    expect(coerceNotices(undefined)).toEqual([]);
  });
});
