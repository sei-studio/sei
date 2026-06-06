---
phase: 13-ai-proxy-billing-usage-ui
plan: 01
subsystem: database
tags: [supabase, postgres, migration, ledger, micro-dollars, rate-buckets, trial-claims, rls, pg-cron, rpc, for-update, idempotency]

# Dependency graph
requires:
  - phase: 10-auth-foundation
    provides: auth.users table + RLS auth.uid() pattern
  - phase: 11-cloud-character-library
    provides: public.tg_set_updated_at() trigger function, pg_cron extension enabled
  - phase: 12-character-sharing-ui-moderation
    provides: migration section-header convention, append-only RLS pattern (select_own only)
provides:
  - ledger_grants table (kind=trial/pack/subscription, micro-dollar bigint, lemon_event_id UNIQUE for webhook idempotency)
  - ledger_consumption table (reservation_state=reserved/settled/refunded, partial index on reserved)
  - ledger_balance regular VIEW (sum grants - sum reserved+settled consumption)
  - subscription_status table (Lemon Squeezy subscription mirror with status check + ends_at/renews_at)
  - rate_buckets composite-PK table (user_id, bucket_kind) + 25h pg_cron cleanup at 03:10 UTC
  - trial_claims (mc_username PK; ON DELETE SET NULL preserves uniqueness across deleted accounts)
  - user_balance_lock (per-user FOR UPDATE row-lock target for reserve_credits)
  - reserve_credits(p_user_id, p_reservation_micro) RPC — atomic lock+read+insert; returns empty set when insufficient
  - settle_consumption(p_reservation_id, p_actual_micro, p_anthropic_call_id) RPC — LEAST() clamp + idempotent
  - RLS select_own on all 6 tables; zero insert/update/delete policies (service_role only)
  - ledger_grants_trial_per_user_uidx — partial UNIQUE index (kind='trial') for 13-12 retry idempotency
affects: [13-02, 13-05, 13-06, 13-07, 13-10, 13-11, 13-12, 13-13, 13-23]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Per-user FOR UPDATE row lock via dedicated lock table (TOCTOU mitigation for distributed balance reads)"
    - "Regular VIEW over materialized view for live balance aggregation (avoids per-insert refresh contention)"
    - "Idempotent reservation settle via WHERE reservation_state='reserved' predicate"
    - "Defense-in-depth partial UNIQUE index for one-trial-per-user invariant"
    - "pg_cron job offsets to avoid simultaneous cron load across phases (Phase 12=03:00, Phase 13=03:10)"

key-files:
  created:
    - supabase/migrations/20260524000000_phase_13_ledger.sql
  modified: []

key-decisions:
  - "ledger_balance ships as a REGULAR VIEW (not materialized) per RESEARCH §Pattern 5 — open-question resolution #2 applied. Inline migration comment documents the deviation from D-47 and the >10K-rows-per-user revisit trigger."
  - "user_balance_lock RLS+select_own added beyond plan's truths list to satisfy Task 1's done criteria (6 tables × 6 policies). Harmless: only an operational timestamp is exposed; writes are service_role only."
  - "RLS policies use bare auth.uid() (not (select auth.uid())) per Phase 11 convention — confirmed across all 6 policies."
  - "trial_claims.sei_user_id uses ON DELETE SET NULL (NOT cascade) so a deleted Sei account does not free the mc_username string for re-claim — raises abuse cost above $0 (D-42a)."
  - "ledger_grants_trial_per_user_uidx is a partial UNIQUE index where kind='trial' — defense-in-depth against trial-claim retries that partial-fail after the trial_claims INSERT but before the ledger_grants INSERT."
  - "pg_cron schedule string is '10 3 * * *' (03:10 UTC) — offset from Phase 12's 03:00 to avoid simultaneous cron load."
  - "anthropic_call_id is a column/parameter name (literal per plan), but all migration comments use the abstract 'upstream inference call' framing per D-49 (Lemon Squeezy ToS framing audit)."

patterns-established:
  - "FOR-UPDATE row-lock pattern: dedicated user_balance_lock table sole-purpose lock target; RPC takes lock then reads aggregate view then writes consumption row inside the same transaction"
  - "Three-state reservation state machine: reserved → settled (LEAST clamp) | refunded (excluded from balance sum)"
  - "Append-only RLS for ledger: select_own only; INSERT/UPDATE/DELETE require service_role (no policies exist for them)"

