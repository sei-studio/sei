/**
 * Transition gates for the onboarding scene (261012). Pure: no React.
 *
 * The scene's choreography (ground slides in, Sui walks in, Sui walks off,
 * ground slides out) used to advance ONLY on CSS `transitionend`. A transition
 * that never runs never fires that event: a class flip before the first style
 * pass (a cold first launch, a window that is not shown yet), a minimized or
 * hidden window that draws no frames, a compositor quirk. With no timer and
 * no button, the player was left on an empty sky: 8 of 42 fresh v0.6.8 first
 * launches never left the intro, and 4 of them never came back.
 *
 * A gate is one stage of that choreography. It completes EXACTLY once, by
 * whichever lands first:
 *   - 'transition'      the element's own transitionend
 *   - 'watchdog'        a timer a little past the CSS duration
 *   - 'skip'            the player clicked or pressed a key to skip
 *   - 'reduced_motion'  the OS asks for reduced motion, so nothing slides
 *
 * A window that is hidden when the gate arms (Electron creates it with
 * show:false and reveals it after the splash) holds the watchdog until the
 * page is visible, so the player still sees the walk-in. That wait is itself
 * bounded by HIDDEN_CEILING_MS: if the visibility signal never arrives (or
 * lies), the watchdog starts anyway, so the worst case is the ceiling plus
 * one watchdog delay, never a hang.
 */

export type AdvanceSource = 'transition' | 'watchdog' | 'skip' | 'reduced_motion';

/** Watchdog delay for a transition expected to take `expectedMs`. */
export function watchdogDelayMs(expectedMs: number): number {
  return Math.max(expectedMs + 1500, 3000);
}

/** Longest a gate waits for a hidden window to become visible. */
export const HIDDEN_CEILING_MS = 20_000;

/** Page visibility, injectable for tests. */
export interface Visibility {
  isHidden(): boolean;
  /** Subscribe to "the page became visible". Returns an unsubscribe. */
  onVisible(cb: () => void): () => void;
}

export const documentVisibility: Visibility = {
  isHidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
  onVisible: (cb) => {
    if (typeof document === 'undefined') return () => {};
    const h = (): void => {
      if (document.visibilityState !== 'hidden') cb();
    };
    document.addEventListener('visibilitychange', h);
    return () => document.removeEventListener('visibilitychange', h);
  },
};

/**
 * Run `cb` once the page is visible: now if it already is, on the next
 * visibilitychange otherwise, and after `ceilingMs` at the latest. Returns a
 * cancel.
 */
export function whenVisible(
  cb: () => void,
  visibility: Visibility = documentVisibility,
  ceilingMs: number = HIDDEN_CEILING_MS,
): () => void {
  if (!visibility.isHidden()) {
    cb();
    return () => {};
  }
  let done = false;
  const fire = (): void => {
    if (done) return;
    done = true;
    off();
    clearTimeout(ceiling);
    cb();
  };
  const off = visibility.onVisible(fire);
  const ceiling = setTimeout(fire, ceilingMs);
  return () => {
    done = true;
    off();
    clearTimeout(ceiling);
  };
}

export interface GateOptions {
  /** The CSS transition's duration (ms). */
  expectedMs: number;
  /** Called exactly once, with how the stage completed. */
  onAdvance: (by: AdvanceSource) => void;
  /** Complete immediately with this source instead of waiting (reduced
   * motion, or the intro was already skipped). */
  instant?: Exclude<AdvanceSource, 'transition' | 'watchdog'> | null;
  visibility?: Visibility;
  hiddenCeilingMs?: number;
}

export interface TransitionGate {
  /** The element's own transitionend landed. */
  transitionEnded(): void;
  /** Complete now (a skip, or reduced motion switched on mid-stage). */
  skip(by?: Exclude<AdvanceSource, 'transition' | 'watchdog'>): void;
  /** Drop the gate without completing it (the stage was superseded). */
  cancel(): void;
  readonly done: boolean;
}

export function armTransitionGate(opts: GateOptions): TransitionGate {
  let done = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cancelVisible: (() => void) | null = null;

  const stop = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    cancelVisible?.();
    cancelVisible = null;
  };
  const finish = (by: AdvanceSource): void => {
    if (done) return;
    done = true;
    stop();
    opts.onAdvance(by);
  };

  const gate: TransitionGate = {
    transitionEnded: () => finish('transition'),
    skip: (by = 'skip') => finish(by),
    cancel: () => {
      done = true;
      stop();
    },
    get done() {
      return done;
    },
  };

  if (opts.instant) {
    finish(opts.instant);
    return gate;
  }

  // The watchdog counts from the moment the page can actually show the
  // transition. whenVisible may call back synchronously, so the handle is
  // assigned before it can be read.
  cancelVisible = whenVisible(
    () => {
      cancelVisible = null;
      if (done) return;
      timer = setTimeout(() => finish('watchdog'), watchdogDelayMs(opts.expectedMs));
    },
    opts.visibility,
    opts.hiddenCeilingMs,
  );
  return gate;
}

/** How a multi-stage scene sequence (the intro) completed, for analytics:
 * any skip wins, then reduced motion, then any watchdog, else 'transition'. */
export function summarizeAdvance(sources: AdvanceSource[]): AdvanceSource {
  if (sources.includes('skip')) return 'skip';
  if (sources.includes('reduced_motion')) return 'reduced_motion';
  if (sources.includes('watchdog')) return 'watchdog';
  return 'transition';
}

/** True when the OS asks for reduced motion. */
export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
}




