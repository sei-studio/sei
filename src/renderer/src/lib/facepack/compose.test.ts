/**
 * sei-facepack v1 compose rule (261028): layer order, fallbacks, blink:false.
 */
import { describe, it, expect } from 'vitest';
import type { FacepackManifest } from '@shared/facepack';
import { layersFor, filesFor, posesOf, expressionBlinks, resolveExpressionName } from './compose';

const box = (x: number, y: number): [number, number, number, number] => [x, y, x + 10, y + 10];

function pose(tag: string) {
  return {
    base: `${tag}/base.webp`,
    eyes: { box: box(100, 200), half: `${tag}/eh.webp`, closed: `${tag}/ec.webp` },
    mouth: { box: box(150, 300), aa: `${tag}/aa.webp`, ee: `${tag}/ee.webp`, oo: `${tag}/oo.webp` },
  };
}

const M: FacepackManifest = {
  format: 'sei-facepack',
  version: 1,
  character: 'Test',
  canvas: [512, 768],
  poses: { c: 'centre', l1: 'left' },
  default_pose: 'c',
  default_expression: 'neutral',
  expressions: {
    neutral: { blink: true, poses: { c: pose('n-c'), l1: pose('n-l1') } },
    happy: { blink: true, overlays: ['sparkle'], poses: { c: pose('h-c'), l1: pose('h-l1') } },
    // blink:false: eyes already shut; the bake ships no eye patches.
    laugh: {
      blink: false,
      poses: { c: { base: 'l-c/base.webp', mouth: { box: box(150, 300), aa: 'l-c/aa.webp' } } },
    },
  },
  overlays: { sparkle: { c: { src: 'ov/sparkle-c.webp', box: box(20, 30) } } },
};

describe('layersFor', () => {
  it('draws base, then eyes, then mouth, then overlays', () => {
    const layers = layersFor(M, { expression: 'happy', pose: 'c', eye: 'closed', viseme: 'aa' });
    expect(layers.map((l) => l.kind)).toEqual(['base', 'eyes', 'mouth', 'overlay']);
    expect(layers.map((l) => l.src)).toEqual(['h-c/base.webp', 'h-c/ec.webp', 'h-c/aa.webp', 'ov/sparkle-c.webp']);
    expect(layers[0]).toMatchObject({ x: 0, y: 0 });
    expect(layers[1]).toMatchObject({ x: 100, y: 200 });
    expect(layers[2]).toMatchObject({ x: 150, y: 300 });
    expect(layers[3]).toMatchObject({ x: 20, y: 30 });
  });

  it('open eyes and the rest mouth add no patch', () => {
    const layers = layersFor(M, { expression: 'neutral', pose: 'c', eye: 'open', viseme: 'rest' });
    expect(layers).toEqual([{ src: 'n-c/base.webp', x: 0, y: 0, kind: 'base' }]);
  });

  it('half eyes use the half patch', () => {
    const layers = layersFor(M, { expression: 'neutral', pose: 'l1', eye: 'half', viseme: 'rest' });
    expect(layers.map((l) => l.src)).toEqual(['n-l1/base.webp', 'n-l1/eh.webp']);
  });

  it('blink:false never draws an eye patch, even mid-blink', () => {
    const layers = layersFor(M, { expression: 'laugh', pose: 'c', eye: 'closed', viseme: 'aa' });
    expect(layers.map((l) => l.kind)).toEqual(['base', 'mouth']);
    expect(expressionBlinks(M, 'laugh')).toBe(false);
    expect(expressionBlinks(M, 'happy')).toBe(true);
  });

  it('an unknown expression falls back to the default expression', () => {
    expect(resolveExpressionName(M, 'flibber')).toBe('neutral');
    const layers = layersFor(M, { expression: 'flibber', pose: 'c', eye: 'open', viseme: 'rest' });
    expect(layers[0].src).toBe('n-c/base.webp');
  });

  it('an unknown pose falls back to the default pose', () => {
    const layers = layersFor(M, { expression: 'laugh', pose: 'l1', eye: 'open', viseme: 'rest' });
    expect(layers[0].src).toBe('l-c/base.webp');
    const tr = layersFor(M, { expression: 'neutral', pose: 'tr', eye: 'open', viseme: 'rest' });
    expect(tr[0].src).toBe('n-c/base.webp');
  });

  it('an overlay without an entry for the pose uses its c entry', () => {
    const layers = layersFor(M, { expression: 'happy', pose: 'l1', eye: 'open', viseme: 'rest' });
    expect(layers.map((l) => l.src)).toEqual(['h-l1/base.webp', 'ov/sparkle-c.webp']);
  });

  it('a viseme the pack lacks is skipped (rest mouth)', () => {
    const layers = layersFor(M, { expression: 'neutral', pose: 'c', eye: 'open', viseme: 'ii' });
    expect(layers.map((l) => l.kind)).toEqual(['base']);
  });

  it('overlays:false leaves them off', () => {
    const layers = layersFor(M, { expression: 'happy', pose: 'c', eye: 'open', viseme: 'rest', overlays: false });
    expect(layers.map((l) => l.kind)).toEqual(['base']);
  });
});

describe('filesFor / posesOf', () => {
  it('lists every file one expression + pose can draw', () => {
    expect(filesFor(M, 'happy', 'c')).toEqual([
      'h-c/base.webp',
      'h-c/eh.webp',
      'h-c/ec.webp',
      'h-c/aa.webp',
      'h-c/ee.webp',
      'h-c/oo.webp',
      'ov/sparkle-c.webp',
    ]);
  });
  it('skips eye files for blink:false', () => {
    expect(filesFor(M, 'laugh', 'c')).toEqual(['l-c/base.webp', 'l-c/aa.webp']);
  });
  it('lists poses with the default first', () => {
    expect(posesOf(M, 'neutral')).toEqual(['c', 'l1']);
    expect(posesOf(M, 'laugh')).toEqual(['c']);
  });
});
