import { describe, expect, it } from 'vitest';
import { fpsBucket, frameModel, loadMsBucket, VisemeMixer } from './vrmMotion';

const B = { minX: -0.3, maxX: 0.3, minY: 0, maxY: 1.6 };

describe('frameModel', () => {
  it('contain-fits the whole model with no camera', () => {
    const f = frameModel(B, 1.1, null, 20);
    expect(f.viewHeight).toBeCloseTo(1.6);
    expect(f.y).toBeCloseTo(0.8);
    expect(f.x).toBeCloseTo(0);
    expect(f.distance).toBeCloseTo(0.8 / Math.tan((10 * Math.PI) / 180));
  });

  it('fits the width when the view is narrower than the model', () => {
    expect(frameModel(B, 0.2, null, 20).viewHeight).toBeCloseTo(3);
  });

  it('bust camera (zoom 1.35, y 0.175) puts the top of the head at the top edge, like Live2D', () => {
    const f = frameModel(B, 1.1, { zoom: 1.35, x: 0, y: 0.175 }, 20);
    expect(f.y + f.viewHeight / 2).toBeCloseTo(B.maxY, 2);
    expect(f.viewHeight).toBeCloseTo(1.6 / 1.35);
  });

  it('pans x the way Live2D does (positive moves the model right, so the camera left)', () => {
    expect(frameModel(B, 1, { zoom: 1, x: 0.1, y: 0 }, 20).x).toBeLessThan(0);
  });

  it('centers on her hips, not on a box widened by a prop on one side', () => {
    const lopsided = { ...B, maxX: B.maxX + 0.6, centerX: 0 };
    expect(frameModel(lopsided, 1.1, null, 20).x).toBeCloseTo(0);
    expect(frameModel({ ...lopsided, centerX: undefined }, 1.1, null, 20).x).toBeCloseTo(0.3);
  });
});

describe('VisemeMixer', () => {
  it('is closed when the level is zero, and always opens aa when speaking', () => {
    const m = new VisemeMixer(['aa', 'ih', 'ou', 'ee', 'oh'], () => 0.99);
    expect(Object.values(m.weights(0)).every((v) => v === 0)).toBe(true);
    const w = m.weights(0.8);
    expect(w.aa).toBeGreaterThan(0.2);
  });

  it('picks a new vowel per syllable', () => {
    let r = 0.6; // aa .34, ih .16, ou .16: lands on 'ou'
    const m = new VisemeMixer(['aa', 'ih', 'ou', 'ee', 'oh'], () => r);
    m.weights(0.1);
    let w = m.weights(0.6);
    for (let i = 0; i < 10; i++) w = m.weights(0.6);
    expect(w.ou).toBeGreaterThan(w.ih);
    r = 0.9; // past ee: 'oh'
    m.weights(0.05);
    for (let i = 0; i < 10; i++) w = m.weights(0.6);
    expect(w.oh).toBeGreaterThan(w.ou);
  });

  it('folds visemes the model lacks into aa', () => {
    const m = new VisemeMixer(['aa'], () => 0.6);
    m.weights(0.1);
    let w = m.weights(0.6);
    for (let i = 0; i < 10; i++) w = m.weights(0.6);
    expect(w.ou).toBe(0);
    expect(w.aa).toBeCloseTo(0.6, 2);
  });
});

describe('buckets', () => {
  it('fps and load buckets', () => {
    expect(fpsBucket(29.7)).toBe('27+');
    expect(fpsBucket(14)).toBe('10-20');
    expect(loadMsBucket(2500)).toBe('1-3s');
  });
});
