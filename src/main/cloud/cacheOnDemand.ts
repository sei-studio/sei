/**
 * Phase 11 plan 11-19 — Cache-on-demand sync (D-19 / LIB-04).
 *
 * On a new machine after sign-in, the Characters page lists cloud rows.
 * When the user opens a character we don't yet have locally, fetch the row
 * + skin + portrait once and write to <userData>/. Subsequent opens are
 * offline-safe — that's the LIB-04 invariant: bot loop reads from local
 * files only, so anything cached here works without cloud.
 *
 * Source: 11-CONTEXT D-19 (cache-on-demand, no eager prefetch) + 11-RESEARCH
 *         §Pitfall 5 (conflict shadow path).
 *
 * MAIN PROCESS ONLY — uses node:fs, Buffer, and lazy-imports the cloud
 * client / supabase / characterStore (matches the lazy-import discipline
 * established by syncQueue.ts so module-init cycles are impossible).
 *
 * Two exports:
 *
 *   ensureLocallyCached(uuid)
 *     - existsSync(<userData>/characters/<uuid>.json) → return immediately
 *       (cache hit; works offline).
 *     - Local exists + sync queue has a pending op for this uuid →
 *       conflict path: download cloud row, write to <uuid>.json.conflict
 *       shadow file, log warning, DO NOT overwrite local. Pitfall 5 minimum
 *       viable.
 *     - Cache miss → fetch cloud row via cloudCharacterClient.downloadCharacter
 *       (throws CLOUD_CHARACTER_NOT_FOUND if cloud returns null), write JSON
 *       via saveCharacterRaw (BYPASSES the cloud-mirror enqueue — we don't
 *       want to re-upload what we just downloaded), then best-effort download
 *       + atomic-write skin + portrait.
 *
 *   listMerged()
 *     - Returns { characters: Array<{ id, name, is_default, source }> } where
 *       source ∈ {'local','cloud','both'}. Local rows win on the name field
 *       when both exist (the local cache is what the user has actually
 *       interacted with). Used by HomeScreen to render cloud-only characters
 *       alongside local ones with a CLOUD chip.
 */

import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
// allowJs:true in tsconfig.node.json lets TS resolve these .js modules.
import { atomicWrite } from '../../bot/brain/storage/atomicWrite.js';
import { withFileLock } from '../../bot/brain/storage/fileLock.js';
import { paths } from '../paths';
import type { Character } from '../../shared/characterSchema';

/**
 * HR-02 — per-uuid in-flight guard.
 *
 * Concurrent invocations for the same uuid (HomeScreen double-click, React
 * Strict-Mode double-invoke on CharacterPage mount, parallel card click +
 * navigation) used to both pass the existsSync cache-hit check and re-run
 * the full download path: wasted Supabase round-trip + skin/portrait re-
 * download + a second writer racing the first for the atomic-write target.
 * withFileLock prevented torn writes but not the wasted bandwidth or the
 * stale-overwrite-fresh race when the cloud row mutated between the two
 * queries.
 *
 * Map<uuid, Promise<void>>: concurrent calls share the in-flight promise;
 * the entry is cleaned up on resolve/reject so a future re-open re-checks
 * disk. Both the cache-hit short-circuit and the cache-miss download path
 * run inside the shared promise — the first caller that wins the Map insert
 * does the work, every subsequent caller awaits the same resolution.
 *
 * Same-tick callers also share: the Map is checked synchronously at function
 * entry, so two await ensureLocallyCached(uuid) calls in the same microtask
 * both see the second has the promise from the first.
 */
const inFlight = new Map<string, Promise<void>>();

export async function ensureLocallyCached(uuid: string): Promise<void> {
  const existing = inFlight.get(uuid);
  if (existing) return existing;
  const p = ensureLocallyCachedImpl(uuid).finally(() => {
    inFlight.delete(uuid);
  });
  inFlight.set(uuid, p);
  return p;
}

