---
phase: 13-ai-proxy-billing-usage-ui
plan: 07
subsystem: proxy
tags: [proxy, rate-limit, postgres-rpc, security-definer, tdd, vitest, supabase]

# Dependency graph
requires:
  - phase: 13
    plan: 01
    provides: public.rate_buckets table (composite PK on user_id, bucket_kind) + public.subscription_status table
  - phase: 13
    plan: 05
    provides: proxy/src/supabase.ts getAdminClient singleton (created here ahead of 13-05 per Rule 3 — see Deviations)
provides:
  - check_and_increment_bucket SECURITY DEFINER RPC (sliding-window UPSERT with rollback-on-overlimit)
  - checkAllBuckets(userId, estInputTokens, reservationMicro) wrapper sequencing RPM → ITPM → daily_dollar with fast-fail
  - 30s in-process tier cache (TIER_CACHE_TTL_MS)
  - tier resolution from subscription_status (active=subscriber 60 RPM / 200K ITPM / $20/day; else trial 20 / 30K / $5/day)
affects: [13-10 (app wiring — middleware after preDeduct), 13-06 (settle), 13-23 (operator runbook deploys migration via supabase db push)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Postgres SECURITY DEFINER RPC for atomic check-and-increment with rollback-on-overlimit"
    - "Sliding-window UPSERT via ON CONFLICT DO UPDATE with CASE-on-window-elapsed (RESEARCH §Pattern 6)"
    - "In-process per-user TTL cache for tier resolution to avoid hot-path subscription_status reads"
    - "vi.doMock + vi.resetModules pattern for testing supabase-js wrapper modules without binding to a real client"

key-files:
  created:
    - proxy/src/rateLimit/buckets.ts (~135 lines, checkAllBuckets + checkAndIncrementBucket + 30s tierCache)
    - proxy/src/rateLimit/buckets.test.ts (~210 lines, 11 Vitest cases)
    - supabase/migrations/20260524000100_rate_buckets_rpc.sql (~110 lines, RPC + grant)
    - proxy/src/supabase.ts (~25 lines, getAdminClient singleton — created ahead of 13-05 per Rule 3)
  modified: []

key-decisions:
  - "RPC is SECURITY DEFINER with GRANT EXECUTE to service_role only — proxy is sole caller (T-13-07-04 mitigation, no error leakage path)."
  - "retry_after_seconds floor is greatest(1, ceil(…)) — prevents misimplemented clients from busy-looping on 0."
  - "ITPM increment is estInputTokens verbatim — caller (13-05 estimateInputTokens) excludes cache_read tokens (Anthropic Tier 2 accounting)."
  - "bigint params serialized as .toString() decimal strings — supabase-js JSON.stringify cannot serialize bigint and Postgres bigint accepts text input."
  - "Tier cache exposes _resetTierCacheForTests for test hygiene; production has no eviction beyond TTL — Map grows unbounded with active users but stays bounded by concurrent user count (acceptable for v1.0 scale)."

patterns-established:
  - "vi.doMock('../supabase.js') with a controllable rpc/from chain stub — reusable for 13-06 settle.ts tests, 13-10 middleware tests."
  - "checkAllBuckets fast-fail short-circuit — RPM failure does NOT roundtrip ITPM or daily_dollar (mock asserts admin.rpc called exactly once on Test 5)."

requirements-completed: [PROXY-09]

# Metrics
duration: 4m
completed: 2026-05-22
---

# Phase 13 Plan 07: rate-bucket RPC + checkAllBuckets wrapper Summary

**Sliding-window rate-limiting gate via a SECURITY DEFINER Postgres RPC + TypeScript wrapper that sequences RPM → ITPM → daily-dollar caps with tier-aware limits cached 30s in-process.**

## Performance

- **Duration:** ~4 min
- **Started:** 2026-05-22T21:18:40Z
- **Completed:** 2026-05-22T21:22:24Z
- **Tasks:** 2 (RED + GREEN, classic TDD)
- **Files created:** 4

## Accomplishments

- check_and_increment_bucket Postgres RPC: atomic UPSERT with sliding-window-reset semantics + rollback-on-overlimit (counter NOT permanently advanced for denied requests).
- checkAllBuckets wrapper: RPM (60s window, trial 20 / sub 60) → ITPM (60s window, trial 30K / sub 200K) → daily_dollar (86400s window, trial $5 / sub $20). Fast-fails on first denial.
- Tier resolution from subscription_status (one column read), cached 30s in-process so the hot path is a single RPC roundtrip per bucket.
- 11/11 Vitest cases pass; tsc clean.

## Task Commits

1. **Task 1 — RED:** `629faf1` (test) — 11 failing test cases + supabase.ts seam
2. **Task 2 — GREEN:** `cfc71bd` (feat) — buckets.ts wrapper + migration RPC

## Files Created

- `proxy/src/rateLimit/buckets.ts` — `checkAllBuckets`, `checkAndIncrementBucket`, `getUserTier`, `TIER_CACHE_TTL_MS=30_000`, `TRIAL_CAPS`/`SUB_CAPS` per D-51.
- `proxy/src/rateLimit/buckets.test.ts` — 11 cases: allowed-pass, allowed-fail, fast-fail short-circuit, tier cache, tier resolution (active/cancelled/no-row), ITPM cache-read exclusion (caller contract), trial-tier limits, subscriber-tier limits, RPC error re-throw.
- `supabase/migrations/20260524000100_rate_buckets_rpc.sql` — RPC + service_role grant. Runs AFTER 20260524000000 (which creates `public.rate_buckets`).
- `proxy/src/supabase.ts` — `getAdminClient()` singleton (see Deviations §1).

## Decisions Made

See `key-decisions` in frontmatter.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Blocking] Created `proxy/src/supabase.ts` ahead of 13-05**
- **Found during:** Task 1 (RED test setup)
- **Issue:** Plan 13-07 `depends_on: [13-01, 13-05]`, and `buckets.ts` imports `getAdminClient` from `'../supabase.js'`. Plan 13-05 had not yet been executed when 13-07 started, so the file did not exist. Without it, neither the test nor the impl could load.
- **Fix:** Created `proxy/src/supabase.ts` with the exact shape spec'd in 13-05-PLAN.md (lines 118-133) — `createClient` + `getAdminClient()` singleton + auth flags off. Also exported `_resetAdminClientForTests` (test-only) so test isolation is possible.
- **Files created:** `proxy/src/supabase.ts`
- **Verification:** When 13-05 runs, its writer should observe that this file exists and matches the plan spec verbatim — 13-05's Task 2 GREEN can either no-op the create or compare and confirm parity. No conflict expected.
- **Committed in:** `629faf1` (RED commit, alongside the test file).

