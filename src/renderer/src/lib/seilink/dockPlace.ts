/**
 * Where the WorldLink dock sits on the wallpaper. Pure.
 *
 * 261110 (product call 261110): in the bottom-right corner of the work area
 * (above the taskbar or the Dock), always. It used to sit beside her box, and
 * her box follows her idle sway and walk (measured a few times a second), so
 * the dock crept sideways with her; it was also too easy to see. Now it is
 * fixed to the corner, small, and faint until the cursor comes near it
 * (the host polls the cursor, CH.hover).
 *
 * Its right edge is fixed, so a wider dock ("Move out?", the offer's text
 * buttons) grows to the left. The native click areas follow (main/seilink/
 * host/dock.ts hitAreas: Windows' one passive rect spans her and the corner;
 * macOS gets a hit panel for the dock of its own).
 */
import type { SeilinkBox } from '@shared/seilinkHost';

/** Gap between the dock and the bottom of the work area. */
export const DOCK_BOTTOM_GAP = 16;
/** Gap between the dock and the right edge of the work area. */
export const DOCK_SIDE_GAP = 16;

/** The dock's position in page CSS px: `right` from the page's right edge, `bottom` = its bottom edge's y. */
export interface DockCorner {
  right: number;
  bottom: number;
}

export function dockCorner(workArea: SeilinkBox, pageWidth: number): DockCorner {
  const waRight = workArea.x + workArea.w;
  const pageW = Number.isFinite(pageWidth) && pageWidth > 0 ? pageWidth : waRight;
  return {
    right: Math.max(0, pageW - waRight) + DOCK_SIDE_GAP,
    bottom: workArea.y + workArea.h - DOCK_BOTTOM_GAP,
  };
}

/** The dock's bottom edge (page CSS px). */
export function dockBottom(workArea: SeilinkBox): number {
  return dockCorner(workArea, workArea.x + workArea.w).bottom;
}

/**
 * Whether the dock shows at full strength. At rest it is faint; it wakes
 * while the cursor is near it, while it is asking or answering something
 * (move out, a caption, the decorate-together offer), and for a moment after
 * a press.
 */
export function dockAwake(s: { hover: boolean; confirming: boolean; caption: boolean; offer: boolean; pressed: boolean }): boolean {
  return s.hover || s.confirming || s.caption || s.offer || s.pressed;
}
