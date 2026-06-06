---
quick_id: 260524-0ka
phase: 13
type: verify
mode: quick-full
verified: 2026-05-24T07:56:14Z
status: passed
score: 14/14 must-haves verified
overrides_applied: 0
gates:
  deno_lemon_webhook: pass (33/33)
  vitest_proxy_and_playtime: pass (42/42)
  tsc_main: pass (clean)
  tsc_web: pass (clean)
  grep_forbidden_patterns: pass (0 hits for "total / 1440|input_tokens|output_tokens")
  grep_isSubscriptionFirstInvoice_count: pass (4 hits, >= 2 required)
  audit_sql_select_only: pass (0 uncommented write statements)
  user_bug_calculation: pass ($23.25 balance → 127.20h via 11_625_000 tokens / 1523 tok/min / 60)
---

# Quick Task 260524-0ka Verification Report

**Goal:** Fix 3 billing-correctness defects from 260523-t8d UAT:
(A) lemon-webhook duplicate grants on subscription signup,
(B) playtime estimator broken column query + anti-conservative formula,
(C) ledger_balance view NULL handling.

**Verified:** 2026-05-24T07:56:14Z
**Status:** passed
**Score:** 14/14 must-haves verified

---

## 14-truth verification matrix

| #   | Truth                                                                                   | Status  | Evidence (file:line / grep / test)                                                                                                                                                                  |
| --- | --------------------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | `case 'subscription_created':` is status-only — NO ledger_grants insert                 | ✓ PASS  | `supabase/functions/lemon-webhook/index.ts:346-364` — case body upserts `subscription_status` only; no `from('ledger_grants').insert` in this case block. Deno test `'A4 (4) subscription_created alone → 0 grants'` passes. |
| A2  | `case 'subscription_payment_success':` is single source of truth for sub grant          | ✓ PASS  | `supabase/functions/lemon-webhook/index.ts:366-387` — inserts `ledger_grants` (kind='subscription', `SUBSCRIPTION_CREDITS_MICRO`) AND upserts `subscription_status`. Deno tests `'A4 (1)'` + `'A4 (3) recurring renewal → two sub grants'` pass. |
| A3  | `isSubscriptionFirstInvoice(payload)` exists; `order_created` skips grant when true     | ✓ PASS  | `supabase/functions/lemon-webhook/index.ts:269-287` defines two-tier helper (Tier 1: `first_order_item.subscription_id != null`; Tier 2: `first_order_item.variant_id === LEMON_VARIANT_SUBSCRIPTION` env). Gate fires at `index.ts:328-334`. `grep -c isSubscriptionFirstInvoice` = 4 (≥2 required). Per LEMON-WEBHOOK-DIAGNOSIS.md §2 the field is `first_order_item.subscription_id` (NOT `first_subscription_item` as plan hypothesised). |
| A4  | 4 regression tests covering Party 3-event, Quest 1-event, sub_created alone, sub_payment alone | ✓ PASS  | `supabase/functions/lemon-webhook/index.test.ts:538, 612, 641, 685` — 4 `Deno.test` blocks tagged `260524-0ka A4 (1)..(4)`. All 33/33 pass via `deno test --allow-env --allow-net --no-check`. Includes the requested Party 3-event → exactly 1 grant, Quest one-time → 1 grant, sub_created alone → 0 grants, sub_payment alone → 1 grant. |
| A5  | `audit_lemon_double_grants.sql` SELECT-only audit identifying 5-min clustered grants    | ✓ PASS  | `.planning/quick/260524-0ka-…/audit_lemon_double_grants.sql:42-73` — CTE `grant_pairs` joins ledger_grants on 5-min window, GROUP BY user_id. `grep -iE 'delete \|update \|truncate '` filtered to uncommented lines returns **0 hits** (all DELETE templates and write statements are commented). |
| B1  | `proxyClient.creditsGet` uses `.select('micro,deducted_at')` from ledger_consumption    | ✓ PASS  | `src/main/cloud/proxyClient.ts:265-268` — `.select('micro,deducted_at').eq('reservation_state', 'settled').gte('deducted_at', since24hIso)`. `grep "input_tokens\|output_tokens" src/main/cloud/proxyClient.ts` returns **0 hits**. |
| B2  | New formula `avg_tokens_per_request × PEAK_CALLS × 60 + STARTUP × SESSIONS`; no /1440  | ✓ PASS  | `src/main/cloud/proxyClient.ts:360-363` — `const tokensPerHour = avgTokensPerRequest * PEAK_CALLS_PER_MIN_MAIN * 60 + STARTUP_TOKENS_MAIN * SESSIONS_PER_HOUR_MAIN; tokensPerMin = Math.ceil(tokensPerHour / 60);`. `grep "total / 1440" src/main/cloud/proxyClient.ts` returns **0 hits**. |
| B3  | `MIN_SIGNAL_ROWS = 20` gate enforced before trusting average                            | ✓ PASS  | `src/main/cloud/proxyClient.ts:334` (`const MIN_SIGNAL_ROWS = 20;`) + `:345` (`if (consumptionRows.length >= MIN_SIGNAL_ROWS)`). Vitest case `'tokens_per_min undefined when consumption row count < MIN_SIGNAL_ROWS (19 rows)'` passes. |
| B4  | `DEFAULT_TOKENS_PER_MIN = 1523` with updated JSDoc derivation                           | ✓ PASS  | `src/renderer/src/lib/playtimeEstimate.ts:23, 31, 40, 75` — `PEAK_CALLS_PER_MIN=10`, `STARTUP_TOKENS=1400`, `SESSIONS_PER_HOUR=1`, `DEFAULT_TOKENS_PER_MIN=1523`. JSDoc at lines 57-58 carries derivation. 1523-vs-1524 one-token offset noted in `deferred-items.md §3` (cosmetic, B5 test tolerates ±1). |
| B5  | Integration test seeds 20 mock rows and asserts new formula result                      | ✓ PASS  | `src/main/cloud/proxyClient.test.ts:434` — `describe('260524-0ka tokens_per_min new model (B5)')` 4 it-cases including: 20 rows micro=300 → exactly 1524; 19 rows → undefined; query error → undefined + console.warn; AVG-not-SUM invariant pinned. All pass under vitest 42/42. |
| B6  | Comments document WHY /1440 was anti-conservative in both files                         | ✓ PASS  | `src/main/cloud/proxyClient.ts:301` (`anti-conservative (more usage → lower per-min → longer displayed`) + `src/renderer/src/lib/playtimeEstimate.ts:49` (`anti-conservative: more usage produced…`). Both files contain `"anti-conservative"`. |
| C1  | `LEDGER-BALANCE-DIAGNOSIS.md` exists with Verdict naming root cause                    | ✓ PASS  | `.planning/quick/260524-0ka-…/LEDGER-BALANCE-DIAGNOSIS.md:6` (`Verdict: Branch B (doc-only contract)`) and `:107` (`Branch B — doc-only contract. NO migration required.`). Root cause identified: MCP/psql `auth.role()` returns `'postgres'` not `'service_role'`, so view WHERE filter excludes all rows. |
| C2  | EITHER migration OR doc-comment at `.from('ledger_balance')` call site (XOR)            | ✓ PASS  | `src/main/cloud/proxyClient.ts:221-238` — doc-block tagged `260524-0ka C2 contract` documents both NULL cases (i: no grants yet → 0 via inner coalesce; ii: no auth.users row → NULL → `?? 0`). XOR satisfied: `git log fe80c20..HEAD -- supabase/migrations/` returns **0 commits** (no migration added). |
| C3  | 3 vitest creditsGet cases: zero grants, grants no consumption, mid-reservation          | ✓ PASS  | `src/main/cloud/proxyClient.test.ts:517` — `describe('260524-0ka C3 — creditsGet shape for ledger_balance edge cases')` covers all 3 states without throw. All pass under vitest 42/42. |

