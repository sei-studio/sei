/**
 * Phase 11 — Cloud character client (main-only).
 *
 * MAIN PROCESS ONLY — do not import from renderer (Phase 10 invariant
 * mirrors src/main/auth/supabaseClient.ts:1-11). Renderer goes through
 * IPC handlers in src/main/ipc.ts which call this module.
 *
 * Source: 11-RESEARCH §Code Examples 1, 2, 3 + §Pattern 1, §Pattern 3 +
 *         11-PATTERNS §cloudCharacterClient.ts (analog: edgeFunctionClient + skinStore).
 *
 * Invariants:
 *   - is_default: true rows NEVER upload (D-22) — checked BEFORE network call.
 *   - portrait_image starting with 'data:' NEVER uploads (Pitfall 2) — checked BEFORE.
 *   - Every call wrapped in 15s AbortController timeout.
 *   - Storage paths use NESTED layout `<ownerUuid>/<characterUuid>.png`
 *     matching Plan 11-01 storage.objects RLS (storage.foldername[1] = auth.uid()).
 *   - Singleton supabaseClient.getClient() by default — never instantiate a
 *     second client here. RLS-scoped writes that must resolve auth.uid()
 *     deterministically (the moderation pre-upload path) may pass an explicitly
 *     JWT-authed client built by the caller via supabaseClient.getAuthedClient;
 *     the singleton's ambient session is not reliably applied to storage
 *     requests in the main process (see supabaseClient.ts getAuthedClient).
 *
 * Error vocabulary: every thrown Error message starts with a CLOUD_* sentinel
 * from cloudErrors.ts so the renderer ERROR_COPY map can route by prefix.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getClient } from '../auth/supabaseClient';
import { callEdgeFunction } from '../auth/edgeFunctionClient';
import type { Character } from '../../shared/characterSchema';
import {
  CLOUD_SYNC_REFUSED_DEFAULT,
  CLOUD_SYNC_REFUSED_DATA_URL,
  CLOUD_SYNC_UPSERT_FAILED,
  CLOUD_STORAGE_UPLOAD_FAILED,
  CLOUD_STORAGE_DELETE_FAILED,
  CLOUD_LIST_FAILED,
  CLOUD_SYNC_TIMEOUT,
  CLOUD_DELETE_FAILED,
  CLOUD_DOWNLOAD_FAILED,
} from './cloudErrors';

const TIMEOUT_MS = 15_000;

/** Storage path layout — matches Plan 11-01 RLS `storage.foldername(name)[1] = auth.uid()`. */
function skinStoragePath(ownerUuid: string, characterUuid: string): string {
  return `${ownerUuid}/${characterUuid}.png`;
}

function portraitStoragePath(ownerUuid: string, characterUuid: string): string {
  return `${ownerUuid}/${characterUuid}.png`;
}

/**
 * Wrap a Supabase call in a 15s AbortController timeout. The supabase-js client
 * accepts `.abortSignal(signal)` on its query builder; we pass the controller's
 * signal through `fn`. On AbortError we re-throw as CLOUD_SYNC_TIMEOUT so the
 * renderer ERROR_COPY map can render a uniform "took too long" message.
 *
 * Pattern: src/main/auth/edgeFunctionClient.ts:30-81 (try/finally clearTimeout).
 */
async function withTimeout<T>(label: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const handle = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fn(controller.signal);
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') {
      throw new Error(`${CLOUD_SYNC_TIMEOUT}: ${label}`);
    }
    throw err;
  } finally {
    clearTimeout(handle);
  }
}

/**
 * Map a Supabase row → Character. Defensive defaults so a row missing newly
 * added columns (mid-deploy schema drift) still parses into a usable object.
 *
 * Note: is_default is HARD-CODED false here. The cloud never carries defaults
 * (D-22) — even if a row somehow had is_default=true (manual SQL, future
 * regression) we strip it on download. The local store re-derives is_default
 * from the bundled persona id list, not from the row.
 */
