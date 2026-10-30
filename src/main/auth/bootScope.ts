/**
 * main/index.ts step 0a (260603 per-profile partitioning): pick the profile
 * scope the boot reads and writes, from the persisted Supabase session,
 * BEFORE any per-account store is touched. Signed in at boot -> the account's
 * UUID profile; signed out -> the anonymous 'local' profile.
 *
 * 261029: from the stored session alone (persistedSessionUserId), never
 * `auth.getSession()`: that refreshes an expired access token over the
 * network, and a refresh that failed here set 'local' under a session that
 * initAuthState then restored, locking the user on the sign-in panel.
 * initAuthState starts from the same stored session, so the two agree; the
 * auth subscription moves the scope on anything later.
 *
 * Its own module so the restart tests run the real step, not a copy of it.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { setActiveScope } from '../paths';
import { persistedSessionUserId } from './supabaseClient';

export async function applyBootScope(
  deps: { client?: SupabaseClient; warn?: (msg: string) => void } = {},
): Promise<string | null> {
  let bootScope: string | null = null;
  try {
    bootScope = await persistedSessionUserId(deps.client ? { client: deps.client } : {});
  } catch (err) {
    (deps.warn ?? console.warn)(`boot scope detection failed, defaulting to local: ${(err as Error).message}`);
  }
  setActiveScope(bootScope);
  return bootScope;
}
