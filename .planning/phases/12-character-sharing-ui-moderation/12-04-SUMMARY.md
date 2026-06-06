---
phase: 12-character-sharing-ui-moderation
plan: 04
subsystem: edge-function
tags: [supabase, edge-function, deno, openai, omni-moderation, two-tier, synchronous-gate, prompt-moderation]

# Dependency graph
requires:
  - phase: 12-character-sharing-ui-moderation
    plan: 02
    provides: "_shared/moderationProviders.ts — callOpenAIModeration + interpretOpenAIModerationFlag (OpenAI omni-moderation-latest model string + D-33 threshold logic lives here, single source)"
  - phase: 12-character-sharing-ui-moderation
    plan: 01
    provides: "characters.moderation_text_provider / moderation_text_checked_at columns (persisted by 12-07 caller, NOT by this function)"
provides:
  - "supabase/functions/moderate-character-prompt/index.ts — synchronous two-tier prompt moderation Edge Function"
  - "POST /functions/v1/moderate-character-prompt — body { name, persona_source, persona_expanded? } → 200 { verdict: 'clean' | 'block' | 'regenerate', tier?, friendlyMessage?, flaggedCategoriesInternal? }"
  - "Two-tier verdict contract: HARD tier on name+persona_source returns verdict='block' on flag; SOFT tier on persona_expanded returns verdict='regenerate' on flag (caller retries up to 2x)"
  - "FRIENDLY_BLOCK_MESSAGE constant — D-33c verbatim copy surfaced to renderer on hard-tier flag"
affects: [12-07-moderation-gate, 12-15-publish-with-moderation, 12-17-browse-enabled-gate]

# Tech tracking
tech-stack:
  added: []  # No new runtime deps — reuses callOpenAIModeration + corsHeaders + @supabase/supabase-js
  patterns:
    - "Thin Edge Function wrapping a _shared/<provider>Providers.ts helper — model string + threshold logic NOT duplicated (Pitfall 1 inherited by reference)"
    - "Two-tier verdict shape: { verdict: 'clean' | 'block' | 'regenerate', tier?, friendlyMessage?, flaggedCategoriesInternal? } — provider-agnostic, never exposes raw OpenAI categories to renderer (D-33c)"
    - "Stateless pure-compute Edge Function — no DB writes; caller (moderationGate.ts in 12-07) persists moderation_text_* columns after clean verdict"
    - "JWT presence + auth.getUser() defense-in-depth even on free-quota OpenAI moderation API (T-12-04-01: prevent anonymous quota abuse)"
    - "Retry loop cap (max 2x on regenerate verdict) explicitly delegated to caller (Pitfall 6) — this function returns verdict, caller decides whether to retry"

key-files:
  created:
    - supabase/functions/moderate-character-prompt/index.ts
  modified: []

key-decisions:
  - "Thin wrapper (~180 lines including JSDoc) around callOpenAIModeration from _shared/moderationProviders.ts — model string `omni-moderation-latest` and D-33 hard-tier thresholds (sexual/minors zero-tolerance, violence/graphic/hate/threatening/self-harm/intent >0.85) live ONLY in the shared module; this function imports the helper and never restates them. grep for `category_scores|sexual/minors|violence/graphic` in this file returns 0"
  - "Pure compute — NO database writes. The caller (12-07 moderationGate.ts) is responsible for persisting moderation_text_provider + moderation_text_checked_at on the character row after a clean verdict. Rationale: this function doesn't take a characterId, so it can be invoked before the row even exists (e.g., during the persona-expand → moderate → save flow)"
  - "Two-tier verdict shape per D-33b: HARD tier on `${name}\\n\\n${persona_source}` returns verdict='block' + friendlyMessage + flaggedCategoriesInternal on flag; SOFT tier on persona_expanded returns verdict='regenerate' + flaggedCategoriesInternal on flag. All clean → verdict='clean'. Caller pattern-matches on verdict, never raw categories"
  - "FRIENDLY_BLOCK_MESSAGE matches D-33c verbatim: 'We can\\'t publish this character because the persona description hits our content guidelines. Edit the persona and try again, or save it as private.' Renderer must surface THIS string, never raw OpenAI category names (T-12-04-02 mitigation)"
  - "flaggedCategoriesInternal field is named 'Internal' as a contract hint to the caller — for server-side logging only. The renderer must never display raw OpenAI categories. D-33c provider abstraction enforced at the response-shape boundary, not just the renderer"
  - "Retry loop on verdict='regenerate' lives in 12-07 moderationGate.ts (Pitfall 6 cap = 2 attempts), NOT here. This function is stateless and re-entrant — repeated calls with the same input return the same verdict"
  - "JWT verification (Bearer + auth.getUser()) is defense-in-depth: OpenAI moderation API is free, but an anonymous flood could still burn rate limits on Sei's OpenAI account. T-12-04-01 mitigation — anonymous callers rejected pre-fetch"
  - "Empty persona_source is allowed through to OpenAI — empty strings return clean which is the correct semantics (nothing to flag). T-12-04-03: attacker cannot 'skip' the hard check by submitting empty text, because the hard check still runs"
  - "On OpenAI HTTP error or 10s timeout (thrown from callOpenAIModeration) → 502 provider_error. Caller (12-07) MUST treat this as a hard failure and refuse to publish — never assume clean (mirrors 12-03 invariant)"

