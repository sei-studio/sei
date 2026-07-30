/**
 * A traced doodle, drawn with the surface's pen.
 *
 * The drawings on the start page are shown at deliberately different sizes (the
 * crown small, the shrimp and horse large), and that is precisely what a bitmap
 * cannot do here: scaling a raster scales its line weight with it, so three
 * images at three sizes arrive with three different pen widths on a page whose
 * whole premise is that every line came off one pen.
 *
 * So they are not images. `doodles.ts` holds their CENTRELINES (see
 * scripts/trace-doodles.py), which carry no thickness at all, and
 * `vector-effect: non-scaling-stroke` makes `stroke-width` mean screen pixels
 * rather than user-space units. The geometry scales, the stroke does not, and
 * the width is `--hand-stroke` like the frames, the rules and the canvas pen.
 */

import React from 'react';
import type { Doodle as DoodleData } from './doodles';
import { makeRng } from './squigglePath';
import styles from './draw.module.css';

export interface DoodleProps {
  doodle: DoodleData;
  /** Described for a screen reader; the drawing itself is decorative. */
  label: string;
  /** Fill the drawing with a rough crayon wash in this colour. */
  wash?: string;
  className?: string;
}

function toPath(points: number[][]): string {
  return `M ${points.map(([x, y]) => `${x},${y}`).join(' L ')}`;
}

/**
 * A rough block of colour in the SHAPE of the drawing.
 *
 * The traced paths are centrelines, not closed regions, so there is nothing to
 * hand to `fill` directly: a crown is a dozen open strokes, and filling them
 * gives slivers. So the silhouette is recovered as a RADIAL HULL. Rays go out
 * from the ink's centroid, each one keeping the farthest ink it hits, which for
 * a star-shaped drawing (a crown is exactly that) traces the outline including
 * the spikes and the valleys between them.
 *
 * Coarse on purpose: few rays, smoothed, then pushed outward past the ink by a
 * jittered margin. A colouring-in that stopped exactly on every line would read
 * as a printed fill, and the one thing this page is not is printed.
 */
function roughWash(doodle: DoodleData, seed: string): string {
  if (doodle.paths.length === 0) return '';

  // Walk the segments, not the vertices. Simplification left the long straight
  // runs with a vertex only at each end, so the crown's whole base is two
  // points: sampling vertices alone leaves every ray along it empty, and the
  // colour cuts the corner off the drawing it is meant to be filling.
  const step = Math.max(doodle.width, doodle.height) / 200;
  const pts: number[][] = [];
  for (const path of doodle.paths) {
    for (let i = 0; i < path.length; i++) {
      pts.push(path[i]);
      const next = path[i + 1];
      if (!next) continue;
      const [x1, y1] = path[i];
      const [x2, y2] = next;
      const n = Math.floor(Math.hypot(x2 - x1, y2 - y1) / step);
      for (let k = 1; k < n; k++) {
        pts.push([x1 + ((x2 - x1) * k) / n, y1 + ((y2 - y1) * k) / n]);
      }
    }
  }
  if (pts.length < 3) return '';

  let cx = 0;
  let cy = 0;
  for (const [x, y] of pts) {
    cx += x;
    cy += y;
  }
  cx /= pts.length;
  cy /= pts.length;

  // One radius per angular bucket: the farthest ink along that ray.
  const RAYS = 36;
  const reach = new Array<number>(RAYS).fill(0);
  for (const [x, y] of pts) {
    const a = Math.atan2(y - cy, x - cx);
    const bin = Math.floor(((a + Math.PI) / (Math.PI * 2)) * RAYS) % RAYS;
    const r = Math.hypot(x - cx, y - cy);
    if (r > reach[bin]) reach[bin] = r;
  }
  // A bucket with no ink in it borrows from its neighbours rather than
  // collapsing the outline to the centre.
  for (let i = 0; i < RAYS; i++) {
    if (reach[i] > 0) continue;
    reach[i] = (reach[(i + RAYS - 1) % RAYS] + reach[(i + 1) % RAYS]) / 2;
  }
  // Smooth, but never below the raw reach: plain smoothing pulls the corners
  // of a wide drawing in far enough to leave its own base sticking out of the
  // colour, which reads as a mistake rather than as roughness. So the pass only
  // ever fills the dips between rays.
  const smooth = reach.map((r, i) =>
    Math.max(r, (reach[(i + RAYS - 1) % RAYS] + r * 4 + reach[(i + 1) % RAYS]) / 6),
  );

  // The roughness is two slow waves rather than per-ray randomness: independent
  // jitter on neighbouring rays reads as a saw blade, and worse, can pull the
  // colour back INSIDE the drawing. Every ray ends up outside the ink.
  const rng = makeRng(seed);
  const phase = rng() * Math.PI * 2;
  const pad = Math.min(doodle.width, doodle.height) * 0.05;
  const out: string[] = [];
  for (let i = 0; i <= RAYS; i++) {
    const a = ((i % RAYS) / RAYS) * Math.PI * 2 - Math.PI;
    const wob = Math.sin(a * 3 + phase) * 0.6 + Math.sin(a * 7 + phase * 2) * 0.4;
    const r = smooth[i % RAYS] + pad * (0.9 + wob * 0.6);
    out.push(`${(cx + Math.cos(a) * r).toFixed(1)},${(cy + Math.sin(a) * r).toFixed(1)}`);
  }
  return `M ${out.join(' L ')} Z`;
}

export function Doodle({ doodle, label, wash, className }: DoodleProps): React.ReactElement {
  const d = doodle.paths.map(toPath).join(' ');
  const washPath = wash ? roughWash(doodle, label) : '';
  return (
    <svg
      className={className ? `${styles.doodle} ${className}` : styles.doodle}
      viewBox={`0 0 ${doodle.width} ${doodle.height}`}
      role="img"
      aria-label={label}
      // The traced strokes stop exactly at the ink, so a little padding keeps
      // the outermost line from being clipped by the viewBox edge once the
      // stroke width is added around it.
      style={{ overflow: 'visible' }}
    >
      {washPath ? <path d={washPath} fill={wash} stroke="none" /> : null}
      <path
        d={d}
        className={styles.doodlePath}
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
