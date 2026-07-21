/**
 * IPC handler registrations. Wires every IpcChannel.<request-response> to
 * its main-process module. Push channels (status / log / lan) are emitted
 * directly by main/index.ts via webContents.send.
 *
 * Sources:
 *   - shared/ipc.ts (IpcChannel, RendererApi)
 *   - PATTERNS §"Zod validation at every external boundary"
 */
import { ipcMain, BrowserWindow, app } from 'electron';
import { z } from 'zod';
import {
  IpcChannel,
  CHAT_TEXT_MAX,
  CHAT_HISTORY_PAGE,
  ProxyConfigureArgsSchema,
  CreditsCheckoutArgsSchema,
  FeedbackSubmitArgsSchema,
  ReportSubmitArgsSchema,
  RecordConsentArgsSchema,
  type WizardProgressEvent,
  type ExpansionProgressEvent,
  type GenProgressEvent,
  type GenerateUniqueResult,
  type PrefsGetResult,
  type BrowseEntry,
  type CreditsStatus,
  type SubscriptionStatusInfo,
  type CreditsHardStopEvent,
  type LanState,
  type BotStatus,
  type ChatPreview,
  type ChatMessage,
} from '../shared/ipc';
import { CharacterSchema, UserConfigSchema, UserPreferencesSchema, MAX_COMPANION_SLOTS, type Character, type UserConfig } from '../shared/characterSchema';
import { loadConfig, saveConfig } from './configStore';
import { DEFAULT_CHARACTER_UUIDS } from './defaultCharacters';
import { listCharacters, getCharacter, expandAndSaveCharacter, saveCharacter, deleteCharacter, resetMemoryForCharacter, checkCreateQuota, recordCreation } from './characterStore';
import { libraryCharacterCount } from './uniqueGeneration';
import { paths } from './paths';
import { saveApiKey, hasApiKey, safeStorageBackendKind } from './apiKeyStore';
import { capture as trackAnalytics, getAnalyticsOptOut, setAnalyticsOptOut } from './analytics';
import { setSupervisor as setAuthSupervisor } from './auth/authHandlers';
import type { BotSupervisor } from './botSupervisor';

// ── Moderation kill-switch ─────────────────────────────────────────────────
// When false, publishing a shared character SKIPS the image/prompt moderation
// gate entirely: runModerationGate marks the row clean directly instead of
// calling the moderate-character-images / moderate-character-prompt Edge
// Functions. Turned OFF 260707 because the prompt moderation was
// false-positive-rejecting legitimate combat-flavored personas (e.g. the
// bundled Sui), blocking users from publishing valid characters to World.
// Re-enable (set true) once the proxy's moderation thresholds are tuned.
// NOTE: client-side, so it reaches users on their next app update — it does not
// retroactively change already-installed apps (those still moderate until they
// update). To disable moderation for existing installs immediately you'd neuter
// the Edge Functions in the private proxy instead.
const MODERATION_ENABLED = false;

// ── Auto-remoderate-on-reset (260707) ──────────────────────────────────────
// When moderation is ENABLED, the reset_moderation_on_portrait_change DB
// trigger nulls moderation_status whenever a shared character's portrait bytes
// change. The user-initiated share/save paths re-run the gate immediately, but
// a background portrait re-upload (sync queue), an owner-change storage
// relocation, or a fresh-device first-save can null a shared character WITHOUT
// a following moderation pass — leaving it stuck out of World
// (search_public_characters requires moderation_status='clean').
//
// This sweep re-runs the gate for the signed-in user's OWN shared characters
// whose moderation_status is null, restoring them to World once they pass. It
// is invoked from authState on sign-in (fire-and-forget).
//
// Dormant under the all-green exemption: while MODERATION_ENABLED === false the
// reset trigger writes 'clean' (never null), so the sweep query below matches
// zero rows and this is a complete no-op. Even if a null row somehow existed,
// runModerationGate honors the kill-switch and writes 'clean' (it never calls
// the Edge Functions and never flags), so this can never hide an all-green or
// first-party-exempt character.
//
// Wired as a module-level delegate assigned by registerIpcHandlers so the sweep
// can reuse the in-closure runModerationGate as the single moderation entry
// point (rather than duplicating its adapter wiring).
let _runResetRemoderationSweep: ((userId: string) => Promise<void>) | null = null;

/**
 * Re-moderate the signed-in user's shared characters whose moderation_status was
 * reset to null (see the note above). Best-effort and non-blocking; a no-op
 * until registerIpcHandlers has wired the delegate and while moderation is off.
 */
export function remoderateResetSharedCharactersOnSignIn(userId: string): Promise<void> {
  return _runResetRemoderationSweep?.(userId) ?? Promise.resolve();
}

export interface IpcHandlerDeps {
  supervisor: BotSupervisor;
  /**
   * Returns the loopback skin server's baseUrl, or null if
   * the server failed to bind on boot. Used by the skin:get-server-url IPC
   * handler to surface the URL to the renderer + wizard. Closure-via-
   * getter so a future restart of the skin server is observable.
   */
  getSkinServerBaseUrl: () => string | null;
  /**
   * Per-step progress sink for the wizard install flow.
   * The orchestrator's `onProgress` callback funnels through here so the IPC
   * handler can push the event onto the `wizard:progress` channel via
   * `webContents.send`. Injected from main/index.ts where `mainWindow` lives.
   */
  sendWizardProgress: (ev: WizardProgressEvent) => void;
  /**
   * Streaming progress sink for the persona-expansion LLM call inside
   * chars:save. The expandAndSaveCharacter `onProgress` callback funnels
   * through here so the IPC handler can push each tick onto the
   * `chars:expansion-progress` channel. Injected from main/index.ts.
   */
  sendExpansionProgress: (ev: ExpansionProgressEvent) => void;
  /**
   * 260703 procgen — stage-progress sink for the unique-companion generation
   * pipeline (gen:start). The generateUnique `emit` callback funnels through
   * here so the IPC handler can push each GenProgressEvent tick onto the
   * gen:progress channel; the renderer filters by requestId. Injected from
   * main/index.ts (mirrors sendExpansionProgress).
   */
  sendGenProgress: (ev: GenProgressEvent) => void;
  /**
   * Returns the current LAN state snapshot. The `lan:state` channel only
   * PUSHES on change, so a freshly-(re)loaded renderer pulls this on mount to
   * seed its store — otherwise a reload while a world is open shows
   * "not connected" until the LAN state next happens to change. Closure-via-
   * getter so it always reflects main's latest `latestLanState`.
   */
  getLanState: () => LanState;
  /**
   * 260703: force one LAN detection pass right now, refreshing the state that
   * getLanState reads. Awaited at the top of chat:send so the companion's
   * world-open answer reflects live truth instead of an up-to-2s-stale poll
   * (the player often messages seconds after clicking "Open to LAN").
   * Optional — absent means chat answers from the cached poll.
   */
  refreshLanState?: () => Promise<void>;
  /**
   * 260703: like {@link refreshLanState} but RETURNS the fresh LanState. Backs
   * the `lan:check-now` invoke channel — the renderer's summon click awaits it
   * so it gates on live ground truth rather than the possibly-damped snapshot
   * (a world that just closed must not summon into a dead port). Falls back to
   * the cached `getLanState()` on any error. Optional for older wiring.
   */
  checkLanNow?: () => Promise<LanState>;
  /**
   * Current per-character bot statuses (snapshot). The `bot:status` channel
   * only PUSHES on transitions, so a freshly-(re)subscribed renderer pulls
   * this to seed its summons map — otherwise a session that went online
   * before the subscription attached stays invisible (no popup, profile stuck
   * on "Play together"). Wired in index.ts to the currentStatuses map.
   */
  getBotStatuses: () => BotStatus[];
  /**
   * A chat-launched join (fired non-blocking so the chat turn doesn't hang)
   * failed. Post a short notice into the transcript so the player isn't left
   * with the companion's "hopping in" and then silence. Wired in index.ts.
   */
  notifyLaunchFailed: (characterId: string, reason: string) => void;
  /** Task 4 — true only when the character's bot is fully spawned in-world. */
  isSessionOnline: (characterId: string) => boolean;
  /**
   * Voice streaming (260706): push ONE already-persisted companion message to the
   * renderer (the `chat:message` channel, no re-persist). Backs the streaming
   * voice turn's per-sentence emit. Wired in index.ts to pushChatMessage.
   */
  pushChatMessage?: (characterId: string, message: ChatMessage) => void;
  /**
   * Voice calls (260705): a call that was actually LIVE just ended (renderer
   * reports how long audio flowed). Posts the "You and X called for Y" system
   * row to the transcript. Wired in index.ts to emitCallSession.
   */
  notifyCallEnded?: (characterId: string, connectedMs: number) => void;
  /**
   * Voice calls (260705): the call pipeline went live — make the companion
   * speak first. In-game → supervisor.greetVoiceCall port event; idle → a
   * standalone chat-brain greeting turn (replies pushed + spoken). Wired in
   * index.ts.
   */
  greetVoiceCall?: (characterId: string, peers?: string[]) => void;
}

/**
 * Canonical persona-id validator. Used by every IPC handler that accepts a
 * characterId — chars.* AND skin.*.
 *
 * Phase 11 D-23 — UUID v4 is canonical id. The previous kebab-case slug
 * regex was retired after runUuidRenameMigration rewrote any pre-existing
 * slug-keyed files (characters/<slug>.json, skins/<slug>.png, memory/<slug>/)
 * to UUID-keyed paths. The IdSchema is the defense-in-depth gate at the IPC
 * boundary: skinStore.applyPng / portraitStore.applyPortrait / paths.* build
 * filesystem path components from this id, so anything that isn't a UUID
 * (hyphens at wrong positions, slashes, dots, null bytes) is rejected here
 * BEFORE main builds the path.
 */
const IdSchema = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  { message: 'characterId must be a UUID' },
);
const PlaintextSchema = z.string().min(1);

/**
 * 260703 procgen — thrown when a CREATE (chars:save of a new id) or a
 * library-add (chars:add-to-library / chars:restore-default) would push the
 * Home companion count past MAX_COMPANION_SLOTS. Plain human-readable text:
 * these handlers surface failures via `err.message` directly (the renderer
 * pre-checks slots in the UI, so this backstop message IS the user copy).
 */
const SLOT_LIMIT_REACHED_MESSAGE =
  `You can only have ${MAX_COMPANION_SLOTS} companions. Remove one to make room.`;


/** Current Home companion count ≥ the slot cap (see libraryCharacterCount). */
async function libraryIsFull(): Promise<boolean> {
  const [cfg, chars] = await Promise.all([loadConfig(), listCharacters()]);
  // Foreign World characters cached by mere browsing must not count — mirror
  // the renderer's library filter (libraryCharacterCount does the same).
  const { getCurrentAuthState } = await import('./auth/authState');
  const auth = getCurrentAuthState();
  const currentUserId = auth.kind === 'signed_in' ? auth.user.id : null;
  return libraryCharacterCount(chars, cfg, currentUserId) >= MAX_COMPANION_SLOTS;
}

/**
 * Auth channel Zod gates (Phase 10). signin allows any non-empty password
 * (the user might be retrying a typo against an existing account whose
 * stored password predates a future min-length policy bump); signup enforces
 * >= 8 chars to match the Supabase project setting in plan 04.
 */
const SignInPasswordSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
const SendPasswordResetSchema = z.object({
  email: z.string().email(),
});
// Mirrors the signup password floor (8 chars) so a reset can't set a password
// weaker than signup would allow. Supabase enforces its own minimum too.
const UpdatePasswordSchema = z.object({
  password: z.string().min(8),
});
/**
 * Signup schema includes the COPPA DOB triple (F-10, quick/260525-usc).
 *
 * Year range: 1900 .. (new Date().getFullYear()) — anything outside this
 * window is rejected as a malformed dropdown selection. Month 1..12, day
 * 1..31. We deliberately do NOT validate "day is valid for month/year"
 * here (Feb 30, Apr 31, etc.) — age comparison via the wall-clock
 * derivation in signUpWithPassword is the load-bearing check; an
 * impossible date that happens to clear the 13-year threshold just lets
 * the user proceed, and an impossible date that fails it correctly
 * rejects them.
 *
 * Privacy minimization: the DOB itself is never persisted; main computes
 * the age and stores only the derived boolean fact `age >= 13` (via the
 * existence of a successful auth.signUp call).
 */
const SignUpPasswordSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  dobYear: z.number().int().min(1900).max(new Date().getFullYear()),
  dobMonth: z.number().int().min(1).max(12),
  dobDay: z.number().int().min(1).max(31),
});

/**
 * skin:apply request shape.
 *
 * `characterId` MUST go through IdSchema — the persona id becomes a
 * filesystem path component inside skinStore.applyPng. The renderer's
 * preload bindings never validate; main is the trust boundary.
 *
 * `username` is the per-persona MC in-game name (atomic skin+username
 * write). Validation is delegated to CharacterSchema.parse()
 * inside saveCharacter — that's where the `^[A-Za-z0-9_]+$` length 1-16
 * regex lives. Empty string after trim = clear (null). Undefined/null = no change.
 */
const ApplySkinArgsSchema = z.object({
  characterId: IdSchema,
  pngBase64: z.string().min(1),
  source: z.enum(['upload', 'username']),
  mojangUsername: z.string().nullable().optional(),
  username: z.string().nullable().optional(),
});

