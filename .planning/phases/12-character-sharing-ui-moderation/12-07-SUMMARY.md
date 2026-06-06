---
phase: 12-character-sharing-ui-moderation
plan: 07
subsystem: main-process-orchestration
tags: [main, moderation, orchestration, tdd, sentinel-errors, dependency-injection]

# Dependency graph
requires:
  - phase: 12-character-sharing-ui-moderation
    plan: 01
    provides: "characters.moderation_status / moderation_provider / moderation_text_provider columns (written by publishWithModeration upsert payload)"
  - phase: 12-character-sharing-ui-moderation
    plan: 03
    provides: "moderate-character-images Edge Function — { characterId, portraitUrl } → { status, provider, category? } | 502"
  - phase: 12-character-sharing-ui-moderation
    plan: 04
    provides: "moderate-character-prompt Edge Function — { name, persona_source, persona_expanded? } → { verdict, tier?, friendlyMessage?, flaggedCategoriesInternal? } | 502"
provides:
  - "src/main/cloud/moderationGate.ts — publishWithModeration(characterId, deps): Promise<PublishResult> orchestrator"
  - "PublishResult tagged-union: { ok:true, moderationProvider, textProvider } | { ok:false, code, friendlyMessage }"
  - "PublishDeps dependency-injection contract — callEdgeFunction, upsertCharacter, reExpandPersona, getCharacter, getJwt, supabaseUrl"
  - "Three new CLOUD_MODERATION_* sentinels in cloudErrors.ts: IMAGE_FLAGGED, PROMPT_FLAGGED, PROVIDER_UNAVAILABLE"
  - "Server-derived portraitUrl invariant (T-12-03-01 mitigation)"
  - "SOFT_RETRY_CAP=2 enforced for verdict='regenerate' (Pitfall 6 / T-12-07-02)"
affects: [12-08-publish-ipc, 12-10-publish-button, 12-11-error-copy, 12-17-browse-enabled-gate]

# Tech tracking
tech-stack:
  added: []  # Reuses existing edgeFunctionClient + cloudCharacterClient + vitest
  patterns:
    - "Dependency-injection orchestrator — module imports zero production collaborators directly; all I/O flows through PublishDeps"
    - "Tagged-union PublishResult — caller pattern-matches on ok+code, no exception flow for moderation outcomes"
    - "Sentinel-prefix error vocabulary (CLOUD_MODERATION_*) matching Phase 11 CLOUD_SYNC_* / CLOUD_STORAGE_* convention"
    - "Bounded retry loop with explicit cap constant (SOFT_RETRY_CAP=2) — defense vs Pitfall 6 infinite regenerate"
    - "Fail-closed on provider error — try/catch around every callEdgeFunction returns PROVIDER_UNAVAILABLE; upsert with shared=true unreachable on error path"
    - "TDD RED→GREEN with 8 invariant tests committed before implementation"

key-files:
  created:
    - src/main/cloud/moderationGate.ts
    - src/main/cloud/moderationGate.test.ts
  modified:
    - src/main/cloud/cloudErrors.ts

