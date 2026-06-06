---
quick_id: 260525-rfj
type: execute-summary
wave: 1
depends_on: [260525-qy0]
requirements_closed: [H1, H2, H3, M9, M10, M11]
files_created:
  - supabase/migrations/20260528001100_rate_buckets_reports_ip_customer_portal.sql
  - proxy/src/rateLimit/customerPortalMinuteGate.ts
  - proxy/src/rateLimit/customerPortalMinuteGate.test.ts
files_modified:
  - proxy/src/rateLimit/buckets.ts
  - proxy/src/middleware/sentinel.ts
  - supabase/functions/trial-claim/index.ts
  - supabase/functions/trial-claim/index.test.ts
  - supabase/functions/submit-report/index.ts
  - supabase/functions/submit-report/index.test.ts
  - proxy/src/app.ts
  - proxy/src/app.test.ts
  - src/main/cloud/proxyClient.ts
  - src/main/cloud/proxyClient.test.ts
  - supabase/config.toml
commits:
  - 2320a3b: feat(260525-rfj-1) — migration + BucketKind union extension
  - 07abcca: test(260525-rfj-2) RED — trial-claim H2 gates + M10 envelope + proxyClient ledger-delta
  - fc368de: feat(260525-rfj-2) GREEN — trial-claim H2 + M10 + proxyClient ledger-delta
  - 84ac78b: test(260525-rfj-3) RED — submit-report account-age + per-IP daily bucket
  - a9c958f: feat(260525-rfj-3) GREEN — submit-report M9 gates + makeHandler factory
  - 65811c5: test(260525-rfj-4) RED — customerPortalMinuteGate + app wire-up
  - de6e54f: feat(260525-rfj-4) GREEN — customerPortalMinuteGate impl + app.ts wire
  - 89ea9b0: chore(260525-rfj-5) — config.toml [auth.rate_limit] + operator runbook
metrics:
  duration_minutes: 14
  task_count: 5
  commit_count: 8
  file_count: 14
  completed_at: "2026-05-26T03:06:19Z"
---

# Quick Task 260525-rfj: Trial Auth Hardening (Cluster D) Summary

Closed six audit findings from the 260525 sweep (H1 / H2 / H3 / M9 / M10 / M11)
across two seams: the trial-claim Edge Function (email gate + neutral envelope
+ renderer ledger-delta classifier) and the rate-buckets table + RPC pattern
(two new bucket kinds for reports-per-IP and customer-portal-per-user). One
migration, four code changes, one config change, eight atomic commits, zero
new test failures.

## Truths Verified

All nine `must_haves.truths` from PLAN.md are now true:

1. **trial-claim rejects a JWT whose `user.email_confirmed_at` is null with 403** —
   Implemented in `supabase/functions/trial-claim/index.ts` (post-getUser
   guard returning `403 { code: 'email_not_confirmed' }`). Pinned by deno
   test case 10.

2. **trial-claim rejects emails containing a `+` alias segment before `@` with 403** —
   `PLUS_ALIAS_RE = /^[^+@]+\+[^@]*@/` guard returning `403 { code: 'aliased_email' }`.
   Regex anchored to the local-part so RFC-5321 `foo@bar+baz.com` is unaffected;
   leading `+@…` rejected as ill-formed. Pinned by deno test case 11.

3. **trial-claim returns the SAME 202 envelope `{ status: 'received' }` for first-claim,
   already-claimed, and post-grant — the client cannot distinguish claim state from
   the response shape or status** — `uniformReceived()` helper replaces three
   leak channels (200 success / 409 trial_claims 23505 / 409 ledger_grants 23505).
   Pinned by deno test cases 5/7/9 (status + shape) and cases 12/13/14
   (`Object.keys(body) === ['status']` invariant).

4. **trial-claim still grants $1 micro-credits exactly once per user via the existing
   UNIQUE indexes (ledger_grants_trial_per_user_uidx + trial_claims PK)** — Idempotency
   is unchanged: `trial_claims` PK on mc_username + `ledger_grants_trial_per_user_uidx`
   partial UNIQUE on user_id (kind='trial') from 13-01. The uniform envelope only
   changes what the client sees; the server-side rows are identical. Pinned by
   deno test case 5 (assert ledger_grants.insert called with credits_micro='1000000').

