/**
 * Sign-in owner reconciliation.
 *
 * Cleans up the on-disk character cache when the user signs in. Two failure
 * modes this guards against:
 *
 *   1. Leaked content: a previous account on the same install left files in
 *      <userData>/characters/<uuid>.json that the new account does NOT own.
 *      Without this sweep they surface on HomeGrid as "MINE" (the null-owner
 *      legacy branch in HomeGrid) and the chars:set-shared moderation gate
 *      then 502s because the upsert is RLS-denied.
 *
 *   2. Mis-stamped owner: a save fired BEFORE the owner-stamp landed left
 *      `owner: null` on a foreign character. We re-stamp from the cloud row
 *      so the renderer-side ownership checks (CharacterPage viewOnly,
 *      HomeGrid filter) are correct.
 *
 * Rules per non-default local character (every char is checked against cloud,
 * because a stale local owner-stamp can be a lie — e.g., a previous save
 * force-stamped owner=current-user onto a leaked-from-another-account file):
 *   - cloud row exists, owner === current user → stamp local owner (no-op
 *     if already correct).
 *   - cloud row exists, owner !== current user → DELETE local file +
 *     drop any sync-queue ops for this id. This is the Eris-leak fix.
 *   - cloud row missing, local owner == current user → keep (legitimately
 *     local, you own it).
 *   - cloud row missing, local owner == null → claim: stamp owner = current user.
 *   - cloud row missing, local owner != current user → DELETE local
 *     (orphaned foreign content; the cloud row was already torn down or
 *     never existed).
 *
 * Best-effort: any per-character failure is logged and we move on so a
 * single network blip doesn't strand the user out of their library.
 */

import { unlink } from 'node:fs/promises';
import { paths } from '../paths';

