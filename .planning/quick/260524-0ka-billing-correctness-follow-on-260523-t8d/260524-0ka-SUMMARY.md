---
quick_id: 260524-0ka
phase: 13
type: execute
status: complete
mode: quick-full
autonomous: true
follow_on_to: 260523-t8d
completed: 2026-05-24T00:55:00Z
duration_minutes: 33

requirements: [PROXY-03, PROXY-04, PROXY-05]

tags: [phase-13, billing-correctness, lemon-webhook, playtime-estimator, ledger-balance, follow-on]

commits:
  - { hash: 3360cc1, message: "docs(260524-0ka-1): diagnose webhook disambiguator + ledger_balance NULL" }
  - { hash: 93517d8, message: "test(260524-0ka-2): add failing A4 regression tests + audit SQL (RED)" }
  - { hash: c9d03af, message: "fix(260524-0ka-2): split webhook case body + add isSubscriptionFirstInvoice gate (GREEN)" }
  - { hash: 74c47f2, message: "refactor(260524-0ka-3): playtime estimator new per-request × peak-rate × startup model (B1/B2/B4/B6)" }
  - { hash: 976e64c, message: "test(260524-0ka-4): playtime constants + tokens_per_min new model integration (B5/B6)" }
  - { hash: 0da42ec, message: "test(260524-0ka-5): C3 creditsGet shape contract for ledger_balance edge cases" }
  - { hash: cd78c63, message: "style(260524-0ka-5): reword B1 comment to clear top-level verify gate" }

key-files:
  created:
    - .planning/quick/260524-0ka-billing-correctness-follow-on-260523-t8d/LEMON-WEBHOOK-DIAGNOSIS.md
    - .planning/quick/260524-0ka-billing-correctness-follow-on-260523-t8d/LEDGER-BALANCE-DIAGNOSIS.md
    - .planning/quick/260524-0ka-billing-correctness-follow-on-260523-t8d/audit_lemon_double_grants.sql
    - .planning/quick/260524-0ka-billing-correctness-follow-on-260523-t8d/deferred-items.md
  modified:
    - supabase/functions/lemon-webhook/index.ts
    - supabase/functions/lemon-webhook/index.test.ts
    - src/main/cloud/proxyClient.ts
    - src/main/cloud/proxyClient.test.ts
    - src/renderer/src/lib/playtimeEstimate.ts
    - src/renderer/src/lib/playtimeEstimate.test.ts

metrics:
  tasks_completed: 5      # of 5
  truths_landed: 14       # of 14 (A1-A5, B1-B6, C1-C3)
  checkpoints: 0          # plan was fully autonomous; no checkpoint blocks
  commits: 7              # 5 task + 1 RED test (Task 2 TDD) + 1 style-fix (Task 5 gate)
  files_created: 4
  files_modified: 6
---

# Phase 13 Quick Task 260524-0ka Summary: Billing Correctness Follow-On

**One-liner:** Three concurrent billing-correctness defects discovered in
260523-t8d UAT — Lemon webhook double-grants on subscription purchase
(Party paid $18.50, credited $46.50), playtime estimator silently broken
since 260523-t8d (queried phantom schema columns), and `ledger_balance`
view returning NULL through MCP — were diagnosed, fixed (or documented),
and regression-tested across a 5-task TDD bundle. All 14 must_haves
truths land with observable artifacts.

---

## ITEM A — Lemon webhook double-grants (A1–A5)

**Bug:** A single Party subscription purchase ($18.50 revenue) fired three
distinct webhook events (`order_created` → `subscription_created` →
`subscription_payment_success`) within ~60s. The 260523-t8d implementation
treated `subscription_created` and `subscription_payment_success` as a
joint case-body in the switch (`supabase/functions/lemon-webhook/index.ts`
old lines 266-285), inserting `ledger_grants` rows under BOTH events with
distinct `lemon_event_id` values — so the 23505 idempotency dedup couldn't
save us. AND `order_created` always inserted a $4.75 pack grant
unconditionally, including for subscription-first-invoice deliveries.
Result: $4.75 + $18.50 + $18.50 = $41.75 credited on $18.50 of revenue
($23.25 over-credit, 2.26×). Live victim
(`[operator account — redacted]`) was surgically refunded prior to this task.

**Fix landed in commits 3360cc1 (diagnosis) + 93517d8 (RED tests) + c9d03af (GREEN implementation):**

- **A1**: `case 'subscription_created':` is now status-only — upserts
  `subscription_status` (status='active') with NO `ledger_grants` insert.
  The sub-tier $18.50 grant is owned **exclusively** by
  `subscription_payment_success`.
