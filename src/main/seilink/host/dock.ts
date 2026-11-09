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
 * 261110: the dock sits in the bottom-right corner of the work area, away
 * from her (it used to ride beside her box and moved with her sway). Windows
 * raw input is passive, so its one rect may span her and the corner; on macOS
 * the hit panel blocks the desktop under it, so her box and the dock get a
 * panel each (hitPanels).
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

/**
 * 261110: a press this close to her box (page CSS px) still counts as on her.
 * Her box is measured a few times a second while she moves, so the edge lags.
 */
export const HER_SLOP_PX = 8;
/** 261110 (diagnostics): a press this close to her that is not on her is a near miss. */
export const NEAR_MISS_PX = 48;
/** 261110: movement (CSS px) beyond which a Windows press on her is a drag, not a tap. */
export const DRAG_SLOP_DIP = 8;
/** 261110: the cursor this close to the dock (CSS px) wakes it. */
export const DOCK_HOVER_PX = 28;

export function growBox(b: SeilinkBox, by: number): SeilinkBox {
  return { x: b.x - by, y: b.y - by, w: b.w + 2 * by, h: b.h + 2 * by };
}

/** What a press at `p` (page CSS px) landed on. Dock buttons win: the dock overlaps her. */
export function pressTarget(
  p: { x: number; y: number },
  her: SeilinkBox | null,
  dock: readonly SeilinkDockButton[] | null,
  slop = 0,
): PressTarget {
  for (const b of dock ?? []) if (inside(p, b)) return { kind: 'dock', id: b.id };
  if (her && inside(p, slop > 0 ? growBox(her, slop) : her)) return { kind: 'her' };
  return { kind: 'none' };
}

/** 261110 (diagnostics): a press near her box that missed her. */
export function isNearMiss(p: { x: number; y: number }, her: SeilinkBox | null, slop = HER_SLOP_PX, margin = NEAR_MISS_PX): boolean {
  if (!her) return false;
  return inside(p, growBox(her, margin)) && !inside(p, growBox(her, slop));
}

/** 261110: the Windows drag threshold in physical px (raw input reports physical px). */
export function dragSlopPhysical(scaleFactor: number): number {
  const s = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
  return Math.round(DRAG_SLOP_DIP * s);
}

/** 261110: the cursor (page CSS px) is over the dock, or near it. */
export function dockHover(p: { x: number; y: number } | null, dock: readonly SeilinkDockButton[] | null, margin = DOCK_HOVER_PX): boolean {
  if (!p) return false;
  const u = unionBox(dock ?? []);
  return !!u && inside(p, growBox(u, margin));
}

/**
 * 261110: the native click areas (page CSS px).
 * - `one`: Windows' single passive rect: her box with the near-miss margin (so near misses are
 *   seen at all) and the dock. Presses inside it that hit neither are ignored.
 * - `her` / `dock`: the two macOS hit panels (each blocks the desktop under it, so they stay tight).
 * The dock only counts while it is reported (it shows whether or not she is in the frame).
 */
export function hitAreas(
  her: SeilinkBox | null,
  dock: readonly SeilinkDockButton[] | null,
): { one: SeilinkBox | null; her: SeilinkBox | null; dock: SeilinkBox | null } {
  const d = unionBox(dock ?? []);
  return {
    one: unionBox([her ? growBox(her, NEAR_MISS_PX) : null, d]),
    her: her ? growBox(her, HER_SLOP_PX) : null,
    dock: d,
  };
}
