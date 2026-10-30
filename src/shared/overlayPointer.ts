/**
 * Polled-pointer hover for the avatar overlay (261029).
 *
 * The overlay's chrome (the pencil that enters edit mode, the hold-to-drag
 * move button, mute + captions) is shown on HOVER, and the window only takes
 * real clicks while the pointer is over that button column. In view mode the
 * window is click-through (`setIgnoreMouseEvents(true, {forward: true})`), so
 * DOM hover existed only when the OS forwarded mouse moves to the page.
 * Electron does not forward on Linux at all, and forwarding was not reaching
 * the page on a user's Live2D setup (261028 Discord report, likely Windows):
 * no hover meant no pencil, and the pencil is the only way into edit mode, so
 * the avatar could not be moved or resized.
 *
 * Main already polls the global cursor for Live2D gaze. These helpers turn
 * that poll into a second, OS-independent hover source: main samples the
 * cursor in window-local coordinates, and the renderer ORs it with DOM hover.
 * Pure and shared so both processes and the tests use the same rules.
 */

export interface OverlayPointerSample {
  /** Cursor inside the overlay window's content bounds. */
  inside: boolean;
  /** Cursor position relative to the content's top-left, in DIPs (= CSS px
   * at zoom 1). Only meaningful while `inside`. */
  x: number;
  y: number;
}

export interface RectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Window-local sample of a screen-space cursor point. Bounds and point must
 * be in the same (DIP) space, which Electron's `screen.getCursorScreenPoint`
 * and `BrowserWindow.getContentBounds` both are. */
export function samplePointer(
  cursor: { x: number; y: number },
  content: { x: number; y: number; width: number; height: number },
): OverlayPointerSample {
  const x = cursor.x - content.x;
  const y = cursor.y - content.y;
  const inside = x >= 0 && y >= 0 && x < content.width && y < content.height;
  return { inside, x, y };
}

/** Whether main should push this sample. Every sample is pushed while the
 * cursor is inside (the renderer needs the position to hit-test the button
 * column); outside, only the first sample after leaving is pushed, so a
 * cursor elsewhere on screen costs no IPC. */
export function shouldPushPointer(
  prev: OverlayPointerSample | null,
  next: OverlayPointerSample,
): boolean {
  if (next.inside) return true;
  return prev === null || prev.inside;
}

/** The polled cursor is over `rect` (the chrome button column's client rect).
 * A null rect (column not mounted) is never hit. */
export function pointerOverRect(
  sample: OverlayPointerSample | null,
  rect: RectLike | null,
): boolean {
  if (!sample?.inside || !rect) return false;
  return (
    sample.x >= rect.left && sample.x < rect.right && sample.y >= rect.top && sample.y < rect.bottom
  );
}

/** The chrome column shows on DOM hover OR a polled pointer inside the
 * window, and for the whole of edit mode. The same rule for every avatar
 * kind: a Live2D, rig or static tile all get the pencil. */
export function overlayChromeVisible(args: {
  domHovered: boolean;
  polled: OverlayPointerSample | null;
  editing: boolean;
}): boolean {
  return args.editing || args.domHovered || args.polled?.inside === true;
}