key-decisions:
  - "Dependency injection over module-level imports. The orchestrator never imports callEdgeFunction or upsertCharacter directly; production wiring happens in the Wave 3 IPC handler (12-08). Rationale: keeps tests Supabase-free, makes the contract between this layer and its collaborators explicit, and lets the future graceful-fallback expander (or jailbreak-hardened expander) be swapped without modifying this file."
  - "Three independent sentinels rather than one with sub-codes. CLOUD_MODERATION_IMAGE_FLAGGED, CLOUD_MODERATION_PROMPT_FLAGGED, and CLOUD_MODERATION_PROVIDER_UNAVAILABLE each get their own constant string. Renderer ERROR_COPY map (12-10/11) can route by exact match without parsing — matches Phase 11 sentinel style."
  - "portraitUrl derived from `${supabaseUrl}/storage/v1/object/public/portraits/${ownerUuid}/${characterId}.png`, NOT from the caller. T-12-03-01 mitigation: an attacker who can call publishWithModeration (e.g., a compromised renderer) cannot point image moderation at a clean URL while publishing a flagged image — the URL is reconstructed deterministically from the row's owner + id."
  - "buildPortraitUrl is hand-rolled rather than calling supabase-js getPublicUrl. Keeps the orchestrator dependency-injected (no supabase client reference needed). Trade-off: the URL layout is now hard-coded in TWO places (here + cloudCharacterClient.portraitStoragePath) — documented in code that they MUST stay in sync."
  - "SOFT_RETRY_CAP = 2. Total prompt-mod calls = 1 initial + 2 retries = 3. On 3rd consecutive `regenerate` verdict the gate returns PROMPT_FLAGGED rather than looping (Pitfall 6). Test 4 enforces by programming 3 regenerate responses and asserting (a) exactly 3 prompt-mod calls (b) reExpandPersona called exactly 2 times (c) upsertCharacter never called with shared=true."
  - "Provider errors (throw from callEdgeFunction) → CLOUD_MODERATION_PROVIDER_UNAVAILABLE, never silently treated as clean. Pitfall 12 / T-12-07-04. Test 6 enforces. The production callEdgeFunction adapter (in 12-08) MUST throw on `ok:false` so 502 / network errors flow through this function's catch blocks rather than appearing as a clean verdict."
  - "MODERATION_TIMEOUT_MS = 30_000 (vs the 15s default in edgeFunctionClient). SightEngine + OpenAI both ~5–10s typical but the long tail on free-tier provider quotas can hit 20s+. 30s gives headroom without making a hung gate feel locked up to the user."
  - "verdict='block' is terminal (no retry). Only verdict='regenerate' triggers reExpandPersona. Matches 12-04 D-33b: hard-tier flag means the user-authored name+persona_source is the problem and only the user can fix it; soft-tier flag means the LLM expansion drifted and re-expansion can recover."

patterns-established:
  - "Main-process orchestrator that fans out to multiple Edge Functions and returns a tagged-union result. Future moderation surfaces (skin scan in v1.x, audio moderation, etc.) can copy this shape: PublishDeps DI bag + try/catch per step + bounded retry loop where applicable."
  - "Per-task atomic commits within a TDD plan: Task 1 sentinels (feat), Task 2 RED tests (test), Task 3 GREEN impl (feat). Three commits, one plan, gate sequence visible in git log."

requirements-completed: [SHARE-05, SHARE-06, SHARE-07]

# Metrics
duration: ~3min
completed: 2026-05-22
---

# Phase 12 Plan 07: moderationGate publishWithModeration Summary

**Main-process orchestrator wiring the Wave 2 Edge Functions (`moderate-character-images` from 12-03 and `moderate-character-prompt` from 12-04) into a single tagged-union publish flow. Dependency-injected for testability; production callers in Wave 3 (12-08 IPC handler) supply the real Edge Function client + cloud character client + supabase URL. Pitfall 6 retry cap and Pitfall 12 provider-error hard-fail both encoded as TDD invariants.**

## Performance

- **Duration:** ~3 min (190s)
- **Started:** 2026-05-22T08:42:21Z
- **Completed:** 2026-05-22T08:45:31Z
- **Tasks:** 3
- **Files created:** 2
- **Files modified:** 1

## Accomplishments

- Added three new sentinel constants to `src/main/cloud/cloudErrors.ts` matching the existing `CLOUD_*` prefix convention: `CLOUD_MODERATION_IMAGE_FLAGGED`, `CLOUD_MODERATION_PROMPT_FLAGGED`, `CLOUD_MODERATION_PROVIDER_UNAVAILABLE`.
- TDD RED: 8 Vitest tests in `src/main/cloud/moderationGate.test.ts` covering every invariant (orchestration order, server-derived portraitUrl, retry cap, hard-fail on provider error, no-publish on any flag). Tests fail on import because `./moderationGate` does not yet exist.
- TDD GREEN: 301-line `src/main/cloud/moderationGate.ts` ships `publishWithModeration(characterId, deps): Promise<PublishResult>` + `PublishResult` + `PublishDeps` + `ModerationCharacter`. All 8 tests pass; `npx tsc --noEmit` shows no new errors.
- portraitUrl is reconstructed inside the gate from `${supabaseUrl}/storage/v1/object/public/portraits/${ownerUuid}/${characterId}.png` — caller can never supply or override it (T-12-03-01 mitigation).
- `SOFT_RETRY_CAP = 2` enforced in the prompt-moderation loop. 3 consecutive `regenerate` verdicts → `CLOUD_MODERATION_PROMPT_FLAGGED` (Pitfall 6 / T-12-07-02).
- Every `callEdgeFunction` invocation is wrapped in try/catch that returns `CLOUD_MODERATION_PROVIDER_UNAVAILABLE` — provider 502 / network errors / timeouts never reach the upsert step (Pitfall 12 / T-12-07-04).

