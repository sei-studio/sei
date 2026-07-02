---
phase: 15-in-game-vision-via-prismarine-viewer
plan: 02
subsystem: api
tags: [hono, rate-limit, supabase, postgres, bucket, vision, proxy]

# Dependency graph
requires:
  - phase: 13-cloud-billing-proxy
    provides: "rate_buckets table + check_and_increment_bucket RPC + sentinel error vocabulary + single-bucket gate pattern (personaDailyGate)"
provides:
  - "vision_hourly bucket kind (TS BucketKind union + live rate_buckets CHECK constraint)"
  - "visionHourlyGate Hono middleware enforcing ~10 explicit renders / 3600s, server-authoritatively"
  - "POST /vision/v1/messages route on the Fly.io proxy with chain originLockGate -> ipRateLimitGate -> verifyJwt -> visionHourlyGate -> rateLimitGate -> forwardToAnthropic"
affects: [15-06-bot-explicit-vision-routing]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Per-feature single-bucket gate cloned from personaDailyGate (one bucket kind + window, sendError on deny)"
    - "Retry-After HEADER capped at 10s (260610 convention) while JSON body keeps honest retry_after_seconds — applied to a 3600s window"
    - "Migration applied to live Supabase via Management API /database/query (history diverged → supabase db push FORBIDDEN), then recorded with migration repair --status applied <version>"

key-files:
  created:
    - "supabase/migrations/20260610120000_vision_hourly_bucket.sql (in sei-proxy)"
    - "src/rateLimit/visionHourlyGate.ts (in sei-proxy)"
    - "src/rateLimit/visionHourlyGate.test.ts (in sei-proxy)"
  modified:
    - "src/rateLimit/buckets.ts (in sei-proxy) — vision_hourly added to BucketKind union"
    - "src/middleware/sentinel.ts (in sei-proxy) — vision_hourly added to rate_limited.kind union"
    - "src/app.ts (in sei-proxy) — POST /vision/v1/messages route mounted"

key-decisions:
  - "VISION_HOURLY_LIMIT = 10n renders / rolling 3600s window (D-09 ~10/hr; configurable via the single exported constant)"
  - "sentinel rate_limited.kind union extended with vision_hourly (Rule 3 blocking — required for the gate's sendError to type-check; kept in lockstep with BucketKind)"
  - "Retry-After header capped at 10s even though the bucket window is 3600s (260610 freeze convention — the bot SDK obeys the header with an un-abortable sleep)"
  - "Live migration applied via Supabase Management API (verified working endpoint) + migration repair, NOT supabase db push (remote history diverged; mass-repair forbidden)"

patterns-established:
  - "Vision-render cost vector capped server-side and independent of credit balance, because an LLM looping `visualize` is unbounded"

requirements-completed: [VIS-07]

# Metrics
duration: 9min
completed: 2026-06-10
---

# Phase 15 Plan 02: Per-Hour Vision Cap (VIS-07 / D-09) Summary

**Server-authoritative `vision_hourly` rate bucket (10 renders / 3600s) + `visionHourlyGate` Hono middleware + `POST /vision/v1/messages` route on the Fly.io proxy, with the CHECK-constraint migration applied live via the Supabase Management API.**

## Performance

- **Duration:** ~9 min
- **Started:** 2026-06-10T02:25Z
- **Completed:** 2026-06-10T02:30Z
- **Tasks:** 3
- **Files modified/created:** 6 (3 created, 3 modified) — all in the sei-proxy repo

## Accomplishments

- **Live DB CHECK extended** — `rate_buckets_bucket_kind_check` now accepts `'vision_hourly'` (10 prior kinds preserved + the new one), applied to the live project and recorded in migration history.
- **`visionHourlyGate` middleware** — caps a cloud-AI user to 10 explicit renders / rolling 3600s, server-side; over-cap returns `429 rate_limited` (kind `vision_hourly`) with a Retry-After header capped at 10s while the JSON body keeps the honest value.
- **`POST /vision/v1/messages` route** — chain `originLockGate -> ipRateLimitGate -> verifyJwt -> visionHourlyGate -> rateLimitGate -> forwardToAnthropic` (same forward closure as `/v1/messages`). Idle renders stay on `/v1/messages` and are NOT counted (D-09).
- **All 141 src/ proxy tests pass; tsc clean.** No regression.

## Task Commits

Each task was committed atomically in `/Users/ouen/slop/sei-studio/sei-proxy`:

1. **Task 1: Migration + BucketKind union (+ sentinel union)** — `4642093` (feat)
2. **Task 2 (TDD RED): failing visionHourlyGate test** — `0c4882d` (test)
3. **Task 2 (TDD GREEN): visionHourlyGate implementation** — `98327ae` (feat)
4. **Task 3: mount POST /vision/v1/messages** — `51be1a9` (feat)

_Task 2 followed RED → GREEN; no REFACTOR commit (implementation was already idiomatic vs. the personaDailyGate clone)._

## Files Created/Modified (all in sei-proxy)

