/**
 * sei-facepack v1 compose rule (261028): layer order, fallbacks, blink:false.
 */
import { describe, it, expect } from 'vitest';
import type { FacepackManifest } from '@shared/facepack';
import { layersFor, filesFor, posesOf, expressionBlinks, resolveExpressionName } from './compose';
import * as compose from './compose';

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

describe('gaze frames (261120)', () => {
  const X = [-1, -0.5, 0, 0.5, 1];
  const Y = [-0.5, 0, 0.5];
  const grid = (tag: string) => Y.map((y, yi) => X.map((x, xi) => (x === 0 && y === 0 ? null : `${tag}/iris_${xi}_${yi}.webp`)));
  const withIris: FacepackManifest = {
    ...M,
    expressions: {
      ...M.expressions,
      neutral: { blink: true, poses: { c: { ...pose('n-c'), iris: { box: box(100, 210), x: X, y: Y, frames: grid('n-c') } }, l1: pose('n-l1') } },
      laugh: { blink: false, poses: { c: { base: 'l-c/base.webp', iris: { box: box(100, 210), x: X, y: Y, frames: grid('l-c') } } } },
    },
  };

  it('a pose with frames has them; other poses, older packs and shut-eye expressions have none', () => {
    const { irisOf, irisFiles } = compose;
    expect(irisOf(withIris, 'neutral', 'c')?.x).toEqual(X);
    expect(irisFiles(withIris, 'neutral', 'c')).toHaveLength(14);
    expect(irisOf(withIris, 'neutral', 'l1')).toBeNull();
    expect(irisOf(M, 'neutral', 'c')).toBeNull();
    expect(irisOf(withIris, 'laugh', 'c')).toBeNull();
    expect(irisFiles(M, 'neutral', 'c')).toEqual([]);
  });

  it('a malformed record is ignored', () => {
    const bad = (iris: unknown): FacepackManifest => ({ ...M, expressions: { neutral: { blink: true, poses: { c: { ...pose('n-c'), iris } } } } }) as FacepackManifest;
    expect(compose.irisOf(bad({ box: box(0, 0), x: [1, 0], y: Y, frames: grid('a') }), 'neutral', 'c')).toBeNull();
    expect(compose.irisOf(bad({ box: box(0, 0), x: X, y: Y, frames: grid('a').slice(1) }), 'neutral', 'c')).toBeNull();
    expect(compose.irisOf(bad({ box: box(0, 0), x: X, y: Y, frames: [['../x.webp', null, null, null, null], ...grid('a').slice(1)] }), 'neutral', 'c')).toBeNull();
  });

  it('picks the frame nearest the gaze point, clamped to the grid', () => {
    const ir = compose.irisOf(withIris, 'neutral', 'c')!;
    expect(compose.irisCell(ir, 0, 0, null)).toEqual([2, 1]);
    expect(compose.irisCell(ir, 0.3, -0.3, null)).toEqual([3, 0]);
    expect(compose.irisCell(ir, 5, 5, null)).toEqual([4, 2]);
    expect(compose.irisCell(ir, -0.8, 0.1, null)).toEqual([0, 1]);
    expect(compose.irisFrameAt(ir, 2, 1)).toBeNull();
    expect(compose.irisFrameAt(ir, 3, 0)).toBe('n-c/iris_3_0.webp');
    expect(compose.irisFrameAt(ir, 9, -3)).toBe('n-c/iris_4_0.webp');
  });

  it('holds the frame shown until the gaze is clearly past the midpoint', () => {
    const ir = compose.irisOf(withIris, 'neutral', 'c')!;
    // midpoint between x 0 and 0.5 is 0.25; hold 0.1 of the 0.5 step = 0.05 (distance margin 0.05: switch past 0.275)
    expect(compose.irisCell(ir, 0.27, 0, [2, 1], 0.1)).toEqual([2, 1]);
    expect(compose.irisCell(ir, 0.29, 0, [2, 1], 0.1)).toEqual([3, 1]);
    expect(compose.irisCell(ir, 0.23, 0, [3, 1], 0.1)).toEqual([3, 1]);
    expect(compose.irisCell(ir, 0.2, 0, [3, 1], 0.1)).toEqual([2, 1]);
    // a far jump steps straight there; a frame index from another grid is ignored
    expect(compose.irisCell(ir, -1, 0.5, [3, 1], 0.1)).toEqual([0, 2]);
    expect(compose.irisCell(ir, 0, 0, [7, 9], 0.1)).toEqual([2, 1]);
  });

  it('half-lid looks: nearest across, loaded with the state, optional and dropped when malformed', () => {
    const half = X.map((x, xi) => (x === 0 ? null : `n-c/iris_half_${xi}.webp`));
    const iris = { box: box(100, 210), x: X, y: Y, frames: grid('n-c'), half };
    const mk = (ir: unknown): FacepackManifest => ({ ...M, expressions: { neutral: { blink: true, poses: { c: { ...pose('n-c'), iris: ir } } } } }) as FacepackManifest;
    const ir = compose.irisOf(mk(iris), 'neutral', 'c')!;
    expect(compose.irisHalfAt(ir, 0)).toBe('n-c/iris_half_0.webp');
    expect(compose.irisHalfAt(ir, 3)).toBe('n-c/iris_half_3.webp');
    expect(compose.irisHalfAt(ir, 2)).toBeNull();
    expect(compose.irisHalfAt(ir, 8)).toBe('n-c/iris_half_4.webp');
    expect(compose.irisFiles(mk(iris), 'neutral', 'c')).toHaveLength(18);
    const noHalf = compose.irisOf(withIris, 'neutral', 'c')!;
    expect(compose.irisHalfAt(noHalf, 4)).toBeNull();
    const bad = compose.irisOf(mk({ ...iris, half: ['../x.webp', null, null, null, null] }), 'neutral', 'c');
    expect(bad?.frames).toEqual(iris.frames);
    expect(bad && compose.irisHalfAt(bad, 0)).toBeNull();
    expect(compose.irisOf(mk({ ...iris, half: half.slice(1) }), 'neutral', 'c')?.half).toBeUndefined();
  });
});
