/**
 * Canvas rendering primitives for Draw!.
 *
 * Pure functions over stroke data, shared by the three places pixels are
 * produced: the live canvas, the snapshot sent to the character, and the
 * gallery PNG. Keeping one painter means the picture the player watched
 * appear, the picture the character guessed at, and the picture saved to the
 * Desktop are all the same picture.
 *
 * Everything works in the logical CANVAS_W x CANVAS_H space; callers scale.
 */

import { CANVAS_H, CANVAS_W, type DrawPoint, type DrawStroke } from '@shared/drawIpc';

/** The one and only pen width, in logical units. */
export const LINE_WIDTH = 4;

export interface PartialStroke {
  points: DrawPoint[];
  /**
   * How many points of `points` to draw, fractional. Used for the character's
   * stroke-by-stroke playback so a stroke grows from its start rather than
   * appearing whole.
   */
  upto: number;
}

function tracePath(ctx: CanvasRenderingContext2D, points: DrawPoint[]): void {
  if (points.length === 0) return;
  ctx.moveTo(points[0].x, points[0].y);
  if (points.length === 1) {
    // A tap: a dot, drawn as a zero-length segment with a round cap.
    ctx.lineTo(points[0].x + 0.01, points[0].y);
    return;
  }
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
}

/** Points of a partially-drawn stroke, with the final point interpolated. */
export function partialPoints(points: DrawPoint[], upto: number): DrawPoint[] {
  const whole = Math.floor(upto);
  if (whole >= points.length - 1) return points;
  if (whole < 1) return points.slice(0, 1);
  const head = points.slice(0, whole + 1);
  const t = upto - whole;
  const a = points[whole];
  const b = points[whole + 1];
  if (a && b && t > 0) head.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  return head;
}

export interface PaintOpts {
  /** Fill the background before painting. Omit to paint over what is there. */
  background?: string;
  /** Scale from logical space to the target context. Default 1. */
  scale?: number;
  lineWidth?: number;
  partial?: PartialStroke | null;
}

/** Paint a whole picture. The context is left with its transform restored. */
export function paintStrokes(
  ctx: CanvasRenderingContext2D,
  strokes: DrawStroke[],
  opts: PaintOpts = {},
): void {
  const scale = opts.scale ?? 1;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (opts.background) {
    ctx.fillStyle = opts.background;
    ctx.fillRect(0, 0, CANVAS_W * scale, CANVAS_H * scale);
  }
  ctx.scale(scale, scale);
  ctx.strokeStyle = '#111111';
  ctx.lineWidth = opts.lineWidth ?? LINE_WIDTH;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // One path for every committed stroke: far fewer state changes than
  // stroking each one separately, and they are all identical in style.
  ctx.beginPath();
  for (const s of strokes) tracePath(ctx, s.points);
  ctx.stroke();

  if (opts.partial && opts.partial.points.length > 0) {
    ctx.beginPath();
    tracePath(ctx, partialPoints(opts.partial.points, opts.partial.upto));
    ctx.stroke();
  }
  ctx.restore();
}

/** Square of the distance from p to segment ab. */
function distSqToSegment(p: DrawPoint, a: DrawPoint, b: DrawPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + dx * t;
  const cy = a.y + dy * t;
  return (p.x - cx) ** 2 + (p.y - cy) ** 2;
}

/**
 * The topmost stroke within `radius` of `p`, or null. Topmost so the eraser
 * takes the stroke the player can actually see under the cursor when two
 * overlap.
 */
export function hitTestStroke(
  strokes: DrawStroke[],
  p: DrawPoint,
  radius: number,
): DrawStroke | null {
  const r2 = radius * radius;
  for (let i = strokes.length - 1; i >= 0; i--) {
    const pts = strokes[i].points;
    if (pts.length === 1) {
      if ((p.x - pts[0].x) ** 2 + (p.y - pts[0].y) ** 2 <= r2) return strokes[i];
      continue;
    }
    for (let j = 1; j < pts.length; j++) {
      if (distSqToSegment(p, pts[j - 1], pts[j]) <= r2) return strokes[i];
    }
  }
  return null;
}

/**
 * Render strokes to a standalone PNG data URL at `width` px wide (height
 * follows the canvas aspect). Used for the snapshot the character looks at and
 * for each gallery cell.
 */
export function strokesToPng(strokes: DrawStroke[], width: number): string {
  const scale = width / CANVAS_W;
  const height = Math.round(CANVAS_H * scale);
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d');
  if (!ctx) return '';
  // Line width is scaled up slightly relative to the canvas so a downscaled
  // snapshot keeps the stroke readable instead of dissolving into grey.
  paintStrokes(ctx, strokes, {
    background: '#ffffff',
    scale,
    lineWidth: Math.max(LINE_WIDTH, LINE_WIDTH / Math.max(scale, 0.35)) * scale,
  });
  return c.toDataURL('image/png');
}

/** Decimate while capturing: drop points closer than this to the previous. */
export const MIN_POINT_SPACING = 2.2;

/** Distance from the cursor within which the stroke eraser bites. */
export const ERASER_RADIUS = 12;

export const CANVAS_SIZE = { w: CANVAS_W, h: CANVAS_H };
