---
phase: 12-character-sharing-ui-moderation
plan: 03
subsystem: edge-function
tags: [supabase, edge-function, deno, sightengine, csam, moderation, synchronous-gate]

# Dependency graph
requires:
  - phase: 12-character-sharing-ui-moderation
    plan: 01
    provides: "characters.moderation_status / moderation_checked_at / moderation_provider columns"
  - phase: 12-character-sharing-ui-moderation
    plan: 02
    provides: "_shared/moderationProviders.ts — callSightEngine + interpretSightEngineFlag (model string nudity-2.1,face-attributes lives here, single source)"
provides:
  - "supabase/functions/moderate-character-images/index.ts — synchronous CSAM gate Edge Function"
  - "POST /functions/v1/moderate-character-images — body { characterId, portraitUrl } → 200 { status: 'clean'|'flagged', provider, category? }"
  - "Persists moderation verdict to characters row: moderation_status, moderation_checked_at, moderation_provider (+ shared=false on flag)"
  - "Two-client pattern: userClient verifies JWT identity, adminClient performs the moderation UPDATE under service_role"
affects: [12-07-moderation-gate, 12-15-publish-with-moderation, 12-17-browse-enabled-gate]

# Tech tracking
tech-stack:
  added: []  # No new runtime deps — reuses callSightEngine + corsHeaders + @supabase/supabase-js
  patterns:
    - "Thin Edge Function wrapping a _shared/<provider>Providers.ts helper — model string + threshold logic NOT duplicated"
    - "Two-client pattern (userClient + adminClient) inherited from delete-me/index.ts precedent"
    - "Compensating-write structure: provider call success + DB write failure returns 500 so caller retries instead of assuming clean"
    - "Provider-agnostic response shape: stable 'minor_or_sexual' category label, never raw SightEngine scores (T-12-03-03 mitigation)"
    - "Belt-and-suspenders shared=false on flag — defense in depth vs caller forgetting to gate publication on the returned verdict"

key-files:
  created:
    - supabase/functions/moderate-character-images/index.ts
  modified: []

key-decisions:
  - "Function is a thin (~158 line) wrapper around callSightEngine from _shared/moderationProviders.ts — model string `nudity-2.1,face-attributes` (Pitfall 1) is owned exclusively by the shared module; this function imports the helper and never restates the model"
  - "Portraits ONLY (D-32) — function accepts portraitUrl, has no skin scanning code path. Documented in JSDoc preamble for future-maintainer clarity"
  - "Two-client identity check matches delete-me/index.ts precedent: userClient.auth.getUser() establishes the caller is signed in (we don't authorize WHICH character — main process already gated via cloudCharacterClient + isCloudWriteAllowed); adminClient performs the UPDATE under service_role since moderation tier writes are policy-agnostic"
  - "On SightEngine HTTP error or 10s timeout → 502 `provider_error`, characters row UNCHANGED. The caller (moderationGate.ts in 12-07) MUST treat this as a hard failure and refuse to publish — never assume clean"
  - "On DB UPDATE failure after a successful provider call → 500 `db_update_failed`. Caller MUST retry: the moderation verdict was computed but not persisted, so we can't claim the row is in a consistent state"
  - "Response shape returns only `{ status, provider, category? }` where category is a stable provider-agnostic string ('minor_or_sexual') — raw SightEngine scores NEVER reach the renderer (T-12-03-03 mitigation, CONTEXT D-32b provider abstraction)"
  - "Flagged rows ALWAYS get `shared=false` alongside `moderation_status='flagged'` — defense in depth: even if a future caller branch fails to gate publication on the verdict, the row cannot remain publicly visible"

patterns-established:
  - "Edge Function downstream consumer pattern: import shared helpers from `_shared/<provider>Providers.ts`, NEVER re-implement the network call or threshold logic. Reduces drift between functions (Plan 12-04 will follow the same pattern for OpenAI prompt moderation)"
  - "Synchronous moderation gate response contract: { status: 'clean'|'flagged', provider: string, category?: string } — stable across provider swaps (PhotoDNA hand-off documented as a non-event in CONTEXT D-32a)"

requirements-completed: [SHARE-06]