5. **submit-report rejects reports from accounts younger than 24h with a friendly 403** —
   `MIN_ACCOUNT_AGE_MS = 24h` check on `userData.user.created_at` after getUser,
   before body parse. Friendly copy: "New accounts must wait 24 hours before
   submitting reports." Pinned by deno test case 6.

6. **submit-report enforces a 10-reports-per-IP-per-24h cap via the new `reports_ip_daily`
   bucket; over-cap returns 429 with Retry-After** — Bucket call after the 5/hour
   reporter-id gate; leftmost x-forwarded-for entry is the key. Over-cap returns
   `429 { code: 'rate_limited' }` with `Retry-After: <retry_after_seconds>`. Pinned
   by deno test cases 8 (over-cap), 9 (leftmost XFF extraction), 10 (absent-XFF
   sentinel fallback).

7. **POST /billing/customer-portal enforces 5/minute per-userId via the new
   `customer_portal_minute` bucket; over-cap returns 429 with Retry-After BEFORE
   any Lemon Squeezy API call** — `customerPortalMinuteGate` middleware inserted
   in `proxy/src/app.ts` between `verifyJwt` and the inline handler. The gate
   runs BEFORE the `env.LEMON_SQUEEZY_API_KEY` check so over-cap users get 429
   even in misconfigured environments. Pinned by app.test.ts Test 12
   (`mockFetch` NOT called when bucket denies).

8. **supabase/config.toml carries an `[auth.rate_limit]` block + a comment documenting
   the operator dashboard-mirror requirement** — Appended `[auth]` + `[auth.rate_limit]`
   blocks with the six numeric fields at the prescribed values (email_sent=4,
   sms_sent=30, anonymous_users=30, token_refresh=150, sign_in_sign_ups=30,
   token_verifications=30). Preceded by an impossible-to-miss comment block
   naming the Supabase Dashboard mirror as a required follow-up step + the
   Turnstile/hCaptcha bot-protection toggle.

9. **renderer-side `trialClaim()` consumer in `src/main/cloud/proxyClient.ts` treats
   the uniform 202 envelope as "claim attempt complete" — no leak of claim state to
   the UI** — Refactored to read `ledger_balance` BEFORE the Edge Function call
   and AGAIN AFTER; uses the BigInt delta to classify success (`delta > 0n →
   ok:true, credits_micro=delta`) vs already-claimed (`delta == 0n →
   PROXY_ALREADY_CLAIMED`). The 403 paths surface as PROXY_NETWORK pending a
   follow-up PROXY_EMAIL_NOT_CONFIRMED sentinel (tracked under "Deferred Follow-ups"
   below).

## Artifacts

| Path | Purpose |
|------|---------|
| `supabase/migrations/20260528001100_rate_buckets_reports_ip_customer_portal.sql` | Extends `rate_buckets.bucket_kind` CHECK with `reports_ip_daily` + `customer_portal_minute`. Preserves all 7 pre-existing kinds. |
| `proxy/src/rateLimit/customerPortalMinuteGate.ts` | Hono middleware enforcing 5/userId/60s for the customer-portal route. Mirrors `personaDailyGate.ts` shape. |
| `proxy/src/rateLimit/customerPortalMinuteGate.test.ts` | 4 vitest cases (allow, 5x allow, reject, param-shape). |
| `supabase/functions/trial-claim/index.ts` | H2 email-confirmed-at + plus-alias gates; M10 uniform 202 envelope helper. |
| `supabase/functions/submit-report/index.ts` | Refactored to `makeHandler` factory; M9 account-age gate + per-IP daily bucket. |
| `src/main/cloud/proxyClient.ts` | `trialClaim()` uses ledger-balance pre/post delta to classify success vs already-claimed. |
| `supabase/config.toml` | `[auth.rate_limit]` block + dashboard-mirror operator runbook. |

## Test Results

| Suite | Before | After | Delta |
|-------|--------|-------|-------|
| trial-claim deno | 9 pass / 0 fail | **14 pass / 0 fail** | +5 cases |
| submit-report deno | 5 pass / 0 fail | **10 pass / 0 fail** | +5 cases |
| lemon-webhook deno | 36 pass / 0 fail | **36 pass / 0 fail** | unchanged |
| vitest baseline | 14 fail / 300 pass | **0 fail / 345 pass** | +45 cases; pre-existing module-resolution failures resolved by workspace state (not by this plan) |
| proxyClient.test.ts | 24 pass / 0 fail | **26 pass / 0 fail** | +2 cases (PROXY_ALREADY_CLAIMED via delta + PROXY_NETWORK on 403; 2 obsolete 409-branch tests removed and replaced) |
| customerPortalMinuteGate.test.ts | — | **4 pass / 0 fail** | new file |
| app.test.ts | 11 pass / 0 fail | **13 pass / 0 fail** | +2 cases (Test 12 over-cap; Test 13 allowed-falls-through) |

