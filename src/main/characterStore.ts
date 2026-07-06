/**
 * Per-character JSON CRUD: `<userData>/characters/<id>.json` + index.json manifest.
 *
 * Sources:
 *   - PATTERNS §src/main/characterStore.ts
 *   - CONTEXT D-09 (file layout), D-11 (timestamps)
 *   - Reuse: existing brain atomicWrite + withFileLock helpers
 *
 * 260516-0yw:
 *  - `saveCharacter` is now the "post-expansion" save — it persists the
 *    Character as-is (including persona.expanded as provided).
 *  - `expandAndSaveCharacter` is the IPC entry point: it loads the prior
 *    character (if any) for voice-continuity reference, calls
 *    loadApiKey() + expandPersona(), merges `expanded` into the input,
 *    saves, and returns the persisted Character so the renderer can
 *    update its store with the new long-form prompt.
 *  - `getCharacter` adds an explicit legacy-shape error path: if the raw
 *    JSON has `persona_prompt` (old shape) at the top level instead of
 *    `persona: { source, expanded }`, throw a clear message instead of
 *    surfacing a Zod stack trace.
 */
import { readFile, mkdir, unlink, rm } from 'node:fs/promises';
import { CharacterSchema, CharacterIndexSchema, MAX_CREATIONS_PER_DAY, type Character, type CharacterIndex } from '../shared/characterSchema';
// allowJs:true in tsconfig.node.json lets TS resolve these .js modules at compile time.
import { atomicWrite } from '../bot/brain/storage/atomicWrite.js';
import { withFileLock } from '../bot/brain/storage/fileLock.js';
import { paths } from './paths';
import { expandPersona, type ExpansionProgress } from './personaExpansion';
import { loadApiKey, getAiBackendKind } from './apiKeyStore';

const PROXY_BASE_URL = process.env.SEI_PROXY_URL ?? 'https://api.sei.gg';

const logger = {
  warn: (m: string) => console.warn(`[sei] ${m}`),
};

async function readJson<T>(p: string): Promise<T | null> {
  let raw: string;
  try { raw = await readFile(p, 'utf8'); }
  catch (err) {
    if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  return JSON.parse(raw) as T;
}

async function loadIndex(): Promise<CharacterIndex> {
  const data = await readJson<unknown>(paths.indexPath());
  if (!data) return CharacterIndexSchema.parse({});
  try { return CharacterIndexSchema.parse(data); }
  catch (err) {
    logger.warn(`characters/index.json invalid; treating as empty: ${(err as Error).message}`);
    return CharacterIndexSchema.parse({});
  }
}

async function writeIndex(idx: CharacterIndex): Promise<void> {
  const target = paths.indexPath();
  await mkdir(paths.charactersDir(), { recursive: true });
  await withFileLock(target, async () => {
    await atomicWrite(target, JSON.stringify(idx, null, 2) + '\n');
  });
}

export async function listCharacters(): Promise<Character[]> {
  const idx = await loadIndex();
  const out: Character[] = [];
  const legacyToPurge: string[] = [];
  for (const id of idx.order) {
    try {
      const c = await getCharacter(id);
      if (c) out.push(c);
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (msg.includes('legacy shape')) {
        // 260516-x62: self-heal. Old persona_prompt/description files are
        // unparseable under the 260516-0yw schema. Rather than nagging the
        // user forever, delete the JSON and drop it from the index. The
        // memory dir is left alone (user may want it back if they re-create
        // a character with the same id). Defaults seeded on next boot.
        legacyToPurge.push(id);
        logger.warn(`characters/${id}.json: legacy shape detected, purging (next boot will reseed defaults if applicable)`);
      } else {
        logger.warn(`characters/${id}.json failed to load: ${msg}`);
      }
    }
  }
  if (legacyToPurge.length > 0) {
    for (const id of legacyToPurge) {
      try { await unlink(paths.characterPath(id)); } catch { /* ignore */ }
    }
    const fresh = await loadIndex();
    const next = fresh.order.filter(x => !legacyToPurge.includes(x));
    if (next.length !== fresh.order.length) {
      fresh.order = next;
      await writeIndex(fresh);
    }
  }
  return out;
}

export async function getCharacter(id: string): Promise<Character | null> {
  const data = await readJson<unknown>(paths.characterPath(id));
  if (!data) return null;
  // 260516-0yw: detect legacy shape (top-level `persona_prompt` / `description`,
  // no `persona` object) BEFORE Zod parsing so we can throw a useful message.
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    const hasLegacy =
      typeof obj.persona_prompt !== 'undefined' ||
      (typeof obj.description !== 'undefined' && typeof obj.persona === 'undefined');
    const hasNew = obj.persona && typeof obj.persona === 'object';
    if (hasLegacy && !hasNew) {
      throw new Error(
        `character ${id} has legacy shape (persona_prompt/description); delete characters/${id}.json or re-create via the GUI`,
      );
    }
  }
  return CharacterSchema.parse(data);
}