async function ensureLocallyCachedImpl(uuid: string): Promise<void> {
  const localJson = paths.characterPath(uuid);
  const localExists = existsSync(localJson);

  // Conflict detection (Pitfall 5 minimum viable): if local file exists AND
  // there is a pending sync op for this uuid, preserve the local copy and
  // dump the incoming cloud row to a .conflict shadow file.
  if (localExists) {
    try {
      const { getStatus } = await import('./syncQueue');
      const s = await getStatus();
      if (s.pendingByUuid[uuid]) {
        try {
          const { downloadCharacter } = await import('./cloudCharacterClient');
          const cloud = await downloadCharacter(uuid);
          if (cloud) {
            const conflictPath = `${localJson}.conflict`;
            await mkdir(path.dirname(conflictPath), { recursive: true });
            await withFileLock(conflictPath, async () => {
              await atomicWrite(conflictPath, JSON.stringify(cloud, null, 2) + '\n');
            });
            console.warn(
              `[sei] cache-on-demand: pending local write for ${uuid}; cloud version written to ${conflictPath}`,
            );
          }
        } catch (err) {
          console.warn(
            `[sei] cache-on-demand conflict shadow failed for ${uuid}: ${(err as Error).message}`,
          );
        }
        return;
      }
      // No conflict — local cache is good. First, check the cloud row for a
      // newer version and re-pull the whole stored set if the upstream author
      // (or a bundled default's system row) shipped changes — this is what
      // makes opening a foreign / default character's page deliver prompt /
      // image / description updates. No-op for characters the local user
      // authors (those are locally authoritative). Then Item 6: heal any
      // still-missing skin / portrait bytes (cheap existsSync gate; no network
      // unless an asset is actually missing).
      await refreshFromCloud(uuid);
      await healMissingAssets(uuid);
      return;
    } catch (err) {
      // syncQueue.getStatus failure shouldn't block a cache-hit return; the
      // local file is already on disk and bot reads from there.
      console.warn(
        `[sei] cache-on-demand getStatus failed for ${uuid}: ${(err as Error).message}`,
      );
      return;
    }
  }

  // Cache miss — fetch from cloud. NOTE: no sign-in requirement. Public
  // (shared) rows are readable by anon — RLS `characters_select_own_or_shared`
  // is `shared = true OR owner = auth.uid()` with no role restriction — so a
  // SIGNED-OUT user can open a World character to view it (item 5). The
  // download returns null for rows not visible to the caller (a private row
  // they don't own), which surfaces as CLOUD_CHARACTER_NOT_FOUND below.
  const { getClient } = await import('../auth/supabaseClient');
  const { data: { session } } = await getClient().auth.getSession();

  const { downloadCharacter, downloadSkin, downloadPortrait } = await import('./cloudCharacterClient');
  const cloud = await downloadCharacter(uuid);
  if (!cloud) {
    throw new Error(`CLOUD_CHARACTER_NOT_FOUND: ${uuid}`);
  }

  // Storage path is `<owner>/<uuid>.png` — for a foreign / World character the
  // bytes live under the ORIGINAL CREATOR's path (cloud.owner), NOT the current
  // user's. Fall back to the session only for legacy null-owner rows; when
  // signed out and the row somehow has no owner, skip the asset downloads.
  const ownerUuid = cloud.owner ?? session?.user?.id ?? null;

  // 260703 procgen: a FOREIGN-owned character cached from the World tab is a
  // 'world' companion locally, regardless of the kind the author stored (it is
  // not editable here and lives in the World tab). Own cloud copies keep their
  // authored kind. Legacy null-owner rows are left as-is.
  const isForeign = !!cloud.owner && cloud.owner !== (session?.user?.id ?? null);
  const toCache: Character = isForeign ? { ...cloud, kind: 'world' } : cloud;

  // Write character JSON via saveCharacterRaw (BYPASSES cloud-mirror enqueue).
  const { saveCharacterRaw } = await import('../characterStore');
  await saveCharacterRaw(toCache);

  if (ownerUuid) {
    // Skin + portrait bytes — best-effort and INDEPENDENT, so download them
    // concurrently. Failure of either does NOT abort the cache-on-demand; the
    // character JSON is already on disk and the bot renders with the default
    // skin. User can re-open later to retry, or apply a new skin.
    await Promise.all([
      writeSkin(downloadSkin, ownerUuid, uuid),
      writePortrait(downloadPortrait, ownerUuid, uuid),
    ]);
  }
}

type SkinDownloader = (owner: string, uuid: string) => Promise<Buffer | null>;

/**
 * Download + atomic-write a character's skin PNG. Best-effort; swallows + logs.
 * Returns true only when bytes actually landed on disk (false on a 404/null
 * download or any error) so the refresh path can gate reference adoption on it.
 */
async function writeSkin(downloadSkin: SkinDownloader, ownerUuid: string, uuid: string): Promise<boolean> {
  try {
    const skin = await downloadSkin(ownerUuid, uuid);
    if (skin) {
      const skinTarget = paths.skinPngPath(uuid);
      await mkdir(path.dirname(skinTarget), { recursive: true });
      await withFileLock(skinTarget, async () => {
        await atomicWrite(skinTarget, skin);
      });
      return true;
    }
    return false;
  } catch (err) {
    console.warn(
      `[sei] cache-on-demand skin download failed for ${uuid}: ${(err as Error).message}`,
    );
    return false;
  }
}

