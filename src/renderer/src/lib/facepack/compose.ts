/**
 * sei-facepack v1 compose rule (261028), pure. Mirrors the bake's reference
 * compositor (face-sets tools/compose.py) so FacepackView draws exactly what
 * the QC sheets showed:
 *
 *   base (eyes open, mouth rest) at 0,0
 *   → eyes[half|closed] at eyes.box[0..1]  (only if blinking AND expression.blink)
 *   → mouth[viseme]    at mouth.box[0..1]  (only if viseme != rest)
 *   → each expression overlay, overlays[name][pose] or [c], at its box
 *
 * Fallbacks: unknown expression → the pack's default_expression (then
 * neutral, then the first one); unknown pose → default_pose → c; a missing
 * eye state or viseme patch is skipped (open eyes / rest mouth).
 */
import type {
  FacepackEyeState,
  FacepackExpression,
  FacepackIris,
  FacepackManifest,
  FacepackPose,
  FacepackViseme,
} from '@shared/facepack';
import { isSafePackPath, packPalette } from '@shared/facepack';
import { resolveExpression } from '../../../../bot/brain/faceExpressions.js';

export interface FaceFrameState {
  expression: string;
  pose: string;
  eye: FacepackEyeState;
  viseme: FacepackViseme;
  overlays?: boolean;
}

export interface FaceLayer {
  src: string;
  x: number;
  y: number;
  kind: 'base' | 'eyes' | 'mouth' | 'overlay';
}

export function resolveExpressionName(m: FacepackManifest, name: string): string {
  if (m.expressions[name]) return name;
  if (m.default_expression && m.expressions[m.default_expression]) return m.default_expression;
  if (m.expressions.neutral) return 'neutral';
  return Object.keys(m.expressions)[0];
}

/**
 * A face cue word for this pack (261028): mapped through the pack's palette
 * and aliases. null = the pack cannot show it, so the current face stays.
 */
export function cueExpression(m: FacepackManifest, word: string): string | null {
  const name = resolveExpression(word, packPalette(m));
  return name && m.expressions[name] ? name : null;
}

export function resolvePoseName(e: FacepackExpression, m: FacepackManifest, pose: string): string {
  if (e.poses[pose]) return pose;
  const d = m.default_pose ?? 'c';
  if (e.poses[d]) return d;
  if (e.poses.c) return 'c';
  return Object.keys(e.poses)[0];
}

/** Whether this expression ever blinks (blink:false = eyes already closed). */
export function expressionBlinks(m: FacepackManifest, expression: string): boolean {
  const e = m.expressions[resolveExpressionName(m, expression)];
  return e?.blink !== false;
}

/** The ordered layers for one frame. */
export function layersFor(m: FacepackManifest, s: FaceFrameState): FaceLayer[] {
  const exprName = resolveExpressionName(m, s.expression);
  const e = m.expressions[exprName];
  if (!e) return [];
  const poseName = resolvePoseName(e, m, s.pose);
  const p: FacepackPose | undefined = e.poses[poseName];
  if (!p) return [];
  const out: FaceLayer[] = [{ src: p.base, x: 0, y: 0, kind: 'base' }];
  if (s.eye !== 'open' && e.blink !== false && p.eyes) {
    const src = p.eyes[s.eye];
    if (src) out.push({ src, x: p.eyes.box[0], y: p.eyes.box[1], kind: 'eyes' });
  }
  if (s.viseme !== 'rest' && p.mouth) {
    const src = p.mouth[s.viseme];
    if (src) out.push({ src, x: p.mouth.box[0], y: p.mouth.box[1], kind: 'mouth' });
  }
  if (s.overlays !== false) {
    for (const name of e.overlays ?? []) {
      const ov = m.overlays?.[name];
      const q = ov?.[poseName] ?? ov?.c;
      if (q) out.push({ src: q.src, x: q.box[0], y: q.box[1], kind: 'overlay' });
    }
  }
  return out;
}

/** Every file one expression + pose can draw (to decode before showing it). */
export function filesFor(m: FacepackManifest, expression: string, pose: string): string[] {
  const exprName = resolveExpressionName(m, expression);
  const e = m.expressions[exprName];
  if (!e) return [];
  const poseName = resolvePoseName(e, m, pose);
  const p = e.poses[poseName];
  if (!p) return [];
  const files = [p.base];
  if (e.blink !== false && p.eyes) {
    if (p.eyes.half) files.push(p.eyes.half);
    if (p.eyes.closed) files.push(p.eyes.closed);
  }
  if (p.mouth) {
    for (const v of ['aa', 'ii', 'uu', 'ee', 'oo'] as const) {
      const src = p.mouth[v];
      if (src) files.push(src);
    }
  }
  for (const name of e.overlays ?? []) {
    const ov = m.overlays?.[name];
    const q = ov?.[poseName] ?? ov?.c;
    if (q) files.push(q.src);
  }
  return files;
}

/** The poses an expression actually has, default first. */
export function posesOf(m: FacepackManifest, expression: string): string[] {
  const e = m.expressions[resolveExpressionName(m, expression)];
  if (!e) return [];
  const keys = Object.keys(e.poses);
  const d = m.default_pose ?? 'c';
  return keys.includes(d) ? [d, ...keys.filter((k) => k !== d)] : keys;
}