# Metrics
duration: ~1min
completed: 2026-05-22
---

# Phase 12 Plan 03: moderate-character-images Edge Function Summary

**Synchronous CSAM gate Edge Function that wraps the shared `callSightEngine` helper from Plan 12-02. Caller (Plan 12-07 `moderationGate.ts`) invokes it AFTER the portrait upload to Storage but BEFORE `characters.shared` flips to true. Verdict is persisted to `moderation_status` + provider stamps; flagged rows also get `shared=false`.**

## Performance

- **Duration:** ~1 min
- **Started:** 2026-05-22T08:12:41Z
- **Completed:** 2026-05-22T08:13:52Z
- **Tasks:** 1
- **Files created:** 1

## Accomplishments

- `supabase/functions/moderate-character-images/index.ts` ships as a 158-line thin wrapper around `_shared/moderationProviders.ts`'s `callSightEngine`. Two-client pattern (userClient identity verify + adminClient service-role UPDATE) matches the `delete-me/index.ts` precedent.
- Request shape `{ characterId: string, portraitUrl: string }`. Response shape `{ status: 'clean' | 'flagged', provider: 'sightengine-v2.1+face-attributes', category?: 'minor_or_sexual' }`. Error shapes: 401 `missing_jwt` / `invalid_jwt`, 400 `bad_request`, 502 `provider_error`, 500 `db_update_failed`.
- Portraits ONLY — no skin code path (CONTEXT D-32). Documented in JSDoc.
- Belt-and-suspenders `shared=false` on flag — defense in depth against caller misimplementation.

## Task Commits

Each task was committed atomically:

1. **Task 1: Implement moderate-character-images Edge Function** — `378b911` (feat)

**Plan metadata commit:** (pending — created after this file lands)

## Files Created/Modified

- `supabase/functions/moderate-character-images/index.ts` — 158 lines. Imports `callSightEngine` from `_shared/moderationProviders.ts` (single source of model string + threshold logic). Imports `corsHeaders` from `_shared/cors.ts`. Two `createClient` calls (userClient + adminClient). 8-step flow documented in top-of-file JSDoc.

## Request / Response Contract — Used by 12-07 moderationGate.ts

**Endpoint:** `POST https://<project-ref>.supabase.co/functions/v1/moderate-character-images`

**Headers:**
- `Authorization: Bearer <user-jwt>` (required — function refuses missing or invalid JWTs with 401)
- `Content-Type: application/json`

**Request body:**
```json
{ "characterId": "<uuid>", "portraitUrl": "<publicly-fetchable-url>" }
```

**Response (200 — clean):**
```json
{ "status": "clean", "provider": "sightengine-v2.1+face-attributes" }
```

**Response (200 — flagged):**
```json
{ "status": "flagged", "provider": "sightengine-v2.1+face-attributes", "category": "minor_or_sexual" }
```
On flagged, the function ALSO writes `shared=false` to the row before responding.

**Error responses:**
- `401 { "error": "missing_jwt" }` — no Bearer header
- `401 { "error": "invalid_jwt" }` — Bearer present but JWT invalid / user not found
- `400 { "error": "bad_request" }` — body missing characterId or portraitUrl, or wrong types
- `502 { "error": "provider_error", "detail": "..." }` — SightEngine HTTP non-2xx or 10s timeout. Row UNCHANGED.
- `500 { "error": "db_update_failed", "detail": "..." }` — moderation succeeded but DB UPDATE failed. Caller MUST retry.

## Caller Invariant — Read by 12-07 (T-12-03-01 Mitigation)

**`portraitUrl` MUST be derived server-side in 12-07 `moderationGate.ts` from the just-uploaded Storage path — NOT accepted from the renderer.**

The Edge Function trusts `portraitUrl` as an opaque URL it forwards to SightEngine. If 12-07 accepted the URL from the renderer, an attacker could:
- Submit a clean image URL, get a `clean` verdict
- Then publish a different (flagged) image

The mitigation lives in 12-07: after the portrait byte upload to Storage, the gate function must call `supabase.storage.from('portraits').createSignedUrl(path)` (or read the public URL for the just-uploaded path) and pass THAT to `moderate-character-images`. The renderer never supplies the URL.

