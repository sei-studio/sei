/**
 * Stroke humanization (260727) — turns the model's sparse polylines into
 * strokes that read as a hand rather than a plotter.
 *
 * The model emits a `pen` call with a handful of control points. Replaying
 * those directly looks like vector clip art: dead-straight runs, perfectly
 * closed shapes, uniform speed. This module applies the same five things a
 * real pen does, then hands back playback timing:
 *
 *   1. resample   spline (or line) through the control points at a fixed
 *                 spacing, so wobble has somewhere to live and playback can
 *                 advance evenly along the path;
 *   2. wobble     offset each point along its own normal by smooth low
 *                 frequency noise, so the line drifts instead of jittering;
 *   3. overshoot  run a few px past the end along the tangent, and start a
 *                 hair short, because hands do not stop on the mark;
 *   4. settle     a sub-degree rotation and a couple of px of translation per
 *                 stroke, so nothing lines up perfectly with anything else;
 *   5. timing     duration from path length at a jittered human pen speed,
 *                 plus a pen-up pause before the stroke that is occasionally
 *                 a long "what next" think.
 *
 * Everything is driven by a PRNG seeded from the stroke id, so a given stroke
 * humanizes identically every time. That matters because the strokes are
 * stored and re-rendered later in the gallery and in the exported PNG: a
 * non-deterministic wobble would redraw the picture differently than the
 * player watched it appear.
 */

import type { DrawPoint, DrawStroke } from '../../shared/drawIpc';
import { CANVAS_H, CANVAS_W } from '../../shared/drawIpc';

/** Spacing between resampled points, in canvas units. */
const RESAMPLE_PX = 4;
/** Peak normal offset applied by the wobble, in canvas units. */
const WOBBLE_AMP = 2.2;
/**
 * Canvas units per unit of noise input. The wobble is driven by ARC LENGTH,
 * not by point index, so its wavelength is a fixed physical size (~130px for
 * the slow term, ~57px for the ripple) no matter how long the stroke is.
 *
 * Indexing by position used to make the frequency depend on stroke length:
 * every stroke got the same ~2.6 cycles, so a 900px outline bowed gently while
 * a 30px detail buzzed. Arc length gives a long stroke several gentle waves and
 * a short one a fraction of a wave, which is what a hand actually does.
 */
const WOBBLE_SCALE_MAX_PX = 55;
/**
 * Floor on that scale, so a SHORT stroke still completes most of a bow instead
 * of receiving a fraction of a wave, which is a uniform sideways offset (the
 * line stays straight, it just sits slightly off). Growing the wavelength with
 * length but clamping both ends gives a short stroke roughly one gentle bow and
 * a long one several slow waves, which is how a hand behaves.
 */
const WOBBLE_SCALE_MIN_PX = 18;
/**
 * Distance over which the wobble ramps to full amplitude at each end, itself
 * capped to a share of the stroke so a short one is not entirely ramp.
 */
const TAPER_PX = 24;
const TAPER_MAX_SHARE = 0.35;
/**
 * The end taper never reaches zero. Tapering to 0 put both endpoints exactly on
 * the ideal path, and a short stroke is nearly all "end", so small details and
 * stick limbs came out ruler-straight next to wobbly outlines. A weak baseline
 * everywhere reads better than a perfect line anywhere.
 */
const TAPER_FLOOR = 0.35;
/** Nominal doodling pen speed, canvas units per second. */
const PEN_SPEED = 620;

export interface HumanizedStroke {
  stroke: DrawStroke;
  /** Pen-up pause to hold before this stroke starts. */
  delayBeforeMs: number;
  /** How long the stroke itself should take to draw. */
  durationMs: number;
}

/** mulberry32 — small, fast, good enough, and seedable from a string. */
function makeRng(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dist(a: DrawPoint, b: DrawPoint): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Drop consecutive duplicates, which break tangent maths downstream. */
function dedupe(points: DrawPoint[]): DrawPoint[] {
  const out: DrawPoint[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || dist(last, p) > 0.01) out.push(p);
  }
  return out;
}

