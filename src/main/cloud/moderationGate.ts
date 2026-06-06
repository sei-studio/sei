/**
 * Phase 12 Plan 07 — Pre-publish moderation orchestrator (SHARE-05/06/07).
 *
 * MAIN PROCESS ONLY. Wraps the two synchronous Edge Function gates
 * (`moderate-character-images` from 12-03, `moderate-character-prompt` from
 * 12-04) and returns a tagged-union `PublishResult` that the renderer-facing
 * IPC handler in Wave 3 (12-08) translates into ERROR_COPY entries.
 *
 * ─── Order of operations (mandatory; covered by tests 1–8) ─────────────────
 *
 *   1. Image moderation (Edge Function `moderate-character-images`).
 *      portraitUrl is DERIVED here from
 *        `${supabaseUrl}/storage/v1/object/public/portraits/${ownerUuid}/${characterId}.png`
 *      so the caller (renderer or IPC handler) CANNOT point at a different
 *      image (T-12-03-01 mitigation; 12-03-SUMMARY caller invariant).
 *      Provider 502 / network error / timeout → CLOUD_MODERATION_PROVIDER_UNAVAILABLE
 *      (Pitfall 12 hard-fail; never silently treated as clean).
 *
 *   2. Prompt moderation (Edge Function `moderate-character-prompt`).
 *      Body shape from 12-04: `{ name, persona_source, persona_expanded? }`.
 *      Three possible verdicts:
 *        - 'clean'      → proceed to upsert.
 *        - 'block'      → CLOUD_MODERATION_PROMPT_FLAGGED. Terminal — caller
 *                         must edit name or persona_source.
 *        - 'regenerate' → re-expand persona via `reExpandPersona` and retry.
 *                         Cap = SOFT_RETRY_CAP (2). 3rd consecutive regenerate
 *                         returns CLOUD_MODERATION_PROMPT_FLAGGED (Pitfall 6 /
 *                         T-12-07-02).
 *      Provider error → same hard-fail as image step.
 *
 *   3. Upsert with shared=true + moderation_status='clean' + provider stamps.
 *      Failure here is NOT a moderation-gate failure; it bubbles up as the
 *      existing CLOUD_SYNC_UPSERT_FAILED sentinel from cloudCharacterClient.
 *
 * ─── Why dependency injection ──────────────────────────────────────────────
 * The orchestrator never imports `callEdgeFunction`, `upsertCharacter`,
 * `getCharacter`, or the Supabase URL directly. All collaborators are passed
 * through `PublishDeps` so:
 *   - Tests assert call order + payload shape without spinning up Supabase.
 *   - Production wiring (Wave 3 IPC handler in 12-08) supplies the real
 *     `callEdgeFunction` from `edgeFunctionClient.ts`, the real
 *     `upsertCharacter` from `cloudCharacterClient.ts`, and the supabaseUrl
 *     from main-process `env.ts`.
 *   - `reExpandPersona` is wired to the existing persona-expansion LLM call
 *     from Phase 11 (`expandAndSaveCharacter`); production callers pass that
 *     function. v1.0 may pass a graceful-fallback identity function if the
 *     expander isn't yet ready — in that case soft regenerate becomes a single
 *     retry with the same expanded text, which will (correctly) re-flag and
 *     trip the cap.
 */

import {
  CLOUD_MODERATION_IMAGE_FLAGGED,
  CLOUD_MODERATION_PROMPT_FLAGGED,
  CLOUD_MODERATION_PROVIDER_UNAVAILABLE,
} from './cloudErrors';

/**
 * Soft-tier regenerate cap (Pitfall 6 / T-12-07-02).
 * Total prompt-mod calls = 1 initial + SOFT_RETRY_CAP retries.
 * 3rd consecutive `regenerate` verdict fails closed as PROMPT_FLAGGED.
 */
const SOFT_RETRY_CAP = 2;

/**
 * Per-call timeout for moderation Edge Functions. 30s headroom: SightEngine
 * + OpenAI moderation typically respond in 5–10s; the Edge Function itself
 * adds ~1s of cold-start latency. The default 15s in edgeFunctionClient is
 * too tight for the long tail on free-tier provider quotas.
 */
const MODERATION_TIMEOUT_MS = 30_000;

/** Friendly copy — never references provider names or raw categories (D-33c / T-12-07-03). */
const FRIENDLY_IMAGE_FLAGGED =
  'Image flagged by automated review — please use a different portrait.';
