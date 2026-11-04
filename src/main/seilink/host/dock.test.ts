import { describe, expect, it } from 'vitest';
import { pressTarget, toPagePoint, unionBox } from './dock';

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

  it('converts native press points to page px', () => {
    // Windows: physical px on a 150% display.
    expect(toPagePoint({ x: 1500, y: 750 }, { bounds: { x: 0, y: 0 }, scaleFactor: 1.5 }, 'physical')).toEqual({ x: 1000, y: 500 });
    // mac: global top-left points, display not at the origin.
    expect(toPagePoint({ x: 1100, y: 520 }, { bounds: { x: 100, y: 20 }, scaleFactor: 2 }, 'points')).toEqual({ x: 1000, y: 500 });
  });
});