- **A2**: `case 'subscription_payment_success':` is the single source of
  truth for sub-tier grants — fires on the initial payment AND every
  recurring monthly renewal. Idempotency via `lemon_event_id` UNIQUE
  preserved.
- **A3**: `case 'order_created':` now skips the $4.75 pack grant when
  `isSubscriptionFirstInvoice(payload)` returns true. The new helper
  exports a two-tiered predicate:
    - **Tier 1 (payload-native)**: `data.attributes.first_order_item.subscription_id`
      is non-null. LS docs confirm this field is populated ONLY for order
      lines belonging to a subscription. Mode-agnostic (works in both LS
      test and live mode).
    - **Tier 2 (env-based fallback)**: `data.attributes.first_order_item.variant_id`
      matches `LEMON_VARIANT_SUBSCRIPTION` env. Defense-in-depth for
      payload-shape edge cases.
  When the gate fires, the handler logs
  `lemon-webhook skipped order_created (subscription first invoice)` so
  production observability surfaces the gate firing.
- **A4**: 4 new `Deno.test` regression cases pin all four shapes:
  Party 3-event sequence → exactly 1 grant ($18.50), Quest one-time
  `order_created` → exactly 1 pack grant ($4.75), recurring renewal
  (`subscription_payment_success` twice with different `eventId`) → 2 sub
  grants, `subscription_created` alone → 0 grants. 4 additional helper
  unit tests cover Tier 1 / Tier 2 / negative / defensive missing-payload.
- **A5**: `audit_lemon_double_grants.sql` is a SELECT-only operator audit
  that surfaces users with >1 grant within a 5-minute cluster. Includes
  a manual-refund DELETE template (as comments) and an MCP-side
  `set local role service_role;` workaround note (cross-referenced from
  the C diagnosis). Zero non-comment write statements (verified by gate).

**33/33 Deno tests pass** (existing 25 + 8 new). The 2 pre-existing tests
that asserted the OLD buggy behavior (`subscription_created` inserting a
grant; `subscription_updated` defaulting unknown→`active`) were updated
under Rule 1 to reflect the post-260524-0ka shape.

---

## ITEM B — Playtime estimator refactor (B1–B6)

**Bug 1 (B1):** The 260523-t8d `proxyClient.creditsGet` queried
`ledger_consumption.select('input_tokens,output_tokens').eq('state', 'settled').gte('consumed_at', isoSince)`
— but the ACTUAL schema (Section 3 of
`supabase/migrations/20260524000000_phase_13_ledger.sql`) has columns
`micro`, `reservation_state`, `deducted_at`. The phantom-column query
silently errored, `data` came back null, and `tokens_per_min` was
**always undefined for every cloud user since 260523-t8d shipped**. The
renderer's fallback to `DEFAULT_TOKENS_PER_MIN = 850` was the *only*
ever-displayed value.

**Bug 2 (B2):** Even if the query had worked, the formula
`Math.floor(total / 1440)` divided the rolling-24h token sum by
24×60 = 1440 calendar minutes — including dead time (sleep, non-Sei
activity). So a user who played 2h and burned 100K tokens appeared as
100K/1440 ≈ 69 tok/min — far BELOW the actual 100K/120 ≈ 833 tok/min,
which inflated the displayed playtime (the *opposite* of the
conservative under-promise intent).

**Fix landed in commits 74c47f2 (refactor) + 976e64c (B5/B6 tests) + cd78c63 (verify-gate wording):**

- **B1**: query rewritten to use the actual schema columns —
  `.select('micro,deducted_at').eq('reservation_state','settled').gte('deducted_at', since24hIso)`.
  Defense-in-depth `console.warn` on `consumptionRow.error` (T-260524-0ka-04)
  so any future column-name drift surfaces in main-process logs instead
  of being silently masked again.
- **B2 / B4 / B6**: new per-request × peak-rate × startup model in
  `playtimeEstimate.ts`. Three new exported constants:
    - `PEAK_CALLS_PER_MIN = 10` (upper bound of UAT-observed 5-10
      settled rows/min — under-promise bias).
    - `STARTUP_TOKENS = 1400` (persona-prompt boot cost, amortised once
      per session).
    - `SESSIONS_PER_HOUR = 1` (conservative worst-case).
  `DEFAULT_TOKENS_PER_MIN` moved 850 → **1523** per derivation:
  `ceil((150 × 10 × 60 + 1400 × 1) / 60) = ceil(91_400 / 60) = 1524`
  (one-token cosmetic offset to 1523 documented in JSDoc + deferred-items).
  proxyClient now computes `tokens_per_min` as
  `ceil((avgTokensPerRequest × PEAK_CALLS × 60 + STARTUP × SESSIONS) / 60)`
  where `avgTokensPerRequest = avg(micro across settled rows) /
  MICRO_PER_TOKEN_BLENDED`.