- `supabase/migrations/20260610120000_vision_hourly_bucket.sql` (created) — drop-then-add `rate_buckets_bucket_kind_check` re-listing all 9 prior kinds + `vision_hourly`.
- `src/rateLimit/visionHourlyGate.ts` (created) — exports `visionHourlyGate` + `VISION_HOURLY_LIMIT = 10n`, window 3600s.
- `src/rateLimit/visionHourlyGate.test.ts` (created) — 5 vitest cases (under-limit next, 10 successive, 11th 429 + capped header, no-next on deny, exact bucket-call shape).
- `src/rateLimit/buckets.ts` (modified) — `| 'vision_hourly'` added to `BucketKind`.
- `src/middleware/sentinel.ts` (modified) — `| 'vision_hourly'` added to `rate_limited.kind`.
- `src/app.ts` (modified) — import + `POST /vision/v1/messages` route.

## Live Migration Apply (BLOCKING — completed)

- **Procedure used:** Supabase Management API `POST /v1/projects/wfloawnjgkpammmnjncm/database/query` with the CLI keychain token (`security find-generic-password -l "Supabase CLI"`), then `supabase migration repair --status applied 20260610120000`. Plain `supabase db push` was NOT used (remote history diverged; forbidden per the plan).
- **Apply result:** `[]` (success, exit 0).
- **`migration repair` result:** `Repaired migration history: [20260610120000] => applied`.
- **Verified live CHECK constraint definition (queried after apply):**
  ```
  CHECK ((bucket_kind = ANY (ARRAY['rpm'::text, 'itpm'::text, 'otpm'::text, 'daily_dollar'::text, 'persona_daily'::text, 'sightengine_daily'::text, 'openai_moderation_daily'::text, 'reports_ip_daily'::text, 'customer_portal_minute'::text, 'vision_hourly'::text])))
  ```
  (The before-apply def was the identical list minus `'vision_hourly'::text` — exactly the 9 documented kinds, confirming the drop-then-add was correct and additive.)

## Chosen VISION_HOURLY_LIMIT

- **`VISION_HOURLY_LIMIT = 10n`** renders per rolling **3600s** window (D-09 ~10/hr). Exported from `visionHourlyGate.ts` as the sole configurable enforcement point.

## Decisions Made

- **Sentinel union extended (Rule 3 fix, see below)** — required for type coherence.
- **Header capped at 10s** despite the 3600s window — clones the 260610 freeze-prevention convention from `personaDailyGate`/the incident memo (the bot's Anthropic SDK obeys Retry-After with an un-abortable sleep).
- **Same forward closure as `/v1/messages`** — the vision path is a normal Anthropic turn that also consumes credits/RPM/TPM/$; only the hourly cap is inserted before `rateLimitGate`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Extended the sentinel `rate_limited.kind` union with `vision_hourly`**
- **Found during:** Task 1 (after adding `vision_hourly` to `BucketKind`, `tsc --noEmit` failed).
- **Issue:** `src/middleware/sentinel.ts` keeps a narrower `rate_limited.kind` union, manually mirrored from `BucketKind`. Adding `vision_hourly` to `BucketKind` alone broke compilation in `personaDailyGate.ts`, `customerPortalMinuteGate.ts`, and `gate.ts` (all pass `result.kind: BucketKind` into the narrower sentinel union) — `error TS2322: Type 'BucketKind' is not assignable to ...`. The eventual `visionHourlyGate.sendError({ kind })` call also needs it.
- **Fix:** Added `| 'vision_hourly'` to the sentinel `rate_limited.kind` union, keeping it in lockstep with `BucketKind`.
- **Files modified:** `src/middleware/sentinel.ts`
- **Verification:** `npx tsc --noEmit` clean afterward.
- **Committed in:** `4642093` (Task 1 commit).

---

**Total deviations:** 1 auto-fixed (1 blocking).
**Impact on plan:** Necessary for compilation and type coherence — the sentinel `kind` union is the manually-maintained mirror of `BucketKind`, and any new bucket kind that can be surfaced as a `rate_limited` error must be added to both. No scope creep.

## Issues Encountered

None — the migration applied cleanly on the first attempt and the live CHECK verification matched the documented 9-kind pre-state exactly.

## Pre-existing test note (not a regression)

The full `npx vitest run` reports **5 Failed Suites** — `supabase/functions/_shared/ipRateLimit.test.ts`, `supabase/functions/_shared/moderationProviders.test.ts`, `supabase/functions/signup-guard/index.test.ts`, `supabase/functions/polar-webhook/index.test.ts`, `supabase/functions/trial-claim/index.test.ts`. These are **Deno** tests that fail COLLECTION under vitest (`Failed to load url @std/assert`), are **pre-existing and unrelated to this plan** (none were touched here), and were flagged as out-of-scope in the plan. **All 141 `src/` tests pass.**

## Self-Check: PASSED

- FOUND: `supabase/migrations/20260610120000_vision_hourly_bucket.sql`
- FOUND: `src/rateLimit/visionHourlyGate.ts`
- FOUND: `src/rateLimit/visionHourlyGate.test.ts`
- FOUND commits: `4642093`, `0c4882d`, `98327ae`, `51be1a9`

## Next Phase Readiness

- The `/vision/v1/messages` path now exists and is server-authoritatively capped. **15-06** wires the bot to route only explicit-`visualize`-triggered turns to this path (idle renders continue on `/v1/messages`).
- No blockers. The cap is live (DB CHECK accepts `vision_hourly`), so a real `vision_hourly` insert will succeed at runtime.

---
*Phase: 15-in-game-vision-via-prismarine-viewer*
*Completed: 2026-06-10*
