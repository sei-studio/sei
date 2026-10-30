/**
 * 261029 (login lock on restart): read main's auth state on demand instead of
 * trusting the renderer's default and whatever pushes happened to land.
 *
 * The store starts at `local` and only learns better from `auth:state` pushes,
 * and the onboarding sign-in panel only moves on once an `app:scope-changed`
 * push says the account's profile is live. A push sent before a listener
 * existed is gone, so a panel mounted late could wait for a push that had
 * already happened (or would never come, when the scope was right all along).
 * `sei.authSnapshot()` answers both questions at once.
 */
import { sei } from './ipcClient';
import type { AuthSnapshot } from '@shared/ipc';

/** How long the boot routing waits for a scope switch already under way. */
export const SCOPE_READY_WAIT_MS = 10_000;
/**
 * How long the boot routing waits for main's first auth state (261029
 * review). Main answers from the stored session, so this is normally instant;
 * the bound only keeps a broken main from holding the loading screen forever.
 */
export const AUTH_LOAD_WAIT_MS = 90_000;
const POLL_MS = 300;

function isSnapshot(v: unknown): v is AuthSnapshot {
  if (!v || typeof v !== 'object') return false;
  const s = (v as { state?: { kind?: unknown } }).state;
  return (
    !!s &&
    (s.kind === 'local' || s.kind === 'signed_in') &&
    typeof (v as { scopeReady?: unknown }).scopeReady === 'boolean' &&
    typeof (v as { loaded?: unknown }).loaded === 'boolean'
  );
}

/** Main's snapshot, or null when the bridge lacks it (tests, stubs) or the call failed. */
export async function readAuthSnapshot(): Promise<AuthSnapshot | null> {
  try {
    const fn = (sei as Partial<typeof sei> | undefined)?.authSnapshot;
    if (typeof fn !== 'function') return null;
    const snap: unknown = await fn();
    return isSnapshot(snap) ? snap : null;
  } catch {
    return null;
  }
}

function hasSnapshotBridge(): boolean {
  return typeof (sei as Partial<typeof sei> | undefined)?.authSnapshot === 'function';
}

/** Tries of the first read when the bridge exists but the call failed. */
const FIRST_READ_TRIES = 4;

/**
 * The snapshot once main has loaded its auth state and the data scope follows
 * it, polling while either is still under way (each bounded). `waited` says
 * the first answer was not final, so anything read from the profile before it
 * may be stale.
 *
 * 261029 review: a snapshot with `loaded: false` is main's DEFAULT state, not
 * an answer. Routing on it sent a signed-in user to the sign-in panel over
 * their own account's profile, so it is polled until main has loaded. If the
 * bound passes first, the result still has `loaded: false` and the caller must
 * not apply its state (see resolveBootRoute).
 *
 * The load bound is one deadline from the start of the first call: each
 * auth:snapshot can itself wait on main (up to 30 s), so a per-poll clock
 * stretched the splash well past it. A first read that failed (IPC threw) is
 * retried a few times before the caller falls back to the store.
 */
export async function waitForAuthScope(
  opts: {
    timeoutMs?: number;
    loadTimeoutMs?: number;
    isCancelled?: () => boolean;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<{ snapshot: AuthSnapshot | null; waited: boolean }> {
  const timeoutMs = opts.timeoutMs ?? SCOPE_READY_WAIT_MS;
  const loadTimeoutMs = opts.loadTimeoutMs ?? AUTH_LOAD_WAIT_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const cancelled = (): boolean => opts.isCancelled?.() === true;
  const loadDeadline = now() + loadTimeoutMs;
  // One read, given up on (null) at `deadline` even if main has not answered.
  const readBy = async (deadline: number): Promise<AuthSnapshot | null> => {
    const left = deadline - now();
    if (left <= 0) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        readAuthSnapshot(),
        new Promise<null>((r) => {
          timer = setTimeout(() => r(null), left);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  let waited = false;
  let snapshot = await readBy(loadDeadline);
  for (let i = 1; !snapshot && i < FIRST_READ_TRIES && hasSnapshotBridge() && now() < loadDeadline && !cancelled(); i++) {
    waited = true;
    await sleep(POLL_MS);
    snapshot = await readBy(loadDeadline);
  }
  while (snapshot && !snapshot.loaded && now() < loadDeadline && !cancelled()) {
    waited = true;
    await sleep(POLL_MS);
    snapshot = (await readBy(loadDeadline)) ?? snapshot;
  }
  if (!snapshot || !snapshot.loaded) return { snapshot, waited };
  const readyDeadline = now() + timeoutMs;
  while (!snapshot.scopeReady && now() < readyDeadline && !cancelled()) {
    waited = true;
    await sleep(POLL_MS);
    snapshot = (await readBy(readyDeadline)) ?? snapshot;
  }
  return { snapshot, waited };
}