export async function saveCharacter(character: Character): Promise<void> {
  await saveCharacterRaw(character);

  // Phase 11 D-18 — Local write completed; mirror to cloud via the sync queue.
  // Fire-and-forget: cloud failure does NOT block GUI. Defaults (D-22) never
  // upload — cloudCharacterClient throws CLOUD_SYNC_REFUSED_DEFAULT as a
  // belt-and-suspenders guard, but skipping the enqueue here avoids needless
  // queue churn for the sui/lyra/clawd bundle.
  if (!character.is_default) {
    void (async () => {
      try {
        const { enqueueUpsert, processNext } = await import('./cloud/syncQueue');
        await enqueueUpsert(character.id);
        // Drain attempt; gated on isCloudWriteAllowed inside processNext so
        // signed-out users just leave the op pending in the queue.
        void processNext();
      } catch (err) {
        console.warn(`[sei] cloud mirror enqueue failed for ${character.id}: ${(err as Error).message}`);
      }
    })();
  }
}

/**
 * Phase 11 plan 11-19 — internal non-mirroring local write.
 *
 * Identical to saveCharacter EXCEPT it does NOT enqueue a cloud-mirror upsert.
 * Used by `src/main/cloud/cacheOnDemand.ts` when a cloud row is downloaded
 * onto the local cache for the first time — we do NOT want that cache hydration
 * to re-upload the same data we just pulled, which would create needless queue
 * churn and (worse) could race a more-recent edit if the cloud row gets stale
 * between download and re-upload.
 *
 * Callers OUTSIDE the cache-on-demand path should use saveCharacter so cloud
 * mirroring happens. The name `Raw` echoes the convention used elsewhere in
 * the codebase for non-side-effecting low-level writes.
 */
export async function saveCharacterRaw(character: Character): Promise<void> {
  // owner field (ITEM 13, quick/260523-t8d) carried in if present; null for
  // local-only characters. Zod parse round-trips it through to disk via the
  // CharacterSchema gate — no explicit copy needed here.
  const validated = CharacterSchema.parse(character);
  const target = paths.characterPath(validated.id);
  await mkdir(paths.charactersDir(), { recursive: true });

  await withFileLock(target, async () => {
    await atomicWrite(target, JSON.stringify(validated, null, 2) + '\n');
  });

  // Pre-create the per-character memory directory so the bot's atomic-write
  // helper (which assumes the parent dir exists) can write PLAYER.md /
  // MEMORY.md on first run without ENOENT. The bot supervisor injects
  // explicit memory paths under this dir.
  await mkdir(paths.memoryDir(validated.id), { recursive: true });

  // Maintain index ordering — append new ids; leave existing order alone.
  const idx = await loadIndex();
  if (!idx.order.includes(validated.id)) {
    idx.order.push(validated.id);
    await writeIndex(idx);
  }
}

/**
 * 260516-0yw: expand-then-save flow used by the chars.save IPC handler.
 * Loads the prior character (if any) to pull its persona.expanded as
 * voice-continuity reference for regeneration; calls loadApiKey() to get
 * the user's Anthropic key; runs expandPersona; merges the new `expanded`
 * into the input character; persists via raw saveCharacter; returns the
 * persisted Character so the renderer can update its store with the new
 * long-form prompt.
 *
 * Throws on missing API key, expansion failure, or write failure. The
 * IPC handler surfaces the thrown message to the renderer for display.
 */
