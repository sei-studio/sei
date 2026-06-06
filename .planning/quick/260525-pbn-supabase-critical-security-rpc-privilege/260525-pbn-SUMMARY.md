---
phase: quick-260525-pbn
plan: 01
subsystem: supabase-security
tags:
  - security
  - supabase
  - rls
  - rpc
  - privilege-escalation
  - timing-attack
  - storage
  - moderation
dependency_graph:
  requires:
    - supabase/migrations/20260524000000_phase_13_ledger.sql
    - supabase/migrations/20260524000100_rate_buckets_rpc.sql
    - supabase/migrations/20260525000000_ledger_balance_restrict.sql
    - supabase/migrations/20260526000000_phase_13_hardening.sql
    - supabase/migrations/20260521000100_storage_buckets.sql
    - supabase/migrations/20260521000000_characters_tos.sql
    - supabase/migrations/20260521000300_deletion_queue_user_insert.sql
    - supabase/migrations/20260523000000_moderation_and_reports.sql
  provides:
    - "public.my_grants view (security_invoker; safe column subset of ledger_grants)"
    - "public.my_subscription view (security_invoker; safe column subset of subscription_status)"
    - "RPC privilege-escalation guards on reserve_credits/settle_consumption/check_and_increment_bucket"
    - "tg_set_updated_at search_path pinned (pg_catalog, public)"
    - "deletion_queue WITH CHECK validating storage_paths jsonb entry ownership"
    - "Defense-in-depth REVOKE INSERT/UPDATE/DELETE on ledger tables for authenticated+anon"
    - "Drop of skins_public_read + portraits_public_read storage SELECT policies (H7)"
    - "Fully idempotent reconciliation of 20260523000000 schema (H6)"
    - "supabase/functions/_shared/timingSafe.ts (timingSafeEqual helper)"
    - "notify-report bearer comparison via timingSafeEqual"
  affects:
    - src/main/cloud/proxyClient.ts (reads via my_subscription)
    - supabase/functions/lemon-webhook/index.ts (re-imports timingSafeEqual from _shared)
    - supabase/functions/notify-report/index.ts (uses timingSafeEqual for bearer compare)
    - src/main/cloud/proxyClient.test.ts (mock dispatch recognizes my_subscription)
tech_stack:
  added:
    - "PostgreSQL security_invoker views (Supabase view with (security_invoker = true))"
    - "Postgres jsonb_array_elements_text + split_part RLS WITH CHECK fold"
    - "Postgres ALTER FUNCTION ... SET search_path (function-attribute hardening)"
  patterns:
    - "SECURITY DEFINER RPC privilege-escalation guard: p_user_id IS DISTINCT FROM auth.uid() + auth.role() <> 'service_role' → RAISE 42501"
    - "Column-restricted view + drop-base-table-SELECT-policy pattern to gate PII columns"
    - "Idempotent reconciliation migration: catalog-guarded constraints + create-or-replace functions + drop-recreate triggers"
    - "Constant-time bearer comparison: shared _shared/timingSafe.ts + re-export-for-back-compat from lemon-webhook"
key_files:
  created:
    - supabase/migrations/20260528000000_security_definer_guards.sql
    - supabase/migrations/20260528000100_drop_storage_listing.sql
    - supabase/migrations/20260528000200_user_read_views.sql
    - supabase/migrations/20260528000300_reconcile_moderation_and_reports.sql
    - supabase/functions/_shared/timingSafe.ts
  modified:
    - supabase/functions/lemon-webhook/index.ts
    - supabase/functions/notify-report/index.ts
    - src/main/cloud/proxyClient.ts
    - src/main/cloud/proxyClient.test.ts
