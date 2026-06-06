---
phase: 13-ai-proxy-billing-usage-ui
plan: 16
subsystem: renderer-credits-store
tags: [renderer, zustand, credits-store, push-seq-race-guard, hardstop, remaining-pct, tdd]

# Dependency graph
requires:
  - phase: 13-ai-proxy-billing-usage-ui
    provides: 13-02 — CreditsStatus + CreditsHardStopEvent types, onCreditsStatusUpdate / onCreditsHardStop push channels, creditsGet IPC, creditsOpenCheckout, subscriptionCancel
  - phase: 13-ai-proxy-billing-usage-ui
    provides: 13-13 — main-process proxyClient that actually populates the IPC return shapes
  - phase: 11-cloud-character-library
    provides: useSyncStore.ts gold-standard template (push-seq race guard, idempotent init)
  - phase: 12-character-sharing-ui-moderation
    provides: useBrowseStore test harness pattern (globalThis.window stub before await import, vi.resetModules between tests)
provides:
  - src/renderer/src/lib/stores/useCreditsStore.ts — single source of truth for the credits UI
  - Push-seq race guard wired against onCreditsStatusUpdate (mirrors useSyncStore.ts:77-91)
  - Explicit hardStopActive semantics (NEVER computed from remaining_pct === 0)
  - PROXY-05 enforcement at the type level — no token/dollar/micro fields in state shape
affects:
  - 13-17-credits-screen
  - 13-18-hard-stop-modal
  - 13-19-pricing-icon
  - 13-20-settings-row

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "useCreditsStore mirrors useSyncStore.ts — interface FooState + FooActions + idempotent init() + push-seq race guard"
    - "Push-seq race guard via in-state counter: subscribe FIRST, capture seqBefore, await seed; skip seed's set() if pushSeq advanced during the await (push state is strictly newer)"
    - "Test harness — stub globalThis.window with mocked sei methods BEFORE await import('./useCreditsStore'); ipcClient.ts reads window.sei at module init so vi.resetModules() between tests is critical"

key-files:
  created:
    - src/renderer/src/lib/stores/useCreditsStore.ts
    - src/renderer/src/lib/stores/useCreditsStore.test.ts
  modified: []

key-decisions:
  - "13-16: pushSeq lives IN STATE (per plan's <implementation> block) rather than as a closure variable like useSyncStore.ts. Behavioral semantics are identical — the verifier grep `grep -c pushSeq >= 3` enforces this choice. In-state form makes the race-guard visible to any future debugger that inspects the zustand state object."
  - "13-16: acknowledgeHardStop() clears LOCAL UI state only — server is never touched. The next proxied call will either succeed (push fires with restored balance) or re-trigger the hard-stop push. This explicit semantics matters: a stale local clear cannot mask a real server-side depletion."
  - "13-16: hardStopActive set EXCLUSIVELY by onCreditsHardStop push — never derived from `remaining_pct === 0` in render or store. Defense-in-depth against a stale-but-zero seed spuriously triggering the modal (T-13-16-03 mitigation)."
  - "13-16: rateLimitedUntil is a ms-epoch only; the banner component owns the 1Hz `setInterval` for the countdown. Store does NOT hold the countdown value (would trigger 1Hz re-renders across every consumer of the store — T-13-16-04 disposition)."
  - "13-16: State shape has NO token / dollar / micro fields — PROXY-05 bright-line enforced at the type level. Test 11 asserts every state key has none of those substrings, so a future refactor that adds e.g. `tokens_remaining` fails loud at the test boundary."
  - "13-16: init() catch block marks `initialized = true` on transient IPC failure rather than leaving the store in a perpetual 'pending boot' state. Prevents a busy-retry loop; next push or manual refresh re-populates."
  - "13-16: reset() invokes BOTH unsubscribe handles before clearing state — important so a push that arrives after the user signs out doesn't re-populate the cleared store."

