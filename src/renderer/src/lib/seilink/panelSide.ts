/**
 * Which side the editor's panel goes on (261110, product call 261110): the
 * items panel sits over the left of the room, where a room's wall shelves
 * often are, so the tops an extra goes on were hidden behind it. While items
 * are being placed the panel moves to the right when the left would cover
 * more of the tops (and the items already out) than the right.
 */
import type { RoomViewport } from '@shared/seilinkDraw';
import type { PlacementRegions } from '@shared/seilinkPlace';
import type { RoomPolygon, RoomState } from '@shared/seilinkRoom';

export type PanelSide = 'left' | 'right';

/** Screen-x span of a canvas polygon. */
function span(p: RoomPolygon, vp: RoomViewport): [number, number] {
  let a = Infinity;
  let b = -Infinity;
  for (const [x] of p) {
    const sx = vp.left + x * vp.scale;
    a = Math.min(a, sx);
    b = Math.max(b, sx);
  }
  return [a, b];
}

/** Share (0..1) of [a, b] inside [lo, hi]; a point counts as 0 or 1. */
function share([a, b]: [number, number], lo: number, hi: number): number {
  if (b - a < 1) return a >= lo && a <= hi ? 1 : 0;
  return Math.max(0, Math.min(b, hi) - Math.max(a, lo)) / (b - a);
}

/**
 * `zone`: the panel's width from the screen edge (CSS px, with its inset).
 * Tops count fully; items already in the room count half. Ties stay left.
 */
export function placementPanelSide(regions: PlacementRegions, state: Pick<RoomState, 'items'>, vp: RoomViewport, stageW: number, zone: number): PanelSide {
  if (!vp.scale || stageW < zone * 2) return 'left';
  const spans: Array<[[number, number], number]> = [];
  for (const s of regions.surfaces) {
    if (s.kind === 'area') spans.push([span(s.face, vp), 1]);
    else
      spans.push([
        span(
          [
            [s.seg[0], s.seg[1]],
            [s.seg[2], s.seg[3]],
          ],
          vp,
        ),
        1,
      ]);
  }
  for (const it of state.items) {
    const x = vp.left + it.x * vp.scale;
    spans.push([[x, x], 0.5]);
  }
  let left = 0;
  let right = 0;
  for (const [sp, w] of spans) {
    left += w * share(sp, 0, zone);
    right += w * share(sp, stageW - zone, stageW);
  }
  return right < left ? 'right' : 'left';
}
