import { describe, expect, it } from 'vitest';
import {
  CODE_PATTERNS,
  codeTile,
  mipTile,
  greyTileFromRgba,
  hexToRgb,
  inQuad,
  mixPatternColour,
  patternPixel,
  patternTile,
  patternValue,
  project,
  quadMap,
  quadSize,
  sampleMip,
  screenToSurface,
  squareToQuad,
  toneOnTone,
  warpPatternGrey,
  warpScale,
  type QuadPoints,
} from './seilinkPatterns';

describe('pattern mixing math', () => {
  it('white is the base, black the accent, grey in between', () => {
    expect(mixPatternColour([200, 100, 0], [0, 50, 100], 1)).toEqual([200, 100, 0]);
    expect(mixPatternColour([200, 100, 0], [0, 50, 100], 0)).toEqual([0, 50, 100]);
    expect(mixPatternColour([200, 100, 0], [0, 50, 100], 0.5)).toEqual([100, 75, 50]);
    // Clamped.
    expect(mixPatternColour([10, 10, 10], [0, 0, 0], 2)).toEqual([10, 10, 10]);
  });

  it('multiplies the art shading inside the mask and leaves it alone outside', () => {
    const frame: [number, number, number] = [128, 128, 128];
    expect(patternPixel(frame, 0, [255, 0, 0], [0, 0, 255], 1)).toEqual([128, 128, 128]);
    expect(patternPixel(frame, 1, [255, 0, 0], [0, 0, 255], 1)).toEqual([128, 0, 0]);
    expect(patternPixel(frame, 1, [255, 0, 0], [0, 0, 255], 0)).toEqual([0, 0, 128]);
    // A plain white tile at full mask is a plain tint (frame x base / 255).
    const p = patternPixel([200, 100, 50], 1, [128, 255, 64], [0, 0, 0], 1);
    expect(p.map(Math.round)).toEqual([100, 100, 13]);
  });

  it('tone-on-tone keeps the hue, steps lightness 18%, darker for light bases', () => {
    const light = hexToRgb(toneOnTone('#e8c0c0'))!;
    const base = hexToRgb('#e8c0c0')!;
    expect(light[0]).toBeLessThan(base[0]);
    expect(light[0]).toBeGreaterThan(light[1]); // still reddish
    const dark = hexToRgb(toneOnTone('#202840'))!;
    expect(dark[2]).toBeGreaterThan(0x40);
    expect(toneOnTone('#ffffff')).toBe('#d1d1d1');
    expect(toneOnTone('not a colour')).toBe('#808080');
  });

  it('a painted tile becomes luminance x alpha, transparent = base', () => {
    const t = greyTileFromRgba([255, 255, 255, 255, 0, 0, 0, 255, 0, 0, 0, 0], 3, 1);
    expect(Array.from(t.data)).toEqual([255, 0, 255]);
  });
});

describe('code patterns', () => {
  it('every pattern has both colours and tiles seamlessly', () => {
    for (const p of CODE_PATTERNS) {
      const t = codeTile(p.id)!;
      const vals = new Set(t.data);
      expect(vals.has(255) || Math.max(...t.data) > 200, p.id).toBe(true);
      expect(Math.min(...t.data), p.id).toBeLessThan(120);
      // Periodic: value at u and u + 1 match.
      for (const [u, v] of [[0.13, 0.41], [0.77, 0.05], [0.5, 0.92]]) {
        expect(patternValue(p.id, u + 1, v - 1), p.id).toBe(patternValue(p.id, u, v));
      }
    }
  });

  it('gingham: crossings are accent, single bands half, gaps base', () => {
    expect(patternValue('gingham', 0.25, 0.25)).toBe(0);
    expect(patternValue('gingham', 0.25, 0.75)).toBe(0.5);
    expect(patternValue('gingham', 0.75, 0.75)).toBe(1);
  });

  it('unknown ids are plain; tiles are anti-aliased at edges', () => {
    expect(patternValue('nope', 0.3, 0.3)).toBe(1);
    expect(codeTile('nope')).toBeNull();
    const t = patternTile('wide_stripe', 10, 2);
    // A stripe edge falling mid-texel would be grey; at w=10 edges land on texel borders.
    expect(Array.from(t.data.slice(0, 10))).toEqual([0, 0, 0, 0, 0, 255, 255, 255, 255, 255]);
    const odd = patternTile('wide_stripe', 9, 1);
    expect(odd.data[4]).toBeGreaterThan(0);
    expect(odd.data[4]).toBeLessThan(255);
  });
});

