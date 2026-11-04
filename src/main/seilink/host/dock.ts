/**
 * SeiLink dock geometry for the room host (261104, M4). Pure, so it is tested
 * without a desktop.
 *
 * The room window sits behind the desktop icons, so the page never gets DOM
 * clicks. The native hit area is ONE rect (Windows raw input, the mac hit
 * panel), so it becomes the union of her box and the dock buttons, and each
 * press is routed by where it landed: a dock button, her, or neither (the
 * small gap the union adds, ignored).
 *
 * Coordinates: boxes from the page are CSS px of the room page, whose window
 * covers the primary display. Native presses arrive in screen units:
 * Windows physical px (divide by the scale factor), mac global top-left
 * points. toPagePoint converts them back.
 */
import type { SeilinkBox, SeilinkDockAction, SeilinkDockButton } from '../../../shared/seilinkHost';

export function unionBox(boxes: ReadonlyArray<SeilinkBox | null | undefined>): SeilinkBox | null {
  let out: { l: number; t: number; r: number; b: number } | null = null;
  for (const b of boxes) {
    if (!b || !(b.w > 0) || !(b.h > 0)) continue;
    if (!out) out = { l: b.x, t: b.y, r: b.x + b.w, b: b.y + b.h };
    else {
      out.l = Math.min(out.l, b.x);
      out.t = Math.min(out.t, b.y);
      out.r = Math.max(out.r, b.x + b.w);
      out.b = Math.max(out.b, b.y + b.h);
    }
  }
  return out ? { x: out.l, y: out.t, w: out.r - out.l, h: out.b - out.t } : null;
}

function inside(p: { x: number; y: number }, b: SeilinkBox): boolean {
  return p.x >= b.x && p.x < b.x + b.w && p.y >= b.y && p.y < b.y + b.h;
}

/** A native press point in page CSS px. */
export function toPagePoint(
  p: { x: number; y: number },
  display: { bounds: { x: number; y: number }; scaleFactor: number },
  units: 'physical' | 'points',
): { x: number; y: number } {
  const s = units === 'physical' ? display.scaleFactor || 1 : 1;
  return { x: p.x / s - display.bounds.x, y: p.y / s - display.bounds.y };
}

export type PressTarget = { kind: 'dock'; id: SeilinkDockAction } | { kind: 'her' } | { kind: 'none' };

/** What a press at `p` (page CSS px) landed on. Dock buttons win: the dock overlaps her. */
export function pressTarget(p: { x: number; y: number }, her: SeilinkBox | null, dock: readonly SeilinkDockButton[] | null): PressTarget {
  for (const b of dock ?? []) if (inside(p, b)) return { kind: 'dock', id: b.id };
  if (her && inside(p, her)) return { kind: 'her' };
  return { kind: 'none' };
}
