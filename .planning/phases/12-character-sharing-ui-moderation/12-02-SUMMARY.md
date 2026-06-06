---
phase: 12-character-sharing-ui-moderation
plan: 02
subsystem: edge-function
tags: [supabase, edge-function, deno, sightengine, openai, moderation, backfill, idempotent, abortcontroller]

# Dependency graph
requires:
  - phase: 12-character-sharing-ui-moderation
    plan: 01
    provides: "characters.moderation_status / moderation_checked_at / moderation_provider / moderation_text_provider / moderation_text_checked_at columns + characters_unmoderated_idx partial index for ordered backfill walks"
  - phase: 11-cloud-character-library
    provides: "public characters table (owner, shared, persona_source, portrait_image) + portraits Storage bucket (Phase 11 D-24)"
provides:
  - "supabase/functions/_shared/moderationProviders.ts — shared call surface for SightEngine + OpenAI moderation reused by Plans 12-03/04/05"
  - "callSightEngine(portraitUrl) — SightEngine `nudity-2.1,face-attributes` call with 10s AbortController timeout"
  - "callOpenAIModeration(text) — OpenAI `omni-moderation-latest` call with 10s AbortController timeout"
  - "interpretSightEngineFlag(data) — pure threshold logic (minor face >0.5 AND non-trivial sexualization → flag)"
  - "interpretOpenAIModerationFlag(scores) — pure threshold logic (D-33 hard tier: sexual/minors zero-tolerance + violence/hate/self-harm >0.85)"
  - "supabase/functions/backfill-moderate-existing/index.ts — one-shot retroactive D-30 closure scanner"
  - "Idempotent + resumable batch walker (BATCH_SIZE=100, created_at ASC, returns nextCursor)"
affects: [12-03-moderate-character-images, 12-04-moderate-character-prompt, 12-05-submit-report, 12-15-publish-with-moderation]

# Tech tracking
tech-stack:
  added: []  # no new runtime deps — uses existing @supabase/supabase-js + Deno fetch + AbortController
  patterns:
    - "Shared provider module (_shared/moderationProviders.ts) imported by multiple Edge Functions — thin-wrapper pattern for downstream functions"
    - "Pure interpret*Flag helpers separated from network callers — testable threshold logic without provider hits"
    - "AbortController + setTimeout/clearTimeout in finally — every external Edge Function fetch wrapped with PROVIDER_TIMEOUT_MS (CLAUDE.md invariant)"
    - "Idempotent backfill via WHERE moderation_status IS NULL — re-runs only see unscanned rows; errored rows stay NULL and retry on next invocation"
    - "Resumable cursor pattern: { processed, flagged, errors, nextCursor: 'more' | 'done' } drives operator while-loop without per-row id tracking"
    - "created_at ASC ordering on UPDATEs that trigger updated_at bump — preserves historical chronology in updated_at-DESC Browse listing"

key-files:
  created:
    - supabase/functions/_shared/moderationProviders.ts
    - supabase/functions/backfill-moderate-existing/index.ts
  modified: []