describe('UV quad warp', () => {
  const quad: QuadPoints = [[100, 100], [300, 120], [300, 280], [100, 300]];

  it('square-to-quad maps the unit corners onto the quad', () => {
    const m = squareToQuad(quad)!;
    const corners: Array<[number, number]> = [[0, 0], [1, 0], [1, 1], [0, 1]];
    corners.forEach(([u, v], i) => {
      const [x, y] = project(m, u, v);
      expect(x).toBeCloseTo(quad[i][0], 6);
      expect(y).toBeCloseTo(quad[i][1], 6);
    });
  });

  it('the inverse takes canvas points back to surface px, with the uv offset', () => {
    const map = quadMap({ quad, size: [400, 200], uv: [10, 20] })!;
    const [u, v] = screenToSurface(map, 300, 280);
    expect(u).toBeCloseTo(410, 6);
    expect(v).toBeCloseTo(220, 6);
    const [u0, v0] = screenToSurface(map, 100, 100);
    expect(u0).toBeCloseTo(10, 6);
    expect(v0).toBeCloseTo(20, 6);
  });

  it('is projective: the centre of the quad is the diagonals crossing, not the corner average', () => {
    // A trapezoid receding to the right: the far half is shorter on screen.
    const trap: QuadPoints = [[0, 0], [100, 30], [100, 70], [0, 100]];
    const map = quadMap({ quad: trap, size: [100, 100] })!;
    const m = squareToQuad(trap)!;
    const [cx] = project(m, 0.5, 0.5);
    expect(cx).toBeGreaterThan(50); // the near half takes more than half the width
    const [u] = screenToSurface(map, 50, 50);
    expect(u).toBeLessThan(50);
  });

  it('degenerate quads give no map', () => {
    expect(squareToQuad([[0, 0], [10, 0], [20, 0], [30, 0]])).toBeNull();
    expect(quadMap({ quad: [[0, 0], [0, 0], [0, 0], [0, 0]] })).toBeNull();
  });

  it('default size is the mean edge lengths', () => {
    expect(quadSize([[0, 0], [100, 0], [100, 50], [0, 50]])).toEqual([100, 50]);
  });

  it('inQuad is a point-in-polygon test', () => {
    expect(inQuad(quad, 200, 200)).toBe(true);
    expect(inQuad(quad, 50, 200)).toBe(false);
    expect(inQuad(quad, 299, 110)).toBe(false); // above the sloped top edge
  });

  it('fills only inside the quads and leaves the rest plain base', () => {
    const tile = mipTile(patternTile('checker', 32, 32));
    const out = warpPatternGrey({ tile, period: [40, 40], quads: [{ quad }], rect: [0, 0, 400, 400], scale: 0.25 });
    expect(out.w).toBe(100);
    expect(out.h).toBe(100);
    // Outside: base.
    expect(out.data[10 * 100 + 10]).toBe(255);
    expect(out.data[50 * 100 + 90]).toBe(255);
    // Inside: both colours appear.
    const inside: number[] = [];
    for (let j = 30; j < 70; j++) for (let i = 30; i < 70; i++) inside.push(out.data[j * 100 + i]);
    expect(Math.min(...inside)).toBeLessThan(60);
    expect(Math.max(...inside)).toBeGreaterThan(200);
  });

  it('follows the plane: an axis-aligned quad reproduces the tile exactly', () => {
    const tile = mipTile(patternTile('wide_stripe', 20, 20));
    const out = warpPatternGrey({
      tile,
      period: [20, 20],
      quads: [{ quad: [[0, 0], [40, 0], [40, 10], [0, 10]], size: [40, 10] }],
      rect: [0, 0, 40, 10],
      scale: 1,
    });
    const row = Array.from(out.data.slice(0, 40));
    expect(row.slice(0, 10).every((g) => g === 0)).toBe(true);
    expect(row.slice(10, 20).every((g) => g === 255)).toBe(true);
    expect(row.slice(20, 30).every((g) => g === 0)).toBe(true);
  });

  it('box filters far-away detail to the mean instead of aliasing', () => {
    const tile = mipTile(patternTile('pinstripe', 20, 20));
    // 1 output px covers 10 tiles: every pixel should be the tile mean.
    const out = warpPatternGrey({
      tile,
      period: [2, 2],
      quads: [{ quad: [[0, 0], [100, 0], [100, 100], [0, 100]], size: [100, 100] }],
      rect: [0, 0, 100, 100],
      scale: 0.05,
    });
    const mean = Math.round(tile.mean * 255);
    for (const g of out.data) expect(Math.abs(g - mean)).toBeLessThanOrEqual(3);
  });

  it('sampling wraps across the tile edge and blurs to the mean far away', () => {
    const tile = mipTile({ w: 4, h: 1, data: new Uint8Array([0, 255, 255, 0]) });
    expect(sampleMip(tile, 4, 0.5, 1)).toBeCloseTo(0, 6); // between texel 3 and texel 0 (wrapped)
    expect(sampleMip(tile, 2, 0.5, 1)).toBeCloseTo(1, 6);
    expect(sampleMip(tile, -2, 0.5, 1)).toBeCloseTo(1, 6);
    expect(sampleMip(tile, 1.3, 0.5, 64)).toBeCloseTo(0.5, 6);
  });

  it('skips pixels the keep map rules out', () => {
    const tile = mipTile(patternTile('checker', 8, 8));
    const keep = new Uint8Array(16).fill(0);
    const out = warpPatternGrey({ tile, period: [4, 4], quads: [{ quad: [[0, 0], [4, 0], [4, 4], [0, 4]] }], rect: [0, 0, 4, 4], scale: 1, keep });
    expect(Array.from(out.data).every((g) => g === 255)).toBe(true);
  });

  it('caps the work for a huge region', () => {
    expect(warpScale([0, 0, 100, 100], 1)).toBe(1);
    const s = warpScale([0, 0, 2560, 1440], 1);
    expect(2560 * 1440 * s * s).toBeCloseTo(1_200_000, -2);
  });
});