/**
 * Download + atomic-write a character's portrait PNG. Best-effort; swallows +
 * logs. Returns true only when bytes actually landed on disk (see writeSkin).
 */
async function writePortrait(downloadPortrait: SkinDownloader, ownerUuid: string, uuid: string): Promise<boolean> {
  try {
    const portrait = await downloadPortrait(ownerUuid, uuid);
    if (portrait) {
      const portraitTarget = paths.portraitPath(uuid);
      await mkdir(path.dirname(portraitTarget), { recursive: true });
      await withFileLock(portraitTarget, async () => {
        await atomicWrite(portraitTarget, portrait);
      });
      return true;
    }
    return false;
  } catch (err) {
    console.warn(
      `[sei] cache-on-demand portrait download failed for ${uuid}: ${(err as Error).message}`,
    );
    return false;
  }
}

/**
 * Item 6 — re-fetch a character's skin / portrait bytes when the local JSON
 * exists but an asset file is missing on disk. ensureLocallyCached's cache-hit
 * short-circuit otherwise never retries the best-effort asset downloads, so a
 * single failed download at first-open left the detail page's 3D skin preview
 * permanently blank for foreign (World-imported) characters. Storage path is
 * `<owner>/<uuid>.png`; for World-imported chars the bytes live under the
 * ORIGINAL author's owner id, read from the cached row (falling back to the
 * current session for legacy null-owner local copies).
 */
async function healMissingAssets(uuid: string): Promise<void> {
  try {
    const skinTarget = paths.skinPngPath(uuid);
    const portraitTarget = paths.portraitPath(uuid);
    const skinMissing = !existsSync(skinTarget);
    const portraitMissing = !existsSync(portraitTarget);
    if (!skinMissing && !portraitMissing) return;

    const { getCharacter } = await import('../characterStore');
    const local = await getCharacter(uuid);
    if (!local) return;

    const { getClient } = await import('../auth/supabaseClient');
    const { data: { session } } = await getClient().auth.getSession();
    const ownerUuid = local.owner ?? session?.user?.id;
    if (!ownerUuid) return;

    const { downloadSkin, downloadPortrait } = await import('./cloudCharacterClient');
    // Heal whichever assets are missing, concurrently.
    await Promise.all([
      skinMissing ? writeSkin(downloadSkin, ownerUuid, uuid) : Promise.resolve(),
      portraitMissing ? writePortrait(downloadPortrait, ownerUuid, uuid) : Promise.resolve(),
    ]);
  } catch (err) {
    console.warn(`[sei] cache-on-demand healMissingAssets ${uuid} failed: ${(err as Error).message}`);
  }
}

/**
 * Compare the cloud `updated_at` we last cached (`localTs`) against the row's
 * current `updated_at` (`cloudTs`). Returns true when the cloud copy is newer
 * and a re-pull is warranted.
 *
 *   - No cloud timestamp → nothing to compare against, skip (defensive: legacy
 *     rows missing the column).
 *   - No local timestamp → never tracked (pre-feature cache, or a freshly
 *     seeded default whose local JSON predates this field) → treat as stale so
 *     we adopt the latest and backfill the watermark. The adopted content is
 *     usually identical, so this self-heals to a no-op on the next open.
 *   - Otherwise strict ISO/epoch comparison.
 */
function isCloudNewer(localTs: string | null, cloudTs: string | null): boolean {
  if (!cloudTs) return false;
  if (!localTs) return true;
  const c = Date.parse(cloudTs);
  const l = Date.parse(localTs);
  if (!Number.isFinite(c)) return false;
  if (!Number.isFinite(l)) return true;
  return c > l;
}

/**
 * Refresh a locally-cached character from its cloud row when the upstream copy
 * is newer. Powers the "open the page → get the author's / default's latest
 * prompt, image, and description" behavior.
 *
 * SCOPE — only characters the local user does NOT author are refreshed:
 *   - bundled defaults (sui / lyra / clawd), whose canonical copy is a
 *     system-owned PUBLIC row, so local users receive prompt updates to the
 *     three defaults even though they have no other foreign characters; and
 *   - added World characters (owner !== current user).
 * A character the local user owns is locally authoritative — its edits mirror
 * UP to cloud, so we must never pull-overwrite it here. The conflict path above
 * already returns before this runs whenever a local sync op is pending.
 *
 * PRESERVED across a refresh (NOT overwritten from cloud):
 *   - the memory directory (lives outside the character JSON; never touched);
 *   - local usage stats (`last_launched`, `playtime_ms`) and the immutable
 *     `created` stamp — those are the local user's, not the author's;
 *   - `is_default` and `owner` — identity flags that govern editability and
 *     re-seeding (the cloud download hardcodes is_default=false and would carry
 *     the system owner, which must not leak onto a locally-editable default).
 *
 * Best-effort: any failure (offline, timeout, row gone) is swallowed so the
 * cache-hit return is never blocked — the local copy already works (LIB-04).
 */