export async function expandAndSaveCharacter(
  input: { character: Character; onProgress?: (p: ExpansionProgress) => void },
): Promise<Character> {
  const { character, onProgress } = input;
  const validated = CharacterSchema.parse(character);

  // Pull prior expanded for voice continuity, if any. `getCharacter` may
  // throw on legacy-shape detection (which is fine — the calling renderer
  // will surface the message). When the legacy throw happens, treat it as
  // "no prior" and let the new save overwrite the file.
  let priorExpanded: string | undefined;
  try {
    const prior = await getCharacter(validated.id);
    priorExpanded = prior?.persona.expanded || undefined;
  } catch {
    priorExpanded = undefined;
  }

  // Phase 13: route the expansion call through whichever AI backend the user
  // is on. BYOK pulls the local Anthropic key from safeStorage; cloud-proxy
  // pulls the Supabase JWT and points the SDK at the Fly.io proxy (same
  // wiring as src/bot/brain/anthropicClient.js).
  const backendKind = await getAiBackendKind();

  const expansionInput: Parameters<typeof expandPersona>[0] = {
    // ITEM 12 (quick/260523-t8d): pass the character's name so franchise
    // context (Pikachu / Goku / Mario / etc.) shapes the expanded persona.
    name: validated.name,
    source: validated.persona.source,
    priorExpanded,
    // Streaming progress sink — forwarded by the IPC handler to the renderer's
    // progress bar. Undefined for callers that don't pass one (the call still
    // streams internally; it just emits no ticks).
    onProgress,
  };
  if (backendKind === 'cloud-proxy') {
    const { getClient } = await import('./auth/supabaseClient');
    const { data } = await getClient().auth.getSession();
    const jwt = data.session?.access_token;
    if (!jwt) {
      throw new Error('persona expansion failed: signed-out user on cloud-proxy backend');
    }
    // The proxy's /free/v1/messages route is auth'd but does NOT consume
    // credits — character creation works for every signed-in user. Daily cap
    // (20/user) is enforced by the persona_daily bucket on the proxy side.
    expansionInput.cloudMode = { baseURL: `${PROXY_BASE_URL}/free`, authToken: jwt };
  } else {
    // 260703 hard guard: local (BYOK) expansion uses ONLY the on-disk key —
    // never the Supabase JWT. A missing key fails with an actionable message
    // (the IPC handler surfaces it verbatim) instead of a raw ENOENT.
    try {
      expansionInput.apiKey = await loadApiKey();
    } catch {
      throw new Error(
        'persona expansion failed: local mode is on but no API key is saved — add one in Settings, or switch to managed billing',
      );
    }
  }

  // 260630: the expander now CHOOSES the proactiveness level (0 passive /
  // 1 reactive / 2 agentic) from the personality and returns it; we seed it into
  // metadata, which is what bot/index.js reads to drive the runtime dial. The
  // manual dial can override this later by editing metadata.proactiveness.
  const { expanded, proactiveness } = await expandPersona(expansionInput);

  const merged: Character = {
    ...validated,
    persona: {
      source: validated.persona.source,
      expanded,
    },
    metadata: {
      ...(validated.metadata as Record<string, unknown> | undefined),
      proactiveness,
    },
  };
  await saveCharacter(merged);
  return merged;
}

// 260705: the daily character-creation cap is a LOCAL rolling-24h log
// (UserConfig.creation_times), not a proxy-bucket read. Rationale: the old
// persona_daily mirror counted /free CALLS (a unique-companion creation burns
// up to 3: sheet + validation retry + expansion) and skipped BYOK entirely.
// The product rule is "4 CHARACTERS a day, any backend" (MAX_CREATIONS_PER_DAY
// — we only have 4 Home slots; more is create-delete churn). The proxy's
// persona_daily / image_daily / skin_daily buckets remain the server-side
// abuse backstops for a tampered client.
const CREATION_WINDOW_MS = 86_400_000; // rolling 24h

/** Creation timestamps still inside the rolling window, oldest first. */
function creationsInWindow(times: readonly string[] | undefined, now: number): number[] {
  return (times ?? [])
    .map((t) => new Date(t).getTime())
    .filter((t) => Number.isFinite(t) && now - t < CREATION_WINDOW_MS)
    .sort((a, b) => a - b);
}

/**
 * Pre-flight daily character-creation quota check (MAX_CREATIONS_PER_DAY).
 * The renderer calls this BEFORE entering the new-character flow so a maxed-out
 * user gets a friendly "come back tomorrow" modal instead of failing mid-flow;
 * the chars:save create path and generateUnique re-check it as the backstop.
 *
 * Fails OPEN on any error, so a transient config-read hiccup never blocks
 * creation.
 */
export async function checkCreateQuota(): Promise<{
  blocked: boolean;
  resetsAt: string | null;
}> {
  try {
    const { loadConfig } = await import('./configStore');
    const config = await loadConfig();
    const now = Date.now();
    const inWindow = creationsInWindow(config.creation_times, now);
    if (inWindow.length < MAX_CREATIONS_PER_DAY) {
      return { blocked: false, resetsAt: null };
    }
    // Blocked. The next creation frees up when the OLDEST in-window entry
    // ages past 24h.
    return {
      blocked: true,
      resetsAt: new Date(inWindow[0] + CREATION_WINDOW_MS).toISOString(),
    };
  } catch {
    // Fail open — never block creation on a transient error.
    return { blocked: false, resetsAt: null };
  }
}

/**
 * Record a successful character creation in the rolling-24h log. Prunes
 * expired entries on every write so config.json never accumulates history.
 * Best-effort: a failed write must never fail the creation that already
 * happened (worst case the user gets one extra creation today).
 */
export async function recordCreation(): Promise<void> {
  try {
    const { loadConfig, saveConfig } = await import('./configStore');
    const config = await loadConfig();
    const now = Date.now();
    const kept = creationsInWindow(config.creation_times, now).map((t) =>
      new Date(t).toISOString(),
    );
    kept.push(new Date(now).toISOString());
    await saveConfig({ ...config, creation_times: kept });
  } catch (err) {
    logger.warn(`recordCreation failed: ${(err as Error).message}`);
  }
}

