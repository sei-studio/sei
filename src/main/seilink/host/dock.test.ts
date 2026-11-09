import { describe, expect, it } from 'vitest';
import {
  DOCK_HOVER_PX,
  dockHover,
  dragSlopPhysical,
  HER_SLOP_PX,
  hitAreas,
  isNearMiss,
  NEAR_MISS_PX,
  pressTarget,
  toPagePoint,
  unionBox,
} from './dock';

describe('seilink dock geometry (M4)', () => {
  const her = { x: 1000, y: 400, w: 300, h: 600 };
  const dock = [
    { id: 'edit' as const, x: 1060, y: 960, w: 36, h: 36 },
    { id: 'deafen' as const, x: 1102, y: 960, w: 36, h: 36 },
    { id: 'moveout' as const, x: 1144, y: 960, w: 36, h: 36 },
  ];

  it('unions her box and the dock into one click area', () => {
    expect(unionBox([her, ...dock])).toEqual(her);
    expect(unionBox([her, { x: 900, y: 1010, w: 40, h: 40 }])).toEqual({ x: 900, y: 400, w: 400, h: 650 });
    expect(unionBox([null, undefined])).toBeNull();
    expect(unionBox([{ x: 0, y: 0, w: 0, h: 10 }])).toBeNull();
  });

  it('routes a press: dock buttons first, then her, else nothing', () => {
    expect(pressTarget({ x: 1110, y: 970 }, her, dock)).toEqual({ kind: 'dock', id: 'deafen' });
    expect(pressTarget({ x: 1050, y: 500 }, her, dock)).toEqual({ kind: 'her' });
    expect(pressTarget({ x: 1099, y: 970 }, her, dock)).toEqual({ kind: 'her' });
    expect(pressTarget({ x: 920, y: 1020 }, her, dock)).toEqual({ kind: 'none' });
    expect(pressTarget({ x: 1050, y: 500 }, null, null)).toEqual({ kind: 'none' });
  });

  it('261110: a press just past her edge still lands on her (her box lags while she moves)', () => {
    expect(pressTarget({ x: 1000 - HER_SLOP_PX + 1, y: 500 }, her, dock, HER_SLOP_PX)).toEqual({ kind: 'her' });
    expect(pressTarget({ x: 1000 - HER_SLOP_PX - 1, y: 500 }, her, dock, HER_SLOP_PX)).toEqual({ kind: 'none' });
    // Without slop, the old exact box.
    expect(pressTarget({ x: 995, y: 500 }, her, dock)).toEqual({ kind: 'none' });
    // Dock buttons still win over her slop.
    expect(pressTarget({ x: 1110, y: 970 }, her, dock, HER_SLOP_PX)).toEqual({ kind: 'dock', id: 'deafen' });
  });

  it('261110: near misses are presses close to her but outside the slop', () => {
    expect(isNearMiss({ x: 1000 - 20, y: 500 }, her)).toBe(true);
    expect(isNearMiss({ x: 1000 - 4, y: 500 }, her)).toBe(false);
    expect(isNearMiss({ x: 1000 - NEAR_MISS_PX - 1, y: 500 }, her)).toBe(false);
    expect(isNearMiss({ x: 1100, y: 500 }, her)).toBe(false);
    expect(isNearMiss({ x: 980, y: 500 }, null)).toBe(false);
  });

  it('261110: the Windows drag slop scales with the display (raw input is physical px)', () => {
    expect(dragSlopPhysical(1)).toBe(8);
    expect(dragSlopPhysical(1.75)).toBe(14);
    expect(dragSlopPhysical(2.5)).toBe(20);
    expect(dragSlopPhysical(0)).toBe(8);
    expect(dragSlopPhysical(Number.NaN)).toBe(8);
  });

  it('261110: the dock wakes when the cursor is over it or near it', () => {
    const corner = [
      { id: 'edit' as const, x: 2400, y: 1340, w: 28, h: 28 },
      { id: 'moveout' as const, x: 2462, y: 1340, w: 28, h: 28 },
    ];
    expect(dockHover({ x: 2410, y: 1350 }, corner)).toBe(true);
    expect(dockHover({ x: 2400 - DOCK_HOVER_PX + 1, y: 1350 }, corner)).toBe(true);
    expect(dockHover({ x: 2400 - DOCK_HOVER_PX - 1, y: 1350 }, corner)).toBe(false);
    expect(dockHover(null, corner)).toBe(false);
    expect(dockHover({ x: 2410, y: 1350 }, null)).toBe(false);
  });

  it('261110: click areas, one passive rect for Windows and a tight panel each for macOS', () => {
    const corner = [{ id: 'edit' as const, x: 2400, y: 1340, w: 28, h: 28 }];
    const a = hitAreas(her, corner);
    expect(a.her).toEqual({ x: 1000 - HER_SLOP_PX, y: 400 - HER_SLOP_PX, w: 300 + 2 * HER_SLOP_PX, h: 600 + 2 * HER_SLOP_PX });
    expect(a.dock).toEqual({ x: 2400, y: 1340, w: 28, h: 28 });
    expect(a.one).toEqual({ x: 1000 - NEAR_MISS_PX, y: 400 - NEAR_MISS_PX, w: 2428 - (1000 - NEAR_MISS_PX), h: 1368 - (400 - NEAR_MISS_PX) });
    // She walked out of the frame: the dock still takes presses.
    expect(hitAreas(null, corner)).toEqual({ one: { x: 2400, y: 1340, w: 28, h: 28 }, her: null, dock: { x: 2400, y: 1340, w: 28, h: 28 } });
    expect(hitAreas(null, null)).toEqual({ one: null, her: null, dock: null });
  });

  it('converts native press points to page px', () => {
    // Windows: physical px on a 150% display.
    expect(toPagePoint({ x: 1500, y: 750 }, { bounds: { x: 0, y: 0 }, scaleFactor: 1.5 }, 'physical')).toEqual({ x: 1000, y: 500 });
    // mac: global top-left points, display not at the origin.
    expect(toPagePoint({ x: 1100, y: 520 }, { bounds: { x: 100, y: 20 }, scaleFactor: 2 }, 'points')).toEqual({ x: 1000, y: 500 });
  });
});
