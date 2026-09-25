/**
 * Scope write barrier (260926): keeps an account's last writes in that
 * account's profile.
 *
 * Every surface writes its closing rows (the play row, the call row, bot
 * playtime) fire-and-forget, and each write resolves `paths.*` against the
 * ACTIVE scope at the moment it touches the disk. An account switch re-points
 * that scope (profileScope.switchScopeForAuth), so a row still in flight when
 * the switch lands is written into the NEXT account's transcript, and the
 * bundled defaults (Sui, Lyra, ...) share their ids across profiles, so it
 * lands in a real file there.
 *
 * Surfaces register those writes with trackScopedWrite(); the switch ends
 * every live session, then drainScopedWrites() before it moves the scope.
 *
 * isAccountTeardownActive() is true for the length of that teardown. The
 * rolling-summary fold reads it to defer itself: authState applies the NEW
 * session before the scope switch runs, so an LLM fold started during the
 * teardown would bill the incoming account for the outgoing account's
 * summary. The fold is not lost, the watermark simply stays put and the next
 * fold in the old account picks the rows up.
 *
 * Dependency-free on purpose: continuity, the game services and index.ts all
 * import it, and the orchestrator (accountSessions.ts) imports them.
 */

const pending = new Set<Promise<unknown>>();
let teardownDepth = 0;

/** Register a write that must land in the scope it started in. Returns `p`. */
export function trackScopedWrite<T>(p: Promise<T>): Promise<T> {
  const tracked = p.then(
    () => undefined,
    () => undefined,
  );
  pending.add(tracked);
  void tracked.finally(() => pending.delete(tracked));
  return p;
}

/**
 * Wait for every tracked write, including ones registered while waiting (an
 * ending bot's play row is registered only after its process exits). Bounded:
 * a hung disk must not hold a sign-in forever. Returns false on timeout.
 */
export async function drainScopedWrites(timeoutMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (pending.size > 0) {
    const left = deadline - Date.now();
    if (left <= 0) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      Promise.all([...pending]).then(() => false),
      new Promise<boolean>((r) => {
        timer = setTimeout(() => r(true), left);
      }),
    ]);
    clearTimeout(timer);
    if (timedOut) return false;
  }
  return true;
}

/** Number of writes still in flight (tests + logging). */
export function pendingScopedWrites(): number {
  return pending.size;
}

/** Mark the account teardown as running for the duration of `fn`. */
export async function withAccountTeardown<T>(fn: () => Promise<T>): Promise<T> {
  teardownDepth++;
  try {
    return await fn();
  } finally {
    teardownDepth--;
  }
}

/** True while the outgoing account's sessions are being ended. */
export function isAccountTeardownActive(): boolean {
  return teardownDepth > 0;
}

/** TEST-ONLY. */
export function _resetScopeBarrierForTests(): void {
  pending.clear();
  teardownDepth = 0;
}