patterns-established:
  - "Phase 13 renderer store pattern — mirror useSyncStore template exactly; subscribe-before-seed race guard is non-negotiable"
  - "PROXY-05 type-level enforcement — banned-field-name vitest assertion (Test 11) lands in the test file rather than in a lint rule, so the constraint travels with the store"
  - "Explicit hard-stop semantics — never compute hardStopActive from remaining_pct; only set on push"

requirements-completed: [PROXY-05, PROXY-10]

# Metrics
duration: 3min
completed: 2026-05-22
---

# Phase 13 Plan 16: useCreditsStore (renderer-side credits state) Summary

**Renderer-side zustand store backing the credits UI; mirrors `useSyncStore.ts` gold-standard template with idempotent init + push-seq race guard (subscribe-before-seed); PROXY-05 enforced at the type level (no token/dollar/micro fields); hardStopActive set ONLY by explicit `onCreditsHardStop` push.**

## Performance

- **Duration:** ~3 min
- **Started:** 2026-05-23T05:16:21Z
- **Completed:** 2026-05-23T05:18:48Z
- **Tasks:** 2 (RED + GREEN — TDD-mode plan)
- **Files created:** 2
- **Files modified:** 0

## Accomplishments

- Created `src/renderer/src/lib/stores/useCreditsStore.test.ts` (313 lines, 12 vitest cases) covering all 10 plan-mandated behaviors plus 2 extras (rate-limited-until ms-epoch math, PROXY-05 type-level banned-field assertion). Test harness mirrors `useBrowseStore.test.ts` from Phase 12-09: stub `globalThis.window` with mocked `sei` methods before `await import('./useCreditsStore')`, `vi.resetModules()` between tests.
- Created `src/renderer/src/lib/stores/useCreditsStore.ts` (208 lines) with:
  - **State shape** (PROXY-05 compliant): `remaining_pct`, `plan`, `renews_at`, `trial_claimed`, `ai_backend_kind`, `hardStopActive`, `hardStopReason`, `rateLimitedUntil`, `initialized`, `loading`, `pushSeq`, `unsubStatus?`, `unsubHardStop?`. ZERO token/dollar/micro fields.
  - **Idempotent init()** — first-line `if (get().initialized) return` short-circuit; subscribes to `sei.onCreditsStatusUpdate` AND `sei.onCreditsHardStop` BEFORE awaiting the initial `sei.creditsGet()` seed (push-seq race guard mirrors `useSyncStore.ts:77-91`).
  - **Race guard via in-state `pushSeq`:** the push handler increments `pushSeq`; the seed captures the pre-await value and skips its `set()` if `pushSeq` advanced during the await (push state is strictly newer by definition).
  - **Hard-stop push handler:** sets `hardStopActive: true`, `hardStopReason: info.reason`, and (for `rate_limited` only) computes `rateLimitedUntil = Date.now() + retry_after_seconds * 1000`.
  - **`acknowledgeHardStop()`** — clears `hardStopActive` + `hardStopReason` locally; does NOT call the server (verified by Test 7 snapshotting all server-touching mock call-counts before/after).
  - **`refresh()`, `openCheckout(kind)`, `cancelSubscription()`** — thin IPC fan-out.
  - **`reset()`** — invokes both unsubscribe handles BEFORE clearing state so a push arriving after sign-out can't re-populate the cleared store.
- Verified the plan's 4 verification gates: 12 tests pass (≥10 required), `grep -c "pushSeq" useCreditsStore.ts = 7` (≥3 required), `grep -c "hardStopActive" useCreditsStore.ts = 5` (≥2 required), banned-field-name grep empty (no `token_count` / `tokens` / `dollars`).

## Task Commits

This is a `type: tdd` plan; the whole plan is one feature with RED + GREEN gates:

1. **RED — failing tests** — `35caedc` (test): 12 vitest cases, all 12 fail because `useCreditsStore.ts` does not yet exist (`Cannot find module './useCreditsStore'`).
2. **GREEN — implementation** — `89326f8` (feat): zustand store with push-seq race guard; 12/12 pass in 110ms.
3. **REFACTOR** — skipped per execution_flow guidance ("commit only if changes"). Implementation matched the plan's `<implementation>` block exactly + the gold-standard `useSyncStore.ts` template; nothing to clean up.

