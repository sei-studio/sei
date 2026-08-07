/**
 * The switch dwell (260806) — the restartable clock behind the 'switch' wake.
 *
 * Feed it a change signal (a colour jolt from the worker, a share-label change
 * from the poll) and it fires ONCE, dwellMs after the LAST signal. A further
 * signal inside the window restarts the clock, so a fast scroll through five
 * reels produces one wake after the player settles rather than five reactions
 * to clips they already left. See SWITCH_DWELL_MS in shared/backseatIpc.ts for
 * the design reasoning; this file is just the mechanism, pure over injected
 * timers so it can be tested without a session.
 */

export interface SwitchDwell {
  /** A content-change signal landed. Arms the clock, or restarts it. */
  change(): void;
  /** Drop any pending fire (pause, stop). The next change() re-arms. */
  cancel(): void;
  /** True while a fire is armed and waiting out the dwell. */
  pending(): boolean;
}

export function createSwitchDwell(opts: {
  dwellMs: number;
  /** Called once per settled change; `sinceChangeMs` is the time since the
   *  LAST change signal (≈ dwellMs plus timer drift). */
  onFire: (sinceChangeMs: number) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}): SwitchDwell {
  const now = opts.now ?? Date.now;
  // The timer id is opaque: window setTimeout returns number, Node's returns
  // Timeout, and injected fakes return whatever they like — this code only
  // ever hands it back to the matching clear.
  const setT: (fn: () => void, ms: number) => unknown =
    opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT: (id: unknown) => void =
    opts.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
  let timer: unknown = null;
  let lastChangeAt = 0;

  return {
    change() {
      lastChangeAt = now();
      if (timer !== null) clearT(timer);
      timer = setT(() => {
        timer = null;
        opts.onFire(now() - lastChangeAt);
      }, opts.dwellMs);
    },
    cancel() {
      if (timer !== null) clearT(timer);
      timer = null;
    },
    pending() {
      return timer !== null;
    },
  };
}