Per-task verification — direct deno + vitest commands — all green.
Full `npx tsc --noEmit` clean on `tsconfig.json`, `tsconfig.web.json`, and
`proxy/tsconfig.json`.

## Architecture Decisions Made

1. **Uniform 202 envelope as the M10 mitigation, not a 200/404 mix.** Status 202
   ("Accepted; processing complete; ledger is the source of truth") is semantically
   correct AND identical across all three claim dispositions, eliminating both
   the body-shape and status-code enumeration oracles. The client uses the
   ledger-balance delta to decide outcome.

2. **403 H2 gates surface as `PROXY_NETWORK` in the renderer for now.** The renderer
   does not yet have copy for "verify your email" or "use a non-aliased email,"
   so a dedicated `PROXY_EMAIL_NOT_CONFIRMED` sentinel would surface as the
   same generic error toast. Tracked as a deferred follow-up. The user-visible
   effect is that the trial-claim button shows a generic error and the user
   re-tries — the second attempt either succeeds (after they confirm via the
   email link Supabase already sent) or fails the same way (prompting them to
   use a different email).

3. **`makeHandler` factory refactor of `submit-report/index.ts`** to enable
   handler-level testing without spinning up Deno.serve. The refactor is
   confined to one file — no callers because submit-report is invoked over
   HTTP, not as a module import. The 5 pre-existing pure-function
   `countReportsInLastHour` tests are unchanged; 5 new handler-level cases
   are additive.

4. **Sentinel `kind` union widened in `proxy/src/middleware/sentinel.ts` to
   include `reports_ip_daily` even though that bucket is Deno-side only.**
   Rationale: `submit-report` does not import from `proxy/`, but the
   discriminated union in `sentinel.ts` is the cross-process error vocabulary
   and the simpler design is to keep ALL bucket kinds enumerable in one place.
   The `customer_portal_minute` extension is the mandatory one (the proxy's
   429 envelope serializer needs it); `reports_ip_daily` is added for
   consistency.

5. **Renderer `trialClaim()` ledger-delta classification accepts T-rfj-07.** A
   network failure between the pre and post ledger reads can cause a
   user-visible misclassification (UI says "already claimed" when the credit
   actually landed). The credits ARE in the ledger; the next refresh shows
   them. Worst case is a one-time confusing toast; tracked as accepted.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 — Bug fix] Defensive `Number.isFinite` over plan's `Number.isNaN`
in submit-report Task 3.**
- **Found during:** Task 3 implementation
- **Issue:** Plan suggested `if (createdAt === null || Number.isNaN(createdAt))`
  but `createdAt === null` would never trip the NaN check (only the unparsed
  string→NaN path would). A cleaner check is `Number.isFinite(createdAt)` after
  initializing to `NaN` instead of `null`.
- **Fix:** `const createdAt = createdAtRaw ? new Date(createdAtRaw).getTime() : NaN;
  if (!Number.isFinite(createdAt)) { return 403 account_too_new; }`. Same
  behavior, cleaner predicate.
- **Files modified:** `supabase/functions/submit-report/index.ts`
- **Commit:** `a9c958f`

**2. [Rule 1 — Bug fix] Cluster B's `proxy/src/middleware/sentinel.ts` `kind`
union was structured as a single-line union; Task 1 extended it to a
multi-line union for readability.**
- **Found during:** Task 1
- **Issue:** Adding two more kinds to a 4-kind inline union made the line ~120
  chars and unreadable.
- **Fix:** Reformatted to multi-line `|` union; semantically identical.
- **Files modified:** `proxy/src/middleware/sentinel.ts`
- **Commit:** `2320a3b`

### Auth Gates

None encountered. All work was code-only; no operator credentials, dashboard
clicks, or email links required during execution. The Task 5 operator
runbook (Supabase Dashboard rate-limit mirror + Turnstile/hCaptcha toggle)
is documented in config.toml + plan frontmatter `user_setup` as a
**post-merge** action — it is not blocking and is tracked under the
deferred-follow-ups section below.

## Deferred Follow-ups

