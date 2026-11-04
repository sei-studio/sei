/**
 * Where a dragged item can go (261105, physics-aware placement): a faint
 * highlight over the room for the item's class, drawn only while dragging.
 *  - floor: the real floor, minus what the parts cover (bed, lamp, chair);
 *  - surface: each top (a plank's whole top face, a bed top) as a soft
 *    band, the one the item is on brighter with a soft glow round it (261105
 *    shelf pass: the band, not a line), legacy lines as a soft stroke; with
 *    no surface left in the room it shows the floor the item falls to;
 *  - wall: the bare wall, minus the window and the parts on it.
 * Canvas px in, laid over the room with the same viewport as RoomCanvas.
 * Nothing heavy: white at low alpha, no outlines, it fades in.
 */
import React, { useId } from 'react';
import type { RoomViewport } from '@shared/seilinkDraw';
import type { PlacementClass, PlacementRegions } from '@shared/seilinkPlace';
import type { RoomPolygon } from '@shared/seilinkRoom';
import styles from './RoomEditor.module.css';

const pts = (p: RoomPolygon): string => p.map(([x, y]) => `${x},${y}`).join(' ');

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
      className={styles.guide}
      style={{ left: vp.left, top: vp.top, width: w * vp.scale, height: h * vp.scale }}
      viewBox={`0 0 ${w} ${h}`}
      aria-hidden="true"
      data-placement-guide={cls}
    >
      {showArea && (
        <>
          <defs>
            <mask id={`${id}m`} maskUnits="userSpaceOnUse" x="0" y="0" width={w} height={h}>
              {areas.map((p, i) => (
                <polygon key={i} points={pts(p)} fill="#fff" />
              ))}
              {blocks.map((p, i) => (
                <polygon key={`b${i}`} points={pts(p)} fill="#000" />
              ))}
            </mask>
          </defs>
          <rect x="0" y="0" width={w} height={h} fill="rgb(255 255 255 / 0.2)" mask={`url(#${id}m)`} />
        </>
      )}
      {cls === 'surface' && regions.surfaces[surface]?.kind === 'area' && (
        <>
          <defs>
            <filter id={`${id}g`} x="-20%" y="-200%" width="140%" height="500%">
              <feGaussianBlur stdDeviation={5 * px} />
            </filter>
          </defs>
          <polygon
            points={pts((regions.surfaces[surface] as { face: RoomPolygon }).face)}
            fill="rgb(255 255 255 / 0.18)"
            stroke="rgb(255 255 255 / 0.55)"
            strokeWidth={6 * px}
            strokeLinejoin="round"
            filter={`url(#${id}g)`}
            data-guide-glow=""
          />
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
              stroke={i === surface ? 'rgb(255 255 255 / 0.85)' : 'rgb(255 255 255 / 0.45)'}
              strokeWidth={(i === surface ? 5 : 4) * px}
              strokeLinecap="round"
            />
          ) : (
            <polygon
              key={i}
              points={pts(s.face)}
              fill={i === surface ? 'rgb(255 255 255 / 0.3)' : 'rgb(255 255 255 / 0.2)'}
              stroke={i === surface ? 'rgb(255 255 255 / 0.7)' : 'none'}
              strokeWidth={1.5 * px}
              strokeLinejoin="round"
              data-guide-band={i === surface ? 'on' : ''}
            />
          ),
        )}
    </svg>
  );
}
