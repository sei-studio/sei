import { describe, it, expect } from 'vitest';
import { bumpPortraitRef, portraitSrc } from './portraitSrc';

describe('portraitSrc — resolves portrait_image refs to loadable URLs', () => {
  it('returns null for nullish refs (→ procedural sprite fallback)', () => {
    expect(portraitSrc(null)).toBeNull();
    expect(portraitSrc(undefined)).toBeNull();
    expect(portraitSrc('')).toBeNull();
  });

  it('maps a bare "<uuid>.png" ref onto the sei-portrait:// scheme', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    expect(portraitSrc(`${uuid}.png`)).toBe(`sei-portrait://local/${uuid}.png`);
  });

  it('passes a bundled default portrait (renderer-relative asset) through untouched', () => {
    expect(portraitSrc('./img/sui.png')).toBe('./img/sui.png');
    expect(portraitSrc('img/lyra.png')).toBe('img/lyra.png');
  });

  it('passes a cloud Supabase https URL through untouched', () => {
    const url = 'https://x.supabase.co/storage/v1/object/public/portraits/o/u.png';
    expect(portraitSrc(url)).toBe(url);
  });

  it('passes data:, blob:, and already-resolved sei-portrait: URLs through', () => {
    expect(portraitSrc('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    expect(portraitSrc('blob:abc')).toBe('blob:abc');
    expect(portraitSrc('sei-portrait://local/x.png')).toBe('sei-portrait://local/x.png');
  });

  it('bumpPortraitRef adds a per-ref cache-buster to bare refs only (260909)', () => {
    const uuid = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
    const other = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';
    expect(portraitSrc(`${uuid}.png`)).toBe(`sei-portrait://local/${uuid}.png`);
    bumpPortraitRef(`${uuid}.png`);
    expect(portraitSrc(`${uuid}.png`)).toBe(`sei-portrait://local/${uuid}.png?v=1`);
    bumpPortraitRef(`${uuid}.png`);
    expect(portraitSrc(`${uuid}.png`)).toBe(`sei-portrait://local/${uuid}.png?v=2`);
    // Other refs and non-bare refs are untouched.
    expect(portraitSrc(`${other}.png`)).toBe(`sei-portrait://local/${other}.png`);
    expect(portraitSrc('./img/sui.png')).toBe('./img/sui.png');
    bumpPortraitRef(null);
  });
});
