import { describe, expect, it } from 'vitest';
import { DOCK_BOTTOM_GAP, DOCK_SIDE_GAP, dockAwake, dockBottom, dockCorner } from './dockPlace';

const work = { x: 0, y: 0, w: 1920, h: 1032 };

describe('dockCorner (261110: the bottom-right corner, never beside her)', () => {
  it('sits in the bottom-right corner of the work area', () => {
    expect(dockCorner(work, 1920)).toEqual({ right: DOCK_SIDE_GAP, bottom: 1032 - DOCK_BOTTOM_GAP });
  });

  it('stays inside a work area that does not reach the page edge (a taskbar on the right)', () => {
    expect(dockCorner({ x: 0, y: 0, w: 1860, h: 1080 }, 1920)).toEqual({ right: 60 + DOCK_SIDE_GAP, bottom: 1080 - DOCK_BOTTOM_GAP });
    // Taskbar on the left or top: only the right and bottom edges matter.
    expect(dockCorner({ x: 60, y: 25, w: 1860, h: 1055 }, 1920)).toEqual({ right: DOCK_SIDE_GAP, bottom: 1080 - DOCK_BOTTOM_GAP });
  });

  it('does not depend on where she is (the old dock followed her sway)', () => {
    const a = dockCorner(work, 1920);
    expect(dockCorner(work, 1920)).toEqual(a);
    expect(Object.keys(a).sort()).toEqual(['bottom', 'right']);
  });

  it('falls back to the work area when the page width is unknown', () => {
    expect(dockCorner(work, 0)).toEqual({ right: DOCK_SIDE_GAP, bottom: 1032 - DOCK_BOTTOM_GAP });
    expect(dockBottom({ x: 0, y: 25, w: 1440, h: 875 })).toBe(900 - DOCK_BOTTOM_GAP);
  });
});

describe('dockAwake', () => {
  const rest = { hover: false, confirming: false, caption: false, offer: false, pressed: false };
  it('is faint at rest and wakes for the cursor, a question, a caption, the offer or a press', () => {
    expect(dockAwake(rest)).toBe(false);
    for (const k of Object.keys(rest) as Array<keyof typeof rest>) expect(dockAwake({ ...rest, [k]: true }), k).toBe(true);
  });
});