## Files Created/Modified

- `src/renderer/src/lib/stores/useCreditsStore.ts` (created, 208 lines) — zustand store; mirrors `useSyncStore.ts` shape; PROXY-05 enforced at type level (state shape has no token/dollar/micro fields); idempotent `init()`; push-seq race guard.
- `src/renderer/src/lib/stores/useCreditsStore.test.ts` (created, 313 lines) — vitest suite; 12 cases; mocks `window.sei.{creditsGet, creditsOpenCheckout, subscriptionCancel, onCreditsStatusUpdate, onCreditsHardStop}` before `await import('./useCreditsStore')`.

## Decisions Made

- **`pushSeq` lives in state, not in a closure variable:** The gold-standard `useSyncStore.ts` uses a closure-local `let pushSeq = 0`. The plan's `<implementation>` block specifies in-state `pushSeq`, and the verifier grep `grep -c "pushSeq" >= 3` enforces this. In-state form makes the race-guard counter visible to any future debugger that inspects the zustand state object (e.g. zustand devtools). Behavioral semantics are identical to the closure form: pre-await capture + post-await comparison decides whether the seed wins.
- **`acknowledgeHardStop()` is purely local:** The action clears `hardStopActive` + `hardStopReason` in the store and does NOT call the server. Rationale: server is the authority on balance / rate-bucket state; the next proxied call will either succeed (push fires with restored balance) or re-trigger the hard-stop push. A local clear that mutated the server would risk masking a real depletion. Test 7 verifies this by snapshotting `creditsGetMock`, `creditsOpenCheckoutMock`, `subscriptionCancelMock` call-counts before/after `acknowledgeHardStop()`.
- **`hardStopActive` set ONLY by push:** Never derived from `remaining_pct === 0` in render or in the store. Defense in depth against a stale-but-zero seed triggering the modal during the boot window (the seed could land BEFORE the proxy's first push for the user's actual balance). T-13-16-03 mitigation.
- **`rateLimitedUntil` is a ms-epoch, not a countdown value:** The banner component (Phase 13 Plan 18 future) will own its own `setInterval(1000)` and compute `until - Date.now()` each tick. Holding the countdown value itself in the store would trigger a 1Hz `set()` that re-renders every consumer of the store. T-13-16-04 accepted disposition.
- **`init()` catch block marks `initialized = true`:** On transient `creditsGet` rejection, the store flips `initialized` and `loading` but leaves the field values at defaults. Prevents a busy-retry loop; the next push (or a manual `refresh()`) re-populates. Mirrors `useSyncStore.ts:92-95` behavior.
- **`reset()` unsubscribes first, then clears state:** A push that arrives between "clear state" and "unsubscribe" would re-populate the cleared store with stale data. Unsubscribing first eliminates the race.

## Deviations from Plan

None — plan executed exactly as written. The plan's `<implementation>` block was followed closely with three minor refinements (none changing behavior or contract):

