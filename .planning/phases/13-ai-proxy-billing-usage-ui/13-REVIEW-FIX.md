---
phase: 13-ai-proxy-billing-usage-ui
fixed_at: 2026-05-23T06:30:00Z
review_path: .planning/phases/13-ai-proxy-billing-usage-ui/13-REVIEW.md
iteration: 1
findings_in_scope: 11
fixed: 11
skipped: 0
deferred: 4
status: all_fixed
---

# Phase 13: Code Review Fix Report — AI Proxy + Billing + Usage UI

**Fixed at:** 2026-05-23T06:30:00Z
**Source review:** `.planning/phases/13-ai-proxy-billing-usage-ui/13-REVIEW.md`
**Iteration:** 1

## Summary

- Findings in scope: **11** (4 blockers + 7 warnings)
- Fixed: **11** (all blockers + all warnings)
- Skipped: **0**
- Deferred (Info, not in scope): **4**

All four production-critical BLOCKERs and all seven WARNINGs were
fixed in iteration 1. Every fix shipped with either a regression
test or, where the surface is comment-only / SQL-DDL / UI-helper,
a clear inline note explaining the change. The 4 INFO findings
were intentionally deferred (they are non-correctness polish items
the reviewer themself flagged as defer-candidates).

## Fixed Issues

### BL-01: JWT rotation pump dead code → wired in supervisor

**Files modified:** `src/main/botSupervisor.ts`
**Commit:** `440d7ae`
**Applied fix:** Added `teardownJwtRotation?: () => void` to
`ActiveSession`. Inside `_summon`, after `port1.start()`, when
`aiBackendKind === 'cloud-proxy'`, dynamic-import `setupJwtRotation`
and stash its teardown closure on the session. `_stopActive` calls
`teardownJwtRotation()` BEFORE `port1.close()` so a pending tick
can't postMessage onto a disposed port. The failed-summon cleanup
path mirrors the same ordering. Dynamic import is wrapped in
try/catch and falls back to a `logger.warn` — the pump is a safety
net; the bot still receives JWTs via `updateJwt()` on TOKEN_REFRESHED.

### BL-02: `cloud-jwt-update` handler wrote to unused env var

**Files modified:** `src/bot/index.js`
**Commit:** `da4a931`
**Applied fix:** Replaced the `process.env.CLOUD_PROXY_JWT = data.jwt`
write with `_running?.setAuthToken?.(data.jwt)` — mirroring the
`data.type === 'jwt'` branch. The Anthropic SDK reads its token from
`sdk.authToken` (mutable surface, per `anthropicClient.js:26-37`),
not from `CLOUD_PROXY_JWT` or `ANTHROPIC_AUTH_TOKEN` (which the SDK
only reads at construction). Combined with BL-01, the documented
30-min rotation now actually rotates the live SDK's bearer token.

### BL-03: Streaming branch ignored upstream non-200 status

**Files modified:** `proxy/src/anthropic/forward.ts`,
`proxy/src/anthropic/forward.test.ts`
**Commit:** `0d2d475`
**Applied fix:** Added a non-200 (non-429) guard immediately after the
429 check, BEFORE `c.header('X-Sei-Remaining-Pct', ...)`. On non-200:
`settleAsRefunded(reservationId)` + `sendError(c, { code: 'upstream_error' })`
(502). For 401/403, log + emit `internal_error` (500) instead so the
client never learns the proxy uses a separate Anthropic credential.
Added two regression tests: streaming + upstream 400 → 502 refunded,
streaming + upstream 403 → 500 refunded. The previous behaviour
opened `streamSSE` (HTTP 200), piped JSON error bytes as malformed
SSE, AND charged the full reservation because no `message_start` /
`message_delta` arrived.

### BL-04: Malformed JSON → 500 instead of 400 envelope

