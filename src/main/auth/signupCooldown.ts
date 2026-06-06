/**
 * Escalating per-device account-creation cooldown (anti-abuse, Layer 1).
 *
 * MAIN PROCESS ONLY.
 *
 * Backed by a DEVICE-GLOBAL JSON file `<userData>/signup-attempts.json` (via
 * `paths.signupAttemptsPath()`) holding a rolling window of signup ATTEMPT
 * timestamps (epoch ms). NO emails, NO PII — only timestamps.
 *
 * Policy (ABUSE-GUARD-PLAN.md §4a) — tuned so a human making 2-3 accounts
 * barely notices, but rapid automation is throttled hard:
 *
 *   attempts already in 24h window → required wait before the NEXT attempt
 *     0 → 0s        (1st signup: instant)
 *     1 → 30s       (2nd)
 *     2 → 2min      (3rd)
 *     3 → 8min      (4th)
 *     4+ → 30min    (5th and beyond, capped)
 *
 * The wait is measured from the MOST RECENT attempt. A human spacing signups
 * by more than the required wait never sees a block; a tight automation loop is
 * clamped to ~2 accounts/hour after the 4th.
 *
 * THIS IS FRICTION, NOT SECURITY. An attacker can delete the file. The hard
 * walls are server-side (Supabase per-IP auth limits + Turnstile, signup-guard
 * per-IP bucket, trial-claim per-account/per-device/per-IP gates). The
 * cooldown's job is to make casual scripting unrewarding and to shield Supabase
 * from a naive local loop.
 *
 * Atomic tmp+rename write mirrors `apiKeyStore.ts` / `sessionStore.ts`.
 *
 * NOTE (paths.ts partition refactor): `signupAttemptsPath()` MUST stay in the
 * DEVICE-GLOBAL tier — the cooldown is a property of the machine, not an
 * account. See ABUSE-GUARD-PLAN.md §9.
 */
import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { paths } from '../paths';

/** Rolling window over which attempts are counted. */
export const COOLDOWN_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Required wait (ms) before the Nth attempt, indexed by the count of attempts
 * already in-window. Index 0 = first signup (instant). The last entry is the
 * cap for every subsequent attempt.
 */
export const COOLDOWN_LADDER_MS: readonly number[] = [
  0,             // 1st
  30_000,        // 2nd  → 30s
  2 * 60_000,    // 3rd  → 2min
  8 * 60_000,    // 4th  → 8min
  30 * 60_000,   // 5th+ → 30min (cap)
];

interface AttemptsFile {
  /** Epoch-ms timestamps of recent signup attempts (within the window). */
  attempts: number[];
}

export interface CooldownDecision {
  /** Whether a signup attempt is allowed RIGHT NOW. */
  allowed: boolean;
  /** When blocked, ms the caller must wait before retrying (>0). 0 when allowed. */
  retryAfterMs: number;
}

async function readAttempts(now: number): Promise<number[]> {
  let raw: string;
  try {
    raw = await readFile(paths.signupAttemptsPath(), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    return []; // any other read error → treat as empty (fail open for humans)
  }
  try {
    const parsed = JSON.parse(raw) as Partial<AttemptsFile>;
    const arr = Array.isArray(parsed?.attempts) ? parsed.attempts : [];
    // Keep only well-formed, in-window timestamps.
    return arr
      .filter((t): t is number => typeof t === 'number' && Number.isFinite(t))
      .filter((t) => now - t < COOLDOWN_WINDOW_MS)
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

async function writeAttempts(attempts: number[]): Promise<void> {
  const target = paths.signupAttemptsPath();
  const tmp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.tmp.${process.pid}.${Date.now()}`,
  );
  await mkdir(path.dirname(target), { recursive: true });
  const payload: AttemptsFile = { attempts };
  try {
    await writeFile(tmp, JSON.stringify(payload), 'utf8');
    await rename(tmp, target);
  } catch (err) {
    try { await unlink(tmp); } catch {}
    throw err;
  }
}

function requiredWaitMs(attemptsInWindow: number): number {
  const idx = Math.min(attemptsInWindow, COOLDOWN_LADDER_MS.length - 1);
  return COOLDOWN_LADDER_MS[idx];
}

/**
 * Decide whether a signup attempt is allowed NOW, based on the escalating
 * ladder applied to the most-recent in-window attempt. Does NOT record an
 * attempt — call {@link recordSignupAttempt} when the attempt is actually made.
 *
 * `nowFn` is injectable for deterministic tests.
 */
export async function checkSignupCooldown(
  nowFn: () => number = Date.now,
): Promise<CooldownDecision> {
  const now = nowFn();
  const attempts = await readAttempts(now);
  if (attempts.length === 0) {
    return { allowed: true, retryAfterMs: 0 };
  }
  const last = attempts[attempts.length - 1];
  const wait = requiredWaitMs(attempts.length);
  const elapsed = now - last;
  if (elapsed >= wait) {
    return { allowed: true, retryAfterMs: 0 };
  }
  return { allowed: false, retryAfterMs: wait - elapsed };
}

/**
 * Record a signup attempt at `now`. Called REGARDLESS of whether the server
 * accepts the signup, so an attacker can't dodge the ladder by triggering a
 * server-side 4xx. Prunes out-of-window timestamps as a side effect.
 *
 * Best-effort: a write failure is swallowed (the cooldown is friction, not a
 * security gate — a failed write just means this attempt isn't counted).
 */
export async function recordSignupAttempt(nowFn: () => number = Date.now): Promise<void> {
  const now = nowFn();
  const attempts = await readAttempts(now);
  attempts.push(now);
  try {
    await writeAttempts(attempts);
  } catch {
    // swallow — friction layer, never block signup on a write error
  }
}

/** TEST-ONLY: convenience to compute the ladder wait for an attempt count. */
export function _requiredWaitMsForTests(attemptsInWindow: number): number {
  return requiredWaitMs(attemptsInWindow);
}
