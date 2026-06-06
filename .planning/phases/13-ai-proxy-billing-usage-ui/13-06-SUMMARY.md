---
phase: 13-ai-proxy-billing-usage-ui
plan: 06
subsystem: proxy-ledger
tags: [proxy, ledger, settle, refund, cache-savings, idempotent, bigint, supabase-rpc, tdd]

# Dependency graph
requires:
  - phase: 13-ai-proxy-billing-usage-ui
    plan: 01
    provides: settle_consumption RPC + ledger_consumption table + reservation_state state machine
  - phase: 13-ai-proxy-billing-usage-ui
    plan: 03
    provides: proxy/ Hono shell + env.ts singleton + tsconfig + vitest harness
  - phase: 13-ai-proxy-billing-usage-ui
    plan: 05
    provides: (canonical) proxy/src/supabase.ts getAdminClient singleton + proxy/src/anthropic/pricing.ts computeMicroDollarCost
provides:
  - proxy/src/ledger/settle.ts — three public functions (settle, settleAsRefunded, settleAtReservation)
  - proxy/src/ledger/settle.test.ts — 10 Vitest cases (5 settle, 2 settleAsRefunded, 3 settleAtReservation)
  - proxy/src/anthropic/pricing.ts — Rule 3 forward-compatible stand-in matching 13-05 spec verbatim
affects: [13-08, 13-10]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Three settlement modes parallel three Anthropic upstream outcomes (success / 429 / truncated stream) — caller chooses, settle.ts never decides"
    - "BigInt → numeric text via .toString() for Postgres bigint RPC params (T-13-05-05 mitigation)"
    - "Idempotency via WHERE reservation_state='reserved' predicate — both RPC and direct UPDATE paths"
    - "Re-throw RPC/UPDATE errors so the caller (13-08 forward.ts) logs server-side; never fail the user-facing streamed response"

key-files:
  created:
    - proxy/src/ledger/settle.ts
    - proxy/src/ledger/settle.test.ts
    - proxy/src/anthropic/pricing.ts
  modified: []

key-decisions:
  - "Three public functions, not one — caller in 13-08 selects which to invoke based on observed upstream outcome. settle.ts never decides whether to refund."
  - "settleAtReservation does NOT touch the micro column on the UPDATE — preserves the original reservation amount as the consumed cost. Per PATTERNS pitfall #5 v1.0 chooses the safer variant (settle at reservation) over zero-refund on truncated streams."
  - "Direct table UPDATE for refunded + at-reservation paths instead of extending the settle_consumption RPC with a refund flag — simpler, same idempotency guarantee, no migration churn."
  - "Pricing.ts created here as a Rule 3 forward-compatible stand-in because 13-05 had only landed RED tests at execution time. File matches 13-05-PLAN.md verbatim so the parallel agent's GREEN commit will be a no-op merge."

patterns-established:
  - "Three-function settlement layer: normal RPC path + refund-on-failure + settle-at-reservation-on-truncation. Each is idempotent in isolation."
  - "BigInt-end-to-end through the proxy ledger: computeMicroDollarCost returns bigint, .toString() at the supabase-js boundary, Postgres bigint accepts numeric text losslessly."
  - "Vitest mock chain pattern for supabase-js .from().update().eq().eq() — buildChain() helper that resets per-test."

requirements-completed: [PROXY-09]

# Metrics
duration: 3min
completed: 2026-05-22
---

# Phase 13 Plan 06: Settle + SettleAsRefunded + SettleAtReservation Summary

**Post-call settlement layer for the Phase 13 proxy ledger — three public functions parallel three Anthropic upstream outcomes (success / 429 / truncated stream), each idempotent via `reservation_state='reserved'` predicates, BigInt micro-dollar math end-to-end with `.toString()` at the Postgres boundary.**

## Performance

- **Duration:** ~3 min
- **Started:** 2026-05-22T21:19:31Z
- **Completed:** 2026-05-22T21:22:24Z
- **Tasks:** 2 (TDD RED + GREEN)
- **Files created:** 3 (settle.ts, settle.test.ts, pricing.ts forward-compat stand-in)
- **Files modified:** 0

## Accomplishments

