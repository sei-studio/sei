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
 * Tri-state acceptance status (260610 offline-misfire fix).
 *
 * 'accepted' / 'not_accepted' are DEFINITIVE — the query reached the database
 * and we know whether a current-version row exists. 'unknown' means the query
 * never produced an answer (DNS failure, offline, timeout, RLS denial, any
 * supabase error): callers must not treat it as "user hasn't accepted".
 *
 * Why this exists: isTosAccepted's fail-closed boolean collapsed 'unknown'
 * into false, so a transient DNS failure at launch (getaddrinfo ENOTFOUND)
 * re-showed the BLOCKING legal modal to a user who had already accepted —
 * and their re-accept then hit the composite-PK duplicate error. The modal
 * gate (tos:status IPC) now consumes the tri-state and shows an offline
 * notice for 'unknown' instead; the cloud-write gate still fails closed.
 */
export type TosAcceptance = 'accepted' | 'not_accepted' | 'unknown';

/**
 * Has this user accepted the CURRENT ToS + Privacy versions?
 *
 * 'accepted' iff a tos_acceptance row exists whose tos_version AND
 * privacy_version both equal the active constants. A bump to either constant
 * effectively invalidates every prior acceptance and re-prompts on next launch.
 *
 * Only a SUCCESSFUL query with zero rows yields 'not_accepted' — any error
 * (RLS denial, network failure, timeout) yields 'unknown', which downstream
 * gates treat as fail-closed for cloud writes (T-11-12-03) but NOT as grounds
 * to re-show the blocking legal modal.
 */
export async function getTosAcceptance(userId: string): Promise<TosAcceptance> {
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
    if (error) return 'unknown';
    return (data ?? []).length > 0 ? 'accepted' : 'not_accepted';
  } catch {
    // AbortError on timeout, network throws, anything else: inconclusive.
    return 'unknown';
  } finally {
    clearTimeout(handle);
  }
}

/**
 * Boolean convenience over {@link getTosAcceptance} preserving the original
 * fail-closed contract: 'unknown' and 'not_accepted' both map to false. Used
 * by the cloud-write gate (authState.isCloudWriteAllowed), where over-blocking
 * on a transient error is the intended behavior.
 */
export async function isTosAccepted(userId: string): Promise<boolean> {
  return (await getTosAcceptance(userId)) === 'accepted';
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
 * Reentrancy: the table's PRIMARY KEY is composite (user_id, tos_version,
 * privacy_version) — see migration 20260521000000_characters_tos.sql — so a
 * re-insert of the same triple raises Postgres 23505 (unique_violation).
 * That duplicate means the acceptance is ALREADY recorded, so it is treated
 * as success here, not surfaced as an error. (An earlier version of this
 * doc claimed there was no uniqueness constraint — that was wrong, and a
 * 260610 incident showed the blocking modal trapping an already-accepted
 * user on the duplicate-key error after a transient offline launch.)
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
    if (error) {
      const code = (error as { code?: string }).code;
      const isDuplicate =
        code === '23505' || /duplicate key value/i.test(error.message ?? '');
      if (isDuplicate) return; // already accepted — idempotent success
      throw new Error(`TOS_RECORD_FAILED: ${error.message}`);
    }
  } finally {
    clearTimeout(handle);
  }
}
