/**
 * Recovery-flow flag shared between authHandlers (which initiates a password
 * reset) and loopbackCallback (which detects the recovery code landing).
 *
 * Why its own module: authHandlers already imports LOOPBACK_CALLBACK_URL from
 * loopbackCallback. If loopbackCallback imported the flag back from
 * authHandlers we'd have a require-cycle at module-init time. Keeping the flag
 * in a leaf module both sides import sidesteps that entirely.
 *
 * Semantics: sendPasswordReset marks a request; the loopback callback consumes
 * the flag on the next successful code exchange. A reset the user never clicks
 * auto-expires after RECOVERY_TTL_MS so a stale flag can't misclassify an
 * unrelated email-verification landing as a recovery.
 */

/**
 * Window in which a marked reset request is still considered "fresh". Supabase
 * recovery links default to a 1-hour lifetime; we use a tighter 15-minute
 * window — comfortably longer than the click-the-email round-trip, short enough
 * that a forgotten reset request doesn't shadow a later verification landing.
 */
const RECOVERY_TTL_MS = 15 * 60 * 1000;

let requestedAt: number | null = null;

/** Mark that a password-reset email was just requested. */
export function markRecoveryRequested(): void {
  requestedAt = Date.now();
}

/**
 * Returns true (and clears the flag) iff a reset was requested within the TTL
 * window. Returns false — and still clears — for a stale or absent request, so
 * a single call fully resolves the flag either way.
 */
export function consumeRecoveryRequested(): boolean {
  if (requestedAt === null) return false;
  const fresh = Date.now() - requestedAt < RECOVERY_TTL_MS;
  requestedAt = null;
  return fresh;
}
