/**
 * 260925 backseat act: pure coordinate math. No Electron, no helper.
 *
 * The mapping model px -> global points is LINEAR through the frame's rect and
 * image size, and that is the whole reason mixed-DPI setups work: the helper
 * captures `rect` (global points) at whatever backing scale that display has
 * and ScreenCaptureKit resamples it to exactly width x height, so neither side
 * ever needs to know the scale to map a click back. The scale only matters
 * for choosing the image size (full resolution, then fit to the budget).
 */
import type { DisplayInfo, Frame, ImageBudget, Point, Rect } from './types';

/** Anthropic visual-token estimate for an image of w x h px. */
export function visualTokens(w: number, h: number): number {
  return Math.ceil(w / 28) * Math.ceil(h / 28);
}

/** Frames are single full frames downscaled to at most this many px on the long edge. */
export const FRAME_MAX_EDGE = 1280;

/**
 * Image budget per model: long edge FRAME_MAX_EDGE, and the model's visual
 * token cap (5-generation models take up to 4784, Haiku 4.5 and older about
 * 1568, the same cap backseat's grid is pinned to). At 1280 px a 16:10 frame
 * is 1380 tokens, inside both, so in practice the edge is what binds. An image
 * over a model's cap is downscaled server-side, silently, which would break
 * the coordinate mapping; staying inside it keeps the mapping exact.
 */
export function budgetForModel(model: string, maxEdge = FRAME_MAX_EDGE): ImageBudget {
  const m = model.toLowerCase();
  if (/(sonnet|opus|fable)-5/.test(m)) return { maxLongEdge: Math.min(maxEdge, 2576), maxTokens: 4784 };
  return { maxLongEdge: Math.min(maxEdge, 1568), maxTokens: 1568 };
}

/**
 * Largest size <= (srcW, srcH), same aspect ratio, that fits the budget.
 * Never upscales. The sqrt estimate can land a token or two over because of
 * the ceil() in visualTokens, so it steps down until it fits.
 */
export function fitToBudget(
  srcW: number,
  srcH: number,
  budget: ImageBudget,
): { width: number; height: number; scale: number } {
  if (!(srcW > 0 && srcH > 0)) throw new Error('fitToBudget: empty source');
  let scale = Math.min(
    1,
    budget.maxLongEdge / Math.max(srcW, srcH),
    Math.sqrt((budget.maxTokens * 784) / (srcW * srcH)),
  );
  let width = Math.max(1, Math.floor(srcW * scale));
  let height = Math.max(1, Math.floor(srcH * scale));
  while (visualTokens(width, height) > budget.maxTokens && width > 1 && height > 1) {
    scale *= 0.995;
    width = Math.max(1, Math.floor(srcW * scale));
    height = Math.max(1, Math.floor(srcH * scale));
  }
  return { width, height, scale: width / srcW };
}

/**
 * Pixel size of a global rect at native resolution: the rect in points times
 * the backing scale of the display it sits on. A rect is captured from ONE
 * display (the helper clips it), so one scale applies.
 */
export function nativePixelSize(rect: Rect, displayScale: number): { w: number; h: number } {
  return { w: Math.round(rect.w * displayScale), h: Math.round(rect.h * displayScale) };
}

/** Image px (model) -> global point. Uses the pixel CENTER, clamped into the rect. */
export function imageToGlobal(p: Point, frame: Pick<Frame, 'rect' | 'width' | 'height'>): Point {
  const sx = frame.rect.w / frame.width;
  const sy = frame.rect.h / frame.height;
  const px = clamp(p.x, 0, frame.width - 1);
  const py = clamp(p.y, 0, frame.height - 1);
  return {
    x: frame.rect.x + (px + 0.5) * sx,
    y: frame.rect.y + (py + 0.5) * sy,
  };
}

/** Global point -> image px (for tests and for drawing the cursor hint). */
export function globalToImage(p: Point, frame: Pick<Frame, 'rect' | 'width' | 'height'>): Point {
  return {
    x: Math.floor(((p.x - frame.rect.x) * frame.width) / frame.rect.w),
    y: Math.floor(((p.y - frame.rect.y) * frame.height) / frame.rect.h),
  };
}

/** True when an image-px point is inside the image the model was shown. */
export function inImage(p: Point, frame: Pick<Frame, 'width' | 'height'>): boolean {
  return p.x >= 0 && p.y >= 0 && p.x < frame.width && p.y < frame.height;
}

export function rectContains(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.y >= r.y && p.x < r.x + r.w && p.y < r.y + r.h;
}

export function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w);
  const bt = Math.min(a.y + a.h, b.y + b.h);
  if (r <= x || bt <= y) return null;
  return { x, y, w: r - x, h: bt - y };
}

/** The display holding a point, else the one with the largest overlap of `rect`. */
export function displayForPoint(displays: DisplayInfo[], p: Point): DisplayInfo | undefined {
  return displays.find((d) => rectContains(d.bounds, p));
}

export function displayForRect(displays: DisplayInfo[], rect: Rect): DisplayInfo | undefined {
  let best: DisplayInfo | undefined;
  let bestArea = 0;
  for (const d of displays) {
    const i = intersect(d.bounds, rect);
    const area = i ? i.w * i.h : 0;
    if (area > bestArea) {
      best = d;
      bestArea = area;
    }
  }
  return best;
}

/**
 * What to capture for a target and at what size: the target rect clipped to
 * the display that holds most of it, captured at native pixels and fit to
 * the model's budget.
 */
export function planCapture(
  targetRect: Rect,
  displays: DisplayInfo[],
  budget: ImageBudget,
): { rect: Rect; displayId: number; width: number; height: number } | null {
  const d = displayForRect(displays, targetRect);
  if (!d) return null;
  const rect = intersect(targetRect, d.bounds);
  if (!rect) return null;
  const native = nativePixelSize(rect, d.scale);
  const fit = fitToBudget(native.w, native.h, budget);
  return { rect, displayId: d.id, width: fit.width, height: fit.height };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