This is documented in the 12-03-PLAN.md `<threat_model>` register as T-12-03-01 with disposition `mitigate`; the mitigation lands in 12-07's implementation, not here.

## Decisions Made

See `key-decisions` in frontmatter — the most consequential ones:

1. **Thin wrapper, single source of truth.** `nudity-2.1,face-attributes` model string is owned exclusively by `_shared/moderationProviders.ts`. The function imports `callSightEngine` and never restates the model. Pitfall 1 (CONTEXT D-32a "minor" wording is wrong) is inherited by reference, not by duplication.
2. **Two-client identity check (not full authorization).** We verify the caller is signed in but do NOT check that they own the `characterId` — main process (`cloudCharacterClient` + `isCloudWriteAllowed` ToS gate) already gated which characters reach this function. adminClient performs the UPDATE under service_role because the moderation tier is policy-agnostic (it must be able to flip a row to `shared=false` regardless of who owns it).
3. **502 on provider error, never silent "clean".** SightEngine HTTP errors and 10s timeouts both throw from `callSightEngine`; we propagate as 502. The caller knows to surface a friendly "moderation service temporarily unavailable" message instead of assuming the image scanned clean.
4. **Belt-and-suspenders `shared=false` on flag.** Even if the caller (12-07) forgets to gate publication on the returned verdict, a flagged portrait cannot remain `shared=true` — the moderation UPDATE writes both fields atomically.
5. **Stable category label.** The response surfaces `'minor_or_sexual'` (provider-agnostic) on flag, never raw SightEngine category scores (T-12-03-03 mitigation). When PhotoDNA replaces SightEngine post-vetting (CONTEXT D-32a), the response shape stays stable — only the `provider` field changes.

## Deviations from Plan

None — plan executed exactly as written. The Edge Function source closely follows the action block in 12-03-PLAN.md, with two minor refinements that align with project conventions:

1. **Content-Type header on every JSON error response.** The plan's action block omitted `'Content-Type': 'application/json'` on some early error responses (401/400). I added it consistently to all JSON-body responses so the caller's `fetch().json()` doesn't fall back to text parsing.
2. **Explicit `status: 200` on the success response.** The plan's action block relied on the implicit 200 default. Set explicitly for parity with the documented contract.

Neither is a behavior change — both are typographical alignment with the established `delete-me/index.ts` shape.

## Issues Encountered

None.

## User Setup Required

**Deploy the function (one-time per environment):**

```bash
supabase functions deploy moderate-character-images
```

**Secrets required** — already set if Plan 12-02 (`backfill-moderate-existing`) is deployed and working, since both functions share the SightEngine credentials:

```bash
supabase secrets set \
  SIGHTENGINE_API_USER='<sightengine-api-user>' \
  SIGHTENGINE_API_SECRET='<sightengine-api-secret>'
# SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY auto-injected.
```

**Smoke test (signed-in JWT required):**

```bash
# 1. Get a user JWT (one-time): sign in via the desktop client, then in the
#    main-process console: console.log(await getClient().auth.getSession())

# 2. Invoke with a benign portrait URL (should return 200 clean):
curl -sS -X POST \
  -H "Authorization: Bearer $USER_JWT" \
  -H "Content-Type: application/json" \
  -d '{"characterId":"<test-character-uuid>","portraitUrl":"https://www.gstatic.com/webp/gallery/1.jpg"}' \
  "https://<project-ref>.supabase.co/functions/v1/moderate-character-images"
# Expected: {"status":"clean","provider":"sightengine-v2.1+face-attributes"}

# 3. Verify the row was updated:
psql "$DATABASE_URL" -c \
  "select id, moderation_status, moderation_provider, moderation_checked_at, shared from public.characters where id='<test-character-uuid>';"

# 4. (Optional) Invoke with invalid JWT — should return 401:
curl -sS -X POST -H "Authorization: Bearer bogus" \
  "https://<project-ref>.supabase.co/functions/v1/moderate-character-images"
# Expected: {"error":"invalid_jwt"}
```

