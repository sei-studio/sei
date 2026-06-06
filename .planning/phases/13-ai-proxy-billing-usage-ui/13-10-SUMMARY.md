---
phase: 13
plan: 10
subsystem: proxy
tags: [proxy, hono, wiring, integration, middleware-order]
requirements_addressed: [PROXY-07, PROXY-08, PROXY-09, PROXY-10]
dependency-graph:
  requires:
    - 13-04 (verifyJwt + JWKS)
    - 13-05 (preDeduct + tokenize + pricing + balance)
    - 13-06 (settle / settleAsRefunded / settleAtReservation)
    - 13-07 (checkAllBuckets + supabase.ts admin client)
    - 13-08 (forwardToAnthropic with DI bag)
    - 13-09 (sentinel envelope + extractUsage helper)
  provides:
    - proxy /v1/messages middleware chain end-to-end (verifyJwt → rateLimitGate → forwardToAnthropic)
    - rateLimitGate Hono wrapper (proxy/src/rateLimit/gate.ts)
  affects:
    - proxy/src/app.ts (replaces 13-03 501 stub)
    - proxy/src/index.test.ts (501-stub assertion → 401 missing_jwt assertion)
tech-stack:
  added: []
  patterns:
    - "Hono middleware chain composition via per-route signature (app.post(path, mw1, mw2, handler))"
    - "Body-cache invariant: gate.ts calls c.req.json() (caches raw text); forward.ts subsequently c.req.text() sees identical bytes — preserves T-13-08-07 cache_control marker preservation across the chain"
    - "vi.mock at import level for ALL Wave 2 modules + vi.stubGlobal('fetch', mockFetch) — integration test exercises chain in isolation with zero Supabase / Anthropic I/O"
key-files:
  created:
    - path: proxy/src/rateLimit/gate.ts
      purpose: "Hono middleware wrapping checkAllBuckets (13-07). On rate_limited verdict emits 429 with Retry-After HTTP header + JSON retry_after_seconds field."
    - path: proxy/src/rateLimit/gate.test.ts
      purpose: "3 tests: allowed→next(), denied→429+Retry-After, defaults for missing model/max_tokens."
    - path: proxy/src/app.test.ts
      purpose: "5 integration tests covering happy path + 402 + 429 + 503 + 401 short-circuits; confirms middleware ordering invariants."
  modified:
    - path: proxy/src/app.ts
      purpose: "Replaced 13-03 501 stub with verifyJwt → rateLimitGate → forwardToAnthropic chain. DI bag binds preDeduct/settle/settleAsRefunded/settleAtReservation/remainingPct/estimateInputTokens + ANTHROPIC_API_KEY from loadEnv()."
    - path: proxy/src/index.test.ts
      purpose: "Shell smoke test: POST /v1/messages without Authorization → 401 missing_jwt (was 501 stub). /health remains 200 — unchanged."
decisions:
  - "Body-cache invariant locked: gate.ts calls c.req.json(); Hono's #cachedBody('text') stores the raw text on the request, so forward.ts's subsequent c.req.text() returns identical bytes. The cache_control marker invariant from T-13-08-07 (verbatim forward) survives the chain. Verified by inspecting hono/dist/request.js — `json()` delegates to `#cachedBody('text').then(JSON.parse)` and `text()` returns the same cached promise."
  - "Default model='claude-haiku-4-5' / max_tokens=1024 applied IN gate.ts when client omits them — matches forward.ts defaults so the bucket-check reservation estimate equals the actual preDeduct reservation. Per-route consistency in defaults avoids the cap from gate.ts disagreeing with the actual reserve_credits call."
  - "Retry-After emitted as INTEGER seconds (HTTP/1.1 RFC 7231 §7.1.3 form), NOT HTTP-date — renderer (13-13 proxyClient) reads the JSON `retry_after_seconds` field as the source of truth; the header is convenience for non-Sei clients."
  - "vi.stubGlobal('fetch', mockFetch) in app.test.ts beforeAll — because app.ts captures `fetch` into the DI bag at module init (`fetchImpl: fetch`), the global MUST be stubbed BEFORE the first `await import('./app.js')` in any test. vi.stubGlobal in beforeAll satisfies this."
metrics:
  duration: "~12 minutes (single agent, three sequential commits)"
  completed: "2026-05-22"
  tests-added: 8
  files-created: 3
  files-modified: 2
---

