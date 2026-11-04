import { describe, expect, it } from 'vitest';
import { DOCK_BOTTOM_GAP, DOCK_HER_GAP, DOCK_SIDE_GAP, dockBottom, dockLeft } from './dockPlace';

const work = { x: 0, y: 0, w: 1920, h: 1032 };

describe('dockLeft', () => {
  it('sits right of her box when it fits', () => {
    expect(dockLeft(work, { x: 900, y: 500, w: 400, h: 600 }, 1100, 140)).toBe(1300 + DOCK_HER_GAP);
  });

  it('goes left of her when the right side has no room', () => {
    expect(dockLeft(work, { x: 1500, y: 500, w: 380, h: 600 }, 1690, 140)).toBe(1500 - DOCK_HER_GAP - 140);
  });

  it('centres under her seat when she fills the width', () => {
    expect(dockLeft(work, { x: 40, y: 0, w: 1840, h: 1032 }, 960, 140)).toBe(960 - 70);
  });

  it('centres under her seat with no box, kept inside the work area', () => {
    expect(dockLeft(work, null, 960, 140)).toBe(890);
    expect(dockLeft(work, null, 10, 140)).toBe(DOCK_SIDE_GAP);
    expect(dockLeft(work, null, 1915, 140)).toBe(1920 - 140 - DOCK_SIDE_GAP);
  });

  it('follows a work area that does not start at 0 (a left taskbar)', () => {
    const left = { x: 64, y: 0, w: 1856, h: 1080 };
    expect(dockLeft(left, { x: 100, y: 400, w: 1700, h: 680 }, 950, 140)).toBe(950 - 70);
  });
});

describe('dockBottom', () => {
  it('stays above the taskbar', () => {
    expect(dockBottom(work)).toBe(1032 - DOCK_BOTTOM_GAP);
    expect(dockBottom({ x: 0, y: 25, w: 1440, h: 875 })).toBe(900 - DOCK_BOTTOM_GAP);
  });
});