- **`settle()`** — normal post-call path. Computes actual µ$ via `computeMicroDollarCost(usage, model)` (13-05 contract) and calls the 13-01 `settle_consumption` RPC. The RPC's `LEAST(micro, p_actual_micro)` clamp realizes the cache-savings refund (D-43) implicitly in the next `ledger_balance` read. Idempotent via the RPC's `WHERE reservation_state='reserved'` predicate (second call affects 0 rows but does not error).
- **`settleAsRefunded()`** — upstream returned 429 (D-44) or stream aborted before any usage observed. Direct `UPDATE ledger_consumption SET reservation_state='refunded', micro=0 WHERE id=? AND reservation_state='reserved'`. Idempotent.
- **`settleAtReservation()`** — stream closed without a final `message_delta` usage event (PATTERNS pitfall #5). Direct `UPDATE` flips `reservation_state='settled'` and writes the `anthropic_call_id`, but does NOT touch the `micro` column — so the original reservation amount is preserved as the consumed cost. v1.0 chooses this safer variant over zero-refund (truncated streams still consumed upstream inference budget).
- **BigInt end-to-end.** `computeMicroDollarCost` returns `bigint`; `.toString()` at the supabase-js boundary preserves precision losslessly (Postgres `bigint` accepts numeric text — T-13-05-05 mitigation).
- **All three functions re-throw** supabase errors so the caller in 13-08 `forward.ts` logs server-side without failing the user-facing streamed response (bytes already went out).
- **10/10 Vitest tests pass.** TS clean across both `tsconfig.json` (production) and the implicit test config.

## Task Commits

1. **Task 1 (RED): Failing settle tests** — `b11323e` (test)
2. **Task 2 (GREEN): Implement settle.ts + forward-compat pricing.ts** — `a53e4ea` (feat)

**Plan metadata commit:** to follow (final commit includes SUMMARY.md + STATE.md + ROADMAP.md + REQUIREMENTS.md).

## Files Created/Modified

- `proxy/src/ledger/settle.test.ts` (222 lines, 10 Vitest cases across 3 describe blocks)
  - 5 `settle()` cases: cost math (1500 µ$ for 1000 in/100 out), cache-hit refund delta (5500 µ$ for 50K cache_read), zero-usage defensive default, idempotent re-settle, RPC error rejection.
  - 2 `settleAsRefunded()` cases: direct UPDATE with `state='refunded'` + `micro=0` + reserved predicate, error path rejection.
  - 3 `settleAtReservation()` cases: state='settled' WITHOUT touching `micro`, null anthropic_call_id accepted, error path rejection.
  - Mocks `@supabase/supabase-js` via `vi.mock` with shared `rpcMock` / `updateMock` / `eqMock` / `fromMock` and a `buildChain(error)` helper that reconstructs the `.from().update().eq().eq()` final resolution per-test.
- `proxy/src/ledger/settle.ts` (88 lines, three exported functions). Imports `getAdminClient` from `../supabase.js` (13-07's seam, ahead of 13-05) and `computeMicroDollarCost, type Usage` from `../anthropic/pricing.js`.
- `proxy/src/anthropic/pricing.ts` (49 lines, forward-compatible stand-in matching 13-05-PLAN.md verbatim). Exports `Usage` type, `PRICING` const, `computeMicroDollarCost`, and `estimateReservationMicro`.

## Decisions Made

- **Three functions, not one.** The caller in 13-08 `forward.ts` is the only site that knows which Anthropic outcome occurred (200 OK with usage, 429, or truncated stream). settle.ts surfaces all three modes; caller picks. No "smart" dispatcher.
- **`settleAtReservation` leaves `micro` untouched.** The plan body's recommendation is to settle at the reservation amount (no refund) when the stream closes without a usage event. The cleanest implementation is to omit `micro` from the UPDATE payload — Postgres preserves the existing value. The settle.test.ts case explicitly asserts `payload` does NOT contain `micro`.
- **Direct table UPDATE for refund / at-reservation paths.** Plan body offers two options: extend the SQL RPC with a refund flag, or use supabase-js `.from().update().eq()` directly. Chose the latter — simpler, same idempotency guarantee via the `.eq('reservation_state', 'reserved')` predicate, no migration churn during Phase 13 execution.
- **`pricing.ts` forward-compatible stand-in.** 13-05 had committed only its RED tests (`f916f12`) but no GREEN impl when 13-06 executed. settle.ts needs `computeMicroDollarCost` to compile. Per orchestrator instruction ("create a minimal Supabase client wrapper for your needs — the parallel agent's version will merge cleanly"), I extended the same logic to pricing.ts: created the file matching 13-05-PLAN.md §implementation verbatim. When 13-05's GREEN commit lands, the merge will be a no-op (identical content).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Created `proxy/src/anthropic/pricing.ts` ahead of 13-05's GREEN landing**
- **Found during:** GREEN phase — settle.ts imports `computeMicroDollarCost` from `../anthropic/pricing.js`, but 13-05 had only landed RED tests at commit `f916f12`.
- **Issue:** Cannot complete the GREEN phase without the pricing import.
- **Fix:** Created `proxy/src/anthropic/pricing.ts` with the exact spec from 13-05-PLAN.md §implementation — `Usage` type, `PRICING` const, `computeMicroDollarCost`, and `estimateReservationMicro`. 13-05's GREEN commit (when it lands) will recreate the same file with identical content; the merge will be a no-op or trivial.
- **Files modified:** `proxy/src/anthropic/pricing.ts` (created)
- **Verification:** All 10 settle tests pass; `npx tsc --noEmit -p tsconfig.json` clean.
- **Committed in:** `a53e4ea` (Task 2 GREEN commit)
- **Precedent:** 13-07 (`629faf1`) applied the same Rule 3 pattern for `proxy/src/supabase.ts` ahead of 13-05's landing — both files share the "matches 13-05-PLAN.md verbatim → forward-compatible merge" property.

---

**Total deviations:** 1 auto-fixed (1 blocking — parallel-execution ordering).
**Impact on plan:** Zero scope creep. The created file is exactly what 13-05 would produce.

## Issues Encountered

None within scope. The two parallel-plan test files in proxy that fail under `npx vitest run` (`preDeduct.test.ts` for 13-05, `buckets.test.ts` for 13-07) are RED-phase failures for sibling plans and out of scope per SCOPE BOUNDARY.

## Verification

| Check | Expected | Actual |
|------|----------|--------|
| Vitest cases for settle.ts | ≥ 6 | 10 |
| `grep -c "rpc('settle_consumption'" settle.ts` | == 1 | 1 |
| `grep -c "settleAsRefunded\|settleAtReservation" settle.ts` | ≥ 2 | 4 |
| `grep -c "reservation_state.*reserved" settle.ts` | ≥ 2 | 6 |
| All settle tests green | yes | 10/10 pass |
| `npx tsc --noEmit -p tsconfig.json` | clean | clean |

## TDD Gate Compliance

- **RED gate:** `b11323e` (`test(13-06): add failing RED tests ...`) — 10 tests fail with module-not-found before GREEN.
- **GREEN gate:** `a53e4ea` (`feat(13-06): implement settle + settleAsRefunded + settleAtReservation`) — same 10 tests pass.
- **REFACTOR gate:** not needed; implementation matches plan §implementation verbatim, no cleanup pass required.

## Self-Check: PASSED

- File `proxy/src/ledger/settle.ts` exists (FOUND, 88 lines).
- File `proxy/src/ledger/settle.test.ts` exists (FOUND, 222 lines).
- File `proxy/src/anthropic/pricing.ts` exists (FOUND, 49 lines).
- Commit `b11323e` exists on this branch (FOUND).
- Commit `a53e4ea` exists on this branch (FOUND).

## User Setup Required

None. The migration (13-01) has already defined the `settle_consumption` RPC + `ledger_consumption` table; settle.ts is purely application code against that surface.

## Next Phase Readiness

- **13-08 (forward.ts)** unblocked — the three settlement entry points are stable. `forward.ts` picks one per upstream outcome:
  - 200 OK with `message_delta.usage` event → `settle(reservationId, usage, model, anthropic_call_id)`.
  - Upstream 429 (D-44) → `settleAsRefunded(reservationId)`.
  - Stream closes without `message_delta` (PATTERNS pitfall #5) → `settleAtReservation(reservationId, last_known_call_id_or_null)`.
- **13-10 (app wiring)** unblocked at the settlement seam — the three functions are pure async with no shared mutable state; routing logic in 13-08 + 13-10 can call them concurrently across parallel inference requests without coordination.
- **13-05 (preDeduct/pricing/balance) when it lands:** the forward-compatible `proxy/src/anthropic/pricing.ts` written here is bit-identical to 13-05's spec. The rebase / merge will be a no-op or a trivial conflict resolution.

---
*Phase: 13-ai-proxy-billing-usage-ui*
*Completed: 2026-05-22*
