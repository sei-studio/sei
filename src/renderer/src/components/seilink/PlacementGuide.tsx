/**
 * Where a dragged item can go (261105, physics-aware placement), drawn only
 * while dragging, over the room as it is (nothing else is dimmed or blurred).
 *  - floor: the real floor, minus what the parts cover (bed, lamp, chair);
 *  - surface: each top (a plank's whole top face, a bed top), the one the
 *    item is on brighter; legacy lines as a stroke; with no surface left in
 *    the room it shows the floor the item falls to;
 *  - wall: the bare wall, minus the window and the parts on it.
 *
 * 261110 (product call 261110): outlines, not a haze. Until then the svg
 * shared the `.guide` class with the editor's glass panels, so a drag put a
 * frosted blur over the whole room. Now each placeable area is outlined (a
 * crisp light line with a soft dark edge, so it reads on light and dark
 * rooms) over a very light fill; the parts cut out of an area get the same
 * line, so the outline follows the space that is really free.
 * Canvas px in, laid over the room with the same viewport as RoomCanvas.
 */
import React, { useId } from 'react';
import type { RoomViewport } from '@shared/seilinkDraw';
import type { PlacementClass, PlacementRegions } from '@shared/seilinkPlace';
import type { RoomPolygon } from '@shared/seilinkRoom';
import styles from './RoomEditor.module.css';

const pts = (p: RoomPolygon): string => p.map(([x, y]) => `${x},${y}`).join(' ');

/** Outline and fill colours (white over the room; the dark edge comes from the svg's drop shadow). */
const LINE = 'rgb(255 255 255 / 0.95)';
const LINE_SOFT = 'rgb(255 255 255 / 0.82)';
const FILL = 'rgb(255 255 255 / 0.16)';
const FILL_ON = 'rgb(255 255 255 / 0.36)';

export function PlacementGuide({
  regions,
  cls,
  surface,
  vp,
  canvas,
}: {
  regions: PlacementRegions;
  cls: PlacementClass;
  /** The surface the dragged item rests on (index into regions.surfaces), or -1. */
  surface: number;
  vp: RoomViewport;
  canvas: [number, number];
}): React.ReactElement | null {
  const id = useId().replace(/:/g, '');
  if (!vp.scale) return null;
  const [w, h] = canvas;
  // Strokes are sized in screen px, whatever the room's scale.
  const px = 1 / vp.scale;
  const showArea = cls !== 'surface' || (!regions.surfaces.length && regions.labelled);
  const areas = cls === 'wall' ? regions.wall : regions.floor;
  const blocks = cls === 'wall' ? regions.wallBlocks : regions.floorBlocks;
  return (
    <svg
      className={styles.placeGuide}
      style={{ left: vp.left, top: vp.top, width: w * vp.scale, height: h * vp.scale }}
      viewBox={`0 0 ${w} ${h}`}
      aria-hidden="true"
      data-placement-guide={cls}
      data-guide-mode="outline"
    >
      {showArea && (
        <>
          <defs>
            {/* Free space: the areas minus the parts standing in them. */}
            <mask id={`${id}free`} maskUnits="userSpaceOnUse" x="0" y="0" width={w} height={h}>
              {areas.map((p, i) => (
                <polygon key={i} points={pts(p)} fill="#fff" />
              ))}
              {blocks.map((p, i) => (
                <polygon key={`b${i}`} points={pts(p)} fill="#000" />
              ))}
            </mask>
            {/* Inside the areas (a part's outline is drawn only where it cuts into one). */}
            <mask id={`${id}in`} maskUnits="userSpaceOnUse" x="0" y="0" width={w} height={h}>
              {areas.map((p, i) => (
                <polygon key={i} points={pts(p)} fill="#fff" />
              ))}
            </mask>
            {/* Outside the parts (an area's own edge is not drawn across a part). */}
            <mask id={`${id}out`} maskUnits="userSpaceOnUse" x="0" y="0" width={w} height={h}>
              <rect x="0" y="0" width={w} height={h} fill="#fff" />
              {blocks.map((p, i) => (
                <polygon key={`b${i}`} points={pts(p)} fill="#000" />
              ))}
            </mask>
          </defs>
          <rect x="0" y="0" width={w} height={h} fill={FILL} mask={`url(#${id}free)`} />
          <g mask={`url(#${id}out)`} data-guide-outline="area">
            {areas.map((p, i) => (
              <polygon key={i} points={pts(p)} fill="none" stroke={LINE} strokeWidth={2.5 * px} strokeDasharray={`${8 * px} ${6 * px}`} strokeLinejoin="round" />
            ))}
          </g>
          <g mask={`url(#${id}in)`} data-guide-outline="blocks">
            {blocks.map((p, i) => (
              <polygon key={i} points={pts(p)} fill="none" stroke={LINE} strokeWidth={2.5 * px} strokeDasharray={`${8 * px} ${6 * px}`} strokeLinejoin="round" />
            ))}
          </g>
        </>
      )}
      {cls === 'surface' &&
        regions.surfaces.map((s, i) =>
          s.kind === 'line' ? (
            <line
              key={i}
              x1={s.seg[0]}
              y1={s.seg[1]}
              x2={s.seg[2]}
              y2={s.seg[3]}
              stroke={i === surface ? LINE : LINE_SOFT}
              strokeWidth={(i === surface ? 4 : 3) * px}
              strokeLinecap="round"
            />
          ) : (
            <polygon
              key={i}
              points={pts(s.face)}
              fill={i === surface ? FILL_ON : FILL}
              stroke={i === surface ? LINE : LINE_SOFT}
              strokeWidth={(i === surface ? 3 : 2.5) * px}
              strokeDasharray={i === surface ? undefined : `${8 * px} ${6 * px}`}
              strokeLinejoin="round"
              data-guide-band={i === surface ? 'on' : ''}
            />
          ),
        )}
    </svg>
  );
}