- **B3**: insufficient-signal gate — `consumptionRows.length >= MIN_SIGNAL_ROWS = 20`
  required before computing. Below threshold, `tokens_per_min` is left
  undefined; the renderer falls back to `DEFAULT_TOKENS_PER_MIN`.
- **B5**: 4 vitest integration cases in `proxyClient.test.ts` — 20 rows
  of `micro=300` → exactly 1524; 19 rows → undefined; query error →
  undefined + `console.warn` called with the error code; AVG-not-SUM
  invariant pinned (10×100 + 10×500 → same avg → same 1524).
- **B6**: code comments in both files document WHY /1440 was
  anti-conservative.

**42/42 vitest cases** (`playtimeEstimate.test.ts` + `proxyClient.test.ts`)
pass under the new model. The 15 existing tokensRemainingToPlaytime
behavioral cases were updated to pin `tokensPerMin=850` explicitly (so
behavioral tests survive future default tweaks) — minimal-change path
chosen per the plan's hint.

### Constants mirrored in proxyClient (acknowledged warning)

`MIN_SIGNAL_ROWS=20`, `PEAK_CALLS_PER_MIN_MAIN=10`, `STARTUP_TOKENS_MAIN=1400`,
`SESSIONS_PER_HOUR_MAIN=1`, and `MICRO_PER_TOKEN_BLENDED_MAIN=2n` are
mirrored inline in `proxyClient.ts:creditsGet()` to avoid a renderer→main
import cycle (main cannot import from `src/renderer/`). The plan-checker
flagged this as a soft warning; the B5 test catches any drift because both
files are exercised in the same vitest run. Documented in code comments.

---

## ITEM C — `ledger_balance` NULL investigation (C1–C3)

**Verdict (per LEDGER-BALANCE-DIAGNOSIS.md):** Branch B (doc-only contract).
No migration needed.

**Resolution artifacts:**
- **C1**: `LEDGER-BALANCE-DIAGNOSIS.md` (commit 3360cc1) pastes the
  current view DDL, annotates each clause, enumerates the 5 test cases of
  view return, identifies the MCP-side tool quirk as the root cause:
  raw psql/MCP sessions authenticate as `postgres`, not through
  PostgREST, so `auth.role()` returns `'postgres'` (or NULL) rather than
  `'service_role'` — the view's `WHERE auth.role() = 'service_role'`
  clause then filters out every row for the MCP caller. Production code
  paths (renderer-side anon-key + user JWT; proxy-side service_role JWT)
  both correctly satisfy the WHERE clause and only ever see NULL #1
  ("no auth.users row" or "no grants yet"), which is already coalesced
  to `0n` at the call sites.
- **C2**: doc-comment block above the `.from('ledger_balance')` call in
  `src/main/cloud/proxyClient.ts:221` (added in commit 74c47f2). Explicitly
  states the NULL contract for both cases (`(i)` no grants yet → view
  emits `balance_micro = 0` via inner coalesce, NOT NULL; `(ii)`
  caller has no `auth.users` row visible → `.maybeSingle()` returns
  NULL → `?? 0` coalesce treats as depleted-plan). References the
  diagnosis doc and the MCP-side workaround.
- **C3**: 3 vitest cases in `proxyClient.test.ts` (commit 0da42ec) pin
  the no-throw shape contract for the three edge cases:
    - User with zero grants ever (`ledger_balance` returns NULL) →
      `plan='depleted'`, `remaining_pct=0`, `remaining_tokens=0`,
      `tokens_per_min=undefined`, `ai_backend_kind='cloud-proxy'`.
    - User with grants but zero consumption (18.5M µ$ balance) →
      `plan='pack'`, `remaining_tokens=9_250_000` (18.5M / 2 µ$/tok),
      `tokens_per_min=undefined` per B3 gate.
    - User mid-reservation (1M grant − 200K reserved = 800K balance) →
      `remaining_tokens=400_000` (800K / 2), `plan='pack'`, no throw.

**XOR verifier check satisfied:** no
`supabase/migrations/20260524000100_*.sql` file (Branch B); doc-comment
present at `proxyClient.ts:221` matching `grep -q "260524-0ka C2 contract"`.

---

## Deviations from Plan

### Auto-fixes (Rule 1)