function rowToCharacter(row: Record<string, unknown>): Character {
  // Human-facing description is stashed inside the metadata JSONB so we don't
  // need a SQL migration for a dedicated column. The local Character schema
  // exposes it as a top-level `description` field; this projection moves it
  // out of metadata on the way in (and `upsertCharacter` folds it back in
  // on the way out).
  const metadata = ((row.metadata as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;
  const description =
    typeof metadata.description === 'string' ? metadata.description : null;
  const { description: _stripped, ...metadataWithoutDescription } = metadata;
  void _stripped;
  // Cloud column stores the bucket-relative Storage path `<owner>/<uuid>.png`
  // (the moderation Edge Function builds its SightEngine fetch URL straight
  // from this value). Locally we keep the bare `<uuid>.png` form so callers
  // don't have to special-case the prefix; strip it on the way in.
  const rawPortrait = (row.portrait_image as string | null) ?? null;
  const ownerStr = typeof row.owner === 'string' ? row.owner : null;
  const localPortrait =
    rawPortrait && ownerStr && rawPortrait.startsWith(`${ownerStr}/`)
      ? rawPortrait.slice(ownerStr.length + 1)
      : rawPortrait;
  return {
    id: row.id as string,
    // 260703 procgen: kind + server-assigned 4-char public tag ride the cloud
    // row; rows written before the migration lack both → default custom/null.
    kind: ((row.kind as string | null) ?? 'custom') as Character['kind'],
    public_id: (row.public_id as string | null) ?? null,
    name: row.name as string,
    slug: (row.slug as string | null) ?? null,
    persona: {
      source: (row.persona_source as string) ?? '',
      expanded: (row.persona_expanded as string) ?? '',
    },
    is_default: false,
    shared: (row.shared as boolean) ?? true,
    created: ((row.created_at as string | null) ?? new Date().toISOString()),
    // Usage stats are DEVICE-LOCAL: each install/profile keeps its own
    // last_launched / playtime_ms, so a cloud-sourced copy always starts at
    // zero. Adopting the row's values would leak one install's stats onto
    // another (e.g. the packaged app showing a date stamped by `npm run dev`).
    // Legacy rows may still carry values upserted by older clients — ignored.
    last_launched: null,
    playtime_ms: 0,
    portrait_image: localPortrait,
    skin: {
      source: (row.skin_source as 'bundled' | 'upload' | 'username' | 'none') ?? 'none',
      mojang_username: (row.mojang_username as string | null) ?? null,
      png_sha256: (row.skin_png_sha256 as string | null) ?? null,
      applied_at: (row.skin_applied_at as string | null) ?? null,
    },
    username: (row.username as string | null) ?? null,
    metadata: metadataWithoutDescription,
    description,
    // ITEM 13 (quick/260523-t8d): carry the cloud row's owner UUID down to the
    // local Character so the renderer's view-only guard on CharacterPage can
    // compare against authState.user.id and disable edits when the imported
    // character was authored by a different signed-in user.
    owner: (row.owner as string | null) ?? null,
    // Watermark for cache-on-demand staleness checks: the row's server-managed
    // updated_at (bumped by the characters_set_updated_at trigger on every
    // edit). cacheOnDemand stores this locally and re-pulls when the cloud
    // value advances. Null on legacy rows missing the column (schema drift).
    cloud_updated_at: (row.updated_at as string | null) ?? null,
  };
}

/**
 * Upsert a single character row. Two BEFORE-NETWORK guards:
 *   1. is_default=true → CLOUD_SYNC_REFUSED_DEFAULT (D-22)
 *   2. portrait_image starts with `data:` → CLOUD_SYNC_REFUSED_DATA_URL
 *      (defense-in-depth; characterSchema.ts refinement is the primary gate)
 *
 * Payload force-sets is_default=false even after the guard — belt + suspenders.
 */
export async function upsertCharacter(
  c: Character,
  ownerUuid: string,
  client?: SupabaseClient,
): Promise<void> {
  if (c.is_default) {
    throw new Error(`${CLOUD_SYNC_REFUSED_DEFAULT}: bundled defaults never upload (D-22)`);
  }
  if (c.portrait_image && c.portrait_image.startsWith('data:')) {
    throw new Error(`${CLOUD_SYNC_REFUSED_DATA_URL}: upload portrait bytes via uploadPortrait first`);
  }
  const supabase = client ?? getClient();
  // Fold the human-facing description into metadata.description so we don't
  // need a dedicated SQL column. `rowToCharacter` strips it back out on read,
  // so the local schema's top-level `description` field is the only place
  // the rest of the codebase sees this value.
  const metadataForCloud: Record<string, unknown> = { ...(c.metadata ?? {}) };
  if (c.description != null) metadataForCloud.description = c.description;
  // moderate-character-images and backfill-moderate-existing both treat
  // `portrait_image` as a bucket-relative Storage path (`<owner>/<uuid>.png`).
  // Locally we store the bare filename; prefix it on the way out so the
  // Edge Function's SightEngine fetch resolves and moderation doesn't 502
  // with "Moderation service is temporarily unavailable".
  const portraitCloud =
    c.portrait_image && !c.portrait_image.includes('/')
      ? `${ownerUuid}/${c.portrait_image}`
      : c.portrait_image;
  await withTimeout(`upsert ${c.id}`, async (signal) => {
    const { error } = await supabase
      .from('characters')
      .upsert({
        id: c.id,
        owner: ownerUuid,
        slug: c.slug ?? null,
        name: c.name,
        persona_source: c.persona.source,
        persona_expanded: c.persona.expanded,
        skin_source: c.skin.source,
        mojang_username: c.skin.mojang_username,
        skin_png_sha256: c.skin.png_sha256,
        skin_applied_at: c.skin.applied_at,
        username: c.username,
        is_default: false, // defense-in-depth — guard above is the primary gate (D-22)
        shared: c.shared,
        // last_launched / playtime_ms deliberately absent — usage stats are
        // device-local (see rowToCharacter). Omitted keys are left untouched
        // on conflict-update, so legacy rows keep their stale values; new rows
        // get the column defaults (null / 0).
        portrait_image: portraitCloud,
        metadata: metadataForCloud,
      })
      .abortSignal(signal);
    if (error) throw new Error(`${CLOUD_SYNC_UPSERT_FAILED}: ${error.message}`);
  });
}

/** Delete a character row by UUID. RLS scopes to owner — anon callers get 0 rows affected. */
export async function deleteCharacter(uuid: string): Promise<void> {
  const supabase = getClient();
  await withTimeout(`delete ${uuid}`, async (signal) => {
    const { error } = await supabase
      .from('characters')
      .delete()
      .eq('id', uuid)
      .abortSignal(signal);
    if (error) throw new Error(`${CLOUD_DELETE_FAILED}: ${error.message}`);
  });
}

/**
 * List all rows owned by the current user (or shared rows if RLS permits).
 * Plan 11-19 cache-on-demand uses this for the initial pull on sign-in.
 */
export async function listMyCharacters(ownerUuid: string): Promise<Character[]> {
  const supabase = getClient();
  return await withTimeout('list', async (signal) => {
    const { data, error } = await supabase
      .from('characters')
      .select('*')
      .eq('owner', ownerUuid)
      .abortSignal(signal);
    if (error) throw new Error(`${CLOUD_LIST_FAILED}: ${error.message}`);
    return (data ?? []).map((r: unknown) => rowToCharacter(r as Record<string, unknown>));
  });
}

/**
 * Item 7 — upsert the signed-in user's public display name into public.profiles
 * so Browse can render "by <preferred name>" on their published characters. RLS
 * requires auth.uid() = user_id, so we use a JWT-authed client (the ambient
 * singleton session isn't reliably applied to main-process requests — see
 * supabaseClient.getAuthedClient). No-op when signed out or the name is blank.
 */
export async function upsertMyProfile(preferredName: string): Promise<void> {
  const name = preferredName.trim();
  if (!name) return;
  const { getAuthedClient } = await import('../auth/supabaseClient');
  const { data: { session } } = await getClient().auth.getSession();
  const userId = session?.user?.id;
  const token = session?.access_token;
  if (!userId || !token) return;
  const authed = getAuthedClient(token);
  await withTimeout(`upsertProfile ${userId}`, async (signal) => {
    const { error } = await authed
      .from('profiles')
      .upsert({ user_id: userId, preferred_name: name, updated_at: new Date().toISOString() })
      .abortSignal(signal);
    if (error) throw new Error(`profile upsert failed: ${error.message}`);
  });
}

/**
 * Item 4 (cross-device) — fetch the SIGNED-IN user's own display name from
 * public.profiles. Used on sign-in to backfill a fresh device's empty local
 * config so onboarding doesn't re-prompt "what should they call you?" for an
 * account that already set a name on another device. Returns the trimmed name
 * or null (no row / blank / signed out / any error — all non-fatal).
 */
export async function fetchMyProfileName(): Promise<string | null> {
  const { getAuthedClient } = await import('../auth/supabaseClient');
  const { data: { session } } = await getClient().auth.getSession();
  const userId = session?.user?.id;
  const token = session?.access_token;
  if (!userId || !token) return null;
  const authed = getAuthedClient(token);
  try {
    return await withTimeout(`fetchProfile ${userId}`, async (signal) => {
      const { data, error } = await authed
        .from('profiles')
        .select('preferred_name')
        .eq('user_id', userId)
        .abortSignal(signal)
        .maybeSingle();
      if (error) return null;
      const name = ((data as { preferred_name?: string | null } | null)?.preferred_name ?? '').trim();
      return name || null;
    });
  } catch {
    return null;
  }
}

/**
 * Item 7 — fetch public author display names for a set of owner UUIDs. Returns
 * a map of user_id → preferred_name (only ids with a non-empty name included).
 * The profiles_select_public RLS policy allows anon + authenticated reads, so
 * this works on the signed-out Browse path too. Best-effort: any error yields
 * an empty map and Browse falls back to the anonymized "user-xxxx" handle.
 */
export async function getProfileNames(userIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = Array.from(new Set(userIds.filter((x) => !!x)));
  if (ids.length === 0) return out;
  try {
    const { data, error } = await getClient()
      .from('profiles')
      .select('user_id, preferred_name')
      .in('user_id', ids);
    if (error) {
      console.warn(`[sei] getProfileNames failed: ${error.message}`);
      return out;
    }
    for (const row of (data ?? []) as Array<{ user_id: string; preferred_name: string | null }>) {
      const name = (row.preferred_name ?? '').trim();
      if (name) out.set(row.user_id, name);
    }
  } catch (err) {
    console.warn(`[sei] getProfileNames threw: ${(err as Error).message}`);
  }
  return out;
}

/** Fetch a single character row by UUID. Returns null when the row is absent. */
export async function downloadCharacter(uuid: string): Promise<Character | null> {
  const supabase = getClient();
  return await withTimeout(`download ${uuid}`, async (signal) => {
    const { data, error } = await supabase
      .from('characters')
      .select('*')
      .eq('id', uuid)
      .limit(1)
      .abortSignal(signal);
    if (error) throw new Error(`${CLOUD_DOWNLOAD_FAILED}: ${error.message}`);
    const row = (data ?? [])[0];
    return row ? rowToCharacter(row as Record<string, unknown>) : null;
  });
}

/**
 * Upload skin PNG bytes to `skins/<owner>/<uuid>.png` with upsert: true so
 * re-uploads overwrite. Nested path matches Plan 11-01 RLS.
 *
 * Note: storage SDK does not accept an AbortSignal directly (supabase-js bug
 * #1185 — open as of the supabase-js 2.106 release we ship); we accept that
 * a hung storage upload blocks longer than the table queries. Plan 11-19
 * pipes the renderer "cancel" button through a separate watchdog.
 */
/**
 * Upload a character asset (portrait or skin) via the `sign-character-asset-upload`
 * Edge Function.
 *
 * WHY NOT a direct client upload: the project uses asymmetric (ES256) JWT
 * signing keys, but storage-api (1.60.4) only verifies the legacy HS256 secret,
 * so a direct upload authenticated with the user's ES256 token is treated as
 * anonymous and rejected by storage RLS. Instead the Edge Function (which DOES
 * verify ES256 via gotrue/JWKS) mints a signed upload URL with the service_role
 * key, and we PUT the bytes to it — that endpoint is authorized by the signed
 * token, not the user JWT, so it is immune to the storage-api gap. The owner +
 * path are derived server-side from the verified user id; `ownerUuid` is no
 * longer a client input. Revert to a direct `.storage.upload()` once storage-api
 * verifies asymmetric JWTs.
 */
async function uploadCharacterAsset(
  kind: 'portrait' | 'skin',
  characterId: string,
  bytes: Buffer,
  contentType: string,
  jwt: string,
): Promise<void> {
  const resp = await callEdgeFunction('sign-character-asset-upload', {
    jwt,
    body: { characterId, kind },
  });
  if (!resp.ok) {
    throw new Error(`${CLOUD_STORAGE_UPLOAD_FAILED}: sign ${kind} (status ${resp.status}) ${resp.message}`);
  }
  const signed = resp.json as { bucket?: string; path?: string; token?: string } | undefined;
  if (!signed?.bucket || !signed.path || !signed.token) {
    throw new Error(`${CLOUD_STORAGE_UPLOAD_FAILED}: sign ${kind} returned no token`);
  }
  // The signed token authorizes the write, so the singleton's (ES256/anon)
  // Authorization header on this request is irrelevant to storage-api.
  const { error } = await getClient()
    .storage
    .from(signed.bucket)
    .uploadToSignedUrl(signed.path, signed.token, bytes, { contentType, upsert: true });
  if (error) throw new Error(`${CLOUD_STORAGE_UPLOAD_FAILED}: ${signed.bucket} ${error.message}`);
}

export async function uploadSkin(characterId: string, bytes: Buffer, jwt: string): Promise<void> {
  await uploadCharacterAsset('skin', characterId, bytes, 'image/png', jwt);
}

/**
 * Upload portrait bytes to `portraits/<owner>/<uuid>.png`. The format arg
 * controls the wire content-type — the renderer encodes to whichever the
 * source PortraitImagePicker produced (png/jpeg/webp).
 */
export async function uploadPortrait(
  characterId: string,
  bytes: Buffer,
  format: 'png' | 'jpeg' | 'webp',
  jwt: string,
): Promise<void> {
  const contentType = format === 'jpeg' ? 'image/jpeg' : `image/${format}`;
  await uploadCharacterAsset('portrait', characterId, bytes, contentType, jwt);
}

/** Download skin PNG bytes. Returns null on 404 (object not found in bucket). */
export async function downloadSkin(ownerUuid: string, characterUuid: string): Promise<Buffer | null> {
  const supabase = getClient();
  const { data, error } = await supabase
    .storage
    .from('skins')
    .download(skinStoragePath(ownerUuid, characterUuid));
  if (error) {
    if (error.message.toLowerCase().includes('not found')) return null;
    throw new Error(`${CLOUD_DOWNLOAD_FAILED}: skins ${error.message}`);
  }
  return Buffer.from(await data.arrayBuffer());
}

/** Download portrait bytes. Returns null on 404. */
export async function downloadPortrait(ownerUuid: string, characterUuid: string): Promise<Buffer | null> {
  const supabase = getClient();
  const { data, error } = await supabase
    .storage
    .from('portraits')
    .download(portraitStoragePath(ownerUuid, characterUuid));
  if (error) {
    if (error.message.toLowerCase().includes('not found')) return null;
    throw new Error(`${CLOUD_DOWNLOAD_FAILED}: portraits ${error.message}`);
  }
  return Buffer.from(await data.arrayBuffer());
}

/**
 * Delete storage objects across both buckets in one call. Groups inputs by
 * bucket and issues one .remove() per bucket — supabase-js storage doesn't
 * support cross-bucket batch removes natively.
 *
 * Used by Plan 11-13 (delete-account flow) and Plan 11-11 (delete-character).
 */
export async function deleteStorageObjects(paths: { bucket: 'skins' | 'portraits'; name: string }[]): Promise<void> {
  if (paths.length === 0) return;
  const supabase = getClient();
  const byBucket = new Map<'skins' | 'portraits', string[]>();
  for (const p of paths) {
    const arr = byBucket.get(p.bucket) ?? [];
    arr.push(p.name);
    byBucket.set(p.bucket, arr);
  }
  for (const [bucket, names] of byBucket) {
    const { error } = await supabase.storage.from(bucket).remove(names);
    if (error) throw new Error(`${CLOUD_STORAGE_DELETE_FAILED}: ${bucket} ${error.message}`);
  }
}

/**
 * Compute the public URL for a storage object. Sync because supabase-js
 * resolves this from config without a network call. Used by Plan 11-19's
 * <CharacterCard> portrait `<img src>` when the public-bucket optimization
 * is enabled.
 */
export function getStoragePublicUrl(bucket: 'skins' | 'portraits', ownerUuid: string, characterUuid: string): string {
  const supabase = getClient();
  const { data } = supabase.storage.from(bucket).getPublicUrl(`${ownerUuid}/${characterUuid}.png`);
  return data.publicUrl;
}