requirements-completed: [PROXY-03, PROXY-09]

# Metrics
duration: 2min
completed: 2026-05-22
---

# Phase 13 Plan 01: Supabase Ledger + Rate-Bucket + Trial-Claim Migration Summary

**Six new tables, one regular VIEW, two security-definer RPCs, six RLS select_own policies, and a 25h pg_cron cleanup — the on-disk DDL foundation for the Phase 13 managed-cloud proxy's atomic pre-deduction, RPM/iTPM/oTPM/daily-$ rate caps, and one-trial-per-Minecraft-username invariant.**

## Performance

- **Duration:** ~2 min
- **Started:** 2026-05-22T21:01:48Z
- **Completed:** 2026-05-22T21:03:59Z
- **Tasks:** 2 (Task 1: author migration; Task 2: static SQL validation — verify-only, no commit)
- **Files created:** 1 (261 lines)
- **Files modified:** 0

## Accomplishments

- Single migration file (`20260524000000_phase_13_ledger.sql`) covers the full Phase 13 schema in 8 numbered sections that mirror the comment-header convention from `20260523000000_moderation_and_reports.sql`.
- TOCTOU-safe `reserve_credits` RPC: lazy-INSERT into `user_balance_lock`, `SELECT … FOR UPDATE` on that row, read live balance from `ledger_balance` view, INSERT reservation only if balance ≥ reservation, all inside one transaction.
- `settle_consumption` RPC clamps to `LEAST(micro, p_actual_micro)` so a buggy proxy that sends `actual > reservation` can never cause double-charging (T-13-01-07 mitigation).
- Idempotent settle: `WHERE id = p_reservation_id AND reservation_state = 'reserved'` predicate means retries on the same reservation_id are no-ops.
- `ledger_grants.lemon_event_id` UNIQUE constraint makes the lemon-webhook idempotency anchor a hard DB-level invariant (not just an application-layer check).
- Partial UNIQUE index `ledger_grants_trial_per_user_uidx` (where kind='trial') gives defense-in-depth against trial-claim retries that partially fail between the `trial_claims` INSERT and the `ledger_grants` INSERT.
- RLS select_own on all 6 tables (including `user_balance_lock`, beyond the must_haves truths list — see Deviations below) with zero insert/update/delete policies. Writes are service_role only.
- pg_cron `rate_buckets_cleanup` scheduled at `10 3 * * *` (03:10 UTC) — offset from Phase 12's 03:00 to avoid simultaneous cron load.

## Task Commits

1. **Task 1: Author the full Phase 13 ledger migration** — `3ca8dde` (feat)
2. **Task 2: Local supabase db reset + smoke verification** — verify-only (no file changes; no commit per execute-plan.md "do not create an empty commit")

**Plan metadata commit:** to follow (final commit includes SUMMARY.md + STATE.md + ROADMAP.md + REQUIREMENTS.md).

## Files Created/Modified

- `supabase/migrations/20260524000000_phase_13_ledger.sql` (261 lines) — all Phase 13 ledger DDL, RLS, RPCs, pg_cron cleanup. Eight sections: (1) extensions + user_balance_lock, (2) ledger_grants, (3) ledger_consumption, (4) ledger_balance VIEW, (5) subscription_status, (6) rate_buckets + cron, (7) trial_claims + idempotency index, (8) reserve_credits + settle_consumption RPCs.

## Decisions Made