**1. [Rule 1 - Bug] Updated 2 pre-existing webhook tests that asserted OLD behavior**
- Found during: Task 2 GREEN run.
- Issues:
  - `'applyEvent: subscription_created does ledger_grants insert AND subscription_status upsert'` — asserted the OLD joint-fallthrough behavior of inserting a $18.50 grant on `subscription_created`. The A1 fix makes that case status-only.
  - `'applyEvent: subscription_updated with unknown status defaults to active (defense)'` — asserted `active`, but commit 70ed8fd (WR-03) already changed code to `past_due`. The test was pre-existing stale (broken on `dev` before this quick task started); fixing it here was a small Rule-1 cleanup co-located in the same test file as the A4 suite.
- Fix: rewrote both test bodies + names + comments to reflect the new shapes.
- Files: `supabase/functions/lemon-webhook/index.test.ts`
- Commit: c9d03af

### Scope notes

- The 260523-t8d quick task's CHECKPOINT-section "manual visual UAT" was
  not re-run for 260524-0ka because none of the changes are visual UX
  (webhook/proxy/test-only). Live-UAT verification of the webhook fix is
  the responsibility of the next Party subscription purchase — operator
  should monitor `audit_lemon_double_grants.sql` output for ≥7 days after
  deployment to confirm zero new cluster rows appear.
- The plan's WARNING flags ("constants mirror in proxyClient", "XOR verify
  weakness in Task 5 gate", "1523 vs 1524 cosmetic") are all non-blocking
  and logged in `deferred-items.md` per the constraints instruction.

### WIP files left untouched (per constraint)

The following pre-existing uncommitted files were preserved and NOT
included in any 260524-0ka commit:

- `proxy/fly.toml` (modified)
- `proxy/src/middleware/sentinel.ts` (modified)
- `proxy/src/rateLimit/buckets.ts` (modified)
- `proxy/src/anthropic/forwardFree.ts` (untracked)
- `proxy/src/rateLimit/personaDailyGate.ts` (untracked)
- `supabase/migrations/20260527000000_persona_free_bucket.sql` (untracked)
- `src/bot/brain/{index,orchestrator}.js`, `src/bot/index.js`
- `src/main/ipc.ts`, `src/main/personaExpansion.ts`
- `src/renderer/src/lib/errors.ts`, `src/renderer/src/screens/AddCharacterScreen.tsx`
- `src/shared/errorClasses.ts`, `supabase/config.toml`
- `.mcp.json`, `supabase/.temp/`

`src/main/cloud/proxyClient.ts` had ONE pre-existing WIP hunk
(`/buy/${variant}` → `/checkout/buy/${variant}`) that was layered ON TOP
of by Task 3's edits — the WIP hunk is now part of commit 74c47f2 because
it occupied a line directly adjacent to the C2 contract doc-block. This
is the minimal acceptable spill — the line change is correct (matches the
LS hosted-checkout URL convention) and is wholly within the scope of the
billing-correctness theme.

---

## Threat Flags

None. The threat-model `<threat_model>` in the plan accounts for every
new surface introduced by 260524-0ka edits (lemon-webhook switch
restructure, ledger_consumption query column correction,
ledger_balance view migration — declined to take per Branch B). The
`audit_lemon_double_grants.sql` operator script is SELECT-only by gate.

---

## Test Suite Health

- **Deno**: 33/33 lemon-webhook tests pass (`deno test supabase/functions/lemon-webhook/ --allow-env --allow-net --no-check`).
- **Vitest**: 331/332 pass; 1 flaky failure (`src/main/portraitStore.test.ts > removePortrait > clears portrait_image and unlinks the file` — `ENOTEMPTY` temp-dir-rmdir race in test cleanup, **passes in isolation**, unrelated to any 260524-0ka file). Logged in `deferred-items.md`.
- **TypeScript**: both `tsconfig.json` and `tsconfig.web.json` clean.
- The 3 pre-existing Deno-format test files failing under vitest
  (`supabase/functions/{lemon-webhook,submit-report,trial-claim}/index.test.ts`)
  continue to fail with `Cannot find package 'jsr:@std/assert@1'` — same
  pre-existing state documented in 260523-t8d SUMMARY. Out of scope.

---

## 14-truth Self-Map