export async function reconcileLocalOwnershipOnSignIn(
  currentUserId: string,
): Promise<void> {
  const { listCharacters, saveCharacterRaw } = await import('../characterStore');
  const { downloadCharacter } = await import('./cloudCharacterClient');
  const { dropOpsForUuid } = await import('./syncQueue');
  const { loadConfig, saveConfig } = await import('../configStore');

  let chars;
  try {
    chars = await listCharacters();
  } catch (err) {
    console.warn(
      `[sei] reconcile: listCharacters failed: ${(err as Error).message}`,
    );
    return;
  }

  // Chars the user explicitly added from the World tab are NOT leaks — they're
  // foreign-owned by design. Skip them in the cloud.owner !== currentUserId
  // delete branch below, otherwise reconcile undoes every "+ Add to Mine"
  // click as soon as the user signs in (or re-signs in).
  let addedWorldIds = new Set<string>();
  try {
    const cfg = await loadConfig();
    addedWorldIds = new Set(cfg.added_world_ids ?? []);
  } catch {
    /* empty set — worst case we wrongly delete an added world char, but
       the user can re-add it; better than crashing reconcile. */
  }

  // Item 10: track added_world_ids removals so we persist them once after the
  // sweep (the set is mutated in the unpublish-cleanup branch below).
  let addedWorldIdsChanged = false;

  for (const c of chars) {
    if (c.is_default) continue;
    if (addedWorldIds.has(c.id)) {
      // Item 10 — unpublish cleanup. A character the user added from the World
      // tab whose source row is no longer shared (author flipped it
      // public→private) or was deleted should leave the user's library. Per
      // the product decision: drop the persona CONTENT (character JSON + skin +
      // portrait — the author's work; deleteLocalChar never touches the user's
      // memory files, which we deliberately keep) and remove it from
      // added_world_ids so it disappears from Home/World.
      //
      // Safety: only act on a DEFINITIVE cloud answer. downloadCharacter
      // returns null when the query SUCCEEDED but RLS returned no row
      // (foreign row is unshared, or deleted) and THROWS on a network error —
      // so a transient blip can't wrongly evict a still-valid add.
      try {
        const cloud = await downloadCharacter(c.id);
        if (!cloud || cloud.shared === false) {
          await deleteLocalChar(c.id);
          await dropOpsForUuid(c.id).catch(() => {});
          addedWorldIds.delete(c.id);
          addedWorldIdsChanged = true;
          console.log(
            `[sei] reconcile: world char ${c.id} no longer shared — dropped persona content, kept memory`,
          );
        }
      } catch {
        // Network error — keep the char (avoid a false eviction on a blip).
      }
      continue;
    }

    try {
      // Always consult the cloud as authoritative — a local owner-stamp can
      // be a lie if a previous save force-stamped current-user onto a leaked
      // foreign-owned file (the original Eris symptom).
      const cloud = await downloadCharacter(c.id);
      if (cloud) {
        if (cloud.owner === currentUserId) {
          // Cloud agrees you own it. Stamp the local copy if it drifted.
          if (c.owner !== currentUserId) {
            await saveCharacterRaw({ ...c, owner: currentUserId });
          }
          continue;
        }
        // Cloud says someone else owns this — delete the local leak.
        await deleteLocalChar(c.id);
        await dropOpsForUuid(c.id).catch(() => {});
        console.log(
          `[sei] reconcile: removed leaked local copy of ${c.id} (owned by another user in cloud)`,
        );
        continue;
      }
      // No cloud row.
      if (c.owner === currentUserId) continue; // legitimately local-only.
      if (c.owner == null) {
        // Legacy null-owner — claim it.
        await saveCharacterRaw({ ...c, owner: currentUserId });
        continue;
      }
      // Stamped foreign owner + no cloud row → orphaned leak. Drop locally.
      await deleteLocalChar(c.id);
      await dropOpsForUuid(c.id).catch(() => {});
      console.log(
        `[sei] reconcile: removed orphaned foreign-owned local copy of ${c.id}`,
      );
    } catch (err) {
      console.warn(
        `[sei] reconcile: ${c.id} failed: ${(err as Error).message}`,
      );
    }
  }

  // Item 10: persist any added_world_ids removed by the unpublish-cleanup sweep
  // above so the dropped chars don't re-count as "in library" on the next
  // browse:list / HomeGrid render. Best-effort: a write failure just means the
  // (already-deleted-on-disk) char is reconsidered next launch.
  if (addedWorldIdsChanged) {
    try {
      const cfg = await loadConfig();
      await saveConfig({ ...cfg, added_world_ids: Array.from(addedWorldIds) });
    } catch (err) {
      console.warn(
        `[sei] reconcile: persisting added_world_ids after unpublish cleanup failed: ${(err as Error).message}`,
      );
    }
  }
}

async function deleteLocalChar(id: string): Promise<void> {
  // Hand-rolled rather than calling characterStore.deleteCharacter so we
  // skip the cloud-mirror delete enqueue — the cloud row is owned by someone
  // else and we have no business asking Supabase to delete it.
  const targets = [
    paths.characterPath(id),
    paths.characterPortraitPath(id),
    paths.skinPngPath(id),
  ];
  for (const target of targets) {
    try {
      await unlink(target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[sei] reconcile: unlink ${target} failed: ${(err as Error).message}`);
      }
    }
  }
  // Drop from the character index too so chars.list doesn't re-surface it.
  try {
    const { readFile, writeFile, mkdir } = await import('node:fs/promises');
    const indexPath = paths.indexPath();
    let raw: string;
    try {
      raw = await readFile(indexPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    const parsed = JSON.parse(raw) as { version?: number; order?: unknown };
    if (!Array.isArray(parsed.order)) return;
    const next = parsed.order.filter((x) => x !== id);
    if (next.length === parsed.order.length) return;
    await mkdir(paths.charactersDir(), { recursive: true });
    await writeFile(
      indexPath,
      JSON.stringify({ version: 1, order: next }, null, 2) + '\n',
    );
  } catch (err) {
    console.warn(
      `[sei] reconcile: index rewrite for ${id} failed: ${(err as Error).message}`,
    );
  }
}
