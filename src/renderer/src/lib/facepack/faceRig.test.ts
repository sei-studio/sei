import { describe, expect, it } from 'vitest';
import type { FacepackManifest } from '@shared/facepack';
import { faceRigFor, findEyes, irisVisible } from './faceRig';
import { LID_CLOSED_AT, LID_HALF_AT, lidWeights } from './facepackGl';

const W = 160;
const H = 64;

function img(fill: [number, number, number]): Uint8ClampedArray {
  const a = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    a[i * 4] = fill[0];
    a[i * 4 + 1] = fill[1];
    a[i * 4 + 2] = fill[2];
    a[i * 4 + 3] = 255;
  }
  return a;
}

/** Paint an ellipse; `iris` draws a dark disc on white inside it, else one flat colour. */
function eye(a: Uint8ClampedArray, cx: number, cy: number, rx: number, ry: number, iris: boolean): void {
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      if (dx * dx + dy * dy > 1) continue;
      const i = (y * W + x) * 4;
      const inIris = iris && Math.hypot(x - cx, y - cy) < ry * 0.55;
      const c = iris ? (inIris ? [40, 60, 120] : [250, 250, 250]) : [120, 90, 180];
      a[i] = c[0];
      a[i + 1] = c[1];
      a[i + 2] = c[2];
    }
}

describe('findEyes', () => {
  const skin: [number, number, number] = [230, 190, 160];

  it('finds two side-by-side openings from the open/closed difference', () => {
    const open = img(skin);
    eye(open, 45, 32, 18, 12, true);
    eye(open, 115, 32, 18, 12, true);
    const closed = img(skin);
    const found = findEyes(open, closed, W, H);
    expect(found).not.toBeNull();
    const [l, r] = found!;
    expect(l.cx).toBeLessThan(r.cx);
    expect(Math.abs(l.cx - 45)).toBeLessThan(6);
    expect(Math.abs(r.cx - 115)).toBeLessThan(6);
    expect(Math.abs(l.cy - 32)).toBeLessThan(6);
    expect(irisVisible(open, W, l)).toBe(true);
    expect(irisVisible(open, W, r)).toBe(true);
  });

  it('a flat-colour eye is found but has no iris to move', () => {
    const open = img(skin);
    eye(open, 45, 32, 18, 12, false);
    eye(open, 115, 32, 18, 12, false);
    const found = findEyes(open, img(skin), W, H);
    expect(found).not.toBeNull();
    expect(irisVisible(open, W, found![0])).toBe(false);
  });

  it('returns null without two clear openings', () => {
    const open = img(skin);
    eye(open, 80, 32, 30, 14, true);
    expect(findEyes(open, img(skin), W, H)).toBeNull();
    expect(findEyes(img(skin), img(skin), W, H)).toBeNull();
  });
});

describe('faceRigFor', () => {
  it('places the neck below the mouth and the face around eyes and mouth', () => {
    const m = {
      canvas: [600, 700],
      default_expression: 'neutral',
      default_pose: 'c',
      anchor: { face: [300, 260] },
      expressions: { neutral: { poses: { c: { base: 'b.png', eyes: { box: [180, 200, 420, 300] }, mouth: { box: [260, 360, 340, 420] } } } } },
    } as unknown as FacepackManifest;
    const r = faceRigFor(m)!;
    expect(r).not.toBeNull();
    expect(r.unit).toBe(140);
    expect(r.neckY).toBeGreaterThan(390);
    expect(r.bandTop).toBeLessThan(r.bandBottom);
    expect(r.face.cx).toBe(300);
    expect(r.face.cy - r.face.ry).toBeLessThan(250);
    expect(r.face.cy + r.face.ry).toBeGreaterThan(390);
  });

  it('is null for a pack with no eye or mouth boxes', () => {
    const m = { canvas: [10, 10], expressions: { neutral: { poses: { c: { base: 'b.png' } } } } } as unknown as FacepackManifest;
    expect(faceRigFor(m)).toBeNull();
  });
});

describe('lidWeights', () => {
  it('swaps open, half and shut patches (no dissolve between opaque crops)', () => {
    const o = { halfA: 0, closedA: 0 };
    lidWeights(0, o);
    expect(o).toEqual({ halfA: 0, closedA: 0 });
    lidWeights(LID_HALF_AT, o);
    expect(o).toEqual({ halfA: 1, closedA: 0 });
    lidWeights(LID_CLOSED_AT, o);
    expect(o).toEqual({ halfA: 1, closedA: 1 });
    for (const l of [0.1, 0.3, 0.5, 0.8, 1]) {
      lidWeights(l, o);
      expect([0, 1]).toContain(o.halfA);
      expect([0, 1]).toContain(o.closedA);
    }
  });
});