/** Catmull-Rom interpolation at t in [0,1] between p1 and p2. */
function catmullRom(
  p0: DrawPoint,
  p1: DrawPoint,
  p2: DrawPoint,
  p3: DrawPoint,
  t: number,
): DrawPoint {
  const t2 = t * t;
  const t3 = t2 * t;
  return {
    x:
      0.5 *
      (2 * p1.x +
        (-p0.x + p2.x) * t +
        (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
        (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    y:
      0.5 *
      (2 * p1.y +
        (-p0.y + p2.y) * t +
        (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
        (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
  };
}

/**
 * Densify the control points to ~RESAMPLE_PX spacing. `smooth` curves through
 * them with Catmull-Rom (the model uses few points for round things, and
 * straight chords between them read as a polygon); `straight` keeps the
 * corners the model asked for and only subdivides.
 */
function resample(points: DrawPoint[], smooth: boolean): DrawPoint[] {
  if (points.length < 2) return points;
  const out: DrawPoint[] = [];

  if (!smooth) {
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      const steps = Math.max(1, Math.round(dist(a, b) / RESAMPLE_PX));
      for (let s = 0; s < steps; s++) {
        const t = s / steps;
        out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      }
    }
    out.push(points[points.length - 1]);
    return out;
  }

  // Pad the ends so the spline reaches the true first and last points.
  const p = [points[0], ...points, points[points.length - 1]];
  for (let i = 1; i < p.length - 2; i++) {
    const seg = dist(p[i], p[i + 1]);
    const steps = Math.max(1, Math.round(seg / RESAMPLE_PX));
    for (let s = 0; s < steps; s++) {
      out.push(catmullRom(p[i - 1], p[i], p[i + 1], p[i + 2], s / steps));
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

/**
 * Smooth pseudo-noise in [-1,1]: two incommensurable sines so the offset
 * drifts along the stroke instead of buzzing. A per-stroke phase keeps two
 * similar strokes from wobbling identically.
 */
function noiseAt(u: number, phaseA: number, phaseB: number): number {
  return 0.65 * Math.sin(u * 2.7 + phaseA) + 0.35 * Math.sin(u * 6.1 + phaseB);
}

function clampToCanvas(p: DrawPoint): DrawPoint {
  return {
    x: Math.max(0, Math.min(CANVAS_W, p.x)),
    y: Math.max(0, Math.min(CANVAS_H, p.y)),
  };
}

/**
 * Humanize one model stroke. Returns null when the input cannot make a line
 * (fewer than two distinct points), which the caller skips.
 */
export function humanizeStroke(
  id: string,
  rawPoints: DrawPoint[],
  opts: { smooth: boolean; closed: boolean },
): HumanizedStroke | null {
  const control = dedupe(rawPoints.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));
  if (control.length < 2) return null;

  const rng = makeRng(id);

  // A closed shape returns to its start, but with a small gap or overlap
  // rather than a seamless join.
  if (opts.closed) {
    const first = control[0];
    control.push({ x: first.x + (rng() - 0.5) * 6, y: first.y + (rng() - 0.5) * 6 });
  }

  const dense = resample(control, opts.smooth);
  if (dense.length < 2) return null;

  // Per-stroke character: noise phases, a sub-degree tilt, a small offset.
  const phaseA = rng() * Math.PI * 2;
  const phaseB = rng() * Math.PI * 2;
  const amp = WOBBLE_AMP * (0.7 + rng() * 0.6);
  const tilt = (rng() - 0.5) * 0.017; // about +/- 0.5 degrees
  const shiftX = (rng() - 0.5) * 4;
  const shiftY = (rng() - 0.5) * 4;

  // Rotate about the stroke's own centre so the tilt does not translate it.
  let cx = 0;
  let cy = 0;
  for (const p of dense) {
    cx += p.x;
    cy += p.y;
  }
  cx /= dense.length;
  cy /= dense.length;
  const cos = Math.cos(tilt);
  const sin = Math.sin(tilt);

  // Cumulative arc length: both the wobble frequency and the end taper are
  // measured in canvas units, so neither depends on how many points the model
  // happened to send.
  const arc: number[] = new Array(dense.length);
  arc[0] = 0;
  for (let i = 1; i < dense.length; i++) arc[i] = arc[i - 1] + dist(dense[i - 1], dense[i]);
  const total = arc[arc.length - 1];
  const scale = Math.max(WOBBLE_SCALE_MIN_PX, Math.min(WOBBLE_SCALE_MAX_PX, total * 0.7));
  const taperLen = Math.min(TAPER_PX, total * TAPER_MAX_SHARE);

  const wobbled: DrawPoint[] = dense.map((p, i) => {
    // Tangent from neighbours, so the offset is perpendicular to travel.
    const prev = dense[Math.max(0, i - 1)];
    const next = dense[Math.min(dense.length - 1, i + 1)];
    const tx = next.x - prev.x;
    const ty = next.y - prev.y;
    const len = Math.hypot(tx, ty) || 1;
    // Normal is the tangent turned 90 degrees.
    const nx = -ty / len;
    const ny = tx / len;

    const u = arc[i] / scale;
    // Taper the wobble at both ends: a pen is steadiest where it lands. The
    // taper floors above zero so no run is ever perfectly straight.
    const fromEnd = Math.min(arc[i], total - arc[i]);
    const taper = taperLen > 0 ? Math.min(1, fromEnd / taperLen) : 1;
    const ends = TAPER_FLOOR + (1 - TAPER_FLOOR) * taper;
    const off = noiseAt(u, phaseA, phaseB) * amp * ends;

    const wx = p.x + nx * off;
    const wy = p.y + ny * off;

    const rx = cx + (wx - cx) * cos - (wy - cy) * sin + shiftX;
    const ry = cy + (wx - cx) * sin + (wy - cy) * cos + shiftY;
    return clampToCanvas({ x: rx, y: ry });
  });

  // Overshoot: carry a little past the last point along the final tangent.
  const n = wobbled.length;
  if (n >= 2) {
    const a = wobbled[n - 2];
    const b = wobbled[n - 1];
    const len = dist(a, b) || 1;
    const over = 1.5 + rng() * 3.5;
    wobbled.push(
      clampToCanvas({
        x: b.x + ((b.x - a.x) / len) * over,
        y: b.y + ((b.y - a.y) / len) * over,
      }),
    );
  }

  // Timing from the final path length at a jittered pen speed.
  let pathLen = 0;
  for (let i = 1; i < wobbled.length; i++) pathLen += dist(wobbled[i - 1], wobbled[i]);
  const speed = PEN_SPEED * (0.8 + rng() * 0.45);
  const durationMs = Math.round(Math.max(160, Math.min(2800, (pathLen / speed) * 1000)));

  // Pen-up pause. Usually a quick reposition; sometimes a real pause to think
  // about what goes next, which is what sells it as a person drawing.
  const think = rng() < 0.16;
  const delayBeforeMs = think
    ? Math.round(600 + rng() * 900)
    : Math.round(130 + rng() * 300);

  return { stroke: { id, points: wobbled }, delayBeforeMs, durationMs };
}