## Task Commits

Each task was committed atomically:

1. **Task 1: Add three CLOUD_MODERATION_* sentinels to cloudErrors.ts** — `14c5596` (feat)
2. **Task 2: TDD RED — failing moderationGate orchestration tests (8 tests)** — `7e66c68` (test)
3. **Task 3: TDD GREEN — implement publishWithModeration orchestrator** — `7e1035e` (feat)

**Plan metadata commit:** (pending — created after this file lands)

## Files Created/Modified

- **Created** `src/main/cloud/moderationGate.ts` — 301 lines. Exports `publishWithModeration`, `PublishResult`, `PublishDeps`, `ModerationCharacter`. Internal helpers: `buildPortraitUrl`, `providerUnavailable`, `promptFlagged`. Constants: `SOFT_RETRY_CAP=2`, `MODERATION_TIMEOUT_MS=30_000`, `TEXT_PROVIDER_LABEL='openai-omni-moderation-latest'`, three FRIENDLY_* copy strings.
- **Created** `src/main/cloud/moderationGate.test.ts` — 307 lines. 8 Vitest test blocks, dependency-injected via `vi.fn()` stubs and a `programEdge` script helper. Zero external mocks (no `vi.mock` for supabase-js — DI keeps the test surface entirely in-process).
- **Modified** `src/main/cloud/cloudErrors.ts` — appended 20 lines: JSDoc preamble + three new `CLOUD_MODERATION_*` const exports.

## Public Contract — Consumed by 12-08 IPC Handler

**Signature:**
```typescript
publishWithModeration(characterId: string, deps: PublishDeps): Promise<PublishResult>
```

**PublishResult tagged union:**
```typescript
type PublishResult =
  | { ok: true; moderationProvider: string; textProvider: string }
  | {
      ok: false;
      code:
        | 'CLOUD_MODERATION_IMAGE_FLAGGED'
        | 'CLOUD_MODERATION_PROMPT_FLAGGED'
        | 'CLOUD_MODERATION_PROVIDER_UNAVAILABLE';
      friendlyMessage: string;
    };
```

**PublishDeps wiring (production, in 12-08):**

| Field             | Production source                                                                |
| ----------------- | -------------------------------------------------------------------------------- |
| `callEdgeFunction`| Thin adapter around `callEdgeFunction` in `src/main/auth/edgeFunctionClient.ts` that throws on `ok:false` |
| `upsertCharacter` | `upsertCharacter` from `src/main/cloud/cloudCharacterClient.ts`                  |
| `reExpandPersona` | Existing persona-expansion LLM call (Phase 11 `expandAndSaveCharacter`)          |
| `getCharacter`    | Projection over `downloadCharacter` from `src/main/cloud/cloudCharacterClient.ts`|
| `getJwt`          | Main-process auth state `getAccessToken`                                         |
| `supabaseUrl`     | `getSupabaseUrl()` from `src/main/env.ts`                                        |

**Caller pre-conditions (Wave 3 IPC handler MUST satisfy):**
1. Portrait bytes already uploaded to Storage at `portraits/<ownerUuid>/<characterId>.png` via `cloudCharacterClient.uploadPortrait` BEFORE calling `publishWithModeration` (so the derived portraitUrl resolves).
2. The character row already exists in `characters` (since `getCharacter` looks it up). For first-publish, this means the local row was upserted with `shared=false` first.
3. The caller's `callEdgeFunction` adapter MUST throw on the `ok:false` discriminated union — otherwise 502 / network errors leak as a non-throwing falsy verdict and the gate misbehaves.

## reExpandPersona Wiring Note

The plan accepts a `reExpandPersona(characterId): Promise<string>` dep. Two production wiring options:

1. **Real LLM re-expansion (preferred for v1.0).** Production passes a function that:
   - Reads the current row's `persona_source` + the last moderation flag categories (server-side log, not exposed to renderer).
   - Calls the existing persona-expander LLM with mod-steering context ("avoid violence / hate / sexual content").
   - Returns the new expanded string. Does NOT persist on its own — `publishWithModeration` writes the new value via the final upsertCharacter call.
2. **Graceful fallback (if expander not yet wired).** Pass `(characterId) => deps.getCharacter(characterId).then(c => c.persona_expanded)`. The retry will moderate the same text, re-flag, and trip `SOFT_RETRY_CAP` after 2 wasted retries → `CLOUD_MODERATION_PROMPT_FLAGGED`. The user gets a slightly worse error message ("description hits content guidelines") but the gate stays correct.