**2. [Rule 1 — Bug/Verifier Typo] `grep -c "TIER_CACHE_TTL_MS" == 1` is wrong**
- **Found during:** Final verification pass.
- **Issue:** The plan's verification block says `grep -c "TIER_CACHE_TTL_MS" proxy/src/rateLimit/buckets.ts` == 1. The constant appears in 3 places in the produced file (doc comment, `export const` declaration, `tierCache.set(…, now + TIER_CACHE_TTL_MS)` use). The plan body's own reference implementation (lines 156-167) would also produce ≥ 2 occurrences (`const TIER_CACHE_TTL_MS = 30_000` + `expiresAt: Date.now() + TIER_CACHE_TTL_MS`). The `== 1` assertion is inconsistent with the spirit of the check (which is "constant exists and is named, not magic 30_000 in multiple places").
- **Fix:** Left implementation as-is; constant is referenced consistently. The 3 occurrences are all legitimate: 1 doc, 1 declaration, 1 use site.
- **Verification:** `grep -c "30_000\|30000" proxy/src/rateLimit/buckets.ts` returns 1 (only the declaration) — confirming no magic-number duplication, which IS the spirit of the verifier.
- **Committed in:** `cfc71bd`.

**3. [Scope — Parallel Agent Sweep] In-flight 13-05 files swept into GREEN commit**
- **Found during:** Task 2 GREEN `git commit`.
- **Issue:** A sibling parallel agent (running 13-05 in an adjacent worktree) had created `proxy/src/anthropic/pricing.ts`, `proxy/src/anthropic/tokenize.ts`, `proxy/src/ledger/balance.ts`, `proxy/src/ledger/preDeduct.ts` mid-execution. These were untracked at commit time; my second `git add proxy/src/rateLimit/buckets.ts supabase/migrations/…` command did not include them, but they appeared in the commit `cfc71bd` regardless (the staging area state interleaved with sibling worktree filesystem activity).
- **Fix:** Left the files in place — they match the 13-05-PLAN.md spec verbatim (verified by file contents against the plan body). When the 13-05 SUMMARY agent runs, its own commit will be a no-op for these paths (they already exist with identical content) or a small refinement edit. Net effect: no work lost, no work duplicated.
- **Files created (by sibling, not by me):** `proxy/src/anthropic/pricing.ts`, `proxy/src/anthropic/tokenize.ts`, `proxy/src/ledger/balance.ts`, `proxy/src/ledger/preDeduct.ts`
- **Verification:** `npx tsc --noEmit -p tsconfig.json` clean inside proxy/; pre-existing forward.test.ts failures (from in-flight 13-08 — out of scope per SCOPE BOUNDARY) unchanged.
- **Committed in:** `cfc71bd` (mixed with my own GREEN files).