# Phase 13 Plan 10: /v1/messages Middleware Chain Wiring Summary

One-liner: Replaced the Wave-1 `501 not_implemented_yet` stub on POST /v1/messages with the live `verifyJwt → rateLimitGate → forwardToAnthropic` chain, plus 5 integration tests covering all four happy / 402 / 429 / 503 / 401 short-circuit paths.

## What Changed

| File | Change |
|------|--------|
| `proxy/src/rateLimit/gate.ts` | **NEW** — 52-line Hono middleware wrapper. Reads userId from `c.var.userId`, parses body via `c.req.json()` (caches raw text), estimates input tokens + reservation µ$, calls `checkAllBuckets(userId, estInput, reservationMicro)`. On allowed → `next()`; on rate-limited → `sendError(c, {code:'rate_limited', kind, retry_after_seconds})` with `Retry-After: <int>` HTTP header. |
| `proxy/src/rateLimit/gate.test.ts` | **NEW** — 3 tests via vi.mock of buckets/tokenize/pricing. Asserts allowed-path calls next(), denied-path emits 429+Retry-After+kind+retry_after_seconds in JSON, defaults applied when body omits model/max_tokens. |
| `proxy/src/app.ts` | **MODIFIED** — removed 501 stub; wired `app.post('/v1/messages', verifyJwt, rateLimitGate, (c) => forwardToAnthropic(c, depsBag))`. `/health` stays public (registered first). `loadEnv()` invoked at module init to surface ANTHROPIC_API_KEY into the DI bag. |
| `proxy/src/index.test.ts` | **MODIFIED** — the 501-stub assertion was replaced with `POST /v1/messages without Authorization → 401 missing_jwt`. This confirms the chain is reachable (verifyJwt is wired) without duplicating app.test.ts. |
| `proxy/src/app.test.ts` | **NEW** — 5 integration tests covering the chain end-to-end with all Wave 2 modules mocked at import level. |

## Middleware Chain (LOCKED Order)

```
POST /v1/messages
   ↓
verifyJwt (13-04)              [401 missing_jwt / invalid_jwt / expired_jwt]
   ↓ sets c.var.userId
rateLimitGate (13-10/13-07)    [429 rate_limited + Retry-After]
   ↓ checkAllBuckets verdict was 'allowed:true'
forwardToAnthropic (13-08)
   ├ preDeduct                 [402 payment_required]
   ├ fetch api.anthropic.com   [502 upstream_error / 503 service_at_capacity / 504 upstream_timeout]
   ├ stream/JSON pass-through (X-Sei-Remaining-Pct header pre-stream-open)
   └ settle / settleAsRefunded / settleAtReservation
```

Three trust-boundary invariants:
1. **verifyJwt is first** — every downstream step needs `c.var.userId`. Integration Test 5 enforces this at app-test level (T-13-10-02).
2. **rateLimitGate is BEFORE preDeduct** — denied requests never acquire `user_balance_lock FOR UPDATE`. Integration Test 3 confirms `mockPreDeduct` is NOT called when rate-limit denies (T-13-10-01).
3. **preDeduct + settle are CO-LOCATED inside forwardToAnthropic** — reservation lifecycle owned by one module; chain composition doesn't have to know about reservation state machines.

## Integration Test Coverage (5/5)

| # | Scenario | Status | Assertions |
|---|----------|--------|------------|
| 1 | Happy path | 200 | `X-Sei-Remaining-Pct=80`, `settle` called once with res-1 + usage + msg_xyz |
| 2 | 402 payment_required | 402 | `checkAllBuckets` DID run (ordering); `mockFetch` and `settle*` NOT called |
| 3 | 429 rate_limited | 429 | `Retry-After: 42` header; JSON `kind='rpm'`, `retry_after_seconds=42`; `preDeduct` NOT called |
| 4 | 503 service_at_capacity | 503 | Upstream returned 429 → translated; `settleAsRefunded('res-1')` called; `settle` NOT |
| 5 | 401 missing_jwt | 401 | No `checkAllBuckets`, `preDeduct`, or `fetch` invocations |

Body: `{ model: 'claude-haiku-4-5', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }`
Auth: `{ Authorization: 'Bearer mock-jwt' }` (Tests 1–4); absent (Test 5).

## Plan Verification Checks

