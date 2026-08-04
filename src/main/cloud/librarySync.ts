/**
 * librarySync — mirror the local Home roster into the cloud `character_library`
 * table (migration 20260801000000).
 *
 * WHY THIS EXISTS. `characters.owner` records who AUTHORED a character, which
 * is not who has it in their library. Adopting Sui, Marv, Lyra, or a character
 * shared by another user only ever wrote local config
 * (UserConfig.added_default_ids / added_world_ids), so nothing server-side knew
 * an account had them. Analytics could only INFER a roster from `character_id`
 * event properties, which sees a character exactly when it is summoned, called,
 * or played in a minigame — never when it is merely texted, and never at all
 * for a user who opted out of analytics.
 *
 * WHOLE-SET RECONCILE, NOT PER-EVENT DELTAS. Roster membership is written from
 * at least six places (four IPC handlers, the unpublish reconcile sweep, two
 * one-shot config migrations, and onboarding), and a per-write hook would be
 * silently wrong the day a seventh appears. Instead every caller just asks for
 * a reconcile: this module reads the CURRENT config, diffs it against the
 * user's cloud rows, and writes the difference. That makes it idempotent,
 * self-healing (a write that failed offline is repaired by the next pass), and
 * correct for existing installs whose roster predates this table entirely —
 * their first sign-in after upgrading uploads the whole thing.
 *
 * OWN CHARACTERS ARE NOT RECORDED. They are already discoverable through
 * `characters.owner` and are never absent from their author's library, so a
 * second copy here would just be a second source of truth to drift.
 *
 * Never throws. A roster mirror is diagnostic, not load-bearing: signed-out,
 * offline, and RLS-rejected all resolve to "try again next time".
 */

import type { UserConfig } from '../../shared/characterSchema';

/** A roster entry as the cloud table stores it. */
interface RosterRow {
  character_id: string;
  source: 'default' | 'world';
}

/**
 * The roster as the config describes it, deduped. `added_world_ids` wins a
 * collision: the defaults-to-World migration (migration.ts
 * runDefaultsToWorldMigration) moves invited defaults across, and an install
 * caught mid-migration can briefly carry an id in both lists. Exported for
 * tests — pure, no IO.
 */
export function rosterFromConfig(cfg: Pick<UserConfig, 'added_default_ids' | 'added_world_ids'>): RosterRow[] {
  const out = new Map<string, RosterRow>();
  for (const id of cfg.added_default_ids ?? []) out.set(id, { character_id: id, source: 'default' });
  for (const id of cfg.added_world_ids ?? []) out.set(id, { character_id: id, source: 'world' });
  return [...out.values()];
}

/**
 * The writes needed to turn `remote` into `local`. A row whose SOURCE changed
 * is re-inserted, not left alone: the primary key is (user_id, character_id),
 * so the upsert corrects it in place. Exported for tests — pure, no IO.
 */
export function diffRoster(
  local: RosterRow[],
  remote: RosterRow[],
): { upsert: RosterRow[]; remove: string[] } {
  const remoteBy = new Map(remote.map((r) => [r.character_id, r]));
  const localIds = new Set(local.map((r) => r.character_id));
  return {
    upsert: local.filter((r) => remoteBy.get(r.character_id)?.source !== r.source),
    remove: remote.filter((r) => !localIds.has(r.character_id)).map((r) => r.character_id),
  };
}

// Single-flight: the IPC handlers below each save config and then ask for a
// reconcile, and a burst (restore-default immediately followed by an add) would
// otherwise race two read-diff-write passes against each other. A reconcile
// requested while one is running sets `again`, so the in-flight pass is
// followed by exactly one more that sees the final config.
let inFlight: Promise<void> | null = null;
let again = false;

/**
 * Reconcile the cloud roster with local config. Fire-and-forget: callers
 * `void syncLibraryRoster('reason')` after the config write they just made.
 * `reason` appears only in warning logs.
 */
export async function syncLibraryRoster(reason: string): Promise<void> {
  if (inFlight) {
    again = true;
    return inFlight;
  }
  inFlight = (async () => {
    try {
      await reconcileOnce(reason);
      while (again) {
        again = false;
        await reconcileOnce(reason);
      }
    } finally {
      inFlight = null;
      again = false;
    }
  })();
  return inFlight;
}

async function reconcileOnce(reason: string): Promise<void> {
  try {
    const { getClient, getAuthedClient } = await import('../auth/supabaseClient');
    const session = (await getClient().auth.getSession()).data.session;
    const userId = session?.user?.id;
    if (!userId || !session?.access_token) return; // signed out — nothing to mirror
    const db = getAuthedClient(session.access_token);

    const { loadConfig } = await import('../configStore');
    const local = rosterFromConfig(await loadConfig());

    const { data, error: readErr } = await db
      .from('character_library')
      .select('character_id,source')
      .eq('user_id', userId);
    if (readErr) {
      console.warn(`[sei] librarySync(${reason}) read failed: ${readErr.message}`);
      return;
    }
    const { upsert, remove } = diffRoster(local, (data ?? []) as RosterRow[]);

    if (upsert.length > 0) {
      const { error } = await db
        .from('character_library')
        .upsert(upsert.map((r) => ({ user_id: userId, ...r })), { onConflict: 'user_id,character_id' });
      if (error) console.warn(`[sei] librarySync(${reason}) upsert failed: ${error.message}`);
    }
    if (remove.length > 0) {
      const { error } = await db
        .from('character_library')
        .delete()
        .eq('user_id', userId)
        .in('character_id', remove);
      if (error) console.warn(`[sei] librarySync(${reason}) delete failed: ${error.message}`);
    }
  } catch (err) {
    console.warn(`[sei] librarySync(${reason}) threw: ${(err as Error).message}`);
  }
}
