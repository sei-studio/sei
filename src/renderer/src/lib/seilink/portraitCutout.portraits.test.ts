/**
 * The cutout on the default companions' real portraits (261105, T332),
 * downscaled copies of their cloud portraits in __fixtures__.
 *  - Sui: a flat card, keyed (the edge matte never runs).
 *  - Lyra: a painted room with a dark ceiling. The vignette alone left that
 *    ceiling as a dark band across the top of her head; the edge matte cuts it.
 *  - Marv: a busy backdrop. The traced edge is ragged, so the matte stands
 *    down and he keeps the plain vignette (blocks of backdrop would be worse).
 *  - Lyra's cat ears and twin tail stick out of the head oval. The oval cut
 *    them off at the sides (Shawn, 261105, T335); the silhouette keeps them.
 */
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { edgeMatte, keyAlpha, portraitMatte, topTrace, vignetteAlpha } from './portraitCutout';

const FIX = path.join(__dirname, '__fixtures__');

async function load(file: string): Promise<{ data: Uint8ClampedArray; w: number; h: number }> {
  const { data, info } = await sharp(path.join(FIX, file)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8ClampedArray(data), w: info.width, h: info.height };
}

/** Mean final alpha (vignette x matte) over a box given in fractions of the picture. */
function meanAlpha(m: Float32Array | null, w: number, h: number, x0: number, x1: number, y0: number, y1: number): number {
  let sum = 0;
  let n = 0;
  for (let y = Math.round(y0 * h); y < Math.round(y1 * h); y++) {
    for (let x = Math.round(x0 * w); x < Math.round(x1 * w); x++) {
      sum += vignetteAlpha(x, y, w, h) * (m ? m[y * w + x] : 1);
      n++;
    }
  }
  return sum / n;
}

describe('portrait cutout on the default portraits', () => {
  it('Sui: her flat card is keyed, as before', async () => {
    const { data, w, h } = await load('sui-portrait.png');
    const r = keyAlpha(data, w, h);
    expect(r).not.toBeNull();
    expect(r!.alpha[0]).toBe(0);
    expect(r!.alpha[Math.round(0.45 * h) * w + Math.round(0.5 * w)]).toBe(255); // her face
    expect(r!.fg).toBeGreaterThan(0.4);
    expect(r!.fg).toBeLessThan(0.7);
  });

  it('Lyra: no key, and the ceiling over her head is cut instead of left as a dark band', async () => {
    const { data, w, h } = await load('lyra-portrait.jpg');
    expect(keyAlpha(data, w, h)).toBeNull();
    const top = topTrace(data, w, h);
    // Her hair starts about 6% down the picture over the middle.
    const mid = top[Math.round(w * 0.5)] / h;
    expect(mid).toBeGreaterThan(0.04);
    expect(mid).toBeLessThan(0.09);
    const m = edgeMatte(data, w, h);
    expect(m).not.toBeNull();
    // The band: the ceiling between the top and her hair, over the middle of her head.
    const band = [0.38, 0.62, 0.035, 0.055] as const;
    expect(meanAlpha(null, w, h, ...band)).toBeGreaterThan(0.2); // what the vignette alone kept
    expect(meanAlpha(m, w, h, ...band)).toBeLessThan(0.02);
    // Her hair, face and chest stay.
    expect(meanAlpha(m, w, h, 0.4, 0.6, 0.12, 0.2)).toBeGreaterThan(0.97);
    expect(meanAlpha(m, w, h, 0.4, 0.6, 0.4, 0.6)).toBeGreaterThan(0.99);
    expect(meanAlpha(m, w, h, 0.3, 0.7, 0.8, 0.95)).toBeGreaterThan(0.95);
  });

  it('Lyra: her ears and twin tail are kept whole, and the room beside them is not', async () => {
    const { data, w, h } = await load('lyra-portrait.jpg');
    const old = edgeMatte(data, w, h);
    const m = portraitMatte(data, w, h);
    /** Mean of the full matte over a box (portraitMatte already holds the vignette). */
    const kept = (x0: number, x1: number, y0: number, y1: number): number => {
      let sum = 0;
      let n = 0;
      for (let y = Math.round(y0 * h); y < Math.round(y1 * h); y++) {
        for (let x = Math.round(x0 * w); x < Math.round(x1 * w); x++) {
          sum += m[y * w + x];
          n++;
        }
      }
      return sum / n;
    };
    type Box = [number, number, number, number];
    const parts: Record<string, Box> = {
      leftEarTip: [0.17, 0.21, 0.06, 0.1],
      leftEarOuter: [0.16, 0.2, 0.1, 0.16],
      rightEarTip: [0.79, 0.83, 0.06, 0.1],
      rightEarOuter: [0.8, 0.84, 0.1, 0.16],
      rightTail: [0.84, 0.88, 0.3, 0.45],
    };
    for (const [name, box] of Object.entries(parts)) {
      // The oval alone cut these away...
      expect(meanAlpha(old, w, h, ...box), name).toBeLessThan(0.1);
      // ...the silhouette keeps them.
      expect(kept(...box), name).toBeGreaterThan(0.8);
    }
    // The window, the ceiling corners and the walls beside her stay cut.
    const room: Record<string, Box> = {
      window: [0.02, 0.12, 0.1, 0.4],
      ceilingLeft: [0, 0.12, 0, 0.06],
      ceilingRight: [0.88, 1, 0, 0.06],
      ceilingBand: [0.38, 0.62, 0.035, 0.055],
      besideLeftEar: [0.05, 0.15, 0.04, 0.2],
      aboveTail: [0.9, 1, 0.04, 0.18],
      rightWall: [0.975, 1, 0.2, 0.5],
    };
    for (const [name, box] of Object.entries(room)) expect(kept(...box), name).toBeLessThan(0.02);
    expect(kept(0.4, 0.6, 0.4, 0.6)).toBeGreaterThan(0.99);
  });

  it('Marv: a busy backdrop leaves the vignette alone', async () => {
    const { data, w, h } = await load('marv-portrait.jpg');
    expect(keyAlpha(data, w, h)).toBeNull();
    expect(edgeMatte(data, w, h)).toBeNull();
    // No silhouette either: the full matte is the plain oval.
    const m = portraitMatte(data, w, h);
    for (let y = 0; y < h; y += 3) {
      for (let x = 0; x < w; x += 3) expect(Math.abs(m[y * w + x] - vignetteAlpha(x, y, w, h))).toBeLessThan(1e-6);
    }
  });
});