decisions:
  - "my_subscription view exposes {status, renews_at, ends_at} — NOT the cluster description's example {status, tier, current_period_end} (codebase schema has no `tier` or `current_period_end` columns; renderer consumers `proxyClient.subscriptionStatus()` and `creditsGet()` read renews_at + ends_at — both kept; the Lemon Squeezy subscription PK and updated_at are excluded)"
  - "Strategy B (drop broad SELECT + create security_invoker view) chosen over Strategy A (column-level REVOKE + re-GRANT) — Strategy B fails-safe on future column additions, whereas Strategy A would silently leak a new column"
  - "Storage public-bucket fast-path retained — direct GETs to /storage/v1/object/public/<bucket>/<path> continue to work without any SELECT policy (Supabase public-bucket fast-path bypasses RLS for the public route); only LIST enumeration is removed"
  - "settle_consumption REVOKE issued for symmetry with reserve_credits + check_and_increment_bucket (it has no p_user_id parameter so no guard is needed, but the explicit REVOKE matches the defense-in-depth posture)"
  - "tg_set_updated_at hardened via ALTER FUNCTION (no CREATE OR REPLACE) — preserves the existing body byte-for-byte while pinning search_path"
  - "No @ts-expect-error comments needed in proxyClient.ts — src/main/auth/supabaseClient.ts:73 invokes createClient without a <Database> generic, so supabase-js types unknown table names as `any`; tsc --noEmit clean"
  - "Task 4 split into TWO commits (8c180e4 code + cb65188 test-mock fix) instead of one — the test-mock update arose from a regression that surfaced only when vitest ran post-commit; created as a separate commit per the policy against amending previous commits"
metrics:
  duration: "~25 minutes"
  completed: "2026-05-25"
  commits: 7
  tasks: 6
  files_created: 5
  files_modified: 4
  audit_findings_closed: 8
---

# Phase quick-260525-pbn Plan 01: Supabase Critical Security + RPC Privilege Summary

Closes 8 Supabase security audit findings in a single ship: privilege-escalation guards on SECURITY DEFINER RPCs (C1), public storage listing enumeration (H7), column-restricted user-read views to stop Lemon Squeezy PK leakage (H8), idempotent reconciliation of the moderation_and_reports schema drift (H6), trigger search_path hardening (M1), constant-time bearer comparison in notify-report (M2), deletion_queue cross-user path injection guard (M3), and defense-in-depth REVOKEs on ledger tables (M8). Four new migrations (timestamps 20260528000000–20260528000300), one new shared helper, two Edge Function patches, one renderer-side cloud client patch + matching test-mock update.

## Commit Trail

| # | Task | Commit | Audit findings closed | Files |
|---|------|--------|-----------------------|-------|
| 1 | Migration — SECURITY DEFINER guards + tg_set_updated_at search_path + deletion_queue WITH CHECK + ledger REVOKEs | `616cf31` | C1, M1, M3, M8 | supabase/migrations/20260528000000_security_definer_guards.sql |
| 2 | Migration — Drop public storage SELECT listing policies | `314310b` | H7 | supabase/migrations/20260528000100_drop_storage_listing.sql |
| 3 | Migration — Column-restricted my_grants + my_subscription views | `7af7f5a` | H8 (schema side) | supabase/migrations/20260528000200_user_read_views.sql |
| 4a | Code — Switch proxyClient.ts to my_subscription view | `8c180e4` | H8 (client side) | src/main/cloud/proxyClient.ts |
| 4b | Test-mock — Recognize my_subscription in proxyClient.test.ts dispatch | `cb65188` | H8 (test follow-up) | src/main/cloud/proxyClient.test.ts |
| 5 | Migration — Idempotent reconciliation of moderation_and_reports | `c4ff8d1` | H6 | supabase/migrations/20260528000300_reconcile_moderation_and_reports.sql |
| 6 | Code — Extract _shared/timingSafe.ts + apply to notify-report | `5bb860e` | M2 | supabase/functions/_shared/timingSafe.ts, supabase/functions/lemon-webhook/index.ts, supabase/functions/notify-report/index.ts |

Commits 4a + 4b cover the single Task 4 scope; the split is documented under "Deviations" below.

## my_subscription Column-Set Rationale

The cluster description listed `{status, tier, current_period_end}` as the example exposed column set for `my_subscription`. The actual `subscription_status` schema (defined in `20260524000000_phase_13_ledger.sql` §5) has six columns and NO `tier` or `current_period_end`:

```
subscription_status:
  - user_id                (uuid PK, filtered out — security_invoker view scopes via auth.uid())
  - status                 (text — KEEP)
  - lemon_subscription_id  (text — EXCLUDE: H8 PII, Lemon Squeezy subscription primary key)
  - renews_at              (timestamptz — KEEP)
  - ends_at                (timestamptz — KEEP)
  - updated_at             (timestamptz — EXCLUDE: operational metadata)
```

Renderer-side consumers (`src/main/cloud/proxyClient.ts` `creditsGet` and `subscriptionStatus`) read `{status, renews_at, ends_at}` — exactly the safe subset chosen. The Lemon Squeezy subscription identifier was previously reachable via `from('subscription_status')` under the broad `subscription_status_select_own` SELECT policy; both that policy and the equivalent `ledger_grants_select_own` (which exposed the Lemon Squeezy event identifier) were dropped in commit 7af7f5a, forcing all renderer-side reads through the new views.

## TypeScript Generic Check

`src/main/auth/supabaseClient.ts:73` invokes `createClient(getSupabaseUrl(), getSupabaseAnonKey(), { auth: { … } })` WITHOUT a `<Database>` generic parameter. Consequently supabase-js infers `any` for unknown table names, so `supabase.from('my_subscription')` type-checks cleanly without `@ts-expect-error` comments. `npx tsc --noEmit` returns clean output across the entire repo.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 — Bug] Updated proxyClient.test.ts mock dispatch to recognize 'my_subscription'**
- **Found during:** Final regression check (`npx vitest run`) after Task 6 commit
- **Issue:** Task 4's view rename in `proxyClient.ts` (`from('subscription_status')` → `from('my_subscription')`) broke three vitest cases in `src/main/cloud/proxyClient.test.ts` because the hand-rolled mock SupabaseClient dispatches on table name and the unrenamed dispatch returned `{ data: null }` for the new view.
- **Fix:** Replaced the dispatch line `if (table === 'subscription_status')` with `if (table === 'my_subscription')` and added a comment explaining the H8 view substitution. Also updated the file's top-of-file JSDoc to reference `my_subscription` instead of `subscription_status`.
- **Files modified:** `src/main/cloud/proxyClient.test.ts`
- **Commit:** `cb65188`
- **Verification:** `npx vitest run src/main/cloud/proxyClient.test.ts` → 25/25 pass.

### Atomic-commit Split (Task 4)

Task 4 generated TWO commits (`8c180e4` code change + `cb65188` test-mock fix) instead of one. The plan envisioned a single Task 4 commit covering proxyClient.ts only, but the regression surfaced only when vitest ran POST-Task-6 (the plan instructed "Do NOT run npm test or tsc here — TypeScript will not see the new view tables until typegen is regenerated" — that guidance applied to TypeScript, not vitest). Per the policy against amending previous commits, a separate fixup commit was the right call. The fixup commit's subject line still uses the `260525-pbn-4` task tag for traceability.

### No Other Deviations

All other tasks executed exactly as the plan specified. No architectural changes were required.

## Verification Out-of-Band (Operator Runbook)

Per cluster constraints, NO `supabase db push`, `supabase migration up`, or `supabase functions deploy` was executed. The operator should:

1. Run `supabase db diff` against staging to confirm the four migrations apply cleanly in sequence.
2. Apply via `supabase db push` to staging.
3. Run `supabase db lint` — H7/H8/M1 advisor warnings should be gone; triage any new advisors.
4. Smoke-test from a renderer build pointed at staging:
   - `creditsGet()` returns balance + plan correctly (validates `my_subscription` wiring).
   - `subscriptionStatus()` returns the same shape as before (validates the `{status, renews_at, ends_at}` view column subset).
   - Direct `GET /storage/v1/object/public/portraits/<uuid>/<file>.png` still returns the PNG (validates H7 didn't break public reads).
   - `GET /storage/v1/object/list/portraits?prefix=<uuid>/` returns empty (validates H7 took effect).
   - `submit-report → notify-report` end-to-end still succeeds (validates M2 bearer compare is byte-equivalent).
5. Manual RPC probe via `psql` as `authenticated`:
   ```sql
   select * from public.reserve_credits('00000000-0000-0000-0000-000000000001', 100);
   ```
   MUST raise SQLSTATE 42501 (validates C1).
6. Manual probe via `psql` as `authenticated`:
   ```sql
   insert into public.deletion_queue(user_id, storage_paths)
   values (auth.uid(), '["other-uuid/file.png"]'::jsonb);
   ```
   MUST violate the WITH CHECK (validates M3).
7. Re-run `20260528000300` against a freshly-converged DB — MUST succeed with zero changes (validates H6 idempotency).
8. `select count(*) from pg_proc p join pg_namespace n on p.pronamespace = n.oid where n.nspname = 'public' and p.proname = 'tg_set_updated_at' and 'search_path=pg_catalog, public' = any(p.proconfig);` MUST return 1 (validates M1).
9. Manual probe via `psql` as `authenticated`: `insert into public.ledger_grants (user_id, kind, credits_micro) values (auth.uid(), 'pack', 100);` MUST raise RLS denial (validates M8).

## Regression Test Outcome

`npx vitest run` (full repo) after all 7 commits:
- **Pre-cluster baseline:** 16 failure entries (12 distinct tests; mix of proxy/, supabase functions, and one src/main flake).
- **Post-cluster:** 15 failure entries (9 distinct tests).
- **Net change:** 1 FEWER failure (a portraitStore.test.ts flake passed on the second run; nothing caused by this cluster).
- **NEW failures introduced by this cluster:** 0.

All remaining failures are PRE-EXISTING and out-of-scope per the SCOPE BOUNDARY rule. Cataloged in `deferred-items.md`. The pre-existing failures fall into three buckets: (a) `lemon-webhook/index.test.ts` 3 TS2345 errors on `isSubscriptionFirstInvoice` payload shape from the 260524-0ka A3 cluster (interface widening not done); (b) `proxy/src/*` tests failing because the proxy module hasn't been built or because mocks reference modules in the dirty `proxy/src/anthropic/forwardFree.ts` / `proxy/src/rateLimit/personaDailyGate.ts` WIP files; (c) `supabase/functions/submit-report` + `trial-claim` test files erroring at import (likely related to deno-vs-node test runner config — not touched by this cluster).

## Threat Register Coverage

All eight T-260525-pbn-* threats from the plan's `<threat_model>` map to concrete mitigations:

| Threat ID | Disposition | Mitigation Commit |
|-----------|-------------|-------------------|
| T-260525-pbn-01 (Privilege Escalation: RPC) | mitigate | `616cf31` Section 1 |
| T-260525-pbn-02 (Info Disclosure: Storage LIST) | mitigate | `314310b` |
| T-260525-pbn-03 (Info Disclosure: Lemon Squeezy PK) | mitigate | `7af7f5a` + `8c180e4` + `cb65188` |
| T-260525-pbn-04 (Tampering: Schema drift) | mitigate | `c4ff8d1` |
| T-260525-pbn-05 (Tampering: search_path) | mitigate | `616cf31` Section 2 |
| T-260525-pbn-06 (Info Disclosure: Timing) | mitigate | `5bb860e` |
| T-260525-pbn-07 (Tampering: deletion_queue) | mitigate | `616cf31` Section 3 |
| T-260525-pbn-08 (Privilege Escalation: Defense-in-depth) | mitigate | `616cf31` Section 4 |

## Self-Check: PASSED

All 5 created files verified present on disk:
- `supabase/migrations/20260528000000_security_definer_guards.sql` — FOUND
- `supabase/migrations/20260528000100_drop_storage_listing.sql` — FOUND
- `supabase/migrations/20260528000200_user_read_views.sql` — FOUND
- `supabase/migrations/20260528000300_reconcile_moderation_and_reports.sql` — FOUND
- `supabase/functions/_shared/timingSafe.ts` — FOUND

All 7 commits verified in git log:
- `616cf31` — FOUND (Task 1)
- `314310b` — FOUND (Task 2)
- `7af7f5a` — FOUND (Task 3)
- `8c180e4` — FOUND (Task 4 code)
- `cb65188` — FOUND (Task 4 test-mock)
- `c4ff8d1` — FOUND (Task 5)
- `5bb860e` — FOUND (Task 6)