key-decisions:
  - "Shared module placed at _shared/moderationProviders.ts (not duplicated per function) — Plans 12-03 (moderate-character-images) and 12-04 (moderate-character-prompt) become thin wrappers that just call the same helpers + write to a specific row"
  - "SightEngine models parameter is literally `nudity-2.1,face-attributes` (Pitfall 1 in 12-RESEARCH — CONTEXT D-32a wording `minor` is wrong, no such SightEngine model exists; minor signal lives at data.faces[i].attributes.minor from face-attributes)"
  - "interpretSightEngineFlag block rule: minor face >0.5 AND non-trivial sexualization (sexual_activity/sexual_display/erotica/very_suggestive >0.3 OR suggestive >0.5). Adults in sexual content NOT blocked at this layer — policy is CSAM-specific"
  - "interpretOpenAIModerationFlag thresholds per D-33: sexual/minors >0 (ZERO TOLERANCE), violence/graphic >0.85, hate/threatening >0.85, self-harm/intent >0.85"
  - "Backfill orders by created_at ASC (NOT updated_at DESC) because the characters_set_updated_at trigger bumps updated_at on every UPDATE — created_at ASC preserves chronology when the backfill writes a large batch into the Browse RPC's `order by updated_at desc` listing"
  - "BATCH_SIZE=100 per invocation. Returns { processed, flagged, errors, nextCursor: 'more' | 'done' } so operator drives `while true; do curl; jq .nextCursor; done` runbook. nextCursor='more' iff the page exactly filled (likely more behind); 'done' on short pages"
  - "Errored rows stay moderation_status=NULL and get retried on the next invocation — no separate retry queue needed. The function is fully crash-safe and idempotent"
  - "JWT presence check (Bearer header) is defense in depth on top of `corsHeaders` origin lockdown ('null'). Service-role JWT is the expected caller; the function does not verify identity beyond `Bearer ` prefix because operator-driven service_role invocations don't need per-user identity (mirrors `delete-me` only for the JWT-presence check, NOT the userClient.getUser pattern)"
  - "Flagged rows get shared=false alongside moderation_status='flagged' — mirrors D-32c retroactive scan invariant and ensures the Browse RPC's `shared=true` filter excludes them even before the moderation_status='clean' tightening lands"
  - "Backfill only runs D-33b hard tier (name + persona_source); the soft-regenerate path on persona_expanded is a Plan 12-04 concern that lives in the synchronous upload path"

patterns-established:
  - "Edge Function shared helper module: `_shared/<provider>Providers.ts` exporting both network callers and pure interpreter functions. Pure interpreters are exported so downstream tests / consumers can validate threshold logic without provider hits."
  - "AbortController wrap pattern for Deno fetch: `const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS); try { await fetch(..., { signal: ctrl.signal }); } finally { clearTimeout(timer); }`"
  - "Idempotent batch Edge Function: SELECT filter excludes already-processed rows, UPDATE writes a sentinel column, errors leave the sentinel NULL so the next run retries. No checkpoint table needed."
  - "Cursor return contract: `nextCursor: 'more' | 'done'` based on whether the page exactly filled — operator-friendly, no row-id state to thread through the loop."

requirements-completed: [SHARE-06, SHARE-07]

# Metrics
duration: 2min
completed: 2026-05-22
---

# Phase 12 Plan 02: Backfill Edge Function + Shared Moderation Providers Summary

**One-shot retroactive moderation backfill walking `characters WHERE shared=true AND moderation_status IS NULL` in `created_at ASC` batches of 100, plus a shared `_shared/moderationProviders.ts` module exporting SightEngine + OpenAI call helpers and pure threshold interpreters that Plans 12-03/04/05 will reuse.**

## Performance

- **Duration:** ~2 min
- **Started:** 2026-05-22T08:06:39Z
- **Completed:** 2026-05-22T08:08:55Z
- **Tasks:** 2
- **Files created:** 2

## Accomplishments

- `supabase/functions/_shared/moderationProviders.ts` ships with four exports: `callSightEngine`, `callOpenAIModeration`, `interpretSightEngineFlag`, `interpretOpenAIModerationFlag`. Both network callers wrap their fetch in `AbortController` + `PROVIDER_TIMEOUT_MS` (10s). Model parameter is literally `nudity-2.1,face-attributes` (Pitfall 1 enforced).
- `supabase/functions/backfill-moderate-existing/index.ts` ships as a service-role-invoked Edge Function with embedded operator runbook. Selects 100 rows at a time `WHERE shared=true AND moderation_status IS NULL ORDER BY created_at ASC`, runs portrait + prompt moderation per row, writes `moderation_status='clean'|'flagged'` + provider stamps, auto-unshares flagged rows, returns `{ processed, flagged, errors, nextCursor }` for operator loop.
- Idempotent + resumable: re-runs only see still-NULL rows; errored rows stay NULL and retry next invocation. No separate retry queue or checkpoint table.

## Task Commits

Each task was committed atomically:

1. **Task 1: Extract shared moderation provider helpers** — `9a26606` (feat)
2. **Task 2: Implement backfill Edge Function (idempotent, resumable, created_at asc)** — `5519a5d` (feat)