async function refreshFromCloud(uuid: string): Promise<void> {
  try {
    const { getCharacter } = await import('../characterStore');
    const local = await getCharacter(uuid);
    if (!local) return;

    const { getClient } = await import('../auth/supabaseClient');
    const { data: { session } } = await getClient().auth.getSession();
    const currentUserId = session?.user?.id ?? null;

    // Bundled defaults (sui/lyra/clawd) are authoritative from the APP BUNDLE,
    // never the cloud. refreshSeededDefaults re-asserts their authored fields
    // (persona, metadata.proactiveness, skin, …) from the shipped source on
    // every launch, so they auto-update through app releases. Pulling their
    // cloud row HERE adopts a STALE cloud copy and clobbers the bundle value —
    // e.g. Sui flips from the bundle's Agentic back to the cloud row's Reactive
    // moments after launch (the "showed agentic for a second, then dropped to
    // reactive" report). Skip them entirely; the bundle is the single source of
    // truth for defaults.
    if (local.is_default === true) return;
    const isForeign = !!local.owner && local.owner !== currentUserId;
    // Item 4 (cross-device): ALSO refresh the user's OWN cloud-backed characters
    // (owner === currentUserId), not just foreign. A public/private
    // toggle (or any edit) made on ANOTHER device bumps the cloud row's
    // updated_at; pulling it here on next open propagates the new `shared` flag
    // (and content) to this device, fixing the "toggle on device A doesn't update
    // device B" report. Still guarded below by the cloud_updated_at watermark
    // (never clobbers a NEWER local edit) and by ensureLocallyCached, which bails
    // when a local sync op for this uuid is pending (so unsynced local edits win).
    // Local-only characters (owner === null, no cloud row) are still skipped.
    const isOwnCloud = !!local.owner && local.owner === currentUserId;
    if (!isForeign && !isOwnCloud) return;

    const { downloadCharacter } = await import('./cloudCharacterClient');
    const cloud = await downloadCharacter(uuid);
    // Row absent / unpublished — leave the local copy in place. Eviction of
    // unshared added-world chars is reconcileLocalOwnership's job, not ours.
    if (!cloud) return;

    if (!isCloudNewer(local.cloud_updated_at ?? null, cloud.cloud_updated_at ?? null)) {
      return;
    }

    // Adopt the author's content fields unconditionally; preserve local
    // identity + stats (see docblock). Asset references + the watermark are set
    // below, gated on the bytes actually landing.
    const refreshed: Character = {
      ...local,
      name: cloud.name,
      slug: cloud.slug,
      username: cloud.username,
      shared: cloud.shared,
      persona: cloud.persona,
      description: cloud.description ?? null,
      metadata: cloud.metadata,
    };

    // Images: only adopt a cloud portrait/skin REFERENCE once its bytes are
    // cached locally — otherwise keep the local (bundled) reference so the
    // offline baseline keeps rendering. Bundled defaults carry portrait_image=
    // null / skin.source='bundled' in their cloud row, so wantX is false and
    // the local art is untouched; once their cloud row is flipped to point at
    // uploaded storage objects, wantX becomes true and we adopt + cache them.
    const ownerUuid = cloud.owner ?? currentUserId ?? null;
    const wantPortrait = !!cloud.portrait_image;
    const wantSkin = cloud.skin.source !== 'bundled' && cloud.skin.source !== 'none';

    let portraitOk = !wantPortrait; // nothing to fetch counts as success
    let skinOk = !wantSkin;
    if (ownerUuid && (wantPortrait || wantSkin)) {
      const { downloadSkin, downloadPortrait } = await import('./cloudCharacterClient');
      const [pOk, sOk] = await Promise.all([
        wantPortrait ? writePortrait(downloadPortrait, ownerUuid, uuid) : Promise.resolve(true),
        wantSkin ? writeSkin(downloadSkin, ownerUuid, uuid) : Promise.resolve(true),
      ]);
      portraitOk = pOk;
      skinOk = sOk;
    }
    if (wantPortrait && portraitOk) refreshed.portrait_image = cloud.portrait_image;
    if (wantSkin && skinOk) refreshed.skin = cloud.skin;

    // Advance the watermark only when everything we wanted to adopt landed. A
    // failed asset download keeps the prior (stale) watermark so the NEXT open
    // retries the full refresh — content re-adoption is idempotent, and this is
    // how a transient asset 404 self-heals without the separate heal path
    // needing to know the (system) owner the bytes live under.
    const allAssetsOk = portraitOk && skinOk;
    refreshed.cloud_updated_at = allAssetsOk
      ? (cloud.cloud_updated_at ?? null)
      : (local.cloud_updated_at ?? null);

    const { saveCharacterRaw } = await import('../characterStore');
    await saveCharacterRaw(refreshed);

    console.log(
      `[sei] cache-on-demand: refreshed ${uuid} from cloud (updated_at ${cloud.cloud_updated_at}, assets ${allAssetsOk ? 'ok' : 'pending'})`,
    );
  } catch (err) {
    console.warn(
      `[sei] cache-on-demand refresh failed for ${uuid}: ${(err as Error).message}`,
    );
  }
}

