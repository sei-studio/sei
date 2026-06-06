/**
 * Phase 10/11 — Export envelope builder (AUTH-07 / LIB-01).
 *
 * Schema is LOCKED at v1 per CONTEXT D-14:
 *   - Phase 10 fills `account` only.
 *   - Phase 11 fills `characters` (cloud character definitions) — THIS file.
 *   - Phase 12 fills `sharing` (public listings the user has published).
 *
 * The EMPTY-BUT-PRESENT contract for `characters` and `sharing` is
 * load-bearing — Phase 11/12 must NOT bump the schemaVersion just because
 * they add data to existing keys. Documented in this file + the type comment.
 *
 * Phase 11 change: buildExport is now async. The function pulls every row
 * owned by the signed-in user via
 *   supabase.from('characters').select('*').eq('owner', session.user.id)
 * and writes the raw DB rows (snake_case columns) into `characters[]`.
 * RLS on the characters table is the primary owner-scope gate; the explicit
 * .eq('owner', ...) is belt-and-suspenders (T-11-11-01 mitigation).
 *
 * Every supabase call is wrapped in a 15s AbortController timeout to match
 * the CLAUDE.md "every external call has a timeout" invariant
 * (T-11-11-02 mitigation), mirroring cloudCharacterClient.withTimeout.
 *
 * Source: 10-CONTEXT D-14 (schema contract) + 11-RESEARCH §Export envelope.
 */
import type { Session } from '@supabase/supabase-js';
import { getClient } from './supabaseClient';

/**
 * v1 export schema. ALL FIVE KEYS are part of the contract; downstream
 * phases REPLACE the values of `characters` and `sharing` with non-empty
 * arrays but MUST NOT remove the keys or invent new top-level keys.
 *
 * `characters[]` carries the raw DB row shape (snake_case columns) — not the
 * wrapped/camelCase Character object the renderer renders. This preserves
 * what the user sees in the JSON download as a faithful snapshot of cloud
 * state (LIB-01 transparency).
 *
 * When the schema needs to evolve beyond v1, bump schemaVersion to 2 (or
 * add an optional v2-only top-level key) and document a migration in the
 * downstream phase's RESEARCH.
 */
export interface SeiExportV1 {
  schemaVersion: 1;
  exportedAt: string;        // ISO 8601 timestamp of export
  account: {
    email: string;            // empty string if Supabase returned null
    createdAt: string;        // Supabase auth.users.created_at (ISO)
  };
  characters: unknown[];      // Phase 11: filled with cloud character rows
  sharing: unknown[];         // Phase 12: filled with public listings
}

const TIMEOUT_MS = 15_000;

/**
 * Build the v1 export envelope.
 *
 * Phase 11 — fills characters[] via
 *   supabase.from('characters').select('*').eq('owner', session.user.id)
 * RLS allows the user to read their own rows; the result mirrors the DB
 * row shape (snake_case columns).
 *
 * Errors: on supabase failure, throws Error('CLOUD_LIST_FAILED: <msg>') —
 * authHandlers.exportData maps this to its existing
 *   { ok: false, code: 'write_failed', message }
 * envelope. The CLOUD_LIST_FAILED prefix matches the cloudCharacterClient
 * error vocabulary (see src/main/cloud/cloudErrors.ts) so the renderer
 * ERROR_COPY map can route by prefix.
 */
export async function buildExport(session: Session): Promise<SeiExportV1> {
  const supabase = getClient();
  const controller = new AbortController();
  const handle = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let characters: unknown[] = [];
  try {
    const { data, error } = await supabase
      .from('characters')
      .select('*')
      .eq('owner', session.user.id)
      .abortSignal(controller.signal);
    if (error) throw new Error(`CLOUD_LIST_FAILED: ${error.message}`);
    characters = (data as unknown[] | null) ?? [];
  } finally {
    clearTimeout(handle);
  }

  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    account: {
      email: session.user.email ?? '',
      createdAt: session.user.created_at,
    },
    characters,
    sharing: [],
  };
}