1. **`PROXY_EMAIL_NOT_CONFIRMED` sentinel** + renderer copy. Today the 403
   `email_not_confirmed` and `aliased_email` Edge Function responses surface
   as `PROXY_NETWORK` in `proxyClient.trialClaim()`. A follow-up quick task
   should add the sentinel constant in `src/main/cloud/proxyErrors.ts`,
   thread it through `trialClaim()`'s 403 branch (probably via a switch on
   `res.json?.code`), and add user-facing copy in the renderer's error map.

2. **Operator dashboard mirror (H1 USER-action).** The `[auth.rate_limit]`
   block in `supabase/config.toml` is LOCAL-DEV ONLY. The operator must
   mirror the values in Supabase Dashboard → Authentication → Rate Limits
   after deploying, AND enable Cloudflare Turnstile (or hCaptcha) under Bot
   Protection. The runbook lives at the top of the new config block plus the
   plan's `user_setup` frontmatter — surface to the operator at the next
   live-rollout step (per the project's documented Phase 12-18 / 13-23
   operator runbook tradition).

3. **Threat-flag scan for the submit-report `'unknown'` sentinel bucket.**
   The bucket fallback when x-forwarded-for is absent groups all
   missing-header traffic into one shared `'unknown'`-keyed bucket. In
   production, Supabase always populates XFF — this is local-dev belt-and-
   suspenders. If a future Supabase platform change drops XFF, the shared
   bucket becomes a single-collision DoS vector. Tracked but not blocking
   per plan threat register T-rfj-08 / T-rfj-09 (accepted dispositions).

## Known Stubs

None. All new code paths are wired end-to-end:
- The H2 email/alias gates run in production on every trial-claim call.
- The M9 account-age gate + per-IP bucket run on every submit-report call.
- The M11 customer-portal minute gate runs on every customer-portal call.
- The M10 uniform 202 envelope is the sole 2xx success shape from trial-claim.
- The proxyClient ledger-delta classifier runs on every renderer-initiated
  trial-claim.

## TDD Gate Compliance

Tasks 2, 3, and 4 followed the TDD RED/GREEN cycle with explicit gate commits:

- **Task 2:** `test(260525-rfj-2)` 07abcca (RED — 8 deno failures + 2 vitest
  failures) → `feat(260525-rfj-2)` fc368de (GREEN — all pass).
- **Task 3:** `test(260525-rfj-3)` 84ac78b (RED — `makeHandler` import error,
  test file fails to collect) → `feat(260525-rfj-3)` a9c958f (GREEN — all pass).
- **Task 4:** `test(260525-rfj-4)` 65811c5 (RED — `customerPortalMinuteGate`
  module not found, 7 failures) → `feat(260525-rfj-4)` de6e54f (GREEN — all
  pass).

No REFACTOR commits — each GREEN matched the plan's `<action>` block verbatim
modulo the two Rule-1 deviations above; nothing to clean up.

Tasks 1 and 5 are not TDD (Task 1 is a migration + type union widening;
Task 5 is a config-only addition).

## Threat Flags

No surface introduced by this plan falls outside the plan's `<threat_model>`.
All seven `mitigate`-disposition threats (T-rfj-01 through T-rfj-06) are
addressed in the code; the three `accept`-disposition threats (T-rfj-07
ledger-delta best-effort, T-rfj-08 XFF trust, T-rfj-09 NAT IP-bucket
collisions) are documented in the relevant docblocks.

## Self-Check: PASSED

Files created (3):
- FOUND: `supabase/migrations/20260528001100_rate_buckets_reports_ip_customer_portal.sql`
- FOUND: `proxy/src/rateLimit/customerPortalMinuteGate.ts`
- FOUND: `proxy/src/rateLimit/customerPortalMinuteGate.test.ts`

Files modified (11): all confirmed via `git log` per-commit diff.

Commits (8) — all present in `git log`:
- FOUND: `2320a3b feat(260525-rfj-1)`
- FOUND: `07abcca test(260525-rfj-2)` (RED)
- FOUND: `fc368de feat(260525-rfj-2)` (GREEN)
- FOUND: `84ac78b test(260525-rfj-3)` (RED)
- FOUND: `a9c958f feat(260525-rfj-3)` (GREEN)
- FOUND: `65811c5 test(260525-rfj-4)` (RED)
- FOUND: `de6e54f feat(260525-rfj-4)` (GREEN)
- FOUND: `89ea9b0 chore(260525-rfj-5)`
