import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyPattern, packFile, tintGlow } from './roomRender';
import { mipTile, patternTile } from '../../shared/seilinkPatterns';

describe('look() catalog pieces (261105)', () => {
  it('resolves _shared/ beside the pack and never out of the shared folder', () => {
    const dir = path.resolve('/packs/cozy');
    expect(packFile(dir, 'bed.webp')).toBe(path.join(dir, 'bed.webp'));
    expect(packFile(dir, '_shared/views/city.webp')).toBe(path.resolve('/packs/_shared/views/city.webp'));
    expect(packFile(dir, '_shared/../cozy/bed.webp')).toBeNull();
    expect(packFile(dir, '../gamer/bed.webp')).toBeNull();
    const files = new Map([['_shared/views/city.webp', '/elsewhere/city.webp']]);
    expect(packFile(dir, '_shared/views/city.webp', files)).toBe('/elsewhere/city.webp');
  });

  it('colours a patterned layer inside the mask only, base on white and accent on black', () => {
    const w = 4;
    const h = 1;
    const data = Buffer.alloc(w * h * 4, 200);
    const mask = Buffer.alloc(w * h * 4, 0);
    // Mask on the first three px only.
    for (let i = 0; i < 3; i++) mask.fill(255, i * 4, i * 4 + 4);
    // 2-px stripes: px 0-1 accent (black), px 2-3 base (white).
    const tile = mipTile(patternTile('wide_stripe', 4, 4));
    applyPattern(data, mask, { width: w, height: h }, [4, 1], tile, [4, 4], undefined, [255, 0, 0], [0, 0, 255]);
    const px = (i: number): number[] => Array.from(data.subarray(i * 4, i * 4 + 3));
    expect(px(0)).toEqual([0, 0, 200]);
    expect(px(2)).toEqual([200, 0, 0]);
    expect(px(3)).toEqual([200, 200, 200]); // outside the mask: untouched
  });

  it('lights a glow in a colour by its brightness', () => {
    const glow = Buffer.from([255, 128, 0, 255, 0, 0, 0, 255]);
    tintGlow(glow, [0, 200, 100]);
    expect(Array.from(glow)).toEqual([0, 200, 100, 255, 0, 0, 0, 255]);
  });
});
