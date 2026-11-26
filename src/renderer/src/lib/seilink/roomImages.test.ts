import { describe, expect, it } from 'vitest';
import { cleanEdges } from './roomImages';

/** A w x h RGBA image, every pixel dark grey at alpha `a(x, y)`. */
function image(w: number, h: number, a: (x: number, y: number) => number): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      d[p] = d[p + 1] = d[p + 2] = 40;
      d[p + 3] = a(x, y);
    }
  return d;
}
const alpha = (d: Uint8ClampedArray, w: number, x: number, y: number): number => d[(y * w + x) * 4 + 3];

describe('cleanEdges (261121: a seat-fitted chair showed dark specks on its enlarged edge)', () => {
  const W = 20;
  const H = 20;
  // A solid square 5..14, a faint halo ring around it, a stray speck and a one-pixel hair.
  const src = (x: number, y: number): number => {
    if (x >= 5 && x <= 14 && y >= 5 && y <= 14) return 255;
    if (x === 15 && y === 9) return 255; // hair sticking out of the edge
    if (x === 2 && y === 2) return 200; // lone speck
    if (x >= 4 && x <= 15 && y >= 4 && y <= 15) return 60; // halo
    return 0;
  };

  it('drops the halo, the speck and the hair, keeps the inside solid', () => {
    const d = image(W, H, src);
    cleanEdges(d, W, H);
    expect(alpha(d, W, 4, 9)).toBe(0);
    expect(alpha(d, W, 2, 2)).toBe(0);
    expect(alpha(d, W, 15, 9)).toBe(0);
    expect(alpha(d, W, 9, 9)).toBe(255);
    expect(alpha(d, W, 7, 7)).toBe(255);
    // Dropped pixels carry no colour either.
    expect(d[(2 * W + 2) * 4]).toBe(0);
  });

  it('softens the edge inward only: no pixel gains alpha, corners stay inside the shape', () => {
    const before = image(W, H, src);
    const d = image(W, H, src);
    cleanEdges(d, W, H);
    for (let p = 0; p < W * H; p++) expect(d[p * 4 + 3]).toBeLessThanOrEqual(before[p * 4 + 3]);
    expect(alpha(d, W, 5, 9)).toBeGreaterThan(0);
    expect(alpha(d, W, 5, 9)).toBeLessThan(255);
  });
});
