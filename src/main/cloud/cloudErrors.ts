/**
 * Phase 11 — CLOUD_SYNC_* error sentinel strings.
 *
 * Source: 11-PATTERNS §Typed error class family (extends KEYCHAIN_* / SESSION_*
 *         prefix-coded convention). Renderer ERROR_COPY maps these to user-
 *         facing copy.
 *
 * Format: `<CODE>` for static errors, `<CODE>: <detail>` for wrapping
 *         supabase error messages.
 */

export const CLOUD_SYNC_REFUSED_DEFAULT   = 'CLOUD_SYNC_REFUSED_DEFAULT';
export const CLOUD_SYNC_REFUSED_DATA_URL  = 'CLOUD_SYNC_REFUSED_DATA_URL';
export const CLOUD_SYNC_UPSERT_FAILED     = 'CLOUD_SYNC_UPSERT_FAILED';
export const CLOUD_STORAGE_UPLOAD_FAILED  = 'CLOUD_STORAGE_UPLOAD_FAILED';
export const CLOUD_STORAGE_DELETE_FAILED  = 'CLOUD_STORAGE_DELETE_FAILED';
export const CLOUD_LIST_FAILED            = 'CLOUD_LIST_FAILED';
export const CLOUD_SYNC_TIMEOUT           = 'CLOUD_SYNC_TIMEOUT';
export const CLOUD_DELETE_FAILED          = 'CLOUD_DELETE_FAILED';
export const CLOUD_DOWNLOAD_FAILED        = 'CLOUD_DOWNLOAD_FAILED';

/**
 * Phase 12 — moderation gate sentinels (Plan 12-07).
 *
 * Surfaced by `publishWithModeration` in `moderationGate.ts` as the `code`
 * field of `PublishResult`. Renderer ERROR_COPY map in Wave 3 (Plan 12-10/11)
 * routes these to user-facing copy.
 *
 *   - IMAGE_FLAGGED   → SightEngine flagged the portrait. Caller must use a
 *                       different image.
 *   - PROMPT_FLAGGED  → OpenAI omni-moderation flagged name + persona_source
 *                       (hard tier) OR exhausted soft-tier regenerate retries.
 *                       Caller must edit persona or keep private.
 *   - PROVIDER_UNAVAILABLE → Edge Function 502 / network error / timeout.
 *                       Pitfall 12: never silently treated as clean — caller
 *                       refuses to publish (shared=true never set).
 */
export const CLOUD_MODERATION_IMAGE_FLAGGED        = 'CLOUD_MODERATION_IMAGE_FLAGGED';
export const CLOUD_MODERATION_PROMPT_FLAGGED       = 'CLOUD_MODERATION_PROMPT_FLAGGED';
export const CLOUD_MODERATION_PROVIDER_UNAVAILABLE = 'CLOUD_MODERATION_PROVIDER_UNAVAILABLE';

/**
 * Helper: does this error originate from the Phase 11 cloud client (or
 * its peers — TOS_* gate, PORTRAIT_* refinement)? Used by IPC handlers
 * that re-raise client errors verbatim so the renderer ERROR_COPY map
 * can match by prefix.
 */
export function isCloudSyncError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.startsWith('CLOUD_') || err.message.startsWith('TOS_') || err.message.startsWith('PORTRAIT_');
}