12-08 will pick one; this plan exposes the seam.

## Decisions Made

See `key-decisions` in frontmatter. The most consequential:

1. **Dependency injection, not module-level imports.** This file has zero production-side `import` statements for collaborators. All I/O goes through `PublishDeps`. Tests can program every external call without `vi.mock` for supabase-js.
2. **Tagged-union return, not exceptions for moderation outcomes.** Moderation flags / provider errors all return a `{ ok: false, code, friendlyMessage }` value. Only `upsertCharacter` and `getCharacter` exceptions bubble (and those carry the existing `CLOUD_SYNC_*` sentinels). The renderer ERROR_COPY map in 12-10/11 routes on `result.code` directly.
3. **portraitUrl is gate-derived.** Reconstructed from the supabase URL + owner + characterId. T-12-03-01 mitigation lives HERE (12-07), as the 12-03-SUMMARY caller invariant section instructed.
4. **SOFT_RETRY_CAP=2 as a top-of-file constant.** Not a magic 2 in the loop — named, with a comment pointing at Pitfall 6 / T-12-07-02. Test 4 enforces by counting prompt-mod calls and `reExpandPersona` invocations.
5. **Provider error catch is unconditional.** Both the image-moderation and prompt-moderation calls are wrapped in `try/catch` with identical `return providerUnavailable()` paths. No surface area for a "silently clean" outcome (Pitfall 12).

## Deviations from Plan

The plan executed essentially as written, with three refinements made during GREEN-phase implementation:

1. **`getCharacter` return type narrowed to `ModerationCharacter` interface (rather than `any`).** The plan's example signature was `getCharacter(characterId: string) => Promise<{ id, owner, name, persona_source, persona_expanded }>`. I added a named exported `ModerationCharacter` interface with an index signature (`[extra: string]: unknown`) so that:
   - Tests can pass a strict literal.
   - Production can pass a full `Character` (which has many more fields) without casting.
   - The upsert payload spread (`...char`) preserves every field on the row.
   No behavior change — this is purely a TypeScript ergonomics improvement.

2. **`reExpandPersona` only called when about to retry.** The plan's pseudocode called `reExpandPersona` inside the loop before the next iteration. My implementation skips the call on the final iteration where the cap is being tripped (`if (attempt === SOFT_RETRY_CAP) return promptFlagged()` runs BEFORE the re-expand). This means `reExpandPersona` is called exactly N-1 times for N prompt-mod calls — saves one wasted LLM expansion when the cap is tripped. Test 4 asserts this precisely (3 prompt-mod calls + 2 reExpandPersona calls).

3. **`buildPortraitUrl` strips trailing slash from `supabaseUrl`.** Defense-in-depth against future callers passing `https://example.supabase.co/` vs `https://example.supabase.co`. The plan's pseudocode used template-literal concatenation directly. No test asserted this edge case, but the helper is cheap and prevents a class of misconfiguration bugs.

None of (1)–(3) is a behavior change relative to the plan's success criteria.

## Issues Encountered

**One project-level note:** `package.json` has no `test` script. The plan's `<verify>` blocks suggested `npm test -- <file>` — I ran tests via `npx vitest run <file>` instead. This is consistent with how other cloud tests in the repo are run (the existing `src/main/cloud/cloudCharacterClient.test.ts` and peers don't reference an `npm test` script either — they're invoked via `npx vitest` or via IDE integrations).

## Caller Invariants — Read by 12-08

1. **portraitUrl is server-derived.** Never plumb a `portraitUrl` through IPC from the renderer.
2. **Pre-upload portrait bytes.** The character row + portrait Storage object must exist before calling `publishWithModeration`.
3. **callEdgeFunction adapter must throw on `ok:false`.** Otherwise 502 / network errors leak as a clean verdict.
4. **Wire `reExpandPersona` deliberately.** Either the real LLM expander (preferred) or the graceful-fallback identity-projection (acceptable; gracefully degrades to PROMPT_FLAGGED after 2 retries).
5. **Renderer ERROR_COPY map (12-10/11) routes by `result.code`.** Never expose `flaggedCategoriesInternal` or raw provider names to the renderer.

## Threat Surface — Re-verify Against 12-07-PLAN `<threat_model>`

Plan listed 5 STRIDE threats (T-12-07-01..05). Implementation status:

| Threat ID  | Disposition | Implemented as                                                                                                                                                |
| ---------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-12-07-01 | mitigate    | `buildPortraitUrl(supabaseUrl, char.owner, characterId)` reconstructs the URL from the row's owner + id. Caller cannot supply it. **Test 8 asserts.**           |
| T-12-07-02 | mitigate    | `SOFT_RETRY_CAP=2` constant + cap-check before `reExpandPersona` call. **Test 4 asserts (3 regenerate verdicts → PROMPT_FLAGGED, never publishes).**          |
| T-12-07-03 | mitigate    | `PublishResult` only carries `code` + `friendlyMessage` (constants). Raw provider responses never reach the renderer.                                          |
| T-12-07-04 | mitigate    | `try/catch` around BOTH `callEdgeFunction` calls returns `providerUnavailable()` — never falls through to upsert. **Test 6 asserts (upsertCharacter never called).** |
| T-12-07-05 | accept      | `reExpandPersona` is a DI seam; jailbreak resistance is owned by whatever LLM call the caller wires in (existing `expandAndSaveCharacter`). No new surface.    |

No new threat surface beyond the plan. No `Threat Flags` section needed.

## Next Phase Readiness

**Wave 3 unblocked:**

- **Plan 12-08** renderer-facing IPC handler `chars:publishWithModeration(uuid)` consumes this module. It needs to:
  1. Build the PublishDeps bag at handler-creation time (wraps `callEdgeFunction`, `upsertCharacter`, persona expander, `downloadCharacter`, `getAccessToken`, `getSupabaseUrl()`).
  2. Validate the renderer can publish (ToS-accepted, signed-in, character not is_default, portrait bytes already uploaded).
  3. Forward the call: `await publishWithModeration(characterId, deps)`.
  4. Return the `PublishResult` to the renderer verbatim.
- **Plan 12-10/11** publish button + error toast — read `result.code` and route through ERROR_COPY map. The three new sentinels need entries:
  - `CLOUD_MODERATION_IMAGE_FLAGGED` → "Image flagged by automated review — please use a different portrait."
  - `CLOUD_MODERATION_PROMPT_FLAGGED` → "We can't publish this character because the persona description hits our content guidelines. Edit the persona and try again, or save it as private."
  - `CLOUD_MODERATION_PROVIDER_UNAVAILABLE` → "Moderation service is temporarily unavailable. Please try again in a few minutes."
  (Wave 3 should use the same `friendlyMessage` strings the gate already provides — the ERROR_COPY map is a defense-in-depth pass-through.)

## TDD Gate Compliance

Gate sequence verified in `git log`:

1. **RED gate** — `7e66c68 test(12-07): add failing moderationGate orchestration tests` (commit BEFORE implementation).
2. **GREEN gate** — `7e1035e feat(12-07): implement moderationGate publishWithModeration orchestrator` (commit AFTER tests, all 8 pass).
3. REFACTOR gate — not needed; the GREEN-phase code already satisfies the plan's clarity bar (named constants, JSDoc, DI seam, internal helpers extracted).

## Self-Check: PASSED

- `src/main/cloud/moderationGate.ts` — FOUND (301 lines)
- `src/main/cloud/moderationGate.test.ts` — FOUND (307 lines)
- `src/main/cloud/cloudErrors.ts` — FOUND (modified)
- `grep -c 'SOFT_RETRY_CAP' src/main/cloud/moderationGate.ts` = 5 (plan asserted ≥ 2)
- `grep -c 'CLOUD_MODERATION_' src/main/cloud/moderationGate.ts` = 13 (plan asserted ≥ 3)
- `grep -c 'CLOUD_MODERATION_IMAGE_FLAGGED\|CLOUD_MODERATION_PROMPT_FLAGGED\|CLOUD_MODERATION_PROVIDER_UNAVAILABLE' src/main/cloud/cloudErrors.ts` = 3 (plan asserted ≥ 3)
- `npx tsc --noEmit` — no new errors
- `npx vitest run src/main/cloud/moderationGate.test.ts` — 8/8 pass
- Commit `14c5596` (Task 1 sentinels) — FOUND in git log
- Commit `7e66c68` (Task 2 RED tests) — FOUND in git log
- Commit `7e1035e` (Task 3 GREEN impl) — FOUND in git log

---
*Phase: 12-character-sharing-ui-moderation*
*Completed: 2026-05-22*