/**
 * The gaze frames of one expression + pose (261120), or null: none baked,
 * the expression never opens its eyes, or the record is malformed (axes not
 * ascending, a frame row the wrong length, an unsafe path).
 */
export function irisOf(m: FacepackManifest, expression: string, pose: string): FacepackIris | null {
  const e = m.expressions[resolveExpressionName(m, expression)];
  if (!e || e.blink === false) return null;
  const ir = e.poses[resolvePoseName(e, m, pose)]?.iris;
  if (!ir || !Array.isArray(ir.box) || ir.box.length !== 4 || !Array.isArray(ir.x) || !Array.isArray(ir.y) || !Array.isArray(ir.frames)) return null;
  const asc = (a: unknown[]): boolean => a.length >= 2 && a.every((v, i) => typeof v === 'number' && Number.isFinite(v) && (i === 0 || v > (a[i - 1] as number)));
  if (!asc(ir.x) || !asc(ir.y) || ir.frames.length !== ir.y.length) return null;
  for (const row of ir.frames) {
    if (!Array.isArray(row) || row.length !== ir.x.length) return null;
    for (const f of row) if (f !== null && (typeof f !== 'string' || !isSafePackPath(f))) return null;
  }
  // The half-lid looks are optional: a malformed list drops them, not the gaze frames.
  const h = ir.half;
  if (h !== undefined && (!Array.isArray(h) || h.length !== ir.x.length || !h.every((f) => f === null || (typeof f === 'string' && isSafePackPath(f))))) {
    return { ...ir, half: undefined };
  }
  return ir;
}

/** The gaze frame files of one expression + pose (none when it has no gaze frames). */
export function irisFiles(m: FacepackManifest, expression: string, pose: string): string[] {
  const ir = irisOf(m, expression, pose);
  if (!ir) return [];
  const out: string[] = [];
  for (const row of ir.frames) for (const f of row) if (f) out.push(f);
  for (const f of ir.half ?? []) if (f) out.push(f);
  return out;
}

/** One frame of a gaze crossfade: `src` null is the base itself. */
export interface IrisTap {
  src: string | null;
  w: number;
}

/**
 * The farthest iris rotation (grid units, either axis) a player ever shows.
 * THA3 smears the iris into grey/white trailing ghosts at full rotation on
 * some art (chibi eyes at x +-1), while +-0.5 is clean on every pack checked,
 * so the outer frames stay in the pack but are never picked.
 */
export const IRIS_MAX = 0.5;

/**
 * The grid frame (xi, yi) for the gaze point (x right, y down, the grid's
 * units), clamped to the grid and to the cells within `max` (IRIS_MAX) of
 * the centre on each axis; a grid with no value that close keeps only its
 * value nearest the centre. Her look steps from frame to frame (the
 * player crossfades each step quickly, like a saccade) rather than blending
 * by position: two frames half and half show two faint irises side by side,
 * which a gaze resting between grid points would hold. `cur` (the frame
 * shown now) is kept until the point is `hold` of a step past the midpoint,
 * so a gaze resting on a border does not flicker between two frames.
 */
export function irisCell(ir: FacepackIris, x: number, y: number, cur: readonly [number, number] | null, hold = 0.1, max = IRIS_MAX): [number, number] {
  const pick = (axis: number[], v: number, c: number | undefined): number => {
    const n = axis.length;
    let ok = axis.map((a) => Math.abs(a) <= max + 1e-9);
    if (!ok.includes(true)) {
      let mid = 0;
      for (let i = 1; i < n; i++) if (Math.abs(axis[i]) < Math.abs(axis[mid])) mid = i;
      ok = axis.map((_, i) => i === mid);
    }
    const lo = ok.indexOf(true);
    const hi = ok.lastIndexOf(true);
    const cl = Math.min(axis[hi], Math.max(axis[lo], v));
    let best = lo;
    for (let i = lo + 1; i <= hi; i++) if (Math.abs(axis[i] - cl) < Math.abs(axis[best] - cl)) best = i;
    if (c === undefined || c < lo || c > hi || c === best) return best;
    const step = Math.abs(axis[best] - axis[c]);
    return Math.abs(cl - axis[c]) > Math.abs(cl - axis[best]) + hold * step ? best : c;
  };
  return [pick(ir.x, x, cur?.[0]), pick(ir.y, y, cur?.[1])];
}

/** The gaze frame at grid cell (xi, yi), clamped to the grid (null: the base itself). */
export function irisFrameAt(ir: FacepackIris, xi: number, yi: number): string | null {
  const y = Math.min(ir.y.length - 1, Math.max(0, yi));
  const x = Math.min(ir.x.length - 1, Math.max(0, xi));
  return ir.frames[y][x] ?? null;
}

/** The half-lid gaze crop at grid column xi, clamped (null: the plain half patch). */
export function irisHalfAt(ir: FacepackIris, xi: number): string | null {
  if (!ir.half) return null;
  return ir.half[Math.min(ir.x.length - 1, Math.max(0, xi))] ?? null;
}