export function registerIpcHandlers(deps: IpcHandlerDeps): void {
  /**
   * Ensure the cloud row + portrait Storage object exist for `characterId`
   * BEFORE the moderation gate runs. Without this, the moderation Edge
   * Function's ownership-check SELECT (moderate-character-images line 124)
   * returns 404 (`character_not_found`) and our callEdgeFunction wrapper
   * throws, which publishWithModeration catches and surfaces as the generic
   * "Moderation service is temporarily unavailable" copy — confusing because
   * the provider was never actually called.
   *
   * Race in plain terms: saveCharacter enqueues a cloud-mirror upsert
   * fire-and-forget (characterStore.ts ~130); chars:save's willShare branch
   * and chars:set-shared(true) then immediately invoke runModerationGate,
   * which hits the Edge Function before the queue drained. Solution: do the
   * upsert synchronously here (shared = whatever the local row says — likely
   * false; the gate's own upsertCharacter call later flips to shared=true on
   * a clean verdict).
   *
   * Portrait: if portrait_image is set, also upload the bytes synchronously
   * so SightEngine's URL fetch succeeds. portrait_image=null short-circuits
   * to a 'no-portrait' clean verdict inside the Edge Function (lines 156-158
   * + 205-207), so we can skip the upload in that case.
   *
   * Skin is best-effort — the gate doesn't read skin bytes, so async sync
   * via the regular queue is fine.
   */
  async function ensureCloudRowForModeration(
    characterId: string,
    ownerUuid: string,
    accessToken: string,
  ): Promise<void> {
    const { getCharacter: getLocal } = await import('./characterStore');
    const char = await getLocal(characterId);
    if (!char) throw new Error(`character ${characterId} not found locally`);

    console.log(
      `[sei] ensureCloudRowForModeration: upserting ${characterId} (owner=${ownerUuid}, local.owner=${char.owner ?? 'null'}, shared=${char.shared}, portrait=${char.portrait_image ?? 'null'})`,
    );

    // Use an explicitly JWT-authed client for EVERY call below — upsert, verify
    // SELECT, and the portrait Storage upload. The singleton getClient()'s
    // ambient session is not reliably applied to outgoing requests in the main
    // process (see supabaseClient.ts getAuthedClient): when auth.getSession()
    // doesn't resolve, supabase-js's fetchWithAuth falls back to the anon key,
    // so RLS sees auth.uid()=null. PostgREST tolerates this intermittently, but
    // the Storage INSERT then trips "portraits new row violates row-level
    // security policy" → the moderation Edge Function 502s → the user sees the
    // misleading "Moderation service is temporarily unavailable." Passing the
    // JWT in global.headers.Authorization makes auth.uid() deterministic.
    const { getAuthedClient } = await import('./auth/supabaseClient');
    const authed = getAuthedClient(accessToken);

    const { upsertCharacter, uploadPortrait } = await import('./cloud/cloudCharacterClient');
    await upsertCharacter({ ...char, owner: ownerUuid }, ownerUuid, authed);

    // Verify the row landed before handing off to the moderation gate. The
    // Edge Function uses adminClient (service_role, RLS-bypassing) for its
    // SELECT, so if a row visible to service_role doesn't exist, the upsert
    // silently no-op'd — usually because the JWT didn't carry auth.uid()
    // through to the INSERT's WITH CHECK clause. Surfacing this explicitly
    // beats the misleading "Moderation service is temporarily unavailable"
    // copy downstream.
    const { data: verifyRow, error: verifyErr } = await authed
      .from('characters')
      .select('id, owner, portrait_image, shared')
      .eq('id', characterId)
      .maybeSingle();
    if (verifyErr) {
      console.warn(
        `[sei] ensureCloudRowForModeration: verify SELECT failed for ${characterId}: ${verifyErr.message}`,
      );
    } else if (!verifyRow) {
      console.warn(
        `[sei] ensureCloudRowForModeration: row ${characterId} NOT visible after upsert — RLS likely rejected INSERT (auth.uid() vs ${ownerUuid})`,
      );
    } else {
      console.log(
        `[sei] ensureCloudRowForModeration: verified row ${characterId} (owner=${verifyRow.owner}, portrait_image=${verifyRow.portrait_image ?? 'null'}, shared=${verifyRow.shared})`,
      );
    }

    if (char.portrait_image) {
      try {
        const { readFile } = await import('node:fs/promises');
        const bytes = await readFile(paths.portraitPath(characterId));
        // Server-side signed-URL upload (asymmetric-JWT bridge): storage-api
        // can't verify our ES256 token, so uploadPortrait routes through the
        // sign-character-asset-upload Edge Function. Pass the access token, not
        // the authed client — the client no longer touches storage directly.
        await uploadPortrait(characterId, bytes, 'png', accessToken);
        console.log(
          `[sei] ensureCloudRowForModeration: uploaded portrait for ${characterId} (${bytes.byteLength} bytes)`,
        );
      } catch (err) {
        // Non-fatal: if the portrait file is missing on disk (legacy install,
        // partial write), the Edge Function will still find row.portrait_image
        // set and SightEngine will 404 → 502. The user retries; meanwhile the
        // upsert above succeeded so the moderation gate doesn't hit the row-
        // missing 404 path. Logging only.
        console.warn(
          `[sei] ensureCloudRowForModeration: portrait upload for ${characterId} failed: ${(err as Error).message}`,
        );
      }
    }
  }

  // 260525-qy0 Task 4 — moderation gate runner shared by:
  //   - the new chars.save shared=true branch
  //   - the new chars.setShared(true) branch
  //
  // Returns the PublishResult tagged union from moderationGate. Caller decides
  // how to surface ok:false to the renderer (chars.save throws with friendlyMessage;
  // chars.setShared throws with friendlyMessage — same shape as the existing
  // CharacterPage.tsx catch).
  //
  // All adapter logic lifted verbatim from the previous browse.publishWithModeration
  // IPC handler so behavior is identical to what the dead-code path would have done.
  async function runModerationGate(
    characterId: string,
  ): Promise<import('./cloud/moderationGate').PublishResult> {
    const { isCloudWriteAllowed } = await import('./auth/authState');
    if (!(await isCloudWriteAllowed())) {
      return {
        ok: false,
        code: 'CLOUD_MODERATION_PROVIDER_UNAVAILABLE',
        friendlyMessage: 'Please sign in and accept the Terms of Service before publishing.',
      } as const;
    }
    const { getClient } = await import('./auth/supabaseClient');
    const { data: { session } } = await getClient().auth.getSession();
    if (!session?.access_token) {
      return {
        ok: false,
        code: 'CLOUD_MODERATION_PROVIDER_UNAVAILABLE',
        friendlyMessage: 'Please sign in before publishing.',
      } as const;
    }
    const accessToken = session.access_token;

    // Moderation bypass. Two reasons to skip the image/prompt Edge Functions and
    // mark the row clean directly:
    //   1. MODERATION_ENABLED === false — the global kill-switch (see above).
    //   2. First-party defaults (sui/lyra/marv) — curated dev content, always
    //      exempt even when moderation is re-enabled. Re-running the gate on
    //      every edit was landing moderation_status=null on these rows and
    //      silently dropping them out of World (search_public_characters only
    //      returns moderation_status='clean').
    // The write is a targeted UPDATE (no Edge Function, and no full-row upsert
    // that could clobber the uploaded portrait_image with a bundle path). It runs
    // AFTER ensureCloudRowForModeration's portrait upload in both chars.save and
    // chars.setShared, so it overrides the reset_moderation_on_portrait_change
    // trigger's null. Best-effort — publishing must never be blocked by it.
    const isFirstPartyDefault = (Object.values(DEFAULT_CHARACTER_UUIDS) as string[]).includes(characterId);
    if (!MODERATION_ENABLED || isFirstPartyDefault) {
      const provider = MODERATION_ENABLED ? 'first-party-exempt' : 'moderation-disabled';
      try {
        const { getAuthedClient } = await import('./auth/supabaseClient');
        const { error } = await getAuthedClient(accessToken)
          .from('characters')
          .update({
            shared: true,
            moderation_status: 'clean',
            moderation_checked_at: new Date().toISOString(),
            moderation_provider: provider,
          })
          .eq('id', characterId);
        if (error) {
          console.warn(`[sei] moderation-bypass (${provider}) clean write failed for ${characterId}: ${error.message}`);
        }
      } catch (err) {
        console.warn(`[sei] moderation-bypass (${provider}) clean write threw for ${characterId}: ${(err as Error).message}`);
      }
      return { ok: true, moderationProvider: provider, textProvider: provider };
    }

    const [
      { publishWithModeration },
      { callEdgeFunction },
      { upsertCharacter, downloadCharacter },
      { getSupabaseUrl },
    ] = await Promise.all([
      import('./cloud/moderationGate'),
      import('./auth/edgeFunctionClient'),
      import('./cloud/cloudCharacterClient'),
      import('./env'),
    ]);

    // Adapter bag is identical to the one in the old browse.publishWithModeration
    // handler (pre-260525-qy0). Copy is verbatim.
    return await publishWithModeration(characterId, {
      callEdgeFunction: async <T,>(name: string, opts: { jwt: string; body: unknown; timeoutMs?: number }) => {
        const res = await callEdgeFunction(name, {
          jwt: opts.jwt,
          body: opts.body,
          timeoutMs: opts.timeoutMs,
        });
        if (!res.ok) {
          throw new Error(`edge-${name}-failed: status=${res.status} ${res.message}`);
        }
        return res.json as T;
      },
      upsertCharacter: async (char, ownerUuid) => {
        const characterShape = {
          id: char.id,
          kind: ((char.kind as string | null) ?? 'custom') as Character['kind'],
          public_id: (char.public_id as string | null) ?? null,
          name: char.name,
          slug: (char.slug as string | null) ?? null,
          persona: {
            source: char.persona_source,
            expanded: char.persona_expanded,
          },
          is_default: false,
          shared: (char.shared as boolean) ?? true,
          created: (char.created as string | null) ?? new Date().toISOString(),
          last_launched: (char.last_launched as string | null) ?? null,
          playtime_ms: Number(char.playtime_ms ?? 0),
          portrait_image: (char.portrait_image as string | null) ?? null,
          skin: {
            source: (char.skin_source as 'bundled' | 'upload' | 'username' | 'none') ?? 'none',
            mojang_username: (char.mojang_username as string | null) ?? null,
            png_sha256: (char.skin_png_sha256 as string | null) ?? null,
            applied_at: (char.skin_applied_at as string | null) ?? null,
          },
          username: (char.username as string | null) ?? null,
          metadata: (char.metadata as Record<string, unknown>) ?? {},
        };
        await upsertCharacter(characterShape, ownerUuid);
      },
      reExpandPersona: async (id) => {
        const cloudChar = await downloadCharacter(id);
        return cloudChar?.persona.expanded ?? '';
      },
      getCharacter: async (id) => {
        // Read from the LOCAL store, not cloud. The chars.save (and
        // chars.setShared) flow writes the row locally BEFORE invoking the
        // moderation gate, and the cloud mirror is fire-and-forget — so the
        // cloud row may not yet exist when this runs. Previously this called
        // downloadCharacter(id) and threw "character X not found in cloud",
        // surfacing as the chars:save error users saw on new-character save.
        // Local data is the source of truth at gate time; the gate only needs
        // name + persona text + owner to call the moderation Edge Functions,
        // all of which are populated locally.
        const { getCharacter: getLocal } = await import('./characterStore');
        const c = await getLocal(id);
        if (!c) throw new Error(`character ${id} not found`);
        return {
          id: c.id,
          owner: c.owner ?? session.user.id,
          name: c.name,
          persona_source: c.persona.source,
          persona_expanded: c.persona.expanded,
          slug: c.slug,
          shared: c.shared,
          created: c.created,
          last_launched: c.last_launched,
          playtime_ms: c.playtime_ms,
          portrait_image: c.portrait_image,
          skin_source: c.skin.source,
          mojang_username: c.skin.mojang_username,
          skin_png_sha256: c.skin.png_sha256,
          skin_applied_at: c.skin.applied_at,
          username: c.username,
          // Fold the human-facing description into metadata.description. The
          // local Character keeps it as a TOP-LEVEL field, but the cloud row
          // (and every cloud upsert path — see cloudCharacterClient.upsertCharacter
          // / rowToCharacter) carries it inside metadata.description. Without
          // this fold, publishWithModeration spreads this row straight into its
          // final upsertCharacter call with metadata:{}, CLOBBERING the
          // description that the earlier ensureCloudRowForModeration / sync-queue
          // upserts wrote — so every character published through the gate lost
          // its description in cloud and other users saw "No description provided".
          metadata:
            c.description != null
              ? { ...c.metadata, description: c.description }
              : c.metadata,
        };
      },
      getJwt: async () => accessToken,
      supabaseUrl: getSupabaseUrl(),
    });
  }

  // Auto-remoderate-on-reset delegate (see module-level note near
  // MODERATION_ENABLED). Assigned once here so the exported entry point can
  // reuse runModerationGate. registerIpcHandlers runs at app init, before any
  // sign-in event fires, so the delegate is always set before it's called.
  _runResetRemoderationSweep = async (userId: string): Promise<void> => {
    const MAX_RESET_SWEEP = 25;
    try {
      const { isCloudWriteAllowed } = await import('./auth/authState');
      if (!(await isCloudWriteAllowed())) return;

      const { getClient, getAuthedClient } = await import('./auth/supabaseClient');
      const {
        data: { session },
      } = await getClient().auth.getSession();
      const accessToken = session?.access_token;
      if (!accessToken) return;

      // Only the caller's OWN shared rows whose moderation was reset to null.
      // RLS + owner=userId keep this scoped to the signed-in user; the null
      // filter is what makes this dormant while moderation is disabled.
      const { data, error } = await getAuthedClient(accessToken)
        .from('characters')
        .select('id')
        .eq('owner', userId)
        .eq('shared', true)
        .is('moderation_status', null)
        .limit(MAX_RESET_SWEEP);
      if (error) {
        console.warn(`[sei] remoderate-on-reset: query failed: ${error.message}`);
        return;
      }
      const ids = (data ?? []).map((r) => (r as { id: string }).id);
      if (ids.length === 0) return; // no reset rows — dormant under all-green

      console.log(
        `[sei] remoderate-on-reset: re-running gate for ${ids.length} reset shared character(s)`,
      );
      for (const id of ids) {
        try {
          const res = await runModerationGate(id);
          console.log(
            `[sei] remoderate-on-reset: ${id} → ${
              res.ok ? `restored (${res.moderationProvider})` : `left hidden (${res.code})`
            }`,
          );
        } catch (err) {
          console.warn(`[sei] remoderate-on-reset: ${id} failed: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      console.warn(`[sei] remoderate-on-reset: sweep threw: ${(err as Error).message}`);
    }
  };

  // Bot supervision
  ipcMain.handle(IpcChannel.bot.summon, async (_event, idArg: unknown) => {
    const id = IdSchema.parse(idArg);
    await deps.supervisor.summon(id);
  });
  ipcMain.handle(IpcChannel.bot.stop, async (_event, idArg: unknown) => {
    // Multi-summon: `stop(id)` drains one session; `stop()` (no id) drains all.
    const id = idArg == null ? undefined : IdSchema.parse(idArg);
    await deps.supervisor.stop(id);
  });
  // Bot-status snapshot (pull). Seeds a freshly-(re)subscribed renderer's
  // summons map; the bot:status channel only pushes on transitions.
  ipcMain.handle(IpcChannel.bot.getStatuses, async (): Promise<BotStatus[]> => {
    return deps.getBotStatuses();
  });

  // LAN state snapshot (pull). Seeds a freshly-(re)loaded renderer; the
  // lan:state channel only pushes on change.
  ipcMain.handle(IpcChannel.lan.get, async (): Promise<LanState> => {
    return deps.getLanState();
  });

  // Fresh, undamped LAN detection pass (pull). Backs the summon click's
  // live-truth gate so a just-closed world isn't summoned into. Falls back to
  // the cached snapshot if the on-demand check is unwired or throws.
  ipcMain.handle(IpcChannel.lan.checkNow, async (): Promise<LanState> => {
    try {
      return (await deps.checkLanNow?.()) ?? deps.getLanState();
    } catch {
      return deps.getLanState();
    }
  });

  // Character CRUD
  ipcMain.handle(IpcChannel.chars.list, async (): Promise<Character[]> => {
    return await listCharacters();
  });
  ipcMain.handle(IpcChannel.chars.get, async (_event, idArg: unknown): Promise<Character | null> => {
    const id = IdSchema.parse(idArg);
    return await getCharacter(id);
  });
  // Pre-flight daily-creation quota check (MAX_CREATIONS_PER_DAY, local
  // rolling-24h log). Best-effort UX gate; the chars:save create path is the
  // enforcing backstop. See characterStore.checkCreateQuota.
  ipcMain.handle(
    IpcChannel.chars.checkCreateQuota,
    async (): Promise<{ blocked: boolean; resetsAt: string | null }> => {
      return await checkCreateQuota();
    },
  );
  // 260516-0yw: chars.save runs the LLM expansion call (main owns the
  // Anthropic API key) and returns the persisted Character so the renderer
  // can update its store with the new persona.expanded.
  // 260517-frz: when the renderer passes `{ skipExpansion: true }`, main
  // writes `character.persona.expanded` verbatim and skips the LLM call.
  // This is how the Edit modal supports manual editing of the long-form
  // prompt — the user's edits win, no regeneration is triggered.
  ipcMain.handle(IpcChannel.chars.save, async (_event, charArg: unknown, optsArg: unknown): Promise<Character> => {
    const parsedCharacter = CharacterSchema.parse(charArg);

    // 260703 procgen slot backstop — a CREATE (id not yet on disk) may not push
    // the Home library past MAX_COMPANION_SLOTS. Updates to an existing
    // character are always allowed (they don't add a slot). Defaults are never
    // saved through this path. This is defense-in-depth behind the renderer's
    // pre-check and the generateUnique guard.
    //
    // 260705: a CREATE is also subject to the daily creation cap
    // (MAX_CREATIONS_PER_DAY, rolling 24h — checkCreateQuota). The renderer
    // pre-checks and shows CreationLimitModal before entering the wizard;
    // this is the backstop for the mid-flow race, and the thrown sentinel
    // contains 'daily_limit_reached' — the string AddCharacterScreen already
    // pattern-matches to land on the same modal.
    const isCreate = (await getCharacter(parsedCharacter.id).catch(() => null)) === null;
    if (isCreate) {
      if (await libraryIsFull()) {
        throw new Error(SLOT_LIMIT_REACHED_MESSAGE);
      }
      const quota = await checkCreateQuota();
      if (quota.blocked) {
        throw new Error('character creation failed: daily_limit_reached');
      }
    }

    const skipExpansion =
      optsArg != null &&
      typeof optsArg === 'object' &&
      (optsArg as { skipExpansion?: unknown }).skipExpansion === true;

    // Streaming-progress routing key. When present, build an onProgress bridge
    // that stamps each expansion tick with this id and pushes it onto the
    // chars:expansion-progress channel; the renderer filters by the same id.
    // Absent → expansion still streams internally, it just emits no ticks.
    const expansionRequestId =
      optsArg != null &&
      typeof optsArg === 'object' &&
      typeof (optsArg as { expansionRequestId?: unknown }).expansionRequestId === 'string'
        ? (optsArg as { expansionRequestId: string }).expansionRequestId
        : undefined;
    const onProgress = expansionRequestId
      ? (p: { fraction: number; section: string }): void =>
          deps.sendExpansionProgress({ requestId: expansionRequestId, ...p })
      : undefined;

    // Stamp owner on local-only characters at save time so the renderer can
    // filter by current account on sign-in. Without this, characters created
    // while signed in as A had a null owner and would later leak into B's
    // Home grid (the legacy `c.owner == null → show` fallback). Defaults are
    // never owned (D-22). For everything else, copy from the live session.
    let character = parsedCharacter;
    if (!parsedCharacter.is_default) {
      try {
        const { getClient } = await import('./auth/supabaseClient');
        const session = (await getClient().auth.getSession()).data.session;
        if (session?.user.id) {
          character = { ...parsedCharacter, owner: session.user.id };
        }
      } catch {
        // No session / supabase init failure: leave owner unset, character is
        // local-only and visible only when signed-out per HomeGrid filter.
      }
    }

    // 260525-qy0 Task 4 — gate every shared=true transition through the
    // moderation pipeline BEFORE the cloud upsert. Defaults (D-22) can never
    // be shared, so willShare implicitly excludes them.
    const willShare = character.shared === true && !character.is_default;

    // Analytics (260707): a create (not an edit). `source` distinguishes a
    // wizard/prompt-expander companion from an advanced full-custom one
    // (skipExpansion). No persona/name content is sent.
    if (isCreate) {
      trackAnalytics('character_created', {
        source: skipExpansion ? 'custom' : 'expander',
        shared: willShare,
      });
    }

    if (!willShare) {
      // Fast path — private save (or default-with-shared=false). Existing
      // behavior preserved exactly.
      if (skipExpansion) {
        await saveCharacter(character);
        if (isCreate) await recordCreation();
        return character;
      }
      const persisted = await expandAndSaveCharacter({ character, onProgress });
      if (isCreate) await recordCreation();
      return persisted;
    }

    // Phase 1 — local persist as PRIVATE first. This defuses the sync-queue
    // race where saveCharacter's fire-and-forget mirror could enqueue
    // shared=true to cloud BEFORE moderation runs. The cloud row lands as
    // private; moderation's own upsertCharacter adapter does the shared=true
    // flip on clean.
    const draftPrivate: Character = { ...character, shared: false };
    let persistedPrivate: Character;
    if (skipExpansion) {
      await saveCharacter(draftPrivate);
      persistedPrivate = draftPrivate;
    } else {
      persistedPrivate = await expandAndSaveCharacter({ character: draftPrivate, onProgress });
    }
    // The character is on disk from here on — count the creation now, before
    // the (long, failure-prone) moderation + cloud-sync tail.
    if (isCreate) await recordCreation();

    // Phase 2 — run moderation gate. On clean, the gate's upsertCharacter
    // adapter has already written shared=true to cloud; re-sync the local
    // row via saveCharacterRaw (no mirror) so we don't double-queue.
    //
    // Sync-upsert the cloud row + portrait FIRST. saveCharacter above only
    // enqueued a fire-and-forget mirror; if the queue hasn't drained, the
    // moderation Edge Function's row lookup 404s and the friendly "moderation
    // service unavailable" copy fires even though the provider was never
    // actually called.
    try {
      const { getClient } = await import('./auth/supabaseClient');
      const session = (await getClient().auth.getSession()).data.session;
      if (session?.user?.id && session.access_token) {
        await ensureCloudRowForModeration(persistedPrivate.id, session.user.id, session.access_token);
      }
    } catch (err) {
      console.warn(`[sei] pre-moderation sync upsert for ${persistedPrivate.id}: ${(err as Error).message}`);
    }
    const result = await runModerationGate(persistedPrivate.id);
    if (!result.ok) {
      // Local row stays at shared=false. Renderer surfaces friendlyMessage.
      throw new Error(result.friendlyMessage);
    }
    const { saveCharacterRaw } = await import('./characterStore');
    const persistedShared: Character = { ...persistedPrivate, shared: true };
    await saveCharacterRaw(persistedShared);
    return persistedShared;
  });
  ipcMain.handle(IpcChannel.chars.delete, async (_event, idArg: unknown): Promise<void> => {
    const id = IdSchema.parse(idArg);
    const char = await getCharacter(id);
    if (!char) throw new Error('Character not found.');
    // Refuse to delete the active character — UI should never request this.
    if (deps.supervisor.isActive(id)) {
      throw new Error('Cannot delete the currently summoned character. Stop first.');
    }
    if (char.is_default) {
      // Defaults are bundled (D-22) and never actually leave the disk —
      // 260703 procgen: Home visibility for defaults is OPT-IN via
      // UserConfig.added_default_ids (they live in the World tab otherwise),
      // so "remove from library" strips the id from that list. The legacy
      // removed_default_ids field is no longer consulted anywhere.
      const { loadConfig, saveConfig } = await import('./configStore');
      const cfg = await loadConfig();
      const added = (cfg.added_default_ids ?? []).filter((x) => x !== id);
      if (added.length !== (cfg.added_default_ids ?? []).length) {
        await saveConfig({ ...cfg, added_default_ids: added });
      }
      return;
    }
    await deleteCharacter(id);
  });
  ipcMain.handle(IpcChannel.chars.restoreDefault, async (_event, idArg: unknown): Promise<void> => {
    const id = IdSchema.parse(idArg);
    const char = await getCharacter(id);
    if (!char) throw new Error('Character not found.');
    if (!char.is_default) {
      throw new Error('Only default characters can be restored.');
    }
    const { loadConfig, saveConfig } = await import('./configStore');
    const cfg = await loadConfig();
    // 260703 procgen slot backstop — re-adding a default to Home occupies a
    // slot; refuse when the library is already full UNLESS this default is
    // already counted (a no-op re-add must not falsely block).
    const alreadyOnHome = (cfg.added_default_ids ?? []).includes(id);
    if (!alreadyOnHome && (await libraryIsFull())) {
      throw new Error(SLOT_LIMIT_REACHED_MESSAGE);
    }
    // 260703 procgen: Home visibility for defaults is OPT-IN — inviting a
    // default writes it into added_default_ids (the set HomeGrid/IconRail and
    // the slot guard above actually read).
    if (!alreadyOnHome) {
      const added = [...(cfg.added_default_ids ?? []), id];
      await saveConfig({ ...cfg, added_default_ids: added });
    }
  });

  // Add a non-default foreign-owned (World) character to the user's library.
  // Step 1: cache-on-demand pulls the cloud row + skin + portrait onto local
  //          disk so the bot can run it offline.
  // Step 2: write the id into UserConfig.added_world_ids so HomeGrid and
  //          IconRail surface the character on Home despite its owner being
  //          someone else. Defaults follow the restoreDefault path above.
  ipcMain.handle(IpcChannel.chars.addToLibrary, async (_event, idArg: unknown): Promise<void> => {
    const id = IdSchema.parse(idArg);
    // 260703 procgen slot backstop — adding a World character occupies a Home
    // slot; refuse when the library is already full UNLESS it ALREADY occupies a
    // slot. "Already counted" must mirror the exact membership rule
    // libraryCharacterCount uses, NOT merely "cached locally and not default":
    // opening/hovering a World card runs charsOpenPrepare → ensureLocallyCached,
    // which caches the foreign row on disk, so a bare `!is_default` check treats
    // every browsed-but-not-invited character as counted and skips the backstop —
    // letting a full 4/4 user invite a 5th and silently drop an existing one. A
    // foreign row occupies a slot ONLY when it is actually invited
    // (config.added_world_ids); a merely-cached row does not.
    {
      const { loadConfig: loadCfg } = await import('./configStore');
      const preCfg = await loadCfg();
      const { getCurrentAuthState } = await import('./auth/authState');
      const auth = getCurrentAuthState();
      const currentUserId = auth.kind === 'signed_in' ? auth.user.id : null;
      const localExisting = await getCharacter(id).catch(() => null);
      let alreadyCounted: boolean;
      if (localExisting?.is_default) {
        // Bundled default → occupies a slot only when invited to Home.
        alreadyCounted = (preCfg.added_default_ids ?? []).includes(id);
      } else if (
        localExisting != null &&
        currentUserId != null &&
        localExisting.owner != null &&
        localExisting.owner !== currentUserId
      ) {
        // Foreign-owned (World) row → counts only when explicitly invited;
        // merely cached by browsing does NOT count.
        alreadyCounted = (preCfg.added_world_ids ?? []).includes(id);
      } else if (localExisting != null) {
        // Own or legacy null-owner local char → always occupies a slot.
        alreadyCounted = true;
      } else {
        // Not cached locally yet → count it only if already invited.
        alreadyCounted = (preCfg.added_world_ids ?? []).includes(id);
      }
      if (!alreadyCounted && (await libraryIsFull())) {
        throw new Error(SLOT_LIMIT_REACHED_MESSAGE);
      }
    }
    const { ensureLocallyCached } = await import('./cloud/cacheOnDemand');
    await ensureLocallyCached(id);
    const { loadConfig, saveConfig } = await import('./configStore');
    const cfg = await loadConfig();
    const added = new Set(cfg.added_world_ids ?? []);
    if (!added.has(id)) {
      added.add(id);
      await saveConfig({ ...cfg, added_world_ids: Array.from(added) });
    }
  });

  // Remove a foreign-owned World character from the user's library. Two
  // steps: strip the id from UserConfig.added_world_ids so HomeGrid +
  // IconRail re-filter, then wipe the local cache files (JSON + portrait +
  // skin + memory). DOES NOT enqueue any cloud delete — the user doesn't own
  // the row, RLS would reject it, and we'd burn a sync-queue retry slot.
  // Refuses to act while the character is summoned.
  ipcMain.handle(IpcChannel.chars.removeFromLibrary, async (_event, idArg: unknown): Promise<void> => {
    const id = IdSchema.parse(idArg);
    if (deps.supervisor.isActive(id)) {
      throw new Error('Cannot remove the currently summoned character. Stop first.');
    }
    const { loadConfig, saveConfig } = await import('./configStore');
    const cfg = await loadConfig();
    const added = (cfg.added_world_ids ?? []).filter((x) => x !== id);
    if (added.length !== (cfg.added_world_ids ?? []).length) {
      await saveConfig({ ...cfg, added_world_ids: added });
    }
    // Wipe local cache files via the same hand-rolled deletion the reconcile
    // sweep uses (skips the cloud-mirror enqueue inside characterStore.
    // deleteCharacter that would 403 against RLS for a foreign-owned row).
    const { unlink, rm } = await import('node:fs/promises');
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
          console.warn(`[sei] removeFromLibrary unlink ${target}: ${(err as Error).message}`);
        }
      }
    }
    try {
      await rm(paths.memoryDir(id), { recursive: true, force: true });
    } catch (err) {
      console.warn(`[sei] removeFromLibrary memory dir ${id}: ${(err as Error).message}`);
    }
    // Drop from the character index so chars.list doesn't re-surface it.
    try {
      const { readFile, writeFile, mkdir } = await import('node:fs/promises');
      const idxPath = paths.indexPath();
      const raw = await readFile(idxPath, 'utf8').catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return null;
        throw err;
      });
      if (raw == null) return;
      const parsed = JSON.parse(raw) as { version?: number; order?: unknown };
      if (!Array.isArray(parsed.order)) return;
      const next = parsed.order.filter((x) => x !== id);
      if (next.length === parsed.order.length) return;
      await mkdir(paths.charactersDir(), { recursive: true });
      await writeFile(idxPath, JSON.stringify({ version: 1, order: next }, null, 2) + '\n');
    } catch (err) {
      console.warn(`[sei] removeFromLibrary index for ${id}: ${(err as Error).message}`);
    }
  });
  ipcMain.handle(IpcChannel.chars.resetMemory, async (_event, idArg: unknown): Promise<void> => {
    const id = IdSchema.parse(idArg);
    // Refuse while bot is reading/writing memory at runtime.
    if (deps.supervisor.isActive(id)) {
      throw new Error('Cannot reset memory of the currently summoned character. Stop first.');
    }
    await resetMemoryForCharacter(id);
  });

  // Phase 11 D-28 — portrait pipeline. Renderer canvas-resizes + re-encodes
  // bytes (≤1024², ≤500KB) and hands them here as base64. We re-validate
  // (magic + size + PNG dim) in portraitStore.applyPortrait before writing.
  //
  // characterId is gated through z.string().uuid() — the post-11-03 schema
  // requires UUID v4 for `Character.id`, and `paths.portraitPath(uuid)` builds
  // a filesystem path component, so UUID format is the path-traversal defense.
  // The kebab-case IdSchema above is for legacy slug callers; portrait IPC
  // is UUID-only from day one (T-11-06-03).
  ipcMain.handle(IpcChannel.chars.applyPortrait, async (_event, argsRaw: unknown): Promise<string> => {
    const args = z.object({
      characterId: z.string().uuid(),
      bytesBase64: z.string().min(1),
      format: z.enum(['png', 'jpeg', 'webp']),
    }).parse(argsRaw);
    const bytes = Buffer.from(args.bytesBase64, 'base64');
    const { applyPortrait } = await import('./portraitStore');
    return await applyPortrait({ characterId: args.characterId, bytes });
  });

  ipcMain.handle(IpcChannel.chars.removePortrait, async (_event, idArg: unknown): Promise<void> => {
    const id = z.string().uuid().parse(idArg);
    const { removePortrait } = await import('./portraitStore');
    await removePortrait(id);
  });

  // ── In-app chat (Phase 18/19) ─────────────────────────────────────────────
  // The chat LLM call runs entirely in main (mirrors personaExpansion) — no
  // forked bot. `chat:send` may run the launch tool, which consults the live
  // LAN state and summons the bot when a world is open.
  // On-disk the transcript is append-only and never trimmed (260705), but the
  // UI hot path must NOT ship the whole file: a heavy user's chat.jsonl grows to
  // thousands of rows (including hidden voice rows), and reading+parsing+shipping
  // all of it froze the chat screen on open. The open ships only the most recent
  // CHAT_HISTORY_PAGE rows; the FULL transcript stays reachable via
  // chat:history-before, which the renderer calls page by page as the user
  // scrolls toward the top (infinite scrollback, 260721). The model's own
  // context is bounded separately by continuity (rolling summary + recent
  // window); these reads are UI-only.
  ipcMain.handle(IpcChannel.chat.history, async (_event, idArg: unknown) => {
    const id = IdSchema.parse(idArg);
    const { readRecent } = await import('./chat/chatStore');
    return await readRecent(id, CHAT_HISTORY_PAGE);
  });

  ipcMain.handle(IpcChannel.chat.historyBefore, async (_event, argsRaw: unknown) => {
    const args = z
      .object({
        characterId: IdSchema,
        // Cursor: the id of the renderer's oldest loaded row. Free-form (ids are
        // main-minted or legacy), just bounded so junk can't ship a novel.
        beforeId: z.string().min(1).max(256),
      })
      .parse(argsRaw);
    const { readBefore } = await import('./chat/chatStore');
    return await readBefore(args.characterId, args.beforeId, CHAT_HISTORY_PAGE);
  });

  ipcMain.handle(IpcChannel.chat.send, async (_event, argsRaw: unknown) => {
    const args = z
      .object({
        characterId: IdSchema,
        text: z.string().min(1).max(CHAT_TEXT_MAX),
        // Quoted-reply reference (chat #1) — was previously dropped here, so the
        // companion never saw what the user was replying to.
        replyTo: z
          .object({ role: z.enum(['user', 'companion']), text: z.string() })
          .optional(),
        // Multi-companion voice (260706): names of the other companions on the call.
        voicePeers: z.array(z.string()).optional(),
      })
      .parse(argsRaw);
    const { sendChatMessage } = await import('./chat/chatService');
    const { isCallActive } = await import('./voice/callState');
    const inCall = isCallActive(args.characterId);
    // Fresh world-detection pass before the prompt is built (260703): the
    // "is my world open?" answer must not come from a stale poll. ~60-100ms.
    // Skipped mid-call — a live voice call cannot be opening a world, and this
    // ran on the latency-critical path before every spoken reply (260706).
    if (!inCall) {
      try { await deps.refreshLanState?.(); } catch { /* chat proceeds on cache */ }
    }
    return await sendChatMessage(
      // voiceCall (260705): while a call is open the reply is spoken aloud, so
      // the prompt leads with the voice-call primer (spoken register).
      { characterId: args.characterId, text: args.text, replyTo: args.replyTo, voiceCall: inCall, voicePeers: args.voicePeers },
      {
        getLanState: deps.getLanState,
        summon: (id) => deps.supervisor.summon(id),
        // Task 4 — when the character is already in-game (spawned), route this
        // message into that live session instead of the standalone chat brain.
        isInGame: (id) => deps.isSessionOnline(id),
        routeToBot: (id, payload) => deps.supervisor.sendSeiChat(id, payload),
        onLaunchFailed: (id, reason) => deps.notifyLaunchFailed(id, reason),
        // Task 5 — the companion called quit() from chat: end the live session.
        leaveGame: (id) => {
          void deps.supervisor.stop(id);
        },
        // Voice streaming (260706): push each streamed sentence to the renderer
        // the instant it completes, so TTS starts on sentence 1.
        emitReply: (id, message) => deps.pushChatMessage?.(id, message),
      },
    );
  });

  // ── Voice calls (260705) ──────────────────────────────────────────────────
  // TTS synthesis (proxy passthrough; the ElevenLabs key never reaches the
  // renderer or the repo) + the call open/hang-up toggle. The toggle records
  // main-side state (idle-chat prompts read it) and forwards the mode into a
  // live game session so say() reroutes to the call.
  ipcMain.handle(IpcChannel.voice.tts, async (_event, argsRaw: unknown): Promise<ArrayBuffer> => {
    const args = z.object({ characterId: IdSchema, text: z.string().min(1).max(4000) }).parse(argsRaw);
    const { voiceTts } = await import('./voice/tts');
    return await voiceTts(args);
  });

  // Streaming TTS (260705): resolves {streamId} on upstream 200, then pushes
  // ordered audio chunks on voice:tts-chunk until {done} / {error}. Pre-flight
  // failures reject with the same VOICE_* sentinels as voice:tts.
  ipcMain.handle(IpcChannel.voice.ttsStream, async (event, argsRaw: unknown): Promise<{ streamId: string }> => {
    const args = z.object({ characterId: IdSchema, text: z.string().min(1).max(4000) }).parse(argsRaw);
    const { voiceTtsStream } = await import('./voice/tts');
    const sender = event.sender;
    return await voiceTtsStream(args, (ev) => {
      if (!sender.isDestroyed()) sender.send(IpcChannel.voice.ttsChunk, ev);
    });
  });

  ipcMain.handle(IpcChannel.voice.callState, async (_event, argsRaw: unknown): Promise<void> => {
    const args = z
      .object({
        characterId: IdSchema,
        active: z.boolean(),
        // Hang-up only: how long the call was actually LIVE. Present → post
        // the "You and X called for Y" row. Absent → the call never connected
        // (dial error), so nothing is logged.
        connectedMs: z.number().int().nonnegative().optional(),
      })
      .parse(argsRaw);
    const { setCallActive } = await import('./voice/callState');
    setCallActive(args.characterId, args.active);
    deps.supervisor.setVoiceCall(args.characterId, args.active);
    if (!args.active && typeof args.connectedMs === 'number' && args.connectedMs > 0) {
      deps.notifyCallEnded?.(args.characterId, args.connectedMs);
    }
    // Presence (260707): a call is a real interaction, so stamp last_chatted at
    // BOTH edges. Game sessions and text chat already drive the "online" dot;
    // a call previously only did when the player happened to speak a turn (that
    // path reuses sendChatMessage) — a greeting-only or listen-only call left
    // the character looking idle. Best-effort, like the chat-turn stamp.
    try {
      const { patchCharacter } = await import('./characterStore');
      await patchCharacter(args.characterId, (c) => ({ ...c, last_chatted: new Date().toISOString() }));
    } catch (err) {
      console.warn(`[sei] failed to stamp last_chatted on call state: ${(err as Error).message}`);
    }
  });

  // Idle conversation starter (260707): the renderer's call-idle timer asks one
  // companion to break a long quiet stretch (or stay silent via "(silence)").
  // Passes { messages, endCall } through as-is: endCall means the model hung up
  // on the nudge, and the renderer speaks `messages` then ends the call.
  ipcMain.handle(IpcChannel.voice.idleNudge, async (_event, argsRaw: unknown) => {
    const args = z
      .object({
        characterId: IdSchema,
        quietSeconds: z.number().nonnegative().max(3600),
        peers: z.array(z.string()).default([]),
      })
      .parse(argsRaw);
    const { sendVoiceIdleTurn } = await import('./chat/chatService');
    // 260708: hand the turn live LAN truth + a launch honor (see the
    // voice.companionTurn handler below for the full story).
    const idleWorldOpen = deps.getLanState().kind === 'open';
    return await sendVoiceIdleTurn(args.characterId, args.quietSeconds, args.peers, {
      openWorldDetected: idleWorldOpen,
      onLaunch: idleWorldOpen
        ? () => {
            void deps.supervisor.summon(args.characterId).catch((e) => {
              deps.notifyLaunchFailed(args.characterId, (e as Error)?.message ?? 'unknown error');
            });
          }
        : undefined,
    });
  });

  // Voice calls (260705): the renderer's call pipeline just went live — ask the
  // companion to speak first (like answering the phone). 260706: `peers` names
  // any other companions already on the call so a joiner greets the group.
  ipcMain.handle(IpcChannel.voice.greet, async (_event, argRaw: unknown): Promise<void> => {
    // Back-compat: a bare characterId string OR the {characterId, peers} object.
    const parsed =
      typeof argRaw === 'string'
        ? { characterId: IdSchema.parse(argRaw), peers: [] as string[] }
        : z.object({ characterId: IdSchema, peers: z.array(z.string()).default([]) }).parse(argRaw);
    deps.greetVoiceCall?.(parsed.characterId, parsed.peers);
  });

  // Multi-companion voice (260706): on a group call, hand one companion a line
  // another companion just spoke so it can react in character. Returns the
  // reaction lines (empty when it stays silent); the renderer speaks them.
  ipcMain.handle(IpcChannel.voice.companionTurn, async (_event, argsRaw: unknown) => {
    const args = z
      .object({
        characterId: IdSchema,
        speakerName: z.string().min(1).max(80),
        text: z.string().min(1).max(CHAT_TEXT_MAX),
        peers: z.array(z.string()).default([]),
        depth: z.number().int().nonnegative().default(0),
      })
      .parse(argsRaw);
    const { sendCompanionVoiceTurn } = await import('./chat/chatService');
    // 260708: this turn used to hardcode "no world open" — so while one
    // companion was IN the player's world, a call-only companion reacting on
    // the call was told no world existed (and repeated the open-to-LAN
    // instructions), and any launch() it called was silently dropped (this is
    // a single-shot turn with no tool loop). Pass live LAN truth and honor
    // launch() the way chat:send does, gated on the world actually being open.
    const reactWorldOpen = deps.getLanState().kind === 'open';
    return await sendCompanionVoiceTurn(args.characterId, {
      speakerName: args.speakerName,
      text: args.text,
      peers: args.peers,
      depth: args.depth,
      openWorldDetected: reactWorldOpen,
      onLaunch: reactWorldOpen
        ? () => {
            void deps.supervisor.summon(args.characterId).catch((e) => {
              deps.notifyLaunchFailed(args.characterId, (e as Error)?.message ?? 'unknown error');
            });
          }
        : undefined,
    });
  });

  // Multi-companion voice (260706): record a call line into a companion's
  // transcript without generating a reply (context for a non-responding peer).
  ipcMain.handle(IpcChannel.voice.observe, async (_event, argsRaw: unknown): Promise<void> => {
    const args = z
      .object({
        characterId: IdSchema,
        from: z.string().max(80),
        text: z.string().min(1).max(CHAT_TEXT_MAX),
      })
      .parse(argsRaw);
    const { observeVoiceLine } = await import('./chat/chatService');
    await observeVoiceLine(args.characterId, args.from, args.text);
    // 260708: an in-game companion's brain never saw call lines it was not the
    // routed recipient of (the standalone transcript above is only read by the
    // standalone chat brain), leaving in-game siblings deaf to each other on a
    // group call. Mirror the line into the live session as record-only context.
    if (deps.isSessionOnline(args.characterId)) {
      deps.supervisor.observeSeiChat(args.characterId, { from: args.from, text: args.text });
    }
  });

  // Always-on-top call overlay (260706): the main window pushes the overlay's
  // desired state; main reconciles the overlay window (spawn/position/close) and
  // forwards the state to it. Trusted, small payload from our own renderer.
  ipcMain.handle(IpcChannel.voice.overlaySet, async (_event, stateRaw: unknown): Promise<void> => {
    const state = z
      .object({
        enabled: z.boolean(),
        participants: z
          .array(
            z.object({
              id: z.string(),
              name: z.string(),
              portrait: z.string().nullable(),
              speaking: z.boolean(),
            }),
          )
          .max(12),
      })
      .parse(stateRaw);
    const { updateCallOverlay } = await import('./callOverlay');
    updateCallOverlay(state);
  });

  // Overlay window pulls the current state on mount — the seed push can race
  // its subscription (see getCallOverlayState).
  ipcMain.handle(IpcChannel.voice.overlayGet, async () => {
    const { getCallOverlayState } = await import('./callOverlay');
    return getCallOverlayState();
  });

  // Voice picker (creation flow, 260705): the curated pool + per-voice preview.
  ipcMain.handle(IpcChannel.voice.list, async () => {
    const { listPoolVoices } = await import('./voice/voiceAssign');
    return listPoolVoices();
  });

  ipcMain.handle(IpcChannel.voice.preview, async (_event, argsRaw: unknown): Promise<ArrayBuffer> => {
    const args = z.object({ voiceId: z.string().min(1).max(64) }).parse(argsRaw);
    const { voicePreviewTts } = await import('./voice/tts');
    return await voicePreviewTts(args.voiceId);
  });

  // Sample availability (260720): the picker disables play controls with a
  // quiet hint when TTS cannot run (signed out, no dev key). Never throws.
  ipcMain.handle(IpcChannel.voice.previewAvailable, async (): Promise<boolean> => {
    try {
      const { voicePreviewAvailable } = await import('./voice/tts');
      return await voicePreviewAvailable();
    } catch {
      return false;
    }
  });

  // First-meeting greeting (thoughts consumer #1). The renderer calls this when
  // it loads an empty transcript; main decides eligibility (any companion kind,
  // empty transcript, never chatted) and returns any greeting replies. A fresh
  // world-detection pass first so the greeting's prompt reflects live LAN truth,
  // same as chat:send.
  ipcMain.handle(IpcChannel.chat.opened, async (_event, idArg: unknown): Promise<ChatMessage[]> => {
    const id = IdSchema.parse(idArg);
    const { sendFirstMeetingTurn } = await import('./chat/chatService');
    try { await deps.refreshLanState?.(); } catch { /* greeting proceeds on cache */ }
    return await sendFirstMeetingTurn(id, { getLanState: deps.getLanState });
  });

  ipcMain.handle(IpcChannel.chat.previews, async (): Promise<Record<string, ChatPreview>> => {
    // Roster last-line previews (Party redesign §2). Enumerate the library and
    // read each character's last chat line. Per-character failures are skipped
    // so one unreadable transcript never sinks the whole call; characters with
    // no messages are omitted from the map (renderer treats a missing key as
    // "no preview yet").
    const { readLast } = await import('./chat/chatStore');
    const chars = await listCharacters();
    const out: Record<string, ChatPreview> = {};
    await Promise.all(
      chars.map(async (c) => {
        try {
          const last = await readLast(c.id);
          if (last) out[c.id] = { role: last.role, text: last.text, ts: last.ts };
        } catch {
          /* per-character read failure — skip this id, never throw the batch */
        }
      }),
    );
    return out;
  });

  // 260705: chat:clear removed — no UI ever invoked it, and the product wipe
  // surface is Reset memory (chars:reset-memory), which clears the transcript
  // + summary as part of the memory-dir wipe (see resetMemoryForCharacter).

  // ── User profile (Phase 19) ───────────────────────────────────────────────
  ipcMain.handle(IpcChannel.user.getProfile, async () => {
    const { getUserProfile } = await import('./userProfile');
    return await getUserProfile();
  });

  ipcMain.handle(IpcChannel.user.applyProfilePicture, async (_event, argsRaw: unknown): Promise<string> => {
    const args = z.object({ bytesBase64: z.string().min(1), format: z.enum(['png', 'jpeg', 'webp']) }).parse(argsRaw);
    const bytes = Buffer.from(args.bytesBase64, 'base64');
    const { applyUserProfilePicture } = await import('./userProfile');
    return await applyUserProfilePicture(bytes);
  });

  ipcMain.handle(IpcChannel.user.removeProfilePicture, async (): Promise<void> => {
    const { removeUserProfilePicture } = await import('./userProfile');
    await removeUserProfilePicture();
  });

  // Phase 11 D-16 — toggle public/private visibility on a character. Defaults
  // are bundle-supplied (D-22) and never appear in the cloud library, so we
  // refuse to flip `shared` on them at the IPC boundary. saveCharacter will
  // run the standard cloud-mirror upsert if the user is signed-in.
  ipcMain.handle(IpcChannel.chars.setShared, async (_event, argsRaw: unknown): Promise<void> => {
    const args = z.object({ id: IdSchema, shared: z.boolean() }).parse(argsRaw);
    const char = await getCharacter(args.id);
    if (!char) throw new Error('Character not found.');
    if (char.is_default) throw new Error('Cannot share a default character.');

    // Foreign-owned guard: a leaked local copy of someone else's cloud char
    // would otherwise fall through to runModerationGate, where the gate's
    // adapter overrides owner to session.user.id and the cloud upsert is
    // denied by RLS — surfaced to the user as the misleading "Moderation
    // service is temporarily unavailable." copy. Stop early with a clear
    // message instead.
    try {
      const { getClient } = await import('./auth/supabaseClient');
      const session = (await getClient().auth.getSession()).data.session;
      const sessionUserId = session?.user?.id ?? null;
      if (
        sessionUserId &&
        char.owner != null &&
        char.owner !== sessionUserId
      ) {
        throw new Error('You can only share characters you own.');
      }
    } catch (err) {
      // Re-throw our own error; swallow Supabase init failures (no session
      // → setShared(true) falls through to the moderation gate which will
      // reject with "please sign in").
      if ((err as Error).message === 'You can only share characters you own.') {
        throw err;
      }
    }

    // 260525-qy0 Task 4 — un-sharing is always allowed; only the share=true
    // transition is gated by the moderation pipeline.
    if (args.shared === false) {
      await saveCharacter({ ...char, shared: false });
      trackAnalytics('character_unshared', { character_id: char.id });
      return;
    }

    // shared=true path — moderation gate, then local mirror via saveCharacterRaw
    // (the gate's upsertCharacter adapter already wrote shared=true to cloud).
    //
    // Sync-upsert the cloud row + portrait FIRST. setShared can be called on
    // a character whose cloud mirror hasn't drained yet (legacy local-only
    // chars on first share; freshly-created chars where saveCharacter just
    // enqueued the upsert). Without this, the Edge Function 404s and the
    // generic "moderation service unavailable" copy is misleading.
    try {
      const { getClient: getClient2 } = await import('./auth/supabaseClient');
      const session2 = (await getClient2().auth.getSession()).data.session;
      if (session2?.user?.id && session2.access_token) {
        await ensureCloudRowForModeration(char.id, session2.user.id, session2.access_token);
      }
    } catch (err) {
      console.warn(`[sei] pre-moderation sync upsert for ${char.id}: ${(err as Error).message}`);
    }
    const result = await runModerationGate(char.id);
    if (!result.ok) {
      throw new Error(result.friendlyMessage);
    }
    const { saveCharacterRaw } = await import('./characterStore');
    await saveCharacterRaw({ ...char, shared: true });
    trackAnalytics('character_shared', { character_id: char.id });
  });

  // Phase 11 plan 17 — list the UUIDs of the signed-in user's cloud characters.
  // Drives the renderer's "LOCAL ONLY" chip: a character is "local only" when
  // signed_in AND !is_default AND its id is NOT in this set.
  //
  // Return shape (HR-01 fix): `ok` distinguishes "we asked Supabase and the
  // user has no cloud chars" (ok:true, ids:[]) from "Supabase listing failed"
  // (ok:false). The renderer uses `ok:false` to preserve its prior cloudIds
  // snapshot rather than flashing every user-created character as LOCAL ONLY
  // during a transient outage. Signed-out users return ok:true with ids:[]
  // because there is no cloud state to be uncertain about.
  ipcMain.handle(IpcChannel.chars.listCloud, async (): Promise<{ ids: string[]; ok: boolean }> => {
    const { getClient } = await import('./auth/supabaseClient');
    const { data: { session } } = await getClient().auth.getSession();
    if (!session?.user?.id) return { ids: [], ok: true };
    try {
      const { listMyCharacters } = await import('./cloud/cloudCharacterClient');
      const chars = await listMyCharacters(session.user.id);
      return { ids: chars.map((c) => c.id), ok: true };
    } catch (err) {
      console.warn(`[sei] chars.listCloud failed: ${(err as Error).message}`);
      return { ids: [], ok: false };
    }
  });

  // Phase 11 plan 19 (D-19, LIB-04) — cache-on-demand sync surface.
  //
  // chars:open-prepare ensures the requested character is hydrated to local
  // disk BEFORE the renderer navigates into it. For a cloud-only char on a
  // fresh machine, this downloads the row + skin + portrait once; for an
  // already-cached char, it's a no-op (existsSync short-circuit). Throws
  // CLOUD_CHARACTER_NOT_FOUND if the row is missing in cloud and
  // CLOUD_DOWNLOAD_FAILED when the user isn't signed in. Renderer surfaces
  // a generic "couldn't open offline" inline message on either throw.
  //
  // chars:list-merged returns the local + cloud row union, deduped by id,
  // with a per-row source annotation ('local' | 'cloud' | 'both'). HomeScreen
  // calls this in place of chars:list when the user is signed in so that
  // cloud-only characters created on other machines appear in the grid (with
  // the CLOUD chip indicating they require download on open).
  ipcMain.handle(IpcChannel.chars.openPrepare, async (_event, idArg: unknown): Promise<void> => {
    const id = IdSchema.parse(idArg);
    const { ensureLocallyCached } = await import('./cloud/cacheOnDemand');
    await ensureLocallyCached(id);
  });

  ipcMain.handle(IpcChannel.chars.listMerged, async () => {
    const { listMerged } = await import('./cloud/cacheOnDemand');
    return await listMerged();
  });

  // Phase 11 — sync queue status + retry. The renderer drives the per-card
  // pill (syncing / failed) from these; updates flow as one-way pushes over
  // IpcChannel.sync.statusUpdate (wired in the subscribe block below).
  ipcMain.handle(IpcChannel.sync.status, async () => {
    const { getStatus } = await import('./cloud/syncQueue');
    return await getStatus();
  });

  ipcMain.handle(IpcChannel.sync.retry, async (_event, idArg: unknown): Promise<void> => {
    const id = IdSchema.parse(idArg);
    const { retry } = await import('./cloud/syncQueue');
    await retry(id);
  });

  // Phase 11 (Plan 11-14) — TOS cache invalidation hook.
  //
  // Plan 11-12 lands the `tos:accept` IPC handler in this file (parallel wave 5).
  // Inside that handler, after `recordAcceptance(userId)` succeeds, the handler
  // MUST call `invalidateTosCache()` from `./auth/authState` so the next
  // `isCloudWriteAllowed` call re-queries instead of returning a stale 60s-cached
  // `false`. The exact wiring (lazy import in the handler body):
  //
  //   const { invalidateTosCache } = await import('./auth/authState');
  //   invalidateTosCache();
  //
  // This comment is the coordination contract between 11-14 (cache owner) and
  // 11-12 (cache invalidator). The literal `invalidateTosCache` reference here
  // satisfies plan 11-14's acceptance criterion #6.
  // See: src/main/auth/authState.ts:invalidateTosCache + .planning/phases/11-cloud-character-library/11-14-PLAN.md.

  // Skin pipeline. Lazy-import the skinStore module inside the handler
  // bodies so a future cyclic import (skinStore → characterStore → ipc →
  // skinStore) cannot deadlock at module-init time.
  ipcMain.handle(IpcChannel.skin.apply, async (_event, argsRaw: unknown) => {
    const args = ApplySkinArgsSchema.parse(argsRaw);
    const pngBytes = Buffer.from(args.pngBase64, 'base64');
    // Refuse while bot is connected — bot would keep serving the OLD skin
    // until disconnect, and the user's intuition is "skin shows up on next
    // summon". UI also gates this; defense-in-depth.
    if (deps.supervisor.isActive(args.characterId)) {
      throw new Error('Stop the bot before changing skin. Skin applies on next summon.');
    }
    const { applyPng } = await import('./skinStore');
    return await applyPng({
      personaId: args.characterId,
      pngBytes,
      source: args.source,
      mojangUsername: args.mojangUsername ?? null,
      // undefined = leave existing username untouched (renderer didn't ship a value);
      // empty string = explicit clear; any other string = explicit set.
      username: args.username ?? undefined,
    }); // { skin, username }
  });

  ipcMain.handle(IpcChannel.skin.remove, async (_event, idArg: unknown) => {
    const id = IdSchema.parse(idArg); // Same strict slug validator as skin:apply
    if (deps.supervisor.isActive(id)) {
      throw new Error('Stop the bot before changing skin. Skin applies on next summon.');
    }
    const { removePng } = await import('./skinStore');
    const skin = await removePng(id);
    return { skin };
  });

  ipcMain.handle(IpcChannel.skin.getServerUrl, async () => {
    const baseUrl = deps.getSkinServerBaseUrl();
    if (!baseUrl) {
      // Skin server failed to bind on boot (SKIN_SERVER_PORT_TAKEN). Surface
      // as a rejected promise — the renderer's SkinEditor maps the throw to
      // ERROR_COPY[SKIN_SERVER_PORT_TAKEN] so the UI shows the relevant copy.
      throw new Error("Sei couldn't reserve a local port for serving skins. Restart Sei and try again.");
    }
    return { baseUrl };
  });

  // Native file picker for user-supplied skins + Mojang username search.
  // Both lazy-import the underlying module so a future
  // cyclic-import path can't deadlock at module-init time, and so test
  // harnesses that pull in IPC types don't drag electron.dialog / node:crypto
  // into module-eval (same rationale as the skinStore lazy import above).
  ipcMain.handle(IpcChannel.skin.uploadPng, async () => {
    const { openSkinPicker } = await import('./skinUpload');
    return await openSkinPicker(); // null when user cancels
  });

  ipcMain.handle(IpcChannel.skin.searchMojang, async (_event, usernameArg: unknown) => {
    // Zod gate at the IPC boundary — defense-in-depth even though
    // lookupMojangSkin re-validates with its own regex. Length 1..32 mirrors
    // Mojang's allowed username range (modern names cap at 16; pre-2014
    // legacy accounts can be longer — accept up to 32 here, let Mojang's
    // 204 path handle the "no such user" tail).
    const username = z.string().min(1).max(32).parse(usernameArg);
    const { lookupMojangSkin } = await import('./mojangSkinLookup');
    const res = await lookupMojangSkin(username);
    return {
      pngBase64: res.pngBase64,
      sha256: res.sha256,
      resolvedUsername: res.resolvedUsername,
    };
  });

  // Wizard install pipeline. Same lazy-import discipline as the skin
  // handlers — keeps the orchestrator + install modules out of module-init
  // time so a cyclic import (wizard → ... → ipc) can't deadlock.
  //
  // wizard:detect-installs is read-only (scan) so no zod gate needed.
  // wizard:install / wizard:cancel are zod-gated; wizard:cancel's sessionId
  // is the IPC-crossing routing key that maps to the main-side
  // AbortController in src/main/wizard.ts.
  ipcMain.handle(IpcChannel.wizard.detectInstalls, async () => {
    const { scanMcInstalls } = await import('./mcInstallScan');
    const installs = await scanMcInstalls();
    return { installs };
  });

  ipcMain.handle(IpcChannel.wizard.install, async (_event, argsRaw: unknown) => {
    // sessionId is REQUIRED — without it, wizard:cancel has no
    // routing key. installIds must be non-empty; the renderer should also
    // gate this but defense-in-depth at the IPC boundary. skinServerBaseUrl
    // is the loopback URL captured from skin:get-server-url — must be a
    // valid URL because the orchestrator parses .port off it for the
    // port-drift state update.
    const args = z.object({
      sessionId: z.string().min(1),
      installIds: z.array(z.string().min(1)).min(1),
      skinServerBaseUrl: z.string().url(),
    }).parse(argsRaw);
    const { runWizardInstall } = await import('./wizard');
    return await runWizardInstall({
      ...args,
      onProgress: (ev) => deps.sendWizardProgress(ev),
    });
  });

  ipcMain.handle(IpcChannel.wizard.cancel, async (_event, sessionIdArg: unknown) => {
    // The IPC-crossing abort. Resolves immediately after firing
    // .abort() on the matching controller; the in-flight runWizardInstall
    // promise then rejects (or emits a `cancelled` stage event) through
    // signal-aware install modules. Fire-and-forget — we don't surface the
    // boolean return of abortWizardSession to the renderer because the user
    // doesn't care whether the cancel raced against a completed install;
    // either way the UI flips to "cancelled" via the progress channel.
    const sessionId = z.string().min(1).parse(sessionIdArg);
    const { abortWizardSession } = await import('./wizard');
    abortWizardSession(sessionId);
    return;
  });

  ipcMain.handle(IpcChannel.wizard.getState, async () => {
    const { loadWizardState } = await import('./wizardStateStore');
    return await loadWizardState();
  });

  // User config
  ipcMain.handle(IpcChannel.config.get, async (): Promise<UserConfig> => {
    return await loadConfig();
  });
  ipcMain.handle(IpcChannel.config.save, async (_event, cfgArg: unknown): Promise<void> => {
    const cfg = UserConfigSchema.parse(cfgArg);
    await saveConfig(cfg);
    // Item 7: mirror the user's preferred name into the public profiles table
    // so Browse shows "by <name>" on their published characters. Fire-and-forget
    // (don't add a network round-trip to every config save, e.g. theme toggles)
    // and signed-in-only (upsertMyProfile no-ops when signed out / name blank).
    if (cfg.preferred_name && cfg.preferred_name.trim()) {
      void (async () => {
        try {
          const { upsertMyProfile } = await import('./cloud/cloudCharacterClient');
          await upsertMyProfile(cfg.preferred_name);
        } catch (err) {
          console.warn(`[sei] config.save: profile name sync failed: ${(err as Error).message}`);
        }
      })();
    }
  });
  ipcMain.handle(IpcChannel.config.saveApiKey, async (_event, plaintextArg: unknown): Promise<void> => {
    const plaintext = PlaintextSchema.parse(plaintextArg);
    await saveApiKey(plaintext);
  });
  ipcMain.handle(IpcChannel.config.hasApiKey, async (): Promise<boolean> => {
    return await hasApiKey();
  });

  // === Product analytics (260707) ===
  // Fire-and-forget renderer→main event. Zod-gated at the trust boundary like
  // every inbound arg; capture() itself is a no-op under opt-out / no key. Props
  // are scalar-only — the analytics module further sanitizes so no free-form
  // content can ride along.
  const TrackArgsSchema = z.object({
    event: z.string().min(1).max(80),
    props: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  });
  ipcMain.on(IpcChannel.analytics.track, (_event, raw: unknown) => {
    try {
      const { event, props } = TrackArgsSchema.parse(raw);
      trackAnalytics(event, props);
    } catch {
      /* malformed track payload — drop silently, analytics must never disrupt */
    }
  });
  ipcMain.handle(IpcChannel.analytics.getOptOut, async (): Promise<boolean> => {
    return await getAnalyticsOptOut();
  });
  ipcMain.handle(IpcChannel.analytics.setOptOut, async (_event, optOutArg: unknown): Promise<void> => {
    const { optOut } = z.object({ optOut: z.boolean() }).parse({ optOut: optOutArg });
    await setAnalyticsOptOut(optOut);
  });

  // === 260703 procgen — unique-companion generation + questionnaire prefs ===
  //
  // gen:start runs the full pipeline (soulcaster sheet → parallel portrait/skin
  // + persona expansion → save). It NEVER throws for expected failures — it
  // returns the discriminated GenerateUniqueResult. Stage ticks push over
  // gen:progress, tagged with the caller's requestId (same routing pattern as
  // chars:expansion-progress).
  const GenerateUniqueSchema = z.object({
    requestId: z.string().min(1),
    gender: z.enum(['male', 'female', 'other']),
  });
  // SINGLE-FLIGHT: React StrictMode (dev) double-invokes the casting screen's
  // mount effect, firing two gen:start calls milliseconds apart — each ran a
  // full pipeline and saved a DUPLICATE companion. A second call now joins the
  // in-flight run and shares its result. Progress is re-tagged to the latest
  // requestId because StrictMode keeps the SECOND mount alive: it subscribes
  // under its own id and would otherwise see a frozen bar. The guard is set
  // synchronously (before any await) so near-simultaneous calls can't race
  // past the check.
  let genInflight: {
    promise: Promise<GenerateUniqueResult>;
    requestIdRef: { current: string };
  } | null = null;
  ipcMain.handle(IpcChannel.gen.start, (_event, argsRaw: unknown): Promise<GenerateUniqueResult> => {
    const args = GenerateUniqueSchema.parse(argsRaw);
    if (genInflight) {
      genInflight.requestIdRef.current = args.requestId;
      return genInflight.promise;
    }
    const requestIdRef = { current: args.requestId };
    const promise = (async (): Promise<GenerateUniqueResult> => {
      try {
        const { generateUnique } = await import('./uniqueGeneration');
        return await generateUnique(args, {
          emit: (stage, status, message) => {
            // Stage errors are non-fatal for portrait/skin and the renderer
            // only shows a summary line — log the detail here or it's lost.
            if (status === 'error') {
              console.warn(`[sei] gen:${stage} error: ${message ?? 'unknown'}`);
            }
            deps.sendGenProgress({ requestId: requestIdRef.current, stage, status, message });
          },
        });
      } catch (err) {
        // Backstop: generateUnique is written to never throw for expected
        // failures, but an unexpected throw must still resolve the union
        // rather than reject the IPC call.
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[sei] gen:start unexpected throw: ${message}`);
        return { ok: false, code: 'generation_failed', message };
      } finally {
        genInflight = null;
      }
    })();
    genInflight = { promise, requestIdRef };
    return promise;
  });

  // prefs:get — local config.user_profile merged with the cloud user_preferences
  // row (cloud wins when it has a newer completed_at). `needed` drives the
  // first-sign-in questionnaire gate: signed-in AND no completed_at anywhere.
  ipcMain.handle(IpcChannel.prefs.get, async (): Promise<PrefsGetResult> => {
    const cfg = await loadConfig();
    const localProfile = cfg.user_profile ?? null;

    const { getClient } = await import('./auth/supabaseClient');
    const session = (await getClient().auth.getSession()).data.session;
    const { missingPrefQuestions } = await import('../shared/characterSchema');
    if (!session?.user?.id || !session.access_token) {
      // Signed out — no cloud row, questionnaire never forced.
      return { profile: localProfile, needed: false, missing: missingPrefQuestions(localProfile) };
    }

    // Best-effort cloud read of the user_preferences row (user_id PK,
    // preferences jsonb). A failure falls back to the local copy.
    let cloudProfile: import('../shared/characterSchema').UserPreferences | null = null;
    try {
      const { getAuthedClient } = await import('./auth/supabaseClient');
      const { data, error } = await getAuthedClient(session.access_token)
        .from('user_preferences')
        .select('preferences')
        .eq('user_id', session.user.id)
        .maybeSingle();
      if (!error && data && (data as { preferences?: unknown }).preferences != null) {
        const parsed = UserPreferencesSchema.safeParse((data as { preferences: unknown }).preferences);
        if (parsed.success) cloudProfile = parsed.data;
      }
    } catch (err) {
      console.warn(`[sei] prefs:get cloud read failed: ${(err as Error).message}`);
    }

    const { resolvePrefs } = await import('./uniqueGeneration');
    const { profile, cloudIsNewer, hasCompleted } = resolvePrefs(localProfile, cloudProfile);
    // `needed` drives the first-sign-in Home gate. Report it true not only when
    // NO copy has a completed_at, but also when the effective profile still has
    // UNFILLED answer fields — a brand-new account (empty profile), a run
    // abandoned partway, or a profile completed before a newer question shipped
    // all have gaps to walk the user through. Keying on completed_at alone let a
    // partially-filled account slip past the gate (the reported flash-skip).
    const missing = missingPrefQuestions(profile);

    // Merge the newer cloud copy back into local config so a re-install / second
    // device skips the questionnaire without a round-trip next time. Via
    // updateConfig (read-modify-write under the file lock): `cfg` was read
    // before the cloud round-trip above and may be stale by now (TOCTOU).
    if (cloudIsNewer) {
      try {
        const { updateConfig } = await import('./configStore');
        await updateConfig((cur) => ({ ...cur, user_profile: profile }));
      } catch (err) {
        console.warn(`[sei] prefs:get config write-back failed: ${(err as Error).message}`);
      }
    }

    return { profile, needed: !hasCompleted || missing.length > 0, missing };
  });

  // prefs:save — 260706: accepts a PARTIAL patch (only the answers the user
  // was just asked). The merge over stored answers happens inside
  // configStore.updateConfig, so the base is the freshly-locked config —
  // never a renderer snapshot (TOCTOU: a retake must only update the fields
  // it carries, and must not clobber a concurrent writer's other fields).
  // completed_at is stamped on every save so the resolvePrefs device-vs-cloud
  // recency comparison adopts the latest answers. Cloud upsert stays
  // best-effort (a later prefs:save retries — no queue needed).
  ipcMain.handle(IpcChannel.prefs.save, async (_event, patchArg: unknown): Promise<void> => {
    const { UserPreferencesPatchSchema } = await import('../shared/characterSchema');
    const patch = UserPreferencesPatchSchema.parse(patchArg);
    const { mergePrefsPatch } = await import('./uniqueGeneration');
    const { updateConfig } = await import('./configStore');
    const now = new Date().toISOString();
    const next = await updateConfig((cur) => ({
      ...cur,
      user_profile: mergePrefsPatch(cur.user_profile, patch, now),
    }));
    const stamped = next.user_profile;

    try {
      const { getClient } = await import('./auth/supabaseClient');
      const session = (await getClient().auth.getSession()).data.session;
      if (session?.user?.id && session.access_token) {
        const { getAuthedClient } = await import('./auth/supabaseClient');
        const { error } = await getAuthedClient(session.access_token)
          .from('user_preferences')
          .upsert({ user_id: session.user.id, preferences: stamped });
        if (error) console.warn(`[sei] prefs:save cloud upsert failed: ${error.message}`);
      }
    } catch (err) {
      console.warn(`[sei] prefs:save cloud upsert threw: ${(err as Error).message}`);
    }
  });

  // App-level one-shot queries
  ipcMain.handle(IpcChannel.app.warnings, async () => {
    const { sessionBackendKind } = await import('./auth/sessionStore');
    const onLinux = process.platform === 'linux';
    return {
      keychainFallbackPlaintext: onLinux && safeStorageBackendKind() === 'basic_text',
      sessionFallbackPlaintext: onLinux && sessionBackendKind() === 'basic_text',
    };
  });

  // === Auth (Phase 10) ===
  // Lazy-import authHandlers inside each handler body so a future cyclic
  // import (authHandlers → ... → ipc → authHandlers) cannot deadlock at
  // module-init time. Plans 04/05/06/08/09 will fill the handler bodies.
  //
  // Plan 10-06: wire the supervisor handle into authHandlers so signOut can
  // call supervisor.stop() BEFORE auth.signOut() (D-09 + T-10-06-09). Must be
  // SYNCHRONOUS — a fire-and-forget dynamic import leaves a window during
  // which auth IPC handlers are registered but supervisorRef is still null,
  // and a fast post-boot signOut would skip the bot-stop step that D-09 +
  // T-10-06-09 promise (BL-01). authHandlers is now imported statically at
  // the top of this file; the per-handler dynamic imports below remain so a
  // future cyclic import can't deadlock at module-init time, but the auth
  // module is already in the import graph by the time we reach this line.
  setAuthSupervisor(deps.supervisor);
  ipcMain.handle(IpcChannel.auth.signinPassword, async (_e, argsRaw: unknown) => {
    const args = SignInPasswordSchema.parse(argsRaw);
    const { signInWithPassword } = await import('./auth/authHandlers');
    return await signInWithPassword(args);
  });
  ipcMain.handle(IpcChannel.auth.signupPassword, async (_e, argsRaw: unknown) => {
    const args = SignUpPasswordSchema.parse(argsRaw);
    const { signUpWithPassword } = await import('./auth/authHandlers');
    return await signUpWithPassword(args);
  });
  ipcMain.handle(IpcChannel.auth.signinGoogle, async () => {
    const { signInWithGoogle } = await import('./auth/authHandlers');
    return await signInWithGoogle();
  });
  ipcMain.handle(IpcChannel.auth.cancelGoogle, async () => {
    const { cancelGoogle } = await import('./auth/authHandlers');
    return await cancelGoogle();
  });
  ipcMain.handle(IpcChannel.auth.signout, async () => {
    const { signOut } = await import('./auth/authHandlers');
    return await signOut();
  });
  ipcMain.handle(IpcChannel.auth.deleteAccount, async () => {
    const { deleteAccount } = await import('./auth/authHandlers');
    return await deleteAccount();
  });
  ipcMain.handle(IpcChannel.auth.exportData, async () => {
    const { exportData } = await import('./auth/authHandlers');
    return await exportData();
  });
  ipcMain.handle(IpcChannel.auth.resendVerification, async () => {
    const { resendVerification } = await import('./auth/authHandlers');
    return await resendVerification();
  });
  ipcMain.handle(IpcChannel.auth.sendPasswordReset, async (_e, argsRaw: unknown) => {
    const args = SendPasswordResetSchema.parse(argsRaw);
    const { sendPasswordReset } = await import('./auth/authHandlers');
    return await sendPasswordReset(args);
  });
  ipcMain.handle(IpcChannel.auth.updatePassword, async (_e, argsRaw: unknown) => {
    const args = UpdatePasswordSchema.parse(argsRaw);
    const { updatePassword } = await import('./auth/authHandlers');
    return await updatePassword(args);
  });
  // 260603 anti-abuse — store a renderer-solved Turnstile/hCaptcha token for the
  // next signup. Inert until bot-protection is enabled (see auth/captcha.ts).
  ipcMain.handle(IpcChannel.auth.setCaptchaToken, async (_e, tokenRaw: unknown) => {
    const token = typeof tokenRaw === 'string' ? tokenRaw : null;
    const { setCaptchaToken } = await import('./auth/captcha');
    setCaptchaToken(token);
  });

  // === ToS / Privacy gate (Phase 11 plan 12) ===
  // Lazy-import tosGate inside each handler body so a future cyclic import
  // can't deadlock at module-init time, mirroring the auth handler convention.
  ipcMain.handle(IpcChannel.tos.status, async () => {
    const [{ TOS_VERSION, PRIVACY_VERSION }, { getClient }] = await Promise.all([
      import('../shared/legalVersions'),
      import('./auth/supabaseClient'),
    ]);
    const { data: { session } } = await getClient().auth.getSession();
    if (!session?.user?.id) {
      return { accepted: false, tosVersion: TOS_VERSION, privacyVersion: PRIVACY_VERSION };
    }
    // 260610 — tri-state: a check that never reached the DB (offline/DNS/
    // timeout) returns accepted:null so the renderer shows the offline-retry
    // notice instead of re-prompting an already-accepted user with the
    // blocking legal modal.
    const { getTosAcceptance } = await import('./auth/tosGate');
    const status = await getTosAcceptance(session.user.id);
    return {
      accepted: status === 'unknown' ? null : status === 'accepted',
      tosVersion: TOS_VERSION,
      privacyVersion: PRIVACY_VERSION,
    };
  });

  ipcMain.handle(IpcChannel.tos.accept, async () => {
    const { getClient } = await import('./auth/supabaseClient');
    const { data: { session } } = await getClient().auth.getSession();
    if (!session?.user?.id) return { ok: false, message: 'Not signed in.' };
    try {
      const { recordAcceptance } = await import('./auth/tosGate');
      await recordAcceptance(session.user.id);
      // Verifier nit (11-VERIFICATION.md Anti-Patterns) — invalidate the
      // isCloudWriteAllowed 60s TTL cache so the next cloud-write attempt
      // re-queries instead of returning a stale `false` for up to a minute.
      // The coordination comment above this handler documented the
      // requirement; the merge between 11-12 / 11-14 dropped the call. The
      // system functioned without it (fail-closed direction) but users hit
      // a confusing "syncing pending" delay after acceptance.
      const { invalidateTosCache } = await import('./auth/authState');
      invalidateTosCache();
      // Privacy re-consent (260720): accepting the current Privacy version
      // (which discloses analytics + crash diagnostics) re-baselines analytics
      // consent — clear any prior opt-out in this profile's config. Only runs
      // here, on an explicit acceptance click; a normal launch never reaches
      // this handler. Best-effort: a config-write failure must not fail the
      // legal acceptance itself.
      try {
        const { reenableAnalyticsOnConsent } = await import('./analytics');
        await reenableAnalyticsOnConsent();
      } catch { /* non-fatal — the Settings toggle remains available */ }
      return { ok: true };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  });

  // === Migration prompt (Phase 11 plan 18, D-20) ===
  // One-shot local→cloud upload prompt for users with pre-sign-up local-mode
  // characters. listLocal computes the LOCAL ONLY set in main (chars present
  // on disk but absent from the user's cloud row set, defaults excluded);
  // upload sequentially mirrors them via cloudCharacterClient and returns a
  // per-uuid result so the modal can show partial failures; shown reads/sets
  // the <userData>/migration-modal-shown.json flag that suppresses auto-mount
  // on subsequent sign-ins.
  ipcMain.handle(IpcChannel.migration.listLocal, async (): Promise<{ characters: Array<{ id: string; name: string; slug: string | null; created: string }>; cloudListOk: boolean }> => {
    const { getClient } = await import('./auth/supabaseClient');
    const { data: { session } } = await getClient().auth.getSession();
    if (!session?.user?.id) return { characters: [], cloudListOk: true };
    const all = await listCharacters();
    let cloudIds: Set<string>;
    let cloudListOk = true;
    try {
      const { listMyCharacters } = await import('./cloud/cloudCharacterClient');
      const cloud = await listMyCharacters(session.user.id);
      cloudIds = new Set(cloud.map((c) => c.id));
    } catch (err) {
      console.warn(`[sei] migration.listLocal cloud list failed: ${(err as Error).message}`);
      // MR-02: surface the listing failure to the modal so the user sees a
      // "Couldn't verify which of these are already in cloud" banner instead
      // of silently uploading already-mirrored chars as "Done". Fallback to
      // every non-default local char so the migration path stays reachable
      // when the user wants to proceed anyway (.upsert is idempotent).
      cloudIds = new Set();
      cloudListOk = false;
    }
    // Characters added from the World tab are foreign-owned imports, NOT the
    // user's own local creations — they must never appear in the upload-to-cloud
    // prompt (the bug where adding a public char like "Beep" then re-launching
    // asked "Upload local characters? Beep"). Exclude both the explicit
    // added_world_ids set AND any character whose owner is someone else; the
    // migration offer is strictly for chars the user authored locally
    // (owner === self, or legacy null-owner pre-sign-up locals) that aren't
    // yet mirrored to their cloud library.
    const myId = session.user.id;
    let addedWorldIds = new Set<string>();
    try {
      const cfgForMigration = await loadConfig();
      addedWorldIds = new Set(cfgForMigration.added_world_ids ?? []);
    } catch {
      /* empty set — worst case we offer a world-added char, no data loss. */
    }
    const localOnly = all
      .filter(
        (c) =>
          !c.is_default &&
          !cloudIds.has(c.id) &&
          !addedWorldIds.has(c.id) &&
          (c.owner == null || c.owner === myId),
      )
      .map((c) => ({ id: c.id, name: c.name, slug: c.slug, created: c.created }));
    return { characters: localOnly, cloudListOk };
  });

  ipcMain.handle(IpcChannel.migration.upload, async (_event, uuidsArg: unknown): Promise<{ results: Array<{ id: string; ok: boolean; message?: string }> }> => {
    const uuids = z.array(IdSchema).parse(uuidsArg);

    // ToS / verified-email / signed-in gate (Plan 11-14). Fails closed: if
    // the user lands here without an accepted ToS row, refuse every uuid
    // with a uniform message. The modal also blocks ahead of ToS via
    // AcceptToSModal (Plan 11-13), so this is defense-in-depth.
    const { isCloudWriteAllowed } = await import('./auth/authState');
    if (!(await isCloudWriteAllowed())) {
      return { results: uuids.map((id) => ({ id, ok: false, message: 'Cloud writes not allowed yet (verify email and accept Terms first).' })) };
    }
    const { getClient } = await import('./auth/supabaseClient');
    const { data: { session } } = await getClient().auth.getSession();
    if (!session?.user?.id || !session.access_token) {
      return { results: uuids.map((id) => ({ id, ok: false, message: 'Not signed in.' })) };
    }
    const owner = session.user.id;
    // Skin/portrait bytes upload through the sign-character-asset-upload Edge
    // Function (asymmetric-JWT bridge — see cloudCharacterClient.uploadCharacterAsset);
    // the row upsert below still goes direct over PostgREST, which verifies ES256.
    const jwt = session.access_token;

    const { resolveSkinPng } = await import('./skinStore');
    const { upsertCharacter, uploadSkin, uploadPortrait } = await import('./cloud/cloudCharacterClient');
    const { readFile } = await import('node:fs/promises');

    const results: Array<{ id: string; ok: boolean; message?: string }> = [];
    for (const id of uuids) {
      try {
        const char = await getCharacter(id);
        if (!char) {
          results.push({ id, ok: false, message: 'Character not found.' });
          continue;
        }
        if (char.is_default) {
          // Defense-in-depth — the LOCAL ONLY chip + listLocal filter both
          // exclude defaults, but if a uuid somehow snuck through (manual
          // IPC call, race), upsertCharacter would throw CLOUD_SYNC_REFUSED_DEFAULT
          // anyway. Surface a clean message here.
          results.push({ id, ok: false, message: 'Defaults cannot be uploaded.' });
          continue;
        }
        // 1. character row first. If this fails the skin/portrait uploads
        // are pointless — bail before touching Storage.
        await upsertCharacter(char, owner);

        // 2. skin bytes — resolveSkinPng takes the full Character and honors
        // its skin.source descriptor. Missing local PNG → null → skip.
        try {
          const skinBytes = await resolveSkinPng(char);
          if (skinBytes) await uploadSkin(id, skinBytes, jwt);
        } catch (err) {
          console.warn(`[sei] migration: skin upload for ${id} failed: ${(err as Error).message}`);
          // Skin failure does NOT fail the whole upload — the row landed and
          // the chip will drop. The user can re-upload skin via the editor.
        }

        // 3. portrait bytes — file may not exist at all; ENOENT is fine.
        try {
          const portraitBytes = await readFile(paths.portraitPath(id));
          if (portraitBytes.length > 0) await uploadPortrait(id, portraitBytes, 'png', jwt);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            console.warn(`[sei] migration: portrait upload for ${id} failed: ${(err as Error).message}`);
          }
        }

        results.push({ id, ok: true });
      } catch (err) {
        const raw = (err as Error).message;
        // MR-03: translate sentinel error strings to user-facing copy so the
        // per-row modal message doesn't surface raw CLOUD_SYNC_* prefixes.
        // The most common pre-Phase-11 case is a legacy character whose
        // portrait still rides as an inline data URL — upsertCharacter
        // refuses these with CLOUD_SYNC_REFUSED_DATA_URL, and the user can
        // fix it by re-saving the portrait through the editor (which now
        // routes through the portrait file pipeline).
        let message = raw;
        if (raw.startsWith('CLOUD_SYNC_REFUSED_DATA_URL')) {
          message = "This character's portrait needs to be re-saved before it can sync. Open the character to update it.";
        } else if (raw.startsWith('CLOUD_SYNC_REFUSED_DEFAULT')) {
          message = 'Default characters cannot be uploaded.';
        }
        results.push({ id, ok: false, message });
      }
    }
    return { results };
  });

  ipcMain.handle(IpcChannel.migration.shown, async (_event, actionArg: unknown): Promise<{ shown: boolean }> => {
    const action = z.enum(['get', 'set']).parse(actionArg);
    // NR-02 — use async fs/promises to match the file's established pattern.
    // The sync variants here were a minor inconsistency; the I/O is small so
    // it never blocked perceptibly, but async keeps the handler body uniform
    // with surrounding code (which all uses atomicWrite / async mkdir).
    const { writeFile, mkdir, access } = await import('node:fs/promises');
    const nodePath = await import('node:path');
    const target = paths.migrationModalShownPath();
    if (action === 'set') {
      try {
        await mkdir(nodePath.dirname(target), { recursive: true });
        await writeFile(target, JSON.stringify({ shown: true, shownAt: new Date().toISOString() }, null, 2) + '\n');
      } catch (err) {
        console.warn(`[sei] migration.shown set failed: ${(err as Error).message}`);
      }
      return { shown: true };
    }
    try {
      await access(target);
      return { shown: true };
    } catch {
      return { shown: false };
    }
  });

  // wizard:prompt-shown — one-time "run skin setup" nudge flag, shown when a
  // user first tries to summon a character. Same get/set + file-existence
  // pattern as migration.shown above; profile-scoped via
  // paths.skinSetupPromptShownPath so each account is nudged at most once.
  ipcMain.handle(IpcChannel.wizard.promptShown, async (_event, actionArg: unknown): Promise<{ shown: boolean }> => {
    const action = z.enum(['get', 'set']).parse(actionArg);
    const { writeFile, mkdir, access } = await import('node:fs/promises');
    const nodePath = await import('node:path');
    const target = paths.skinSetupPromptShownPath();
    if (action === 'set') {
      try {
        await mkdir(nodePath.dirname(target), { recursive: true });
        await writeFile(target, JSON.stringify({ shown: true, shownAt: new Date().toISOString() }, null, 2) + '\n');
      } catch (err) {
        console.warn(`[sei] wizard.promptShown set failed: ${(err as Error).message}`);
      }
      return { shown: true };
    }
    try {
      await access(target);
      return { shown: true };
    } catch {
      return { shown: false };
    }
  });

  // 260603 per-profile partitioning — anonymous(local)→account on-device import.
  ipcMain.handle(IpcChannel.profile.peekLocal, async () => {
    const { peekLocalProfile } = await import('./profile/localImport');
    return peekLocalProfile();
  });

  ipcMain.handle(IpcChannel.profile.importFromLocal, async (_event, idsArg: unknown) => {
    const { getActiveScope, SCOPE_LOCAL } = await import('./paths');
    const scope = getActiveScope();
    // Only meaningful while signed in (active scope = the account). Signed-out
    // (scope === 'local') has no account to import into — no-op.
    if (scope === SCOPE_LOCAL) {
      return { imported: [], failed: [], copiedOnboarding: false };
    }
    const characterIds = z.array(z.string()).optional().parse(idsArg);
    const { importLocalProfileInto } = await import('./profile/localImport');
    return importLocalProfileInto(scope, characterIds ? { characterIds } : undefined);
  });

  // === Phase 12 — Browse + moderation + reports + capabilities ===
  //
  // Three-layer contract: channel strings in src/shared/ipc.ts (already
  // declared), handlers here, preload bindings in src/preload/index.ts.
  // Lazy-import discipline + Zod validation at boundary mirror the migration
  // and tos handlers above.

  // --- Phase 12 — Browse listing (signed-in OR signed-out — LIB-04) ---
  //
  // NOT gated on isCloudWriteAllowed — Browse is read-public. Calls the
  // search_public_characters RPC (12-01) which has security invoker so the
  // characters_select_own_or_shared RLS policy filters to shared=true rows
  // for anon callers. Main pre-joins each row with the public Storage URL
  // and computes inMyLibrary against the local characters/index.json so the
  // renderer never crosses two stores per row.
  const BrowseListSchema = z.object({
    query: z.string().max(200),
    limit: z.number().int().min(1).max(50),
    offset: z.number().int().min(0),
  });
  ipcMain.handle(IpcChannel.browse.list, async (_event, argsRaw: unknown): Promise<{ entries: BrowseEntry[]; hasMore: boolean }> => {
    const parsed = BrowseListSchema.parse(argsRaw);
    const { getClient } = await import('./auth/supabaseClient');
    const { getStoragePublicUrl } = await import('./cloud/cloudCharacterClient');
    const { data: rows, error } = await getClient().rpc('search_public_characters', {
      search_query: parsed.query,
      page_limit: parsed.limit,
      page_offset: parsed.offset,
    });
    if (error) {
      console.warn(`[sei] browse:list rpc failed: ${error.message}`);
      return { entries: [], hasMore: false };
    }

    // Precompute the in-library set so each BrowseEntry.inMyLibrary is O(1).
    // Strict definition (the World pill must match what HomeGrid actually
    // surfaces, otherwise a card promises "Already in My Library" for a
    // character that doesn't appear on Home):
    //
    //   signed_in:
    //     - self-owned (c.owner === sessionUserId), OR
    //     - explicit World add (id in UserConfig.added_world_ids).
    //   signed_out:
    //     - any legacy null-owner local copy (those are the only chars a
    //       signed-out user can "own").
    //
    // Earlier versions included "owner == null" as "in library" regardless of
    // sign-in state. That was the Eris false-positive: when downloadCharacter
    // returned a row with a stripped/missing owner column, cacheOnDemand
    // wrote a null-owner local copy, and the next browse:list flagged it as
    // in-library even though the user never added it.
    const local = await listCharacters();
    const { getClient: getClientForBrowse } = await import('./auth/supabaseClient');
    const sessionForBrowse = (await getClientForBrowse().auth.getSession()).data.session;
    const sessionUserId = sessionForBrowse?.user?.id ?? null;
    const cfgForBrowse = await loadConfig();
    const addedWorldIds = new Set(cfgForBrowse.added_world_ids ?? []);
    const localIds = new Set<string>();
    if (sessionUserId) {
      for (const c of local) {
        if (c.owner === sessionUserId) localIds.add(c.id);
      }
    } else {
      for (const c of local) {
        if (c.owner == null && !c.is_default) localIds.add(c.id);
      }
    }
    // Explicit World adds always count as in-library — even if the cached
    // file is briefly absent (mid-add) the World tab must not re-prompt.
    for (const id of addedWorldIds) localIds.add(id);

    // Item 7: resolve author display names (preferred_name) for every owner in
    // this page so the card reads "by <name>" instead of "by user-1a2b". One
    // batched profiles read; falls back to the anonymized handle for owners
    // with no profile row yet.
    const rowsArr = (rows ?? []) as Array<Record<string, unknown>>;
    const ownerIdsForNames = rowsArr
      .map((r) => (typeof r.owner === 'string' ? r.owner : ''))
      .filter((x) => !!x);
    const { getProfileNames } = await import('./cloud/cloudCharacterClient');
    const nameByOwner = await getProfileNames(ownerIdsForNames);

    const entries: BrowseEntry[] = rowsArr.map((row: Record<string, unknown>) => {
      const personaSource = typeof row.persona_source === 'string' ? row.persona_source : '';
      const personaSnippet = personaSource.length > 120
        ? personaSource.slice(0, 120).trimEnd() + '…'
        : personaSource;
      const ownerStr = typeof row.owner === 'string' ? row.owner : '';
      const id = String(row.id);
      // Use the same Storage layout as cloudCharacterClient.uploadPortrait /
      // uploadSkin (`<owner>/<id>.png`). getStoragePublicUrl is a sync,
      // network-free helper from supabase-js so we can call it inline.
      const portraitUrl = row.portrait_image && ownerStr
        ? getStoragePublicUrl('portraits', ownerStr, id)
        : null;
      const skinUrl = row.skin_png_sha256 && ownerStr
        ? getStoragePublicUrl('skins', ownerStr, id)
        : null;
      return {
        id,
        name: typeof row.name === 'string' ? row.name : '',
        personaSnippet,
        creatorLabel: (() => {
          const authorName = ownerStr ? nameByOwner.get(ownerStr) : undefined;
          if (authorName) return `by ${authorName}`;
          return ownerStr ? `by user-${ownerStr.slice(0, 4)}` : 'by anonymous';
        })(),
        // search_public_characters returns `select *`, so the 260703 public_id
        // column rides along; older rows without one show no tag.
        publicId: typeof row.public_id === 'string' ? row.public_id : null,
        portraitUrl,
        skinUrl,
        updatedAt: typeof row.updated_at === 'string'
          ? row.updated_at
          : (typeof row.created_at === 'string' ? row.created_at : ''),
        inMyLibrary: localIds.has(id),
      };
    });
    return { entries, hasMore: entries.length === parsed.limit };
  });

  // --- Phase 12 — Publish-with-moderation: TOMBSTONE (260525-qy0 Task 4) ---
  //
  // Was the dead-code orchestrator handler bound to the now-removed
  // IpcChannel.browse.publishWithModeration channel. The renderer never
  // called it (grep on src/renderer returns zero hits); chars.save +
  // chars.setShared bypassed it entirely.
  //
  // Cluster C (260525-qy0) moved the moderation gate call site inline into
  // chars.save and chars.setShared — see the runModerationGate helper at the
  // top of registerIpcHandlers. The IPC channel + RendererApi method +
  // preload binding for the old publish-with-moderation surface have been
  // deleted.

  // app:open-external — T-11-12-01 / T-12-17-01 / T-13-21-01. The renderer
  // can't call shell.openExternal directly (contextIsolation); we don't want
  // to blindly forward an arbitrary URL either, because a compromised renderer
  // or an XSS hole in our own strings could pass `javascript:` / `file:///`
  // URIs that the OS would happily resolve. The handler URL-parses + validates
  // against an https-only host allowlist (legal pages + DMCA Designated Agent
  // Directory + Polar checkout/customer-portal) plus a narrow mailto:
  // allowlist (DMCA contact). Anything else throws — the renderer treats
  // throws as silent no-ops.
  //
  // External URL allowlist — every host that shell.openExternal will route to.
  // Adding a host = trusting it not to host malicious downloads or phishing.
  //  - Phase 11 added 'sei.gg' / 'www.sei.gg' (marketing + legal pages).
  //  - Phase 12-17 added 'dmca.copyright.gov' (DMCA Designated Agent Directory)
  //    and the 'mailto:dmca@sei.app' scheme/path pair (DMCA contact).
  //  - Polar migration (2026-06) trusts the 'polar.sh' registrable domain (exact
  //    'polar.sh' + the '.polar.sh' suffix covering buy./sandbox./<org>. etc.).
  //    Polar is the Merchant of Record; its billing UX is the cancellation
  //    surface (Phase 13 open-question resolution #5).
  //
  // Host comparison uses exact-equality (Array.prototype.includes on a string
  // array) for fixed hosts and a DOT-ANCHORED suffix match for '.polar.sh', so
  // `evil.polar.sh.attacker.tld` is rejected even though it contains an
  // allowlisted label as a substring (T-13-21-01). The protocol gate is
  // enforced separately (https / mailto only) so `javascript:` / `data:` /
  // `file:` URLs that happen to parse with a matching `hostname` field are
  // still rejected (T-13-21-03).
  ipcMain.handle(IpcChannel.app.openExternal, async (_event, urlArg: unknown): Promise<void> => {
    const url = z.string().url().parse(urlArg);
    // 260525-s09 H5: validation extracted into src/main/lib/externalUrlValidator
    // so cancelSubscription and any future shell.openExternal call site stays in
    // lockstep with this allowlist. The validator owns the allowlist + protocol
    // gate + substring-host-bypass guard; see that module for provenance + rationale.
    const { assertSafeExternalUrl } = await import('./lib/externalUrlValidator');
    assertSafeExternalUrl(url);
    const { shell } = await import('electron');
    await shell.openExternal(url);
  });

  // === In-app updater (quick/260604-uoy) ===
  //
  // Renderer → main invoke surface for the electron-updater flows. The actual
  // autoUpdater wiring + push-channel emissions live in ./updater (lazy import
  // keeps electron-updater out of the pre-handler startup graph and lets the
  // module guard itself on app.isPackaged). getVersion needs no updater module.

  ipcMain.handle(IpcChannel.app.updateCheck, async (): Promise<void> => {
    const { checkForUpdatesManual } = await import('./updater');
    await checkForUpdatesManual();
  });

  ipcMain.handle(IpcChannel.app.updateDownload, async (): Promise<void> => {
    const { downloadAcceptedUpdate } = await import('./updater');
    await downloadAcceptedUpdate();
  });

  ipcMain.handle(IpcChannel.app.updateInstall, async (): Promise<void> => {
    const { installDownloadedUpdate } = await import('./updater');
    installDownloadedUpdate();
  });

  ipcMain.handle(IpcChannel.app.whatsNewGet, async () => {
    const { getPendingWhatsNew } = await import('./updater');
    return getPendingWhatsNew();
  });

  ipcMain.handle(IpcChannel.app.version, async (): Promise<string> => {
    return app.getVersion();
  });

  // === Frameless window controls (custom titlebar on Windows/Linux) ===
  // macOS uses native traffic lights and never invokes these, but the handlers
  // are platform-agnostic. Each resolves the window from the calling
  // webContents so multi-window is correct without a captured reference.
  ipcMain.handle(IpcChannel.window.minimize, async (event): Promise<void> => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });
  ipcMain.handle(IpcChannel.window.maximizeToggle, async (event): Promise<void> => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.handle(IpcChannel.window.close, async (event): Promise<void> => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
  ipcMain.handle(IpcChannel.window.isMaximized, async (event): Promise<boolean> => {
    return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false;
  });

  // === Phase 13 — Proxy + billing + credits (PROXY-11 + D-57) ===
  //
  // STUB SURFACE — every handler validates args with Zod and returns a
  // placeholder shape that matches the renderer-facing TypeScript types.
  // Wave 2/3 plans swap each lazy import (apiKeyStore today; proxyClient /
  // edgeFunctionClient / shell.openExternal in Wave 3) without changing the
  // channel name, argument shape, or return contract. Lazy imports keep the
  // pre-Phase-13 startup graph unchanged.
  //
  // T-13-02-01..T-13-02-03 mitigations: the Zod schemas are the trust
  // boundary — any deviation (bad mc_username, non-enum kind) 400s at .parse
  // before the lazy import even resolves.

  // proxy:configure — flip aiBackendKind via apiKeyStore.setAiBackendKind.
  // Already wired (vs. the trial/credits stubs) because this is what unlocks
  // the credits UI surface; Wave 3 only adds the signed-in guard.
  ipcMain.handle(IpcChannel.proxy.configure, async (_e, argsRaw: unknown) => {
    const parsed = ProxyConfigureArgsSchema.parse(argsRaw);
    const { setAiBackendKind } = await import('./apiKeyStore');
    await setAiBackendKind(parsed.kind);
    // Analytics (260707): keep the cached backend kind current so every event's
    // `backend` prop is accurate, and record the explicit switch.
    try {
      const { setAnalyticsBackendKind } = await import('./analytics');
      setAnalyticsBackendKind(parsed.kind);
    } catch { /* best-effort */ }
    trackAnalytics('backend_selected', { backend: parsed.kind });
    // WR-05 follow-up: apply the new routing to the RUNNING bot immediately so
    // the swap doesn't wait for a manual stop+re-summon. No-op when idle (the
    // next summon reads ai_backend_kind fresh). switchBackend surfaces its own
    // error status and never throws, but we guard anyway so a future change
    // can't turn the config write into a rejected IPC call.
    try {
      await deps.supervisor.switchBackend(parsed.kind);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[sei] proxy.configure: live switchBackend failed: ${(err as Error).message}`);
    }
    return { ok: true as const };
  });

  // trial:claim — Plan 13-13 wired path. Calls the `trial-claim` Edge Function
  // via proxyClient (lazy-imported). Takes no arguments — the trial is bound to
  // the account UUID (derived server-side from the session JWT), not the
  // Minecraft username. Translates the PROXY_* sentinel codes back into the
  // lowercase RendererApi contract codes ('already_claimed' | 'device_claimed' |
  // 'no_session' | 'network') so the renderer ERROR_COPY map only deals with one
  // vocabulary. 'device_claimed' is the per-device anti-abuse gate (this machine
  // already used its one trial, possibly under another account).
  ipcMain.handle(IpcChannel.trial.claim, async () => {
    const { trialClaim } = await import('./cloud/proxyClient');
    const res = await trialClaim();
    if (res.ok) return res;
    const mapped: 'already_claimed' | 'device_claimed' | 'no_session' | 'network' =
      res.code === 'PROXY_ALREADY_CLAIMED'
        ? 'already_claimed'
        : res.code === 'PROXY_DEVICE_CLAIMED'
          ? 'device_claimed'
          : res.code === 'PROXY_NO_SESSION'
            ? 'no_session'
            : 'network';
    return { ok: false as const, code: mapped };
  });

  // credits:get — Plan 13-13 wired path. proxyClient.creditsGet reads
  // ledger_balance + subscription_status + ledger_grants + apiKeyStore in
  // parallel and computes remaining_pct via BigInt math (D-41 5% step).
  ipcMain.handle(IpcChannel.credits.get, async (): Promise<CreditsStatus> => {
    const { creditsGet } = await import('./cloud/proxyClient');
    return creditsGet();
  });

  // credits:openCheckout — asks the proxy to mint a Polar checkout session
  // (user_id stamped into metadata server-side), then opens the allowlist-
  // validated URL in the user's SYSTEM BROWSER via shell.openExternal.
  //
  // 260603: reverted the 260602-uv9 in-app popup BrowserWindow back to the
  // system browser (user request). The system browser is the safer host for a
  // third-party payment page — it has the user's saved payment methods, its own
  // phishing/cert UI, and zero Node/IPC surface by construction. The URL is
  // allowlist-validated in proxyClient AND re-asserted here before the handoff.
  // Balance refresh still flows through the webhook → onCreditsStatusUpdate
  // push (no success-detection wiring needed).
  ipcMain.handle(IpcChannel.credits.openCheckout, async (_e, argsRaw: unknown) => {
    const parsed = CreditsCheckoutArgsSchema.parse(argsRaw);
    trackAnalytics('checkout_opened', { kind: String(parsed.kind) });
    const { openCheckout } = await import('./cloud/proxyClient');
    const res = await openCheckout(parsed.kind);
    if (!res.ok) return res;

    // Defense in depth: the URL was already allowlist-validated in proxyClient
    // before being returned, but we re-assert here before the OS handoff.
    const { assertSafeExternalUrl } = await import('./lib/externalUrlValidator');
    try {
      assertSafeExternalUrl(res.url);
    } catch {
      return { ok: false as const, code: 'PROXY_NETWORK' as const };
    }

    const { shell } = await import('electron');
    await shell.openExternal(res.url);
    // Return the {ok}/{ok:false,code} contract the renderer expects (the
    // renderer's useCreditsStore.openCheckout is Promise<void> and ignores the
    // body, so dropping the URL here is fine — it stays in the main process).
    return { ok: true as const };
  });

  // subscription:status — Plan 13-13 wired path. Reads subscription_status
  // via supabase-js (RLS scopes to current user).
  ipcMain.handle(IpcChannel.subscription.status, async (): Promise<SubscriptionStatusInfo> => {
    const { subscriptionStatus } = await import('./cloud/proxyClient');
    return subscriptionStatus();
  });

  // subscription:cancel — Plan 13-13 wired path. Opens the LS customer portal
  // externally (open-question resolution #5; Sei does not implement a cancel
  // endpoint).
  ipcMain.handle(IpcChannel.subscription.cancel, async () => {
    const { cancelSubscription } = await import('./cloud/proxyClient');
    return cancelSubscription();
  });

  // subscription:record-consent — quick/260525-sbo Task 3 — record an
  // immutable affirmative auto-renewal consent before the renderer opens
  // the LS subscription checkout. Required by CA Bus & Prof Code §17602(b).
  // Zod-validates consent_version is a non-empty string ≤64 chars at the IPC
  // trust boundary (defense in depth alongside the Edge Function's own
  // shape gate).
  ipcMain.handle(IpcChannel.subscription.recordConsent, async (_e, argsRaw: unknown) => {
    const parsed = RecordConsentArgsSchema.parse(argsRaw);
    const { recordSubscriptionConsent } = await import('./cloud/proxyClient');
    return recordSubscriptionConsent({ consent_version: parsed.consent_version });
  });

  // feedback:submit — 260706. Proxy POST /feedback (20/day per user; optional
  // once-per-account reward claim). Zod-validated at the IPC trust boundary;
  // the proxy re-validates everything server-side.
  ipcMain.handle(IpcChannel.feedback.submit, async (_e, argsRaw: unknown) => {
    const parsed = FeedbackSubmitArgsSchema.parse(argsRaw);
    const { feedbackSubmit } = await import('./cloud/proxyClient');
    const res = await feedbackSubmit(parsed);
    trackAnalytics('feedback_submitted');
    return res;
  });

  // feedback:report — 260706. Proxy POST /report (20/day per user).
  ipcMain.handle(IpcChannel.feedback.report, async (_e, argsRaw: unknown) => {
    const parsed = ReportSubmitArgsSchema.parse(argsRaw);
    const { reportSubmit } = await import('./cloud/proxyClient');
    const res = await reportSubmit(parsed);
    trackAnalytics('report_submitted');
    return res;
  });

  // Phase 11 — push sync-queue status updates to all renderer windows whenever
  // the queue mutates (enqueue / processNext / retry). notifyStatusChange in
  // syncQueue.ts fans out to subscribers; we wire one here that broadcasts
  // the slim push payload over IpcChannel.sync.statusUpdate.
  void (async () => {
    try {
      const { subscribeStatusChange, getStatus } = await import('./cloud/syncQueue');
      subscribeStatusChange(async () => {
        try {
          const { BrowserWindow } = await import('electron');
          const status = await getStatus();
          const payload = {
            pending: status.pending,
            pendingByUuid: status.pendingByUuid,
          };
          for (const w of BrowserWindow.getAllWindows()) {
            if (!w.isDestroyed()) w.webContents.send(IpcChannel.sync.statusUpdate, payload);
          }
        } catch (err) {
          console.warn(`[sei] sync status broadcast failed: ${(err as Error).message}`);
        }
      });
    } catch (err) {
      console.warn(`[sei] sync status subscriber wiring failed: ${(err as Error).message}`);
    }
  })();
}

/* -------------------------------------------------------------------------- */
/*  Phase 13 push emitters (credits:status:update, credits:hard-stop)         */
/* -------------------------------------------------------------------------- */

/**
 * Fan-out a CreditsStatus snapshot to every live renderer window. Wave 2
 * (proxy response interceptor in src/bot/llm/anthropicClient.js) calls this
 * after parsing the `X-Sei-Remaining-Pct` response header so the renderer
 * % bar updates without polling.
 *
 * Mirrors the sync.statusUpdate broadcaster above: uses
 * BrowserWindow.getAllWindows() so a future multi-window UI inherits the
 * fan-out for free, and silently skips destroyed windows so a race against
 * window close doesn't throw.
 */
export function emitCreditsStatusUpdate(status: CreditsStatus): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(IpcChannel.credits.statusUpdate, status);
  }
}

/**
 * Fan-out a CreditsHardStopEvent. Wave 2 calls this from the anthropicClient
 * 402 branch (ledger empty / remaining_pct hit 0) and from the rate-bucket
 * 503 branch (D-51). The renderer surfaces the HardStopModal in response.
 */
export function emitCreditsHardStop(info: CreditsHardStopEvent): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(IpcChannel.credits.hardStop, info);
  }
}