const FRIENDLY_PROMPT_FLAGGED =
  "We can't publish this character because the persona description hits our content guidelines. " +
  'Edit the persona and try again, or save it as private.';
const FRIENDLY_PROVIDER_UNAVAILABLE =
  'Moderation service is temporarily unavailable. Please try again in a few minutes.';

/** Text-moderation provider stamp persisted alongside the verdict on clean. */
const TEXT_PROVIDER_LABEL = 'openai-omni-moderation-latest';

/**
 * The character row shape the gate consumes. Deliberately narrow — we only
 * need the fields that flow into the two Edge Function bodies plus the
 * upsert payload spread.
 *
 * Production callers pass a `Character` (from src/shared/characterSchema.ts)
 * adapted via a small projection; tests use a structural literal.
 */
export interface ModerationCharacter {
  id: string;
  owner: string;
  name: string;
  persona_source: string;
  persona_expanded: string;
  [extra: string]: unknown;
}

/** Result of an image moderation Edge Function call (12-03 contract). */
interface ImageModerationResponse {
  status: 'clean' | 'flagged';
  provider: string;
  category?: string;
}

/** Result of a prompt moderation Edge Function call (12-04 contract). */
interface PromptModerationResponse {
  verdict: 'clean' | 'block' | 'regenerate';
  tier?: 'hard' | 'soft';
  friendlyMessage?: string;
  flaggedCategoriesInternal?: string[];
}

/** Public PublishResult tagged-union — consumed by Wave 3 IPC handler. */
export type PublishResult =
  | { ok: true; moderationProvider: string; textProvider: string }
  | {
      ok: false;
      code:
        | typeof CLOUD_MODERATION_IMAGE_FLAGGED
        | typeof CLOUD_MODERATION_PROMPT_FLAGGED
        | typeof CLOUD_MODERATION_PROVIDER_UNAVAILABLE;
      friendlyMessage: string;
    };

/** Dependency-injection bag. Production wiring lives in the Wave 3 IPC handler. */
export interface PublishDeps {
  /**
   * Edge Function caller. Production = a thin adapter around
   * `callEdgeFunction` from `../auth/edgeFunctionClient.ts` that throws on
   * `ok:false` (so 502 / network errors flow through this function's catch
   * blocks as `CLOUD_MODERATION_PROVIDER_UNAVAILABLE`).
   *
   * Tests use vi.fn() programmed via the `programEdge` helper.
   */
  callEdgeFunction: <T>(
    name: string,
    opts: { jwt: string; body: unknown; timeoutMs?: number },
  ) => Promise<T>;

  /** Production = `upsertCharacter` from `./cloudCharacterClient.ts`. */
  upsertCharacter: (character: ModerationCharacter, ownerUuid: string) => Promise<void>;

  /**
   * Soft-tier regenerate hook. Production = an LLM re-expansion that pulls
   * the current row, runs the persona-expander with mod-steering context,
   * and returns the new expanded text. Returns the NEW persona_expanded
   * string (does NOT persist on its own — this function persists via the
   * final upsertCharacter call).
   */
  reExpandPersona: (characterId: string) => Promise<string>;

  /** Production = `downloadCharacter` projection from `./cloudCharacterClient.ts`. */
  getCharacter: (characterId: string) => Promise<ModerationCharacter>;

  /** Production = `getAccessToken` from main-process auth state. */
  getJwt: () => Promise<string>;

  /** Production = `getSupabaseUrl()` from `../env.ts`. */
  supabaseUrl: string;
}

/**
 * Orchestrate pre-publish moderation. Pure with respect to its deps — any
 * external side effect (Edge Function call, DB write, LLM expansion) flows
 * through `deps`. Returns a tagged-union result; never throws on moderation
 * outcomes (it only throws if upsertCharacter throws or getCharacter throws).
 */