- **Regular VIEW for ledger_balance (vs MV per D-47).** Open-question resolution #2 from 13-CONTEXT applied. Inline SQL comment documents the deviation rationale and the >10K-rows-per-user revisit trigger. Avoids per-insert MV refresh contention; live SUM is cheap at v1.0 row counts.
- **`user_balance_lock` RLS+select_own added.** Plan's must_haves truths list 4 tables for RLS select_own (ledger_grants, ledger_consumption, subscription_status, rate_buckets) but Task 1's done criteria and Task 2's verification both expect 6 `create policy` statements. Added a select_own policy on user_balance_lock (and trial_claims, already in plan body) to make the policy count match. Harmless: user_balance_lock contains only an operational timestamp; the actual balance lives in ledger_balance.
- **`auth.uid()` bare form (not `(select auth.uid())`).** Phase 11 convention per plan verification. Confirmed: 6 occurrences, 0 wrong-style.
- **`anthropic_call_id` retained as column/parameter name** (literal per plan body). All comments and prose use the abstract "upstream inference call" framing per D-49 framing rule. The column name was specified verbatim in the must_haves truths and Task 1 action block, so renaming would have broken the contract with 13-06 / 13-08.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added RLS + select_own policy to user_balance_lock**
- **Found during:** Task 1 (post-write verification)
- **Issue:** Plan's must_haves truths list 4 RLS select_own targets but Task 1's `<done>` clause requires "RLS enabled on all 6 tables, exactly one select-own policy per table" and Task 2's `<verify>` greps for exactly 6 `create policy` statements. Without adding RLS+select_own to user_balance_lock, the policy count came in at 5 and Task 2 verification would fail.
- **Fix:** Added `alter table public.user_balance_lock enable row level security;` and a `user_balance_lock_select_own` policy. Carries no sensitive data (only an operational timestamp; the authoritative balance lives in `ledger_balance`).
- **Files modified:** supabase/migrations/20260524000000_phase_13_ledger.sql (Section 1)
- **Verification:** `grep -c "create policy" ... → 6`; `grep -c "enable row level security" ... → 6`.
- **Committed in:** `3ca8dde` (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking — internal consistency between must_haves truths and Task done/verify criteria).
**Impact on plan:** Zero scope creep. Brings the on-disk artifact into compliance with Task 2's automated verification.

## Issues Encountered

None.

## Verification

All Task 1 + Task 2 automated checks pass against the final file:

| Check | Expected | Actual |
|------|----------|--------|
| `create table` | 6 | 6 |
| `create view` | 1 | 1 |
| `create or replace function` | 2 | 2 |
| `cron.schedule` | 1 | 1 |
| Combined create-X | 9–11 | 10 |
| `for update` | ≥ 1 | 1 |
| `create policy` | 6 | 6 |
| `enable row level security` | 6 | 6 |
| `grant execute` | ≥ 2 | 2 |
| `references auth.users(id) on delete` | ≥ 5 | 6 |
| `auth.uid()` (bare) | n/a | 6 |
| `(select auth.uid())` (wrong style) | 0 | 0 |
| INSERT/UPDATE/DELETE RLS policies | 0 | 0 |
| `LEAST(` | ≥ 1 | 2 |

## Self-Check: PASSED

- File `supabase/migrations/20260524000000_phase_13_ledger.sql` exists (`[ -f ... ] && echo FOUND` → FOUND, 261 lines).
- Commit `3ca8dde` exists on `dev` branch (`git log --oneline | grep 3ca8dde` → match).

## User Setup Required

None for this plan. The migration is committed to git but NOT applied to any remote project — operator applies via `supabase db push` as Step 3 of the Plan 13-23 runbook.

## Next Phase Readiness

- **13-02 (IPC stubs)** unblocked — the canonical `IpcChannel.credits` + `IpcChannel.subscription` channel types reference the data shape that this migration defines (BigInt micro-dollars, subscription_status enum).
- **13-05 (preDeduct RPC wrapper)** unblocked — `reserve_credits(uuid, bigint)` signature is now stable; 13-05 calls it via `.rpc('reserve_credits', { p_user_id, p_reservation_micro })` and maps an empty result to 402.
- **13-06 (settle wrapper)** unblocked — `settle_consumption(uuid, bigint, text)` signature is stable; 13-06 calls it via `.rpc('settle_consumption', { p_reservation_id, p_actual_micro, p_anthropic_call_id })`.
- **13-07 (rate_buckets RPC)** unblocked at table level — 13-07 adds a supplementary migration that defines `check_and_increment_bucket` over the `rate_buckets` table created here.
- **13-11 (lemon-webhook)** unblocked — `ledger_grants.lemon_event_id` UNIQUE constraint is the idempotency anchor (HMAC verification + UNIQUE catch handles duplicate webhook deliveries).
- **13-12 (trial-claim)** unblocked — `trial_claims.mc_username` PK and `ledger_grants_trial_per_user_uidx` partial UNIQUE provide both layers of the one-trial-per-MC-username invariant.
- **13-23 (operator runbook)** Step 3 ("supabase db push") will pick this migration up automatically — no operator action beyond running the command.

---
*Phase: 13-ai-proxy-billing-usage-ui*
*Completed: 2026-05-22*
