/**
 * 260925 backseat act (M0 spike): shared types for the computer-use loop.
 *
 * Coordinate spaces, named everywhere they appear:
 *   - GLOBAL POINTS: Quartz global display space, origin at the top-left of
 *     the main display, y down. CGEvent, CGWindowList, CGDisplayBounds and
 *     Electron's `screen` DIP space all use it on macOS. The helper speaks it.
 *   - IMAGE PX: pixels of the screenshot the model was shown. The model
 *     speaks it. `geometry.ts` maps between the two through the Frame.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface DisplayInfo {
  id: number;
  /** Global points. */
  bounds: Rect;
  /** Backing scale (pixels per point): 2 on a Retina panel, 1 on most externals. */
  scale: number;
  main: boolean;
}

export interface WindowInfo {
  id: number;
  pid: number;
  layer: number;
  alpha: number;
  bounds: Rect;
  onScreen: boolean;
  owner?: string;
  title?: string;
}

export interface AppInfo {
  pid?: number;
  bundleId?: string;
  name?: string;
  /** Owner pid of the frontmost normal-layer window (cross-check). */
  topWindowPid?: number;
  topWindowId?: number;
}

export interface Permissions {
  axTrusted: boolean;
  postEventAccess: boolean;
  screenCaptureAccess: boolean;
}

/**
 * What the act loop is allowed to touch: the thing the player shared.
 * A window share is `window:<CGWindowID>:0` in desktopCapturer terms; a
 * screen share is `screen:<CGDirectDisplayID>:0`.
 */
export type ActTarget =
  | { kind: 'window'; windowId: number; pid?: number; label?: string }
  | { kind: 'screen'; displayId: number; label?: string };

/** One screenshot as shown to the model, plus how to map it back. */
export interface Frame {
  /** base64, no data: prefix. */
  data: string;
  mime: 'image/jpeg' | 'image/png';
  /** Image size in px (what the model sees). */
  width: number;
  height: number;
  /** The global-point rect the image covers. */
  rect: Rect;
  displayId?: number;
  capturedAt: number;
  timing?: Record<string, number>;
  /** 32x18 grayscale thumbnail (hex) for change detection. */
  thumb?: string;
  /** On-device OCR boxes (global points), when asked for. */
  ocr?: OcrBox[];
}

/** Image px per global point of a frame (the downscale factor, tracked for mapping and logs). */
export function frameScale(f: Pick<Frame, 'width' | 'rect'>): number {
  return f.width / f.rect.w;
}

/** One recognized text line (Apple Vision), global points. */
export interface OcrBox {
  text: string;
  confidence: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One Accessibility element from the helper's ax_dump (flat, breadth first). */
export interface AxNode {
  depth: number;
  parent: number;
  role?: string;
  subrole?: string;
  title?: string;
  description?: string;
  placeholder?: string;
  value?: string;
  frame?: Rect;
  enabled?: boolean;
  focused?: boolean;
  pid?: number;
}

/** Image budget for one screenshot, per model family. */
export interface ImageBudget {
  maxLongEdge: number;
  /** Visual tokens, ceil(w/28) * ceil(h/28). */
  maxTokens: number;
}