**Plan metadata commit:** (pending — created after this file lands)

## Files Created/Modified

- `supabase/functions/_shared/moderationProviders.ts` — 163 lines. Four exports. `PROVIDER_TIMEOUT_MS = 10_000`. SightEngine call uses `models=nudity-2.1,face-attributes` (Pitfall 1). OpenAI call uses `omni-moderation-latest`. Pure interpreter helpers exported for testability.
- `supabase/functions/backfill-moderate-existing/index.ts` — 173 lines. JSDoc preamble doubles as operator runbook. `BATCH_SIZE=100`, `created_at ASC`, returns `{ processed, flagged, errors, nextCursor: 'more' | 'done' }`. Per-row try/catch so a single bad portrait can't crash the batch.

## Decisions Made

See `key-decisions` in frontmatter — the most consequential ones:

1. **Shared module pattern.** `_shared/moderationProviders.ts` is the single source of truth for both providers' call surfaces and threshold logic. Plans 12-03 and 12-04 will be thin wrappers that import these helpers + write to a specific characters row, instead of re-implementing the SightEngine + OpenAI fetch.
2. **`nudity-2.1,face-attributes`, not `minor`.** Pitfall 1 in 12-RESEARCH explicitly corrects CONTEXT D-32a's "nudity-2.1 + minor model" wording. SightEngine has no `minor` model; the minor signal is `data.faces[i].attributes.minor` (0..1 float) returned by the `face-attributes` model. Enforced in the shared module so downstream plans inherit it.
3. **`created_at ASC` ordering.** The Phase 11 `characters_set_updated_at` trigger bumps `updated_at` on every UPDATE. Browse RPC orders by `updated_at desc`. If backfill batched rows in `updated_at desc` order, the most recently-modified pending row would land first and dominate Browse listing the moment it cleared. Ordering by `created_at asc` means oldest pending rows land first, newest last, preserving historical chronology in the Browse listing (12-PATTERNS.md trigger-ordering pitfall).
4. **Resumable cursor without row-id state.** `nextCursor: 'more' | 'done'` based on whether the page exactly filled. Simpler than threading the last-seen `created_at` through the operator's loop — and idempotent against rows that change `moderation_status` between invocations.
5. **Errored rows retry automatically.** A row that throws (provider 5xx, timeout, JSON parse error) stays at `moderation_status = NULL` and gets picked up by the next invocation's SELECT. No retry queue, no exponential backoff state — the WHERE filter does the bookkeeping.

## Deviations from Plan

None — plan executed exactly as written. Both tasks landed verbatim from the PLAN.md action blocks (with minor JSDoc expansion to embed the operator runbook directly in the function file, matching the `delete-me/index.ts` precedent).

## Issues Encountered

None.

## User Setup Required

**External services + secrets must be configured before this Edge Function can run.** Deploy + secrets:

```bash
# 1. Deploy the function
supabase functions deploy backfill-moderate-existing

# 2. Set provider secrets (one-time, per environment)
supabase secrets set \
  SIGHTENGINE_API_USER='<sightengine-api-user>' \
  SIGHTENGINE_API_SECRET='<sightengine-api-secret>' \
  OPENAI_API_KEY='<openai-api-key>'

# Note: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are auto-injected
# by Supabase on every Edge Function invocation; no need to set them.

# 3. Drive the backfill loop until done
while true; do
  RESULT=$(curl -sS -X POST \
    -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
    "https://<project-ref>.supabase.co/functions/v1/backfill-moderate-existing")
  echo "$RESULT"
  CURSOR=$(echo "$RESULT" | jq -r .nextCursor)
  [ "$CURSOR" = "done" ] && break
done

# 4. Verify before flipping BROWSE_ENABLED (D-36 gate (b))
psql "$DATABASE_URL" -c \
  "select count(*) from public.characters \
   where shared = true and moderation_status is null;"
# MUST return 0.
```