export async function publishWithModeration(
  characterId: string,
  deps: PublishDeps,
): Promise<PublishResult> {
  const char = await deps.getCharacter(characterId);
  const jwt = await deps.getJwt();

  // ── Step 1: derive portraitUrl server-side (T-12-03-01 mitigation) ──────
  // Caller (renderer) NEVER supplies this URL — it's reconstructed here from
  // the just-uploaded Storage path layout owned by cloudCharacterClient
  // (`portraits/<ownerUuid>/<characterId>.png`).
  const portraitUrl = buildPortraitUrl(deps.supabaseUrl, char.owner, characterId);

  // ── Step 2: image moderation ────────────────────────────────────────────
  let imageResult: ImageModerationResponse;
  try {
    imageResult = await deps.callEdgeFunction<ImageModerationResponse>(
      'moderate-character-images',
      {
        jwt,
        body: { characterId, portraitUrl },
        timeoutMs: MODERATION_TIMEOUT_MS,
      },
    );
  } catch (err) {
    // Pitfall 12 / T-12-07-04: never silently treat as clean. Log the real
    // failure so a stuck "Moderation service is temporarily unavailable"
    // surface has a debuggable breadcrumb — the friendly copy is for the
    // user, the console line is for whoever is triaging.
    console.warn(
      `[sei] moderation gate: moderate-character-images call failed for ${characterId}: ${(err as Error).message}`,
    );
    return providerUnavailable();
  }

  if (imageResult.status === 'flagged') {
    return {
      ok: false,
      code: CLOUD_MODERATION_IMAGE_FLAGGED,
      friendlyMessage: FRIENDLY_IMAGE_FLAGGED,
    };
  }

  // ── Step 3: prompt moderation with bounded soft-retry loop ──────────────
  let personaExpanded = char.persona_expanded;
  for (let attempt = 0; attempt <= SOFT_RETRY_CAP; attempt += 1) {
    let promptResult: PromptModerationResponse;
    try {
      promptResult = await deps.callEdgeFunction<PromptModerationResponse>(
        'moderate-character-prompt',
        {
          jwt,
          body: {
            name: char.name,
            persona_source: char.persona_source,
            persona_expanded: personaExpanded,
          },
          timeoutMs: MODERATION_TIMEOUT_MS,
        },
      );
    } catch (err) {
      console.warn(
        `[sei] moderation gate: moderate-character-prompt call failed for ${characterId} (attempt ${attempt}): ${(err as Error).message}`,
      );
      return providerUnavailable();
    }

    if (promptResult.verdict === 'clean') {
      // Fall through to publish.
      break;
    }

    if (promptResult.verdict === 'block') {
      // Hard-tier flag is terminal — no retry path (D-33b).
      return promptFlagged();
    }

    // verdict === 'regenerate' — soft tier.
    if (attempt === SOFT_RETRY_CAP) {
      // Exhausted retries (3rd consecutive regenerate). Fail closed.
      return promptFlagged();
    }
    // Re-expand and try again on next loop iteration. The new expanded text
    // propagates into the final upsert payload below.
    personaExpanded = await deps.reExpandPersona(characterId);
  }

  // ── Step 4: publish (clean across both gates) ───────────────────────────
  const nowIso = new Date().toISOString();
  await deps.upsertCharacter(
    {
      ...char,
      persona_expanded: personaExpanded,
      shared: true,
      moderation_status: 'clean',
      moderation_checked_at: nowIso,
      moderation_provider: imageResult.provider,
      moderation_text_provider: TEXT_PROVIDER_LABEL,
      moderation_text_checked_at: nowIso,
    },
    char.owner,
  );

  return {
    ok: true,
    moderationProvider: imageResult.provider,
    textProvider: TEXT_PROVIDER_LABEL,
  };
}

// ─── Internal helpers ─────────────────────────────────────────────────────

/**
 * Storage public URL layout — MUST match `cloudCharacterClient.portraitStoragePath`
 * exactly (`<owner>/<characterId>.png`). Hand-rolled rather than calling
 * supabase-js `getPublicUrl` so the gate can derive the URL without holding
 * a supabase client reference (keeping the orchestrator purely
 * dependency-injected for testability).
 */
function buildPortraitUrl(supabaseUrl: string, ownerUuid: string, characterId: string): string {
  const base = supabaseUrl.replace(/\/$/, '');
  return `${base}/storage/v1/object/public/portraits/${ownerUuid}/${characterId}.png`;
}

function providerUnavailable(): PublishResult {
  return {
    ok: false,
    code: CLOUD_MODERATION_PROVIDER_UNAVAILABLE,
    friendlyMessage: FRIENDLY_PROVIDER_UNAVAILABLE,
  };
}

function promptFlagged(): PublishResult {
  return {
    ok: false,
    code: CLOUD_MODERATION_PROMPT_FLAGGED,
    friendlyMessage: FRIENDLY_PROMPT_FLAGGED,
  };
}
