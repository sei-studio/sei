/**
 * woodTexture — procedural wood-grain canvas textures for the 3D chess scene.
 *
 * No external image assets: the grain is generated once per scene from a
 * seeded PRNG (stable across mounts, no flicker on HMR). Colors here are 3D
 * art-asset values, not UI chrome, so they are literal by design (same
 * precedent as the piece SVGs in pieces.tsx).
 */

import * as THREE from 'three';

/** Tiny deterministic PRNG (mulberry32) so the grain is stable. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface WoodSpec {
  /** Base plank color [r, g, b] 0-255. */
  base: [number, number, number];
  /** Grain stripe color. */
  stripe: [number, number, number];
  /** Occasional darker streak color. */
  streak: [number, number, number];
  seed?: number;
  /** Grain ring frequency across x (higher = tighter grain). */
  frequency?: number;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export function makeWoodTexture(spec: WoodSpec): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const rnd = mulberry32(spec.seed ?? 7);
  const freq = spec.frequency ?? 0.055;
  const phase = rnd() * Math.PI * 2;
  // Every sine must complete a whole number of cycles across the canvas or
  // the texture shows a seam line at each repeat boundary. cyc(n) is the
  // frequency for exactly n cycles; the requested grain frequency is snapped
  // to the nearest whole cycle count.
  const TAU = Math.PI * 2;
  const cyc = (n: number): number => (TAU * n) / size;
  const grainCycles = Math.max(1, Math.round((freq * size) / TAU));
  const f1 = cyc(grainCycles);
  const f2 = cyc(Math.max(1, Math.round(grainCycles * 2.9)));
  const fStreak = cyc(Math.max(1, Math.round(grainCycles * 0.5)));

  if (ctx) {
    const img = ctx.createImageData(size, size);
    const data = img.data;
    const [br, bg, bb] = spec.base;
    const [sr, sg, sb] = spec.stripe;
    const [kr, kg, kb] = spec.streak;
    for (let y = 0; y < size; y++) {
      // Slow warp so the grain lines wander instead of being ruler-straight.
      const warp = Math.sin(y * cyc(1) + phase) * 6 + Math.sin(y * cyc(4) + phase * 1.7) * 2;
      for (let x = 0; x < size; x++) {
        const g1 = Math.sin((x + warp) * f1 + phase);
        const g2 = Math.sin((x + warp * 0.6) * f2 + phase * 2.3);
        let t = 0.5 + 0.32 * g1 + 0.16 * g2 + (rnd() - 0.5) * 0.1;
        t = clamp01(t);
        let r = br + (sr - br) * t;
        let g = bg + (sg - bg) * t;
        let b = bb + (sb - bb) * t;
        // Occasional darker streak band.
        // Faint streak bands: strong dark edges repeated N times read as an
        // obvious tile pattern, so keep these barely-there.
        const streak = Math.sin((x + warp * 1.4) * fStreak + phase * 3.1);
        if (streak > 0.985) {
          const k = (streak - 0.985) / 0.015;
          r = r + (kr - r) * k * 0.3;
          g = g + (kg - g) * k * 0.3;
          b = b + (kb - b) * k * 0.3;
        }
        const i = (y * size + x) * 4;
        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
        data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}