---

## Cross-verification — original user bug doesn't regress

### 1. Party 3-event signup now produces exactly 1 grant (not 3)

Verified via Deno test `'260524-0ka A4 (1)'` (lemon-webhook/index.test.ts:538). The
test feeds the exact sequence `order_created → subscription_created →
subscription_payment_success` for the same `user_id`. Assertion: EXACTLY ONE
grant insert (the $18.50 `subscription` from `payment_success`) + 2 status
upserts. Test passes. The `order_created` is skipped via
`isSubscriptionFirstInvoice` (Tier 1 → `first_order_item.subscription_id`
non-null). The `subscription_created` case body has no `ledger_grants.insert`
(A1). Old joint case-fallthrough is gone.

### 2. $23.25 balance → ~127h playtime under new formula

Manual math via node REPL with the deployed constants
(MICRO_PER_TOKEN_BLENDED=2, DEFAULT_TOKENS_PER_MIN=1523):

```
balance_micro = 23_250_000n
tokens        = 23_250_000n / 2n = 11_625_000
minutes       = floor(11_625_000 / 1523) = 7632
hours         = 7632 / 60 = 127.20
```

Matches the pre-execution expected ~127h within rounding. The +1
cosmetic offset (1523 vs derivation 1524) only shifts displayed
playtime by 0.07% (deferred-items.md §3).