/**
 * Reset a character's memory directory: wipe its contents and recreate it
 * empty. The character JSON's persona / portrait / skin / index entry are
 * untouched — only PLAYER.md / MEMORY.md (and any other files under the
 * memory dir) are erased.
 *
 * ui-A9: ALSO resets `last_launched = null` and `playtime_ms = 0` on the
 * character JSON so the renderer's PlaytimePill / "Last summoned" surfaces
 * agree with the wiped memory state. The character JSON write happens AFTER
 * the dir wipe so a partial failure leaves the user with cleared memory but
 * intact stats (the more recoverable failure mode).
 *
 * Caller (main/ipc.ts) gates against resetting an actively summoned bot.
 */
export async function resetMemoryForCharacter(id: string): Promise<void> {
  await rm(paths.memoryDir(id), { recursive: true, force: true });
  await mkdir(paths.memoryDir(id), { recursive: true });
  // ui-A9: reset launch + playtime stats. If the character JSON is missing
  // (race with a delete), the read returns null and we skip the write —
  // there's nothing left to mutate.
  try {
    const prior = await getCharacter(id);
    if (prior) {
      await saveCharacter({ ...prior, last_launched: null, playtime_ms: 0 });
    }
  } catch (err) {
    logger.warn(`reset stats failed for ${id}: ${(err as Error).message}`);
  }
}

export async function deleteCharacter(id: string): Promise<void> {
  // Snapshot the character BEFORE we unlink it; we need its is_default flag to
  // decide whether to enqueue a cloud-mirror delete. If the file is already
  // gone, treat is_default as false (no cloud row to delete either).
  let wasDefault = false;
  try {
    const prior = await getCharacter(id);
    wasDefault = prior?.is_default ?? false;
  } catch {
    // Legacy-shape throw — treat as "no info" and proceed with delete; the
    // cloud-mirror skip below will treat as wasDefault=false (best-effort).
    wasDefault = false;
  }

  // Remove JSON
  try { await unlink(paths.characterPath(id)); }
  catch (err) {
    if (!err || (err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  // Remove optional portrait
  try { await unlink(paths.characterPortraitPath(id)); }
  catch (err) {
    if (!err || (err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  // Remove memory dir recursively (idempotent)
  await rm(paths.memoryDir(id), { recursive: true, force: true });

  // Remove from index
  const idx = await loadIndex();
  const next = idx.order.filter((x) => x !== id);
  if (next.length !== idx.order.length) {
    idx.order = next;
    await writeIndex(idx);
  }

  // Phase 11 — Mirror delete to cloud (chars row + Storage objects). Defaults
  // are local-only (D-22), so skip the enqueue for them.
  if (!wasDefault) {
    void (async () => {
      try {
        const { getClient } = await import('./auth/supabaseClient');
        const session = (await getClient().auth.getSession()).data.session;
        const owner = session?.user.id;
        if (!owner) {
          // Signed-out delete — there is no cloud row to delete and no
          // Storage objects to clean up (nothing was uploaded). Skip both
          // the deletion_queue insert (would fail RLS anyway) and the
          // sync-queue enqueue (its drainer gate would just hold the op).
          return;
        }

        // Belt: write the deletion_queue row first. Cheap insert; RLS
        // (20260521000300_deletion_queue_user_insert) permits the
        // signed-in user to insert rows naming their own user_id. The
        // path-ownership filter in storage_purge_extend (T-11-10-01)
        // guards against cross-user deletes from the cron side.
        // Failure does NOT block — the sync queue's direct delete is
        // the primary path; this row is the 30-day insurance.
        try {
          const { enqueueStorageOrphans } = await import('./cloud/deletionQueueWriter');
          await enqueueStorageOrphans(owner, [
            // Same path used in both buckets — the cron iterates both per
            // storage_purge_extend's `bucket_id in ('skins','portraits')`.
            `${owner}/${id}.png`,
          ]);
        } catch (err) {
          console.warn(`[sei] deletion_queue insert failed for ${id}: ${(err as Error).message}`);
        }

        // Suspenders: enqueue the direct cloud-delete + storage delete
        // attempt. Even if the deletion_queue insert failed, this can
        // still succeed; even if this fails, the cron has the queue row
        // and will sweep within 30 days.
        const { enqueueDelete, processNext } = await import('./cloud/syncQueue');
        await enqueueDelete(id, [
          { bucket: 'skins',     name: `${owner}/${id}.png` },
          { bucket: 'portraits', name: `${owner}/${id}.png` },
        ]);
        void processNext();
      } catch (err) {
        console.warn(`[sei] cloud delete enqueue failed for ${id}: ${(err as Error).message}`);
      }
    })();
  }
}
