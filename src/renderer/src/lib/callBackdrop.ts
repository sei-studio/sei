/**
 * Pure geometry for the call's character-art backdrop.
 *
 * The art is painted with `background-size: cover`, which is what makes the
 * behaviour the same in both places it is used. On a full-window pane a
 * portrait image is WIDER-limited: cover scales it to the pane's width and it
 * overflows vertically, which is the "fit to width, drag up and down" case. In
 * a narrow split-screen pane the same rule flips to height-driven and the art
 * simply fills the column instead of letterboxing. One rule, no special cases,
 * and vertical drag is available exactly when there is something to scroll to.
 */

/** A width/height pair in pixels. */
export interface Size {
  w: number;
  h: number;
}

/**
 * Vertical overflow, in pixels, of an image painted `cover` into a pane.
 *
 * 0 means the art exactly fits (or is width-cropped instead), so there is
 * nothing to drag. Degenerate sizes return 0 rather than NaN — natural
 * dimensions are 0 until the image decodes.
 */
export function coverOverflowPx(natural: Size, pane: Size): number {
  if (natural.w <= 0 || natural.h <= 0 || pane.w <= 0 || pane.h <= 0) return 0;
  const scale = Math.max(pane.w / natural.w, pane.h / natural.h);
  return Math.max(0, natural.h * scale - pane.h);
}

/**
 * Turn a drag in pixels into a change in `background-position-y` percent.
 *
 * CSS positions the overflow across 0..100%, so one percent is `overflow/100`
 * pixels. Converting back this way makes the art track the cursor 1:1 whatever
 * the image size, instead of a fixed sensitivity that feels wrong at both
 * extremes. Dragging DOWN reveals what is above, hence the negation.
 */
export function dragToPositionDelta(dyPx: number, overflowPx: number): number {
  if (overflowPx <= 0) return 0;
  return (-dyPx / overflowPx) * 100;
}

/** Keep a background-position percentage inside the pane. */
export function clampPosition(pct: number): number {
  return Math.min(100, Math.max(0, pct));
}