patterns-established:
  - "Pure-compute synchronous gate Edge Function: imports shared provider helper, validates JWT, runs the check, returns a friendly verdict shape. No DB writes. Caller orchestrates persistence + retries. This is the inverse pattern to 12-03 (which DOES write to the row) — chosen because prompt moderation can fire before the character row exists, whereas image moderation always has a characterId already"
  - "Two-tier verdict contract: { verdict: 'clean' | 'block' | 'regenerate', tier?: 'hard' | 'soft', friendlyMessage?, flaggedCategoriesInternal? }. Stable across provider swaps — if OpenAI moderation gets replaced with Anthropic or a hand-rolled classifier in v1.x, only the `flaggedCategoriesInternal` field's contents change"

requirements-completed: [SHARE-07]

# Metrics
duration: ~2min
completed: 2026-05-22
---

# Phase 12 Plan 04: moderate-character-prompt Edge Function Summary

**Synchronous two-tier prompt moderation Edge Function. Wraps `callOpenAIModeration` from Plan 12-02's `_shared/moderationProviders.ts` (no duplicate OpenAI code or threshold constants). HARD tier on `name + persona_source` returns `verdict='block'` on flag (publication rejected); SOFT tier on `persona_expanded` returns `verdict='regenerate'` on flag (caller re-expands with moderation-steer prompt and retries up to 2x). Response shape is provider-agnostic — never exposes raw OpenAI category names to the renderer (D-33c).**

## Performance

- **Duration:** ~2 min
- **Started:** 2026-05-22T08:18:14Z
- **Completed:** 2026-05-22T08:20:00Z
- **Tasks:** 1
- **Files created:** 1

## Accomplishments

- `supabase/functions/moderate-character-prompt/index.ts` ships as a ~180-line thin wrapper around `_shared/moderationProviders.ts`'s `callOpenAIModeration`. JWT verification (Bearer + `auth.getUser()`) follows the precedent established in 12-03.
- Request shape `{ name: string, persona_source: string, persona_expanded?: string }`. Response shapes: `{ verdict: 'clean' }`, `{ verdict: 'block', tier: 'hard', friendlyMessage, flaggedCategoriesInternal }`, `{ verdict: 'regenerate', tier: 'soft', flaggedCategoriesInternal }`. Error shapes: 401 `missing_jwt` / `invalid_jwt`, 400 `bad_request`, 502 `provider_error`, 405 method not allowed.
- Pure compute — no database writes. Caller (12-07 `moderationGate.ts`) persists `moderation_text_provider` + `moderation_text_checked_at` on the character row after a clean verdict.
- `FRIENDLY_BLOCK_MESSAGE` constant matches D-33c verbatim.
- No magic threshold numbers in this file — single source of truth in `_shared/moderationProviders.ts`. `grep -c "category_scores\|sexual/minors\|violence/graphic"` = 0.

## Task Commits

Each task was committed atomically:

1. **Task 1: Implement moderate-character-prompt with two-tier verdict mapping** — `eaa4866` (feat)

**Plan metadata commit:** (pending — created after this file lands)

## Files Created/Modified

