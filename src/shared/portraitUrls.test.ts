import { describe, expect, it } from 'vitest';
import { PORTRAIT_CACHE_CONTROL, browseArtSources, portraitThumbPath, withVersion } from './portraitUrls';

describe('portrait URL versioning (261111)', () => {
  it('appends ?v=<updated_at>, URL-encoded', () => {
    expect(withVersion('https://x/storage/v1/object/public/portraits/o/c.png', '2026-11-11T10:00:00.123+00:00'))
      .toBe('https://x/storage/v1/object/public/portraits/o/c.png?v=2026-11-11T10%3A00%3A00.123%2B00%3A00');
  });

  it('uses & when the URL already has a query', () => {
    expect(withVersion('https://x/a.png?t=1', 'v2')).toBe('https://x/a.png?t=1&v=v2');
  });

  it('an empty version leaves the URL alone (never ?v=)', () => {
    expect(withVersion('https://x/a.png', null)).toBe('https://x/a.png');
    expect(withVersion('https://x/a.png', '')).toBe('https://x/a.png');
  });

  it('a new updated_at is a new URL; the same one is the same URL (cache hit)', () => {
    const u = 'https://x/a.png';
    expect(withVersion(u, 't1')).toBe(withVersion(u, 't1'));
    expect(withVersion(u, 't1')).not.toBe(withVersion(u, 't2'));
  });

  it('thumbnail path is derived from owner + id; uploads cache for a year', () => {
    expect(portraitThumbPath('own', 'cid')).toBe('own/cid.thumb.webp');
    expect(PORTRAIT_CACHE_CONTROL).toBe('31536000');
  });
});

describe('browseArtSources', () => {
  it('thumbnail first, full portrait as the fallback', () => {
    expect(browseArtSources({ thumbUrl: 'T', portraitUrl: 'P' })).toEqual({ primary: 'T', fallback: 'P' });
  });

  it('no thumbnail: the full portrait, no fallback', () => {
    expect(browseArtSources({ thumbUrl: null, portraitUrl: 'P' })).toEqual({ primary: 'P', fallback: null });
    expect(browseArtSources({ portraitUrl: 'P' })).toEqual({ primary: 'P', fallback: null });
  });

  it('no portrait at all: nothing to load (procedural sprite)', () => {
    expect(browseArtSources({ thumbUrl: null, portraitUrl: null })).toEqual({ primary: null, fallback: null });
  });
});