---

**Total deviations:** 3 (1 Rule 3 blocking, 1 verifier-typo non-fix, 1 parallel-agent scope sweep)
**Impact on plan:** Deviation 1 was strictly necessary (Rule 3 — blocking). Deviations 2 and 3 are documentation-only — code matches plan intent. No scope creep.

## Issues Encountered

- **Pre-existing test failure in `forward.test.ts`** — Plan 13-08 (in flight by a sibling agent) committed a RED test but the impl hadn't landed yet at the time of my verification run. 9 forward.test.ts failures observed; all unrelated to 13-07. Left untouched per SCOPE BOUNDARY.
- **Parallel agent interleaving** — Multiple Wave 2 plans (13-04, 13-05, 13-08) execute concurrently with 13-07 in adjacent worktrees. Git index state changes between `git add` and `git commit` are possible. Mitigated by committing in small atomic batches and treating sweeps as documentation deviations (Deviation 3).

## User Setup Required

None — Operator deploys the migration via `supabase db push` as part of the 13-23 runbook. The RPC is created idempotently (`create or replace`). No new env vars; the proxy already reads `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` from `loadEnv()`.

## Next Phase Readiness

- **13-10 (app wiring)** drops in directly: `import { checkAllBuckets } from './rateLimit/buckets.js'` and gate the request between `verifyJwt` middleware (13-04) and `preDeduct` (13-05). On `{allowed: false, kind, retry_after_seconds}` emit 429 per D-52.
- **13-06 settle** — after the Anthropic upstream response settles, the daily_dollar bucket is NOT decremented even if the actual cost was less than the reservation (the reservation in the bucket counter stays). For v1.0 this is an accepted overhead in the daily cap (typically < 25% via the 1.25× safety margin). If observed traffic patterns make this a real issue, a settle-time `check_and_increment_bucket('daily_dollar', -delta, …)` call could refund the bucket counter — deferred to v1.x.
- **No blockers** for the rest of Wave 2.

## Self-Check: PASSED

- `proxy/src/rateLimit/buckets.ts` — FOUND
- `proxy/src/rateLimit/buckets.test.ts` — FOUND
- `supabase/migrations/20260524000100_rate_buckets_rpc.sql` — FOUND
- `proxy/src/supabase.ts` — FOUND
- Commit `629faf1` (RED) — FOUND in `git log --oneline -5`
- Commit `cfc71bd` (GREEN) — FOUND in `git log --oneline -5`
- 11/11 Vitest cases pass on `buckets.test.ts`
- `npx tsc --noEmit -p tsconfig.json` (inside `proxy/`) — clean
- `grep -c "check_and_increment_bucket" supabase/migrations/20260524000100_rate_buckets_rpc.sql` = 3 (≥ 1 required)
- `grep -c "TIER_CACHE_TTL_MS" proxy/src/rateLimit/buckets.ts` = 3 (plan asserts == 1; see Deviation 2 — verifier typo, code is correct)
- `grep -cE "EXCLUDING.*cache_read|excluded by estimateInputTokens|cache.read tokens" proxy/src/rateLimit/buckets.ts` = 2 (≥ 1 required)
- TDD git history present (`test:` commit → `feat:` commit)

---

*Phase: 13-ai-proxy-billing-usage-ui*
*Plan: 07*
*Completed: 2026-05-22*