1. **Import-style refinement:** Used `import { sei } from '../ipcClient'` (the project's typed wrapper around `window.sei`) rather than the plan's literal `window.sei.*` access. The `ipcClient` re-export is the single substitution point used by every other renderer store (`useSyncStore`, `useBrowseStore`, `useCloudCharactersStore`); inconsistent here would break the project convention. Tests still mock at the `window.sei` boundary (because `ipcClient` reads `window.sei` at module init), so the test harness works identically.
2. **JSDoc enriched:** Added inline JSDoc enumerating the PROXY-05 / T-13-16-03 / T-13-16-04 invariants directly above the relevant fields/actions, so future readers don't have to cross-reference the plan to understand why `hardStopActive` is push-only or why `rateLimitedUntil` is an epoch.
3. **`refresh()` catch swallows errors:** The plan's `<implementation>` block did not show a catch on `refresh()`; added one mirroring `useSyncStore.refresh()` (silently swallow — the next push or manual retry re-populates). Defensive-only; no behavior change in the happy path.

**Total deviations:** 0 auto-fixed bugs / 0 blocking issues / 0 architectural changes. Three within-discretion refinements documented above (none affect behavior or contract).

## Issues Encountered

- Two unrelated files showed up as modified in the worktree during execution (`src/renderer/src/App.tsx`, `src/renderer/src/components/IconRail.tsx`) and one untracked (`.mcp.json`). All three are out of scope per SCOPE BOUNDARY — pre-existing changes from parallel agents on adjacent Wave 4 plans. Not touched by this plan.

## Threat Surface Scan

No new threat surface beyond what the plan's `<threat_model>` covers. All five declared mitigations honoured:

- **T-13-16-01 (Tampering, push race overwrites seed with stale data):** `pushSeq` race guard mirrors `useSyncStore.ts:77-91` verbatim — pre-await capture + post-await comparison + skip-set when push won. Test 3 verifies: push arriving during the await with `remaining_pct: 42` wins over the seed's `remaining_pct: 80`.
- **T-13-16-02 (Information Disclosure, token counts leak to renderer):** State shape contains zero token/dollar/micro fields — PROXY-05 enforced at the type level. Test 11 asserts every state key has none of those substrings.
- **T-13-16-03 (Tampering, hard-stop computed from remaining_pct triggers spurious modal):** `hardStopActive` set ONLY by `onCreditsHardStop` push handler; the only writes are from the push handler and `acknowledgeHardStop()` (which writes `false`, never `true`). No code path derives `hardStopActive` from `remaining_pct`.
- **T-13-16-04 (DoS, rateLimitedUntil setInterval drives 1Hz re-render):** Store holds the epoch ms only; banner component (future 13-18) owns its setInterval. Accepted disposition.
- **T-13-16-05 (Information Disclosure, subscription RLS leak):** Out of scope at the renderer — RLS is enforced on the server-side `subscription_status` table (13-01). proxyClient (13-13) is the trust boundary; this store consumes pre-RLS-scoped responses.

## User Setup Required

None — pure renderer code; no external service configuration.

## Next Phase Readiness

- **13-17 CreditsScreen** can now consume `useCreditsStore` selectors: `remaining_pct`, `plan`, `renews_at`, `trial_claimed`, `ai_backend_kind`, `hardStopActive`. Calls `init()` from a `useEffect([])` on mount (idempotent — multiple mounts safe).
- **13-18 HardStopModal** subscribes to `hardStopActive` + `hardStopReason` + `rateLimitedUntil`; calls `acknowledgeHardStop()` on dismiss and `openCheckout(kind)` on the Top-up / Subscribe buttons.
- **13-19 PricingIcon** reads `remaining_pct` only — the % bar in the icon rail.
- **13-20 Settings row** reads `ai_backend_kind` for the BYOK toggle and `subscriptionStatus()` (via direct IPC, not the store) for the renews_at / ends_at copy.
- **App.tsx boot:** wire `useCreditsStore.getState().init()` inside the existing `useEffect` that gates on `ai_backend_kind === 'cloud-proxy'`. The store has no other consumers until 13-17 lands.

## Self-Check: PASSED

- File `src/renderer/src/lib/stores/useCreditsStore.ts` FOUND (created)
- File `src/renderer/src/lib/stores/useCreditsStore.test.ts` FOUND (created)
- Commit `35caedc` FOUND (RED — failing tests)
- Commit `89326f8` FOUND (GREEN — implementation)
- `npx vitest run src/renderer/src/lib/stores/useCreditsStore.test.ts` → 12/12 passed in 110ms
- `grep -c "pushSeq" src/renderer/src/lib/stores/useCreditsStore.ts` = 7 (≥3 ✓)
- `grep -c "hardStopActive" src/renderer/src/lib/stores/useCreditsStore.ts` = 5 (≥2 ✓)
- `grep -nE "token_count|tokens|dollars" src/renderer/src/lib/stores/useCreditsStore.ts` → no matches (PROXY-05 ✓)
- `npx tsc --noEmit -p tsconfig.web.json` clean (no errors)

---
*Phase: 13-ai-proxy-billing-usage-ui*
*Completed: 2026-05-22*
