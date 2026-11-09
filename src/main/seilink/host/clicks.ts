/**
 * SeiLink click classifier (261104): turns raw presses on her into click /
 * double click / drag.
 *
 * A double click always arrives with a click first (macOS: down, click,
 * down, dblclick; Windows raw input: two down/up pairs), so a single click
 * is held for the user's double-click interval and dropped if the second
 * one comes. Clicking her opens her chat; the double click is reserved
 * (a hook for the next milestone), so this wait is what keeps the two apart.
 *
 * Inputs:
 * - `press(down, up)` (Windows): one press that started on her, with where
 *   and when it went down and came up, in physical px and ms.
 * - `tap()` / `doubleTap()` / `drag()` (macOS): AppKit already classified
 *   the press (SeiHitView in native/seilink/src/mac.mm).
 */

export interface ClickClassifierOptions {
  /** The OS double-click interval (ms). */
  dblMs: number;
  /** Movement (px) beyond which a press is a drag. */
  dragPx: number;
  /** A press held longer than this is not a click (ms). */
  maxPressMs?: number;
  onClick(): void;
  onDoubleClick(): void;
  onDrag?(): void;
  /** 261110 (diagnostics): how a Windows press on her went. */
  onPress?(outcome: 'tap' | 'drag' | 'long'): void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export interface PressPoint {
  x: number;
  y: number;
  t: number;
}

export class ClickClassifier {
  private pending: unknown = null;
  private lastTap: PressPoint | null = null;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;

  constructor(private readonly o: ClickClassifierOptions) {
    this.setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = o.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  }

  /** The OS double-click interval, once the addon has read it. */
  setDoubleClickMs(ms: number): void {
    this.o.dblMs = ms;
  }

  /** 261110: Windows' drag threshold follows the display's scale factor (physical px). */
  setDragPx(px: number): void {
    if (Number.isFinite(px) && px > 0) this.o.dragPx = px;
  }

  /** Windows: a whole press. */
  press(down: PressPoint, up: PressPoint): void {
    const moved = Math.hypot(up.x - down.x, up.y - down.y);
    if (moved > this.o.dragPx) {
      this.o.onPress?.('drag');
      this.drag();
      return;
    }
    if (up.t - down.t > (this.o.maxPressMs ?? 1500)) {
      this.o.onPress?.('long');
      return;
    }
    this.o.onPress?.('tap');
    const prev = this.lastTap;
    if (prev && this.pending !== null && up.t - prev.t <= this.o.dblMs && Math.hypot(up.x - prev.x, up.y - prev.y) <= this.o.dragPx * 2) {
      this.doubleTap();
      return;
    }
    this.lastTap = up;
    this.tap();
  }

  /** A single click: held for the double-click interval. */
  tap(): void {
    this.cancel();
    this.pending = this.setTimer(() => {
      this.pending = null;
      this.lastTap = null;
      this.o.onClick();
    }, this.o.dblMs);
  }

  /** A double click: the held single click is dropped. */
  doubleTap(): void {
    this.cancel();
    this.lastTap = null;
    this.o.onDoubleClick();
  }

  drag(): void {
    this.cancel();
    this.lastTap = null;
    this.o.onDrag?.();
  }

  dispose(): void {
    this.cancel();
  }

  private cancel(): void {
    if (this.pending !== null) this.clearTimer(this.pending);
    this.pending = null;
  }
}