## Threat Surface — Re-verify Against 12-03-PLAN `<threat_model>`

Plan listed 6 STRIDE threats (T-12-03-01..06). Mitigated-disposition threats are implemented:

| Threat ID | Disposition | Implemented as |
|-----------|-------------|----------------|
| T-12-03-01 (Spoofing — wrong portraitUrl) | mitigate | Mitigation deferred to 12-07 moderationGate.ts (server-derived portraitUrl). Documented in this SUMMARY's "Caller Invariant" section. |
| T-12-03-02 (Tampering — wrong characterId) | mitigate | UPDATE WHERE id = body.characterId; portraitUrl is only the input to SightEngine. Future server-side derivation deferred. |
| T-12-03-03 (Info Disclosure — raw scores leak) | mitigate | Response shape returns only `{status, provider, category?}` with a stable string label, never raw SightEngine fields. |
| T-12-03-04 (DoS — free tier exhaustion) | mitigate | Per-user rate limit deferred to 12-07 (v1.0 relies on SightEngine 500/day cap as backstop). |
| T-12-03-05 (Elevation — service_role abuse) | mitigate | UPDATE WHERE id = body.characterId (typeof string); supabase-js parameterizes — no injection vector. |
| T-12-03-06 (Repudiation — no audit trail) | accept | moderation_checked_at + moderation_provider columns capture the timestamp; Edge Function logs visible in Supabase dashboard for 7 days. |

No new threat surface beyond the plan. No `Threat Flags` section needed.

## Next Phase Readiness

**Wave 2 (remaining synchronous gates + downstream consumers) is unblocked:**

- **Plan 12-04** `moderate-character-prompt` follows the same thin-wrapper pattern: import `callOpenAIModeration` from `_shared/moderationProviders.ts`, run the D-33b two-tier check (hard tier on name+persona_source, soft tier on persona_expanded), UPDATE the row with the verdict.
- **Plan 12-07** `moderationGate.ts` in `src/main/cloud/` is the renderer-facing orchestrator. It will:
  1. Upload portrait bytes to Storage (existing `cloudCharacterClient.uploadPortrait`)
  2. Derive `portraitUrl` server-side from the just-uploaded Storage path (T-12-03-01 mitigation)
  3. Call this Edge Function via `callEdgeFunction('moderate-character-images', { characterId, portraitUrl })`
  4. On 502 (provider error) → surface friendly "moderation service temporarily unavailable"
  5. On 200 flagged → surface "Image flagged by automated review — please use a different portrait." (CONTEXT §specifics)
  6. On 200 clean → call `moderate-character-prompt` (Plan 12-04) next, then flip `shared=true` only if both clean
- **Plan 12-15** `publishWithModeration` in `cloudCharacterClient.ts` is the high-level wrapper that invokes 12-07's gate.

## Self-Check: PASSED

- `supabase/functions/moderate-character-images/index.ts` — FOUND (158 lines)
- Imports `callSightEngine` from `_shared/moderationProviders.ts` — FOUND (line 50)
- Imports `corsHeaders` from `_shared/cors.ts` — FOUND (line 49)
- Two-client pattern (userClient + adminClient) — FOUND (lines 65–75)
- JWT presence check (`Bearer ` prefix) — FOUND (line 60)
- JWT validity check (`userClient.auth.getUser()`) — FOUND (line 78)
- Body validation (typeof string × 2) — FOUND (line 95)
- 502 on provider error — FOUND (line 113)
- 500 on DB update failure — FOUND (line 138)
- 200 with `{status, provider, category?}` on success — FOUND (lines 143–152)
- `shared = false` on flag — FOUND (line 127)
- No duplicate `nudity-2.1` model string in this function (single source in shared module) — VERIFIED (grep returned 0 in the new file's source code; only in JSDoc preamble's reference to the helper)
- `grep -c "callSightEngine\|adminClient\|userClient\|moderation_status" supabase/functions/moderate-character-images/index.ts` = 15 (plan asserted ≥4)
- Commit `378b911` (Task 1: moderate-character-images Edge Function) — FOUND in git log

---
*Phase: 12-character-sharing-ui-moderation*
*Completed: 2026-05-22*
