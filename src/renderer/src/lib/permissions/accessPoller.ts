/**
 * Access poller (260929) for the permission cards: while a card is open, ask
 * "is access on yet?" about once a second and continue on its own the moment
 * it is. Pure (no window.sei) so the timing is unit tested with fake timers.
 *
 * Single-flight by construction: the next check is scheduled only after the
 * previous one settles, so a slow check (a desktopCapturer listing, a trial
 * getUserMedia) can never stack up behind itself.
 */

export interface AccessPoller {
  /** Stop polling. Idempotent; a check already in flight is ignored. */
  stop(): void;
  /** Run a check now instead of waiting for the next tick (e.g. on focus). */
  poke(): void;
}

export interface AccessPollerOptions {
  /** Resolves true once access is granted. A throw counts as "not yet". */
  check: () => Promise<boolean>;
  /** Called once, on the first successful check. Polling stops before it. */
  onGranted: () => void;
  intervalMs?: number;
  /** Run the first check immediately (default) or after one interval. */
  immediate?: boolean;
}

export const ACCESS_POLL_MS = 1000;

export function startAccessPoller(opts: AccessPollerOptions): AccessPoller {
  const interval = opts.intervalMs ?? ACCESS_POLL_MS;
  let stopped = false;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = (ms: number): void => {
    if (stopped) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(run, ms);
  };

  const run = (): void => {
    timer = null;
    if (stopped || inFlight) return;
    inFlight = true;
    let result: Promise<boolean>;
    try {
      result = opts.check();
    } catch {
      result = Promise.resolve(false);
    }
    void result
      .catch(() => false)
      .then((ok) => {
        inFlight = false;
        if (stopped) return;
        if (ok) {
          stopped = true;
          opts.onGranted();
          return;
        }
        schedule(interval);
      });
  };

  schedule(opts.immediate === false ? interval : 0);

  return {
    stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
    poke() {
      if (stopped || inFlight) return;
      schedule(0);
    },
  };
}

/**
 * How long after the player says "I turned it on" before the Screen Recording
 * card offers a restart. macOS often will not hand a new Screen Recording grant
 * to a process that is already running, and the probe cannot tell "still off"
 * from "on, but not for this process" apart.
 */
export const RESTART_OFFER_AFTER_MS = 20_000;

/** True once the restart offer is due. `confirmedAt` null = not confirmed yet. */
export function restartOfferDue(confirmedAt: number | null, now: number): boolean {
  return confirmedAt !== null && now - confirmedAt >= RESTART_OFFER_AFTER_MS;
}
