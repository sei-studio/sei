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
  FacepackManifest,
  FacepackPose,
  FacepackViseme,
} from '@shared/facepack';
import { packPalette } from '@shared/facepack';
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