export interface MergedCharacterListing {
  id: string;
  name: string;
  is_default: boolean;
  source: 'local' | 'cloud' | 'both';
}

/**
 * Merge the local character list with the signed-in user's cloud row list.
 * Dedupes by id and annotates each entry with its source. Local rows take
 * priority on the name field when both exist (the local copy is what the
 * user has been editing).
 *
 * Signed-out users get local-only (no cloud listing attempted).
 * Cloud-list failure logs a warning and returns local-only (the LIB-04
 * invariant: never regress offline UX on a transient network issue).
 */
export async function listMerged(): Promise<{ characters: MergedCharacterListing[] }> {
  const { listCharacters } = await import('../characterStore');
  const local = await listCharacters();
  const localMap = new Map<string, { id: string; name: string; is_default: boolean }>();
  for (const c of local) {
    localMap.set(c.id, { id: c.id, name: c.name, is_default: c.is_default });
  }

  const { getClient } = await import('../auth/supabaseClient');
  const { data: { session } } = await getClient().auth.getSession();
  const cloudMap = new Map<string, { id: string; name: string }>();
  if (session?.user?.id) {
    try {
      const { listMyCharacters } = await import('./cloudCharacterClient');
      const rows = await listMyCharacters(session.user.id);
      for (const r of rows) {
        cloudMap.set(r.id, { id: r.id, name: r.name });
      }
    } catch (err) {
      console.warn(
        `[sei] cache-on-demand listMerged cloud fetch failed: ${(err as Error).message}`,
      );
    }
  }

  const allIds = new Set<string>([...localMap.keys(), ...cloudMap.keys()]);
  const merged: MergedCharacterListing[] = [];
  for (const id of allIds) {
    const l = localMap.get(id);
    const c = cloudMap.get(id);
    const source: 'local' | 'cloud' | 'both' = l && c ? 'both' : l ? 'local' : 'cloud';
    merged.push({
      id,
      name: (l?.name ?? c?.name)!,
      is_default: l?.is_default ?? false,
      source,
    });
  }
  return { characters: merged };
}

/**
 * Item 4 (cross-device) — eagerly pull the signed-in user's OWN cloud
 * characters into the local library on sign-in, so they appear in the IconRail
 * + Home grid immediately instead of only after being opened from the World /
 * Summons list (which is what triggered cache-on-demand before). Each
 * `ensureLocallyCached` cache-misses → writes the JSON + appends to the index
 * (so listCharacters surfaces it), or cache-hits → refreshes from cloud. Runs
 * BEFORE the renderer re-bootstraps (called from profileScope.switchScopeForAuth)
 * so the post-sign-in character reload sees them. Best-effort throughout.
 */
export async function cacheMyCloudCharacters(ownerUuid: string): Promise<void> {
  if (!ownerUuid) return;
  try {
    const { listMyCharacters } = await import('./cloudCharacterClient');
    const rows = await listMyCharacters(ownerUuid);
    // Cache in PARALLEL so the wall-time (this runs on the sign-in critical path,
    // before the renderer re-bootstraps) is bounded by the slowest single
    // character rather than the sum across an account with many characters. Each
    // ensureLocallyCached is independently best-effort.
    await Promise.all(
      rows.map((row) =>
        ensureLocallyCached(row.id).catch((err) =>
          console.warn(`[sei] eager-cache own char ${row.id} failed: ${(err as Error).message}`),
        ),
      ),
    );
  } catch (err) {
    console.warn(`[sei] cacheMyCloudCharacters failed: ${(err as Error).message}`);
  }
}
