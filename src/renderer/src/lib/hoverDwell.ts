/**
 * Hover dwell (261111). The World card warms a character's full data
 * (row + skin + full portrait) on hover so opening it is instant. Firing on
 * every pointer-enter also downloaded every portrait the pointer brushed past
 * while scrolling, so the warm-up now waits for a short dwell that signals
 * intent and is cancelled when the pointer leaves (or focus moves) first.
 *
 * Pure timer logic (no React) so the dwell and the cancel are unit-testable
 * with fake timers; `useHoverDwell` in BrowseCard wraps it.
 */

/** Long enough to skip a brush-past, short enough to land before a click. */
export const HOVER_DWELL_MS = 350;

export interface HoverDwell {
  /** Pointer entered / card focused: fire after the dwell unless cancelled. */
  start(): void;
  /** Pointer left / focus moved before the dwell ended: do nothing. */
  cancel(): void;
}

export function createHoverDwell(fire: () => void, delayMs: number = HOVER_DWELL_MS): HoverDwell {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    start() {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        fire();
      }, delayMs);
    },
    cancel() {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
    },
  };
}
