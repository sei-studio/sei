/**
 * Phase 11 — Belt-and-suspenders Storage orphan cleanup writer.
 *
 * Source: 11-RESEARCH §Pitfall 6 (cloud delete succeeds, Storage delete fails).
 *         Inserts a deletion_queue row at the moment of character delete; the
 *         Plan 11-01 storage_purge_extend cron iterates storage_paths nightly
 *         and deletes storage.objects. If the syncQueue.processNext path also
 *         deleted the storage objects directly, the cron finds them already
 *         gone (storage.objects DELETE is idempotent — WHERE clause filters to
 *         nothing).
 *
 * RLS contract:
 *   - The 20260521000300_deletion_queue_user_insert migration grants
 *     `insert` to authenticated users where user_id = auth.uid().
 *     A signed-out caller, or a caller naming a foreign owner UUID, will
 *     fail the RLS with-check and supabase returns an error we wrap as
 *     CLOUD_DELETION_QUEUE_INSERT_FAILED.
 *   - The cron body in 20260521000200_storage_purge_extend.sql separately
 *     filters each storage_paths entry to ones whose first segment matches
 *     the row's user_id, so even a row that somehow named a foreign path
 *     cannot trigger a cross-user storage delete (T-11-10-01).
 *
 * MAIN PROCESS ONLY — do not import from renderer (Phase 10 invariant).
 */

import { getClient } from '../auth/supabaseClient';

const TIMEOUT_MS = 15_000;

const CLOUD_DELETION_QUEUE_INSERT_FAILED = 'CLOUD_DELETION_QUEUE_INSERT_FAILED';

/**
 * Insert one deletion_queue row carrying the given storage paths. The
 * deletion_requested_at column defaults to now() at the DB so we do not pass
 * it. The cron (Plan 11-01 storage_purge_extend) wakes at 03:00 UTC, finds
 * the rows older than 30 days, deletes the named storage.objects, and marks
 * purged_at = now().
 *
 * Idempotency: callers may also fire a direct delete via the sync queue. If
 * the direct delete succeeds, the cron finds the objects already gone and
 * the DELETE WHERE name = ANY(...) is a no-op — safe.
 *
 * Behavior:
 *   - Empty `paths` returns immediately without calling supabase.
 *   - Supabase error → throw CLOUD_DELETION_QUEUE_INSERT_FAILED with the wrapped message.
 *   - 15s AbortController timeout — pattern from cloudCharacterClient.ts.
 */
export async function enqueueStorageOrphans(
  ownerUuid: string,
  paths: string[],
): Promise<void> {
  if (paths.length === 0) return;
  const supabase = getClient();
  const controller = new AbortController();
  const handle = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const { error } = await supabase
      .from('deletion_queue')
      .insert({
        user_id: ownerUuid,
        storage_paths: paths,
      })
      .abortSignal(controller.signal);
    if (error) throw new Error(`${CLOUD_DELETION_QUEUE_INSERT_FAILED}: ${error.message}`);
  } finally {
    clearTimeout(handle);
  }
}