- `supabase/functions/moderate-character-prompt/index.ts` — ~180 lines. Imports `callOpenAIModeration` from `_shared/moderationProviders.ts` (single source of model string + D-33 threshold logic). Imports `corsHeaders` from `_shared/cors.ts`. One `createClient` call (`userClient` for `auth.getUser()` — no `adminClient` needed since there are no DB writes). Two-tier flow documented in top-of-file JSDoc preamble.

## Request / Response Contract — Used by 12-07 moderationGate.ts

**Endpoint:** `POST https://<project-ref>.supabase.co/functions/v1/moderate-character-prompt`

**Headers:**
- `Authorization: Bearer <user-jwt>` (required — function refuses missing or invalid JWTs with 401)
- `Content-Type: application/json`

**Request body:**
```json
{
  "name": "<character name>",
  "persona_source": "<short user-authored persona>",
  "persona_expanded": "<optional LLM-expanded persona>"
}
```

`persona_expanded` is OPTIONAL. If omitted or non-string, only the HARD tier runs.

**Response (200 — all clean):**
```json
{ "verdict": "clean" }
```

**Response (200 — HARD tier flagged):**
```json
{
  "verdict": "block",
  "tier": "hard",
  "friendlyMessage": "We can't publish this character because the persona description hits our content guidelines. Edit the persona and try again, or save it as private.",
  "flaggedCategoriesInternal": ["<openai category names — server log only>"]
}
```

Caller (12-07) MUST surface `friendlyMessage` (or its own equivalent copy) to the renderer. `flaggedCategoriesInternal` is for server-side logs only.

**Response (200 — SOFT tier flagged):**
```json
{
  "verdict": "regenerate",
  "tier": "soft",
  "flaggedCategoriesInternal": ["<openai category names — server log only>"]
}
```

Caller (12-07) re-expands `persona_expanded` with a moderation-steer prompt and re-invokes this function. Retry loop cap = 2 attempts (Pitfall 6 — implemented in 12-07, not here).

**Error responses:**
- `401 { "error": "missing_jwt" }` — no Bearer header
- `401 { "error": "invalid_jwt" }` — Bearer present but JWT invalid / user not found
- `400 { "error": "bad_request" }` — body missing `name` or `persona_source`, or wrong types, or non-JSON body
- `405 Method not allowed` — non-POST method
- `502 { "error": "provider_error", "detail": "..." }` — OpenAI HTTP non-2xx or 10s timeout. NO verdict — caller MUST treat as hard failure and refuse to publish.

## Caller Invariants — Read by 12-07

1. **Retry loop cap = 2** on `verdict='regenerate'`. After 2 failed re-expansions, surface a friendly error to the user (e.g., "We're having trouble generating a persona that fits our content guidelines. Try editing the source description, or save it as private."). Pitfall 6.
2. **Never surface `flaggedCategoriesInternal` to the renderer.** Log it server-side for debugging, but the renderer copy must be `friendlyMessage` (or generic "regenerating…" for the soft tier). D-33c / T-12-04-02.
3. **Treat 502 as hard failure.** Never assume clean on provider error. Surface "Moderation service temporarily unavailable — try again in a moment." (mirrors 12-03 invariant).
4. **Persist on clean verdict.** After receiving `{ verdict: 'clean' }`, write `moderation_text_provider='openai-omni-moderation-latest'` + `moderation_text_checked_at=now()` to the character row (12-01 columns). This Edge Function does NOT do that — it has no characterId.
5. **HARD tier verdict='block' is terminal.** No retry path — the user must edit `name` or `persona_source`. Only the SOFT tier (`persona_expanded`) is regenerable.

## Decisions Made

See `key-decisions` in frontmatter — the most consequential ones:

1. **Thin wrapper, single source of truth.** OpenAI model string `omni-moderation-latest` and D-33 thresholds live exclusively in `_shared/moderationProviders.ts`. This function imports `callOpenAIModeration` and never restates them. Pitfall 1 inherited by reference.
2. **No DB writes — pure compute.** Unlike 12-03 (which writes `moderation_status` to the character row), this function returns a verdict and lets the caller orchestrate persistence. Rationale: prompt moderation can fire before the character row exists (the publish flow may persona-expand → moderate → save). The caller (12-07) has full context — characterId + clean verdict + timestamp — and writes the row atomically.
3. **Two-tier verdict shape.** HARD tier returns `verdict='block'` (publication rejected, user must edit). SOFT tier returns `verdict='regenerate'` (caller re-expands and retries up to 2x). The `verdict` discriminator makes pattern-matching trivial in 12-07 and stable across provider swaps.
4. **`flaggedCategoriesInternal` field name.** The `Internal` suffix is a contract hint: this field is for server-log diagnostics only. The renderer must never display raw OpenAI category names — D-33c keeps user-facing copy in friendly natural language.
5. **JWT defense-in-depth on free quota.** OpenAI moderation is free, but the rate limit still applies to Sei's OpenAI account. Anonymous floods would degrade legitimate moderation. JWT verification rejects pre-fetch (T-12-04-01).

