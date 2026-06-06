import { describe, it, expect } from 'vitest';
import { portraitSrc } from './portraitSrc';

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
});