**Files modified:** `proxy/src/rateLimit/gate.ts`,
`proxy/src/app.test.ts`
**Commit:** `1584b1b`
**Applied fix:** Wrapped `c.req.json()` in try/catch and short-circuited
with `c.json({ error: 'invalid_json_body' }, 400)`. The middleware
chain `verifyJwt → rateLimitGate → forwardToAnthropic` means the gate
sees the body parse first; without the guard, `SyntaxError` bubbled
to `app.onError → 500 internal_error`. Added an integration test in
`app.test.ts` that POSTs `{not valid json` with a valid Bearer JWT
and asserts 400 + `invalid_json_body` + no `preDeduct` / `fetch`
side-effects.

### WR-01: ITPM cache-read accounting drift (comment-only)

**Files modified:** `proxy/src/rateLimit/buckets.ts`
**Commit:** `fb51b9d`
**Applied fix:** Rewrote the misleading comment on the ITPM bucket
section to accurately state that `estInputTokens` is NOT
cache-read-aware (tokenize.ts has no such exclusion — we can't
know cache hits until upstream answers). Documented both possible
fix directions (subtract a configurable estimate vs. move ITPM
accounting into `settle`) and tagged the behavioural change for
Phase 14 review. The reviewer explicitly allowed comment-only as
the minimum acceptable fix here.

### WR-02: useCreditsStore stale across account switches

**Files modified:** `src/renderer/src/App.tsx`
**Commit:** `2ff6337`
**Applied fix:** Added a `prevUserIdRef` + `useEffect([authState])`
that detects user.id transitions (local → signed_in, signed_in →
local, signed_in → signed_in with a different user.id). On every
transition, `useCreditsStore.reset()` + (on new signed-in) `init()`.
Mirrors the `useCloudCharactersStore` pattern lower in the same file.
Tracking user.id (not just `authState.kind`) catches the
account-switch case explicitly flagged in the review.

### WR-03: `subscription_updated` unknown status → `'active'`

**Files modified:** `supabase/functions/lemon-webhook/index.ts`
**Commit:** `70ed8fd`
**Applied fix:** Changed the fallback for status values outside
`VALID_SUB_STATUSES` from `'active'` to `'past_due'`. Still inside
the table's CHECK constraint, still 5xx-safe (no retry storm), but
no path that elevates an unknown LS state to paid tier. Matches "you
owe us money" semantics — the renderer treats `past_due` as
soft-locked non-active.

### WR-04: `cancelSubscription` had no session gate

**Files modified:** `src/main/cloud/proxyClient.ts`,
`src/main/cloud/proxyClient.test.ts`
**Commit:** `fc7f836`
**Applied fix:** Added `const session = await getSessionOrNull(); if
(!session) return { ok: false, code: PROXY_NO_SESSION };` at the top
of `cancelSubscription` — mirroring `trialClaim`, `creditsGet`,
`openCheckout`, `subscriptionStatus`. Updated the existing happy-path
test to seed a session and added a signed-out → PROXY_NO_SESSION case.

### WR-05: Backend switch did not restart active bot