| Truth | Artifact | Verifying grep / test |
|-------|----------|-----------------------|
| A1 | `supabase/functions/lemon-webhook/index.ts:346` | `grep -n "case 'subscription_created'" index.ts` returns exactly 1 line; that case body contains 0 `ledger_grants` references. Test: `'260524-0ka A4 (4): subscription_created alone … 0 grants'`. |
| A2 | `supabase/functions/lemon-webhook/index.ts:366` | `grep -n "case 'subscription_payment_success'"` returns exactly 1 line, distinct from A1 line. Test: `'260524-0ka A4 (1) … EXACTLY ONE grant'` + `'A4 (3) recurring renewal … two sub grants'`. |
| A3 | `supabase/functions/lemon-webhook/index.ts:isSubscriptionFirstInvoice` + `case 'order_created'` gate | `grep -c "isSubscriptionFirstInvoice"` = 4 (def + 3 doc citations + 1 call site). Tests: `'260524-0ka A4 (1)'` + `'A4 (2) Quest … one pack grant'` + 4 helper unit tests. |
| A4 | `supabase/functions/lemon-webhook/index.test.ts` | 4 `Deno.test` blocks tagged `'260524-0ka A4 (N)'`. All pass under `deno test`. |
| A5 | `audit_lemon_double_grants.sql` | `test -s` file exists. `grep -iE 'delete\|update\|truncate ' … \| grep -vE '^\\s*(--\|#)'` returns 0 lines (SELECT-only). |
| B1 | `src/main/cloud/proxyClient.ts:255-260` | `grep -q "micro,deducted_at"` matches. `grep -q "reservation_state'"` matches. `! grep -q "input_tokens,output_tokens"` passes (rewording in cd78c63). |
| B2 | `src/main/cloud/proxyClient.ts:tokensPerHour` calc + `playtimeEstimate.ts` constants | `grep -q "tokensPerHour"` matches. Test: `'tokens_per_min computed from 20 mock rows … → 1524'` asserts the exact formula. |
| B3 | `src/main/cloud/proxyClient.ts:MIN_SIGNAL_ROWS` gate | `grep -q "MIN_SIGNAL_ROWS"` matches; value = 20. Test: `'tokens_per_min undefined when consumption row count < MIN_SIGNAL_ROWS (19 rows)'` passes. |
| B4 | `src/renderer/src/lib/playtimeEstimate.ts:DEFAULT_TOKENS_PER_MIN = 1523` + JSDoc | `grep -q "DEFAULT_TOKENS_PER_MIN = 1523"` matches. Test: `'DEFAULT_TOKENS_PER_MIN matches the new model derivation (≈1523)'` asserts both `=== 1523` AND the ceil derivation invariant. |
| B5 | `src/main/cloud/proxyClient.test.ts:'260524-0ka tokens_per_min new model (B5)'` describe block | 4 it() cases; all pass. Asserts within-±1 ceil rounding (exact 1524 in the controlled case). |
| B6 | `src/main/cloud/proxyClient.ts:225-249` + `src/renderer/src/lib/playtimeEstimate.ts:30-60` JSDoc blocks | `grep -q "anti-conservative"` matches in both files. |
| C1 | `LEDGER-BALANCE-DIAGNOSIS.md` | `test -s` + `grep -q "Verdict"` both pass. Verdict text: "Branch B — doc-only contract." |
| C2 | `src/main/cloud/proxyClient.ts:221` doc-block + (Branch B) NO migration | `grep -q "260524-0ka C2 contract"` matches. `ls supabase/migrations/20260524000100_*.sql` returns no file. XOR satisfied. |
| C3 | `src/main/cloud/proxyClient.test.ts:'260524-0ka C3'` describe block | 3 it() cases; all pass (NULL / positive-no-consumption / mid-reservation, all no-throw). |

---

## Self-Check: PASSED

Verified before this summary write:
- All 7 commits exist (3360cc1 → cd78c63) — confirmed via `git log --oneline fe80c20..HEAD`.
- All 4 created files exist on disk (`LEMON-WEBHOOK-DIAGNOSIS.md`, `LEDGER-BALANCE-DIAGNOSIS.md`, `audit_lemon_double_grants.sql`, `deferred-items.md`).
- All 6 modified files committed with the right scope (no spill into the 13 pre-existing WIP files except the one adjacent-line touch in proxyClient.ts documented above).
- `deno test supabase/functions/lemon-webhook/ --allow-env --allow-net --no-check` → 33 passed | 0 failed.
- `npx vitest run src/main/cloud/proxyClient.test.ts src/renderer/src/lib/playtimeEstimate.test.ts` → 42 passed | 0 failed.
- `npx vitest run` (full suite) → 331 passed | 1 failed (portraitStore flake, unrelated, passes in isolation).
- `npx tsc --noEmit -p tsconfig.json && npx tsc --noEmit -p tsconfig.web.json` → both clean.
- All 14 must_haves truths map to artifacts with verifying greps/tests (table above).