## Deviations from Plan

None — plan executed as written, with the following minor refinements consistent with the established `delete-me/index.ts` + `moderate-character-images/index.ts` shape:

1. **Explicit `Content-Type: application/json` on every JSON-body response** (the plan's action block omitted it on some 401 paths). Added consistently so the caller's `fetch().json()` doesn't fall back to text parsing.
2. **Explicit `status: 200` on success branches** (the plan relied on the implicit default). Set explicitly for parity with the response-contract documentation.
3. **JSDoc preamble does NOT restate the D-33 threshold table.** The plan's action block included a threshold table in the JSDoc as documentation. I trimmed it to a reference-only pointer ("see `_shared/moderationProviders.ts`") to ensure the verification grep — `grep -c "category_scores\|sexual/minors\|violence/graphic" supabase/functions/moderate-character-prompt/index.ts` — returns 0. Single source of truth invariant enforced at the lexical level, not just architecturally.

Neither (1) nor (2) is a behavior change. (3) is a documentation-shape refinement to satisfy the plan's own verification step; the architectural invariant is preserved (thresholds still live exclusively in the shared module).

## Issues Encountered

None.

## User Setup Required

**Deploy the function (one-time per environment):**

```bash
supabase functions deploy moderate-character-prompt
```

**Secrets required** — already set if you have an OpenAI account:

```bash
supabase secrets set OPENAI_API_KEY='sk-...'
# SUPABASE_URL / SUPABASE_ANON_KEY auto-injected.
```

Cost expectation: OpenAI moderation API is **free**. The key only needs to belong to an account.

**Smoke test (signed-in JWT required):**

```bash
# 1. Get a user JWT (one-time): sign in via the desktop client, then in the
#    main-process console: console.log(await getClient().auth.getSession())

# 2. Invoke with clean inputs (should return 200 clean):
curl -sS -X POST \
  -H "Authorization: Bearer $USER_JWT" \
  -H "Content-Type: application/json" \
  -d '{"name":"Friendly Bot","persona_source":"A cheerful Minecraft companion who loves building."}' \
  "https://<project-ref>.supabase.co/functions/v1/moderate-character-prompt"
# Expected: {"verdict":"clean"}

# 3. (Optional) Invoke with a known-flagged hard-tier text — should return 200 block:
curl -sS -X POST \
  -H "Authorization: Bearer $USER_JWT" \
  -H "Content-Type: application/json" \
  -d '{"name":"X","persona_source":"<insert a phrase that trips violence/graphic >0.85>"}' \
  "https://<project-ref>.supabase.co/functions/v1/moderate-character-prompt"
# Expected: {"verdict":"block","tier":"hard","friendlyMessage":"We can't publish...","flaggedCategoriesInternal":[...]}

# 4. (Optional) Invoke with invalid JWT — should return 401:
curl -sS -X POST -H "Authorization: Bearer bogus" \
  "https://<project-ref>.supabase.co/functions/v1/moderate-character-prompt"
# Expected: {"error":"invalid_jwt"}
```

## Threat Surface — Re-verify Against 12-04-PLAN `<threat_model>`

Plan listed 6 STRIDE threats (T-12-04-01..06). Mitigated-disposition threats are implemented:

| Threat ID | Disposition | Implemented as |
|-----------|-------------|----------------|
| T-12-04-01 (Spoofing — anonymous OpenAI quota abuse) | mitigate | Bearer + `userClient.auth.getUser()` check rejects pre-fetch. |
| T-12-04-02 (Info Disclosure — raw categories leak) | mitigate | Response only carries `verdict` + `friendlyMessage` + `flaggedCategoriesInternal` (named "Internal" + documented as server-log-only). Renderer copy = `friendlyMessage`, not category names. |
| T-12-04-03 (Tampering — empty persona_source skip) | mitigate | Empty hard text still goes through OpenAI; empty-string input returns clean (no categories flagged), which is correct (nothing to block). The attacker cannot bypass the call. |
| T-12-04-04 (DoS — OpenAI quota exhaustion) | accept | OpenAI moderation is free; per-account rate limit is high. v1.x: 5-min in-memory cache deferred (noted in 12-PATTERNS). |
| T-12-04-05 (Repudiation — no audit trail) | mitigate | Caller (12-07) persists `moderation_text_provider` + `moderation_text_checked_at` on character row after clean verdict. Edge Function logs visible in Supabase dashboard for 7 days. |
| T-12-04-06 (Tampering — infinite regenerate loop) | mitigate | This Edge Function is stateless. Loop cap (max 2 retries on `regenerate`) lives in 12-07 `moderationGate.ts` per Pitfall 6 — documented in the "Caller Invariants" section above. |

No new threat surface beyond the plan. No `Threat Flags` section needed.

## Next Phase Readiness

**Wave 2 remaining + downstream consumers unblocked:**

- **Plan 12-05** `submit-report` Edge Function — independent of this function, but will follow the same thin-wrapper + JWT-defense-in-depth shape established here and in 12-03.
- **Plan 12-06** `notify-report` Edge Function — independent of moderation; reads from `pg_notify('reports_new', ...)`.
- **Plan 12-07** `moderationGate.ts` in `src/main/cloud/` is the renderer-facing orchestrator that consumes BOTH this function and `moderate-character-images` (12-03). It will:
  1. Upload portrait bytes to Storage
  2. Derive `portraitUrl` server-side (T-12-03-01 mitigation)
  3. Call `moderate-character-images` (12-03) — on 502 hard fail, on flagged surface friendly error
  4. Call `moderate-character-prompt` (this function) with `{ name, persona_source, persona_expanded }`
  5. On `verdict='block'` → surface `friendlyMessage`, refuse publication
  6. On `verdict='regenerate'` → re-expand `persona_expanded` with moderation-steer prompt, re-invoke this function (cap = 2 retries per Pitfall 6)
  7. On `verdict='clean'` → write `moderation_text_provider` + `moderation_text_checked_at` to row, flip `shared=true`
  8. On 502 (provider error) → surface "Moderation service temporarily unavailable" — never assume clean
- **Plan 12-15** `publishWithModeration` in `cloudCharacterClient.ts` is the high-level wrapper that invokes 12-07's gate.

## Self-Check: PASSED

- `supabase/functions/moderate-character-prompt/index.ts` — FOUND
- Imports `callOpenAIModeration` from `_shared/moderationProviders.ts` — FOUND
- Imports `corsHeaders` from `_shared/cors.ts` — FOUND
- JWT presence check (`Bearer ` prefix) — FOUND
- JWT validity check (`userClient.auth.getUser()`) — FOUND
- Body validation (typeof string × 2 for `name` + `persona_source`) — FOUND
- HARD tier on `${name}\n\n${persona_source}` — FOUND
- SOFT tier on `persona_expanded` (only if non-empty string) — FOUND
- `verdict='block'` + `tier='hard'` + `friendlyMessage` + `flaggedCategoriesInternal` on HARD flag — FOUND
- `verdict='regenerate'` + `tier='soft'` + `flaggedCategoriesInternal` on SOFT flag — FOUND
- `verdict='clean'` on all-clean — FOUND
- 502 `provider_error` on OpenAI HTTP error / timeout — FOUND (both tiers)
- `FRIENDLY_BLOCK_MESSAGE` constant matches D-33c verbatim — FOUND
- NO DB writes in this function (no `adminClient`, no `.from('characters').update(...)`) — VERIFIED
- `grep -c "callOpenAIModeration\|verdict\|FRIENDLY_BLOCK_MESSAGE\|persona_expanded" supabase/functions/moderate-character-prompt/index.ts` = 20 (plan asserted ≥4)
- `grep -c "category_scores\|sexual/minors\|violence/graphic" supabase/functions/moderate-character-prompt/index.ts` = 0 (plan asserted = 0; thresholds live ONLY in shared module)
- Commit `eaa4866` (Task 1: moderate-character-prompt) — FOUND in git log

---
*Phase: 12-character-sharing-ui-moderation*
*Completed: 2026-05-22*
