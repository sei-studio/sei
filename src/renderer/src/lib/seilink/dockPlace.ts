/**
 * Where the SeiLink dock sits on the wallpaper (261104, M4). Pure.
 *
 * At the bottom of the work area (above the taskbar or the Dock), BESIDE her:
 * her figure usually runs to the bottom of the screen, so a dock centred under
 * her seat would sit on her. Right of her box when it fits, else left of it,
 * else (she fills the screen width) centred under her seat. With no box (she
 * walked out of the frame) it centres under her seat.
 *
 * Kept next to her box on purpose: the native click area is the UNION of her
 * box and the dock (one rect), so a dock far from her would grow it, and on
 * macOS the hit panel takes the desktop's clicks inside that union.
 */
import type { SeilinkBox } from '@shared/seilinkHost';

/** Gap between the dock and the bottom of the work area. */
export const DOCK_BOTTOM_GAP = 20;
/** Gap between the dock and the edges of the work area. */
export const DOCK_SIDE_GAP = 16;
/** Gap between the dock and her box. */
export const DOCK_HER_GAP = 12;

export function dockLeft(workArea: SeilinkBox, her: SeilinkBox | null, anchorX: number, width: number): number {
  const minLeft = workArea.x + DOCK_SIDE_GAP;
  const maxLeft = workArea.x + workArea.w - width - DOCK_SIDE_GAP;
  if (her) {
    const right = her.x + her.w + DOCK_HER_GAP;
    if (right <= maxLeft) return Math.max(minLeft, right);
    const left = her.x - DOCK_HER_GAP - width;
    if (left >= minLeft) return Math.min(maxLeft, left);
  }
  return Math.max(minLeft, Math.min(anchorX - width / 2, maxLeft));
}

/** The dock's bottom edge (page CSS px). */
export function dockBottom(workArea: SeilinkBox): number {
  return workArea.y + workArea.h - DOCK_BOTTOM_GAP;
}