---

## Gate results

| Gate                                                                              | Result               |
| --------------------------------------------------------------------------------- | -------------------- |
| `deno test supabase/functions/lemon-webhook/ --allow-env --allow-net --no-check`  | ✓ 33/33 pass         |
| `npx vitest run src/main/cloud/proxyClient.test.ts src/renderer/src/lib/playtimeEstimate.test.ts` | ✓ 42/42 pass |
| `npx tsc --noEmit -p tsconfig.json`                                               | ✓ clean              |
| `npx tsc --noEmit -p tsconfig.web.json`                                           | ✓ clean              |
| `grep -n "total / 1440\|input_tokens\|output_tokens" src/main/cloud/proxyClient.ts` | ✓ 0 hits           |
| `grep -c "isSubscriptionFirstInvoice" supabase/functions/lemon-webhook/index.ts`  | ✓ 4 (≥ 2 required)   |
| Audit SQL has no uncommented DELETE/UPDATE/TRUNCATE                               | ✓ 0 write statements |

---

## Behavioral spot-checks (Level 4 — data flow trace)

| Behavior                                                                          | Command / Test                                                       | Result | Status |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------ | ------ |
| Party purchase 3-event sequence → exactly 1 grant                                | Deno test A4 (1)                                                     | pass   | ✓ PASS |
| Quest one-time order → exactly 1 pack grant                                      | Deno test A4 (2)                                                     | pass   | ✓ PASS |
| subscription_created alone → 0 grants                                             | Deno test A4 (4)                                                     | pass   | ✓ PASS |
| subscription_payment_success x2 different eventIds → 2 sub grants                | Deno test A4 (3)                                                     | pass   | ✓ PASS |
| 20 mock rows micro=300 → tokens_per_min = 1524 (exact ceil)                      | Vitest B5 case 1                                                     | pass   | ✓ PASS |
| 19 rows below threshold → tokens_per_min undefined                               | Vitest B5 case 2                                                     | pass   | ✓ PASS |
| ledger_balance NULL → creditsGet returns plan='depleted' with no throw           | Vitest C3 case 1                                                     | pass   | ✓ PASS |
| mid-reservation balance → remaining_tokens correctly subtracted                  | Vitest C3 case 3                                                     | pass   | ✓ PASS |
| $23.25 balance × 1523 tok/min → 127.20h                                          | node REPL math                                                        | 127.20 | ✓ PASS |

---

## Anti-patterns scan

None blocking. The 1523-vs-1524 cosmetic offset and the portraitStore.test.ts
ENOTEMPTY flake are pre-existing/non-blocking and logged in `deferred-items.md`.
The constants mirror in proxyClient.ts (PEAK_CALLS_PER_MIN_MAIN etc.) is
deliberate (main process cannot import from `src/renderer/`) and acknowledged
in code comments — the B5 vitest invariant catches any drift since both files
run in the same vitest suite.

---

## Deferred items (documented in deferred-items.md, not actionable here)

1. **portraitStore.test.ts ENOTEMPTY flake** — pre-existing, passes in isolation, unrelated to 260524-0ka files.
2. **Deno-format webhook tests under vitest** — `Cannot find package 'jsr:@std/assert@1'` is the wrong-runner mismatch, not a logic regression. Runs cleanly under `deno test`.
3. **1523 vs 1524 cosmetic offset in DEFAULT_TOKENS_PER_MIN** — 0.07% display difference; either fix (bump to 1524) or update JSDoc (change ceil → floor) when convenient.

---

## Conclusion

**Status: passed.** All 14 must-haves verified with code evidence. All
four gates green. Original user bug ($46.50 credited on $18.50 of revenue)
will not regress: the Party 3-event sequence now produces exactly 1 grant
of $18.50, and the playtime estimator now displays ~127h for a $23.25
balance under the new under-promise formula.

**Ship recommendation:** deploy the webhook fix immediately. Every Party
purchase that fires against the un-fixed code path generates a $23.25
over-credit that requires manual operator refund. The audit SQL is ready
to surface any new clustered grants post-deploy for ≥7 days of monitoring.

---

_Verified: 2026-05-24T07:56:14Z_
_Verifier: Claude (gsd-verifier)_
