/**
 * Phase 11 — ToS + Privacy acceptance gate.
 *
 * Source: 11-RESEARCH §Code Example 5 + 11-PATTERNS §tosGate.ts.
 *
 * Backed by the `tos_acceptance(user_id, tos_version, privacy_version, accepted_at)`
 * table from Plan 11-01. RLS: user can select/insert their own rows only
 * (insert+select-own; no update or delete — accepted rows are immutable,
 * see T-11-12-02).
 *
 * The check matches against the CURRENT versions in legalVersions.ts — when
 * versions bump, the user is re-prompted (Plan 11-13 mounts the AcceptToSModal
 * at next launch when isTosAccepted returns false).
 *
 * Fail-closed: any supabase error from isTosAccepted resolves to `false`,
 * never throws. The downstream gate (Plan 11-14 isCloudWriteAllowed) prefers
 * to over-block on a transient network error rather than risk writing user
 * data to the cloud before they've accepted the current ToS version.
 *
 * Timeout invariant (CLAUDE.md): every external call has a wall-clock
 * timeout. Both functions wrap supabase queries in a 15s AbortController.
 */

import { getClient } from './supabaseClient';
import { TOS_VERSION, PRIVACY_VERSION } from '../../shared/legalVersions';

const TIMEOUT_MS = 15_000;

/**
 * Has this user accepted the CURRENT ToS + Privacy versions?
 *
 * Returns true iff a tos_acceptance row exists whose tos_version AND
 * privacy_version both equal the active constants. A bump to either constant
 * effectively invalidates every prior acceptance and re-prompts on next launch.
 *
 * Fail-closed: any supabase error (RLS denial, network failure, timeout)
 * returns false. This is the intended behavior — we'd rather force a fresh
 * acceptance prompt than mistakenly grant cloud-write access. See T-11-12-03
 * (the cloud-write gate in Plan 11-14 is a defense-in-depth check beyond
 * this read).
 */
export async function isTosAccepted(userId: string): Promise<boolean> {
  const supabase = getClient();
  const controller = new AbortController();
  const handle = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const { data, error } = await supabase
      .from('tos_acceptance')
      .select('tos_version, privacy_version')
      .eq('user_id', userId)
      .eq('tos_version', TOS_VERSION)
      .eq('privacy_version', PRIVACY_VERSION)
      .limit(1)
      .abortSignal(controller.signal);
    if (error) return false; // fail-closed
    return (data ?? []).length > 0;
  } catch {
    // AbortError on timeout, network throws, anything else: fail-closed.
    return false;
  } finally {
    clearTimeout(handle);
  }
}

/**
 * Record a user's acceptance of the CURRENT ToS + Privacy versions.
 *
 * Inserts a row into `tos_acceptance` (user_id, tos_version, privacy_version);
 * `accepted_at` defaults to now() per the migration in Plan 11-01.
 *
 * Throws `Error('TOS_RECORD_FAILED: <supabase msg>')` on any insert failure —
 * the caller decides whether to surface (blocking modal in Plan 11-13) or
 * swallow (signup success branch in authHandlers, where we fire-and-forget
 * because the next launch's blocking modal will re-prompt anyway).
 *
 * Reentrancy: a re-insert of the same (user_id, tos_version, privacy_version)
 * triple is benign — the table has no uniqueness constraint on those columns
 * (D-27), so a duplicate row just records a second timestamp. Plan 11-13's
 * modal won't fire because isTosAccepted is already true after the first.
 */
export async function recordAcceptance(userId: string): Promise<void> {
  const supabase = getClient();
  const controller = new AbortController();
  const handle = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const { error } = await supabase
      .from('tos_acceptance')
      .insert({
        user_id: userId,
        tos_version: TOS_VERSION,
        privacy_version: PRIVACY_VERSION,
      })
      .abortSignal(controller.signal);
    if (error) throw new Error(`TOS_RECORD_FAILED: ${error.message}`);
  } finally {
    clearTimeout(handle);
  }
}