Provider account setup (one-time):
- **SightEngine:** sign up at https://sightengine.com/ — free tier 2000 ops/month, 500/day. Get `api_user` + `api_secret` from dashboard. Provider call counts as 1 op per model invoked; the combined `nudity-2.1,face-attributes` call likely counts as 2 ops per portrait (Pitfall 12 in 12-RESEARCH).
- **OpenAI:** the `omni-moderation-latest` Moderation API is **free** on any account with a valid API key. Set the same `OPENAI_API_KEY` Sei uses elsewhere, or create a dedicated moderation key.

## Threat Surface — Re-verify Against 12-02-PLAN `<threat_model>`

Plan listed 6 STRIDE threats (T-12-02-01..06). All disposed-as-mitigate threats are implemented:

| Threat ID | Disposition | Implemented as |
|-----------|-------------|----------------|
| T-12-02-01 (Spoofing) | mitigate | `authHeader?.startsWith('Bearer ')` gate at handler top — non-Bearer calls return 401 with no DB or provider work done |
| T-12-02-02 (Info Disclosure of raw provider data) | mitigate | Response body returns only counts + nextCursor; raw SightEngine/OpenAI payloads only reach `console.error` on row failure |
| T-12-02-03 (DoS) | accept | BATCH_SIZE=100 hard cap; SightEngine free-tier 500/day naturally rate-limits; operator runbook documents serial loop (no parallel curls) |
| T-12-02-04 (Tampering provider response) | mitigate | `interpret*Flag` helpers are pure; provider response only writes to DB after the binary verdict is computed locally — no provider field is trusted as authoritative |
| T-12-02-05 (service_role key exposure) | accept | Standard Edge Function pattern; key only in `Deno.env.get` (Supabase-injected); never reaches desktop client |
| T-12-02-06 (Repudiation — silent row skip) | mitigate | `errors` counter in response body; failed rows stay `moderation_status IS NULL` so next invocation retries automatically |

No new threat surface beyond the plan. No `Threat Flags` section needed.

## Next Phase Readiness

**Wave 2 (remaining Edge Functions) is unblocked:**

- **Plan 12-03** `moderate-character-images` becomes a thin wrapper: import `callSightEngine` from `_shared/moderationProviders.ts`, take `{ characterId, portraitUrl }` in the body, call `callSightEngine(portraitUrl)`, UPDATE the matching row with the verdict + provider stamp. ~40 lines on top of the shared module.
- **Plan 12-04** `moderate-character-prompt` becomes a thin wrapper: import `callOpenAIModeration` from `_shared/moderationProviders.ts`, run the D-33b two-tier check (hard tier on name+persona_source, soft tier on persona_expanded), UPDATE with verdict. ~60 lines on top of the shared module.
- **Plan 12-05** `submit-report` is independent of this plan but will live alongside in the same `supabase/functions/` directory and follow the same CORS + JWT scaffolding.

**Wave 1 close-out:** The retroactive backfill function exists but has NOT been invoked yet. Operator must run the curl loop in the User Setup section above before flipping `BROWSE_ENABLED` (D-36 gate (b)).

## Self-Check: PASSED

- `supabase/functions/_shared/moderationProviders.ts` — FOUND (163 lines, 4 exports, model string `nudity-2.1,face-attributes`, both fetches wrapped in AbortController with PROVIDER_TIMEOUT_MS)
- `supabase/functions/backfill-moderate-existing/index.ts` — FOUND (173 lines, imports moderationProviders, BATCH_SIZE=100, `ascending: true` on created_at, returns `nextCursor`, flagged rows auto-unshared)
- Commit `9a26606` (Task 1: shared moderation providers) — FOUND in git log
- Commit `5519a5d` (Task 2: backfill Edge Function) — FOUND in git log
- Grep on backfill function: `shared.*true|moderation_status.*null|created_at.*asc|nextCursor|BATCH_SIZE` = 13 matches (plan asserted ≥4)
- Grep on shared module: 4 export lines for the 4 required functions
- `nudity-2.1,face-attributes` appears ONLY in the shared module (correctly delegated; not duplicated in the backfill function)

---
*Phase: 12-character-sharing-ui-moderation*
*Completed: 2026-05-22*
