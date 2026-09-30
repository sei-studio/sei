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
 * The whole switch is also marked (beginScopeSwitch, from the serialized
 * switchScopeForAuth): session STARTS are refused while it runs
 * (beginSessionStart), and a start that began before it re-checks right before
 * it registers its session, so nothing can start under the outgoing account
 * after its sessions were ended, or land in the incoming account half-built.
 * Chat turns carry the scope generation they began in (withScopedTurn) and drop
 * their writes when it moved (scopedTurnCurrent).
 *
 * Dependency-free on purpose (node builtins only): continuity, the game
 * services and index.ts all import it, and the orchestrator
 * (accountSessions.ts) imports them.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const pending = new Set<Promise<unknown>>();
let teardownDepth = 0;
let switchPending = 0;
let scopeGeneration = 0;
const turnScope = new AsyncLocalStorage<number>();

/** Upper bound on ending the outgoing account's sessions. */
export const ACCOUNT_TEARDOWN_CEILING_MS = 10_000;

/** Error code for a start refused because the account is changing. */
export const ACCOUNT_SWITCHING = 'ACCOUNT_SWITCHING';

export function accountSwitchingError(): Error & { code: string } {
  const err = new Error(`${ACCOUNT_SWITCHING}: the account is changing, try again in a moment`) as Error & {
    code: string;
  };
  err.code = ACCOUNT_SWITCHING;
  return err;
}

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

/**
 * Mark the account teardown as running for the duration of `fn`, bounded by
 * `ceilingMs`. A step that hangs must not hold the switch (the scope would
 * never move) or leave the flag up (the fold would stay off for the whole
 * process), so at the ceiling this resolves `undefined` and the flag comes
 * down; `fn` carries on in the background. Errors from `fn` propagate.
 */
export async function withAccountTeardown<T>(
  fn: () => Promise<T>,
  ceilingMs: number = ACCOUNT_TEARDOWN_CEILING_MS,
): Promise<T | undefined> {
  teardownDepth++;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          console.warn(`[sei] account teardown still running after ${ceilingMs}ms, switching anyway`);
          resolve(undefined);
        }, ceilingMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    teardownDepth--;
  }
}

/** True while the outgoing account's sessions are being ended. */
export function isAccountTeardownActive(): boolean {
  return teardownDepth > 0;
}

/**
 * Mark a scope switch as running, from its start (before the teardown) to its
 * end (after app:scope-changed). Returns the release; calling it twice is safe.
 */
export function beginScopeSwitch(): () => void {
  switchPending++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    switchPending--;
  };
}

/** True while any account scope switch is queued or running. */
export function isScopeSwitchPending(): boolean {
  return switchPending > 0;
}

/** The profile scope just moved (switchScopeForAuth, at setActiveScope). */
export function noteScopeChanged(): void {
  scopeGeneration++;
}

/**
 * Call at the top of a session start (chess, Draw!, backseat). Throws
 * ACCOUNT_SWITCHING while a switch is running. The returned check goes right
 * before the start registers its session: false means a switch began (or the
 * scope moved) during the start's awaits, and the start must clean up and
 * throw accountSwitchingError() instead of leaving a session nobody ends.
 */
export function beginSessionStart(): { stillValid(): boolean } {
  if (switchPending > 0 || teardownDepth > 0) throw accountSwitchingError();
  const generation = scopeGeneration;
  return {
    stillValid: () => switchPending === 0 && teardownDepth === 0 && scopeGeneration === generation,
  };
}

/**
 * Run a chat turn tagged with the scope generation it began in. Refused
 * (ACCOUNT_SWITCHING) while a switch is running: the turn would be billed to
 * one account and written to another.
 */
export function withScopedTurn<T>(fn: () => Promise<T>): Promise<T> {
  if (switchPending > 0 || teardownDepth > 0) return Promise.reject(accountSwitchingError());
  return turnScope.run(scopeGeneration, fn);
}

/**
 * May the current chat turn still write (transcript rows, MEMORY.md)? False
 * once a switch has started or the scope moved since withScopedTurn began it.
 * Outside a scoped turn, only a running switch blocks.
 */
export function scopedTurnCurrent(): boolean {
  if (switchPending > 0 || teardownDepth > 0) return false;
  const began = turnScope.getStore();
  return began === undefined || began === scopeGeneration;
}

/** TEST-ONLY. */
export function _resetScopeBarrierForTests(): void {
  pending.clear();
  teardownDepth = 0;
  switchPending = 0;
  scopeGeneration = 0;
}
