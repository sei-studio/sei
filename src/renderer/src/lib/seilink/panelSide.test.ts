import { describe, expect, it } from 'vitest';
import type { PlacementRegions } from '@shared/seilinkPlace';
import { placementPanelSide } from './panelSide';

const top = (x0: number, x1: number): PlacementRegions['surfaces'][number] =>
  ({
    kind: 'area',
    face: [
      [x0, 100],
      [x1, 100],
      [x1, 120],
      [x0, 120],
    ],
  }) as unknown as PlacementRegions['surfaces'][number];
const regions = (surfaces: PlacementRegions['surfaces']): PlacementRegions =>
  ({ canvas: [1280, 720], labelled: true, perspective: true, floor: [], floorBlocks: [], wall: [], wallBlocks: [], surfaces, floorTop: 0, floorFront: 0, horizon: 0 }) as PlacementRegions;
const vp = { scale: 1, left: 0, top: 0, width: 1280, height: 720 };
const none = { items: [] };

describe('placementPanelSide (261110: shelves hidden behind the panel)', () => {
  it('moves the panel right when the wall shelves are on the left', () => {
    expect(placementPanelSide(regions([top(0, 260), top(0, 260), top(700, 900)]), none, vp, 1280, 420)).toBe('right');
  });
  it('stays left when the tops are on the right or in the middle, and on a tie', () => {
    expect(placementPanelSide(regions([top(950, 1200)]), none, vp, 1280, 420)).toBe('left');
    expect(placementPanelSide(regions([top(500, 800)]), none, vp, 1280, 420)).toBe('left');
    expect(placementPanelSide(regions([top(0, 200), top(1000, 1200)]), none, vp, 1280, 420)).toBe('left');
  });
  it('counts the items already out, and stays left on a narrow window', () => {
    const items = { items: [{ id: 'a', x: 100, y: 500 }, { id: 'b', x: 120, y: 500 }, { id: 'c', x: 140, y: 500 }] } as never;
    expect(placementPanelSide(regions([top(1000, 1200)]), items, vp, 1280, 420)).toBe('right');
    expect(placementPanelSide(regions([top(0, 260)]), none, vp, 700, 420)).toBe('left');
  });
});
