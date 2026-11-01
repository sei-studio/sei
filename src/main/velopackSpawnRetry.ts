/**
 * Starting a program Sei has just written to disk (261102, T293). Windows
 * refuses to start an image while any process holds a write handle on it
 * (ERROR_SHARING_VIOLATION, which Node reports as a synchronous `spawn EBUSY`
 * throw, not as an 'error' event). The holder is short-lived: the download's
 * own handle, which a write stream closes on the thread pool after end()'s
 * callback (and which an antivirus scanning on close keeps open longer), or a
 * scanner still holding the new file. velopack-update.yml migrate jobs lost a
 * migration to it twice (runs 41233281447 peruser-unicode, 41342602088
 * nsis-newer, both unsigned CI builds where Setup starts about 2 ms after the
 * download ends because there is no signature check in between).
 *
 * Only EBUSY is retried. EACCES arrives as an async 'error' event, not here.
 * EPERM is ERROR_ACCESS_DENIED: a file that policy or an antivirus blocks or
 * quarantined, which a few seconds do not fix, and CI has never shown one at
 * spawn. Pure (no electron import) so it unit-tests on any host.
 */

/** Waits before each retry: 5 tries over about 3 s. */
export const SPAWN_BUSY_DELAYS_MS: readonly number[] = [200, 400, 800, 1600];

export function isBusySpawnError(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === 'EBUSY';
}

export type SpawnRetryResult<T> =
  | { ok: true; value: T; retries: number }
  | { ok: false; error: string; retries: number };

export interface SpawnRetryOptions {
  /**
   * Runs before every RETRY (never before the first try, which the caller
   * has just verified) and right before the next start: null when the file
   * is still the one that was verified, else why not. Whatever held the file
   * may have been writing to it, so a retry never starts it unchecked.
   */
  recheck?: () => Promise<string | null>;
  delaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  /** One line per busy try, for the log. */
  onBusy?: (retry: number, delayMs: number) => void;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Calls `start` (which calls spawn) and returns what it returned. A
 * synchronous EBUSY is retried after a short wait, up to the delay list; any
 * other throw, a busy file that never frees, or a failed recheck gives up.
 */
export async function spawnWhenFree<T>(start: () => T, opts: SpawnRetryOptions = {}): Promise<SpawnRetryResult<T>> {
  const delays = opts.delaysMs ?? SPAWN_BUSY_DELAYS_MS;
  const sleep = opts.sleep ?? realSleep;
  for (let retries = 0; ; retries++) {
    try {
      return { ok: true, value: start(), retries };
    } catch (err) {
      const error = (err as Error)?.message ?? String(err);
      if (!isBusySpawnError(err) || retries >= delays.length) return { ok: false, error, retries };
      opts.onBusy?.(retries + 1, delays[retries]);
      await sleep(delays[retries]);
      const changed = opts.recheck ? await opts.recheck() : null;
      if (changed) return { ok: false, error: changed, retries: retries + 1 };
    }
  }
}