| Check | Expected | Actual |
|-------|----------|--------|
| `cd proxy && npm test` | All proxy tests green, ≥50 | **93/93 passing** |
| `npm run build` | clean | clean |
| `grep -E 'verifyJwt, rateLimitGate, ' proxy/src/app.ts \| wc -l` | 1 | **1** |
| `grep -c "app.get.*'/health'" proxy/src/app.ts` | 1 | **1** |
| Task 1 (`npm test -- gate`) | 3 passed | **3 passed** |
| Task 3 (`npm test -- app.test`) | 5 passed | **5 passed** |

## Threat Model Mitigations Verified

| Threat ID | Disposition | How Verified |
|-----------|-------------|--------------|
| T-13-10-01 (rate-limited request hits ledger lock) | mitigate | Integration Test 3 asserts `mockPreDeduct` is NOT called when `checkAllBuckets` returns `allowed:false`. Chain order in `app.post(..., verifyJwt, rateLimitGate, ...)` is enforced by Hono. |
| T-13-10-02 (reordering bypasses auth) | mitigate | Integration Test 5: missing JWT → 401, no downstream mocks called. `verifyJwt` is positional argument 1 in `app.post()`. |
| T-13-10-03 (body parsed twice with different content) | mitigate | Hono's `#cachedBody('text')` shared cache: `c.req.json()` in gate.ts → cached raw text → `c.req.text()` in forward.ts returns same bytes. Verified by reading `hono/dist/request.js`. forward.test.ts Test 8 already proves verbatim forwarding. |
| T-13-10-04 (onError leaks stack) | mitigate | `app.onError` logs only `err.name + err.message`; response body is the fixed `{error:'internal_error'}` envelope. No `err.stack` access anywhere in app.ts. |
| T-13-10-05 (/health requires auth — regression risk) | mitigate | `app.get('/health', ...)` is registered BEFORE the `app.post('/v1/messages', verifyJwt, ...)` route — Hono applies middleware per-route, not globally. `index.test.ts` "GET /health returns 200" test (unchanged from 13-03) confirms unauthenticated 200. |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Updated index.test.ts 501-stub assertion**
- **Found during:** Task 2 (post-app.ts wire)
- **Issue:** `proxy/src/index.test.ts` had a test `POST /v1/messages returns 501 stub` written in 13-03 specifically to assert the placeholder behavior. 13-10's whole purpose is replacing that stub, so the test was guaranteed to fail.
- **Fix:** Rewrote the test to assert `POST /v1/messages without Authorization → 401 missing_jwt`. This is a minimal smoke check that the chain is reachable; full ordering coverage lives in `app.test.ts`.
- **Files modified:** `proxy/src/index.test.ts`
- **Commit:** `5366508` (included in Task 2 commit since they're a single coherent change)

No bugs, no missing critical functionality, no architectural changes needed. The plan executed exactly as written.

## Self-Check: PASSED

- [x] FOUND: proxy/src/rateLimit/gate.ts
- [x] FOUND: proxy/src/rateLimit/gate.test.ts
- [x] FOUND: proxy/src/app.test.ts
- [x] FOUND (modified): proxy/src/app.ts
- [x] FOUND (modified): proxy/src/index.test.ts
- [x] FOUND commit 19dfb25 (test: RED for gate)
- [x] FOUND commit 573e8f8 (feat: gate.ts impl + GREEN)
- [x] FOUND commit 5366508 (feat: app.ts wiring + index.test fix)
- [x] FOUND commit 7f5ed6b (test: app.test.ts integration)

## TDD Gate Compliance

| Gate | Commit | Status |
|------|--------|--------|
| RED (gate.test.ts) | `19dfb25` | `test(13-10): add failing tests for rateLimitGate middleware` — confirmed failing before implementation |
| GREEN (gate.ts) | `573e8f8` | `feat(13-10): implement rateLimitGate Hono middleware` — 3/3 passing |
| RED (app.test.ts) | folded into `7f5ed6b` | All Wave 2 deps were ready, so integration tests passed first run; no RED commit needed (TDD gate satisfied at suite level — the chain itself is the new code from Task 2) |

## Known Stubs

None. The /v1/messages chain is now live end-to-end. The proxy is operationally ready for `fly deploy` (operator task in plan 13-23).

## Threat Flags

None. All security-relevant surface introduced is documented in the 13-10 threat model and mitigated by middleware ordering + sentinel envelope. No new endpoints, no new auth paths, no new file access patterns.
