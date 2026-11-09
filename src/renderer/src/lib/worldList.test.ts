import { describe, expect, it } from 'vitest';
import type { BrowseEntry } from '@shared/ipc';
import { compareWorldEntries, formatAddCount, mergeWorldEntries } from './worldList';

function entry(id: string, over: Partial<BrowseEntry> = {}): BrowseEntry {
  return {
    id,
    name: id,
    personaSnippet: '',
    creatorLabel: 'by someone',
    publicId: null,
    portraitUrl: null,
    skinUrl: null,
    updatedAt: '2026-01-01T00:00:00Z',
    inMyLibrary: false,
    addCount: null,
    ...over,
  };
}

const sui = entry('sui', { name: 'Sui', creatorLabel: 'by Sei', portraitUrl: 'local-sui.png', inMyLibrary: true });
const lyra = entry('lyra', { name: 'Lyra', creatorLabel: 'by Sei' });

describe('mergeWorldEntries (server sorted)', () => {
  it('keeps the server order and puts defaults where the server ranked them', () => {
    const server = [
      entry('sui', { name: 'Sui', portraitUrl: 'cloud-sui.png', addCount: 1100 }),
      entry('aria', { addCount: 72 }),
      entry('lyra', { name: 'Lyra', addCount: 27 }),
      entry('zed', { addCount: 0 }),
    ];
    const out = mergeWorldEntries({ defaults: [sui, lyra], entries: server, sort: 'popular', serverSorted: true, exhausted: false });
    expect(out.map((e) => e.id)).toEqual(['sui', 'aria', 'lyra', 'zed']);
    // Local display data for the default, the server's count.
    expect(out[0]).toMatchObject({ portraitUrl: 'local-sui.png', creatorLabel: 'by Sei', inMyLibrary: true, addCount: 1100 });
  });

  it('holds a default the server has not returned until the list is exhausted', () => {
    const server = [entry('aria', { addCount: 72 })];
    const args = { defaults: [sui], entries: server, sort: 'popular' as const, serverSorted: true };
    expect(mergeWorldEntries({ ...args, exhausted: false }).map((e) => e.id)).toEqual(['aria']);
    expect(mergeWorldEntries({ ...args, exhausted: true }).map((e) => e.id)).toEqual(['aria', 'sui']);
  });

  it('uses local display data even when the search filtered the local default out', () => {
    const server = [entry('sui', { name: 'Sui', portraitUrl: 'cloud-sui.png', addCount: 5 })];
    const out = mergeWorldEntries({ defaults: [], allDefaults: [sui], entries: server, sort: 'popular', serverSorted: true, exhausted: true });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ portraitUrl: 'local-sui.png', addCount: 5 });
  });

  it('drops duplicate ids across pages', () => {
    const out = mergeWorldEntries({ defaults: [], entries: [entry('a'), entry('b'), entry('a')], sort: 'recent', serverSorted: true, exhausted: true });
    expect(out.map((e) => e.id)).toEqual(['a', 'b']);
  });
});

describe('mergeWorldEntries (fallback: server could not sort)', () => {
  const cloud = [
    entry('b', { name: 'Bob', updatedAt: '2026-03-01T00:00:00Z', addCount: 3 }),
    entry('a', { name: 'amy', updatedAt: '2026-05-01T00:00:00Z', addCount: 9 }),
    entry('sui', { name: 'Sui', updatedAt: '2026-01-01T00:00:00Z', addCount: 20 }),
  ];

  it('A-Z over loaded pages with defaults merged in (pre-261110 behaviour)', () => {
    const out = mergeWorldEntries({ defaults: [sui, lyra], entries: cloud, sort: 'alpha', serverSorted: false, exhausted: false });
    expect(out.map((e) => e.name)).toEqual(['amy', 'Bob', 'Lyra', 'Sui']);
    // The local default wins over its cloud duplicate, keeping the cloud count.
    expect(out.find((e) => e.id === 'sui')).toMatchObject({ portraitUrl: 'local-sui.png', addCount: 20 });
  });

  it('newest over loaded pages', () => {
    const out = mergeWorldEntries({ defaults: [], entries: cloud, sort: 'recent', serverSorted: false, exhausted: false });
    expect(out.map((e) => e.id)).toEqual(['a', 'b', 'sui']);
  });

  it('popular by known counts, then A-Z when counts are unknown', () => {
    expect(mergeWorldEntries({ defaults: [], entries: cloud, sort: 'popular', serverSorted: false, exhausted: false }).map((e) => e.id))
      .toEqual(['sui', 'a', 'b']);
    const unknown = cloud.map((e) => ({ ...e, addCount: null }));
    expect(mergeWorldEntries({ defaults: [], entries: unknown, sort: 'popular', serverSorted: false, exhausted: false }).map((e) => e.name))
      .toEqual(['amy', 'Bob', 'Sui']);
  });

  it('compareWorldEntries treats a null count as 0', () => {
    const cmp = compareWorldEntries('popular');
    expect(cmp(entry('x', { addCount: null }), entry('y', { addCount: 1 }))).toBeGreaterThan(0);
  });
});

describe('formatAddCount', () => {
  it('hides zero, unknown and junk', () => {
    expect(formatAddCount(0)).toBeNull();
    expect(formatAddCount(null)).toBeNull();
    expect(formatAddCount(undefined)).toBeNull();
    expect(formatAddCount(-3)).toBeNull();
    expect(formatAddCount(Number.NaN)).toBeNull();
  });

  it('compacts large numbers in English', () => {
    expect(formatAddCount(1)).toBe('1');
    expect(formatAddCount(999)).toBe('999');
    expect(formatAddCount(1140)).toBe('1.1K');
    expect(formatAddCount(1250)).toBe('1.3K');
    expect(formatAddCount(15300)).toBe('15.3K');
    expect(formatAddCount(2_400_000)).toBe('2.4M');
  });

  it('uses the UI locale and survives a bad tag', () => {
    expect(formatAddCount(12345, 'ja-JP')).toBe('1.2万');
    expect(formatAddCount(1140, 'not a locale!!')).toBe('1.1K');
  });
});