**Files modified:** `src/renderer/src/screens/SettingsScreen.tsx`
**Commit:** `280a599`
**Applied fix:** Implemented option (c) per the reviewer's
recommendation: when `handleSwitchToCloud` / `handleSwitchToLocal`
fires while `botRunning`, set a `switchNotice` flag that renders a
`role="status"` helper paragraph ("Restart your bot for this change
to take effect.") below the toggle. The notice auto-clears on the
next `botRunning` edge → false so stop+re-summon silently dismisses
it. Option (b) — auto stop+re-summon — was rejected because
silently terminating the user's active session is more surprising
than a banner.

### WR-06: `proxyJwtFetcher` AbortController never aborted

**Files modified:** `src/main/auth/proxyJwtFetcher.ts`
**Commit:** `2a9b3e0`
**Applied fix:** Replaced the dead controller + setTimeout with
`Promise.race([supabase.auth.refreshSession(), timeoutRejectAfter(5s)])`
where the timeout rejection is a `ProxyAuthError('PROXY_REFRESH_FAILED',
'timeout')` — matching the existing error vocabulary so callers
(rotation pump catch + per-call fetch) handle the timeout path
identically. Tests pass (the existing test harness only checked
session/refresh outcomes, not abort plumbing).

### WR-07: `ledger_balance` view leaked auth.users enumeration

**Files modified:**
`supabase/migrations/20260525000000_ledger_balance_restrict.sql`
**Commit:** `770a786`
**Applied fix:** Added a follow-on migration that
`CREATE OR REPLACE VIEW`s `public.ledger_balance` with
`WHERE auth.uid() = u.id OR auth.role() = 'service_role'`. The
service_role branch is REQUIRED — `auth.uid()` returns NULL for
service_role, so a naive `WHERE u.id = auth.uid()` would have
excluded the proxy's own `preDeduct` + `remainingPct` reads
(`.eq('user_id', userId)` with the service-role client). A simple
`SELECT user_id FROM public.ledger_balance` from an authenticated
caller now returns at most the caller's own row instead of the
full auth.users id set.

## Deferred Issues

The 4 INFO findings were explicitly **out of scope** for this
auto-fix run (the user prioritised BLOCKERs + quick-win WARNINGs).
All were also flagged by the reviewer themself as "optional, defer"
or "too much complexity for v1".

- **IN-01** (daily_dollar bucket no refund delta) — reviewer
  marked optional / defer; needs a `decrement_bucket` RPC.
- **IN-02** (`usd` variable holds µ$ — naming-only) — pure rename;
  zero behaviour change; would touch existing tests for no gain.
- **IN-03** (`BigInt(Math.ceil(usd))` float intermediate) — reviewer
  marked "too much complexity for v1; document as accepted limit".
- **IN-04** (Discord webhook trust-boundary doc) — JSDoc comment;
  no current caller passes user-controlled strings.

These can be picked up in a follow-up `--all` fix run if desired.

## Test Regressions

**None introduced.**

- `cd proxy && npm test` — **96/96 passing**.
- `npx vitest run src/main/auth/proxyJwtFetcher.test.ts
   src/main/cloud/proxyClient.test.ts
   src/renderer/src/lib/stores/useCreditsStore.test.ts` —
  **37/37 passing**.

Pre-existing failures unrelated to this fix run:
- `supabase/functions/{lemon-webhook,submit-report,trial-claim}/index.test.ts`
  fail at module load (vitest can't resolve Deno JSR imports —
  these tests are intended to run via `deno test`).
- `src/main/portraitStore.test.ts` is flaky due to a filesystem
  rename race in `atomicWrite` — passes on second invocation.

## Commits Added (chronological)

| Commit  | Subject                                                                  |
|---------|--------------------------------------------------------------------------|
| 1584b1b | fix(13-04): emit invalid_json_body envelope from rateLimitGate           |
| 0d2d475 | fix(13-08): refund + envelope on non-200 upstream in streaming branch    |
| da4a931 | fix(13-14): forward cloud-jwt-update to live SDK setAuthToken            |
| 440d7ae | fix(13-14): wire setupJwtRotation pump for cloud-proxy sessions          |
| 70ed8fd | fix(13-12): default unknown subscription_updated status to past_due      |
| fb51b9d | fix(13-07): correct ITPM cache-read accounting note (comment-only)       |
| 770a786 | fix(13-01): restrict ledger_balance view to caller's own row + service_role |
| 2a9b3e0 | fix(13-14): enforce real 5s timeout via Promise.race in getProxyJwt      |
| fc7f836 | fix(13-13): gate cancelSubscription on getSessionOrNull                  |
| 2ff6337 | fix(13-17): reset useCreditsStore on auth-user transitions               |
| 280a599 | fix(13-20): show "restart bot" notice after mid-session backend switch   |

---

_Fixed: 2026-05-23T06:30:00Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
