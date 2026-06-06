---
phase: 13-ai-proxy-billing-usage-ui
plan: 14
subsystem: auth
tags: [main, auth, jwt, refresh, message-port, utility-process, supabase, proxy]

# Dependency graph
requires:
  - phase: 10-auth-foundation
    provides: supabase singleton, safeStorage session, MessagePortMain pump
  - phase: 13-02
    provides: cloud-proxy bot-side baseline contracts
provides:
  - getProxyJwt(): on-demand cloud-proxy JWT fetch with 5-min refresh buffer
  - setupJwtRotation(target): 30-min background pump to utilityProcess
  - ProxyAuthError class with stable codes (PROXY_NO_SESSION, PROXY_REFRESH_FAILED)
  - cloud-jwt-update message kind on the bot's initPort channel
  - process.env.CLOUD_PROXY_JWT slot for 13-15's anthropicClient.js per-call read
affects: [13-15, 13-16, 13-23]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "5-min pre-expiry refresh threshold + 30-min rotation pump (REFRESH_THRESHOLD_MS / ROTATION_INTERVAL_MS)"
    - "5s AbortController wall-clock budget on supabase-js refreshSession (PATTERNS pitfall every-external-call-timed)"
    - "Stable error-code vocabulary via typed ProxyAuthError class (callers branch on .code, not .message)"
    - "Distinct cloud-jwt-update message kind vs Phase 10's data.type === 'jwt' — two channels never alias"
    - "Teardown closure returned by setup* functions for clean utilityProcess lifecycle"

key-files:
  created:
    - src/main/auth/proxyJwtFetcher.ts
    - src/main/auth/proxyJwtFetcher.test.ts
  modified:
    - src/bot/index.js

key-decisions:
  - "5-min refresh buffer (REFRESH_THRESHOLD_MS) absorbs clock skew + network jitter so a request never lands at the proxy with an exp-just-past token"
  - "30-min rotation interval × 1h Supabase JWT expiry = 30-min recovery buffer if a single tick fails on a network blip"
  - "Distinct message kind 'cloud-jwt-update' (rather than reusing Phase 10's data.type === 'jwt') so the cloud-proxy bearer and Supabase user JWT never alias on the bot's initPort dispatch"
  - "Seed tick fires immediately so bot has CLOUD_PROXY_JWT before its first cloud-proxy call rather than waiting up to 30 min"
  - "Running flag re-checked between getProxyJwt await and postMessage so a teardown mid-refresh doesn't push a final message into a disposed port"

patterns-established:
  - "Cloud-proxy JWT lifecycle: getProxyJwt() per-call + setupJwtRotation() background pump — composable primitives that 13-15 wires together"
  - "ProxyAuthError sentinel codes pattern: caller branches on err.code for retry/UX decisions; err.message is human-readable diagnostic only"
  - "Test harness for setInterval-driven async pumps: vi.useFakeTimers + step-an-interval-at-a-time advanceTimersByTimeAsync (microtasks drain between fires deterministically)"
  - "Bot initPort handler kind/type split: legacy data.type === '...' messages + new data.kind === '...' messages coexist in the same dispatch switch"

requirements-completed: [PROXY-08]

# Metrics
duration: 7min
completed: 2026-05-22
---

# Phase 13 Plan 14: Cloud-Proxy JWT Fetcher + utilityProcess Rotation Pump Summary

**getProxyJwt() + setupJwtRotation() — 5-min pre-expiry refresh, 30-min background rotation to the bot via MessagePortMain, with ProxyAuthError sentinel codes and a 5s AbortController DoS budget.**

## Performance

- **Duration:** ~7 min
- **Started:** 2026-05-22T21:49:45Z
- **Completed:** 2026-05-22T21:56:00Z (approx)
- **Tasks:** 2 (Task 1 TDD: RED+GREEN, Task 2: bot handler)
- **Files modified:** 3 (2 new, 1 modified)

## Accomplishments

- `getProxyJwt()` reads the current Supabase session and refreshes via `refreshSession` when expiry is within 5 minutes — closes the silent-1h-failure window for long bot sessions.
- `setupJwtRotation(target)` background pump posts `{kind:'cloud-jwt-update', jwt}` to the bot's utilityProcess every 30 min, with a seed tick on startup so the bot has CLOUD_PROXY_JWT before its first cloud-proxy call.
- `ProxyAuthError` class with stable codes (`PROXY_NO_SESSION`, `PROXY_REFRESH_FAILED`) gives 13-15 + 13-16 callers a clean branch surface for retry / re-auth UX.
- 5s `AbortController` wall-clock budget on `refreshSession` (PATTERNS pitfall: every external call has a timeout) — Supabase auth endpoint hang can't deadlock the rotation pump or in-flight cloud-proxy calls.
- `src/bot/index.js` initPort handler accepts `data.kind === 'cloud-jwt-update'` messages and stashes `data.jwt` on `process.env.CLOUD_PROXY_JWT` for plan 13-15's per-call read; distinct from Phase 10's `data.type === 'jwt'` channel.
- 8/8 vitest cases pass with fake timers driving the 30-min pump deterministically.

## Task Commits

Each task was committed atomically:

1. **Task 1 (RED): failing tests for getProxyJwt + setupJwtRotation** — `70686d7` (test) — 169-line test file covering 8 behaviors; fails at collection time because impl module doesn't exist.
2. **Task 1 (GREEN): proxyJwtFetcher.ts implementation** — `4f74d61` (feat) — 145-line impl module + minor test refinements to handle Date.now()-driven session aging under fake timers. 8/8 pass.
3. **Task 2: bot initPort handler for cloud-jwt-update** — `3adad81` (feat) — 12-line branch added to existing `initPort.on('message')` switch in `src/bot/index.js`.

_TDD plan: Task 1 is RED+GREEN (2 commits); Task 2 is a single feat commit (no test infrastructure changes — the verifier is a grep gate)._

## Files Created/Modified

- `src/main/auth/proxyJwtFetcher.ts` (created, 145 lines) — exports `ProxyAuthError`, `getProxyJwt()`, `JwtTarget` interface, `setupJwtRotation()`. Module-level constants `REFRESH_THRESHOLD_MS = 5 * 60 * 1000`, `ROTATION_INTERVAL_MS = 30 * 60 * 1000`, `REFRESH_TIMEOUT_MS = 5_000`.
- `src/main/auth/proxyJwtFetcher.test.ts` (created, 175 lines) — 8 vitest cases. Mocks `./supabaseClient` with stable `getSessionMock` + `refreshSessionMock` `vi.fn()` handles; uses `vi.useFakeTimers()` + `vi.setSystemTime()` + `vi.advanceTimersByTimeAsync()` to drive the 30-min interval.
- `src/bot/index.js` (modified, +12 lines) — `initPort.on('message')` switch gains a `data.kind === 'cloud-jwt-update' && typeof data.jwt === 'string'` branch that sets `process.env.CLOUD_PROXY_JWT = data.jwt`. Typeof-string guard rejects malformed messages without crashing the dispatch loop.

## Decisions Made

- **5-min refresh threshold:** absorbs clock skew + network jitter + in-flight call latency between the gate decision and the upstream Supabase request; tuned per 13-PATTERNS §"JWT rotation".
- **30-min rotation interval:** half the Supabase 1h JWT expiry — gives one full retry window for a transient network blip (T-13-14-04 disposition: accept stale-token risk for one tick).
- **Distinct `cloud-jwt-update` kind vs Phase 10's `jwt-update` / `data.type === 'jwt'`:** plan §truths is explicit; the bot's `initPort.on('message')` switch now disambiguates on `kind` vs `type` so the two channels (cloud-proxy bearer vs Supabase user IPC) never alias. Misroute would silently corrupt either Supabase IPC or the cloud-proxy bearer.
- **Seed tick in `setupJwtRotation`:** without it, the bot would call `anthropicClient.js` with no CLOUD_PROXY_JWT for up to 30 min after spawn. Fires once immediately, then settles into the 30-min cadence.
- **Running-flag re-check between getProxyJwt await and target.postMessage:** a teardown mid-refresh would otherwise push a final message into a port the caller has already disposed. The double-check (entry + post-await) keeps the lifecycle clean.
- **`vi.fn()` declared at module top-level + `vi.mock('./supabaseClient', () => …)` factory closure:** standard vitest pattern. The factory references the outer-scope mocks so per-test setup uses `getSessionMock.mockImplementation` directly.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 — Test bug] Date.now()-driven session aging under fake timers**
- **Found during:** Task 1 GREEN — the `setupJwtRotation` polling test
- **Issue:** Initial test used `mockResolvedValue` with a static `expires_at: NOW_S + 3600` (1h in the future from the fixed `setSystemTime`). When `vi.advanceTimersByTimeAsync` fast-forwarded the clock past 55 min, the fixed expires_at fell within the 5-min refresh threshold; the next `getProxyJwt` tick tried to call `refreshSession` (which wasn't mocked for that test) and threw "Cannot destructure property 'data' of '(intermediate value)'", which the tick handler swallowed via `console.warn` — and the test saw a missing postMessage call.
- **Fix:** Switched both `setupJwtRotation` tests from `mockResolvedValue({static expires_at})` to `mockImplementation(async () => ({ expires_at: Math.floor(Date.now()/1000) + 3600 }))` so every call returns a fresh 1h-in-the-future session relative to current fake time. This isolates the polling-cadence test from the refresh-path tests (which are covered explicitly by the `getProxyJwt` suite above).
- **Files modified:** `src/main/auth/proxyJwtFetcher.test.ts`
- **Verification:** 8/8 vitest cases pass; `getSessionMock.mock.calls.length` matches `postMessage.mock.calls.length` after every advance step.
- **Committed in:** `4f74d61` (Task 1 GREEN commit — test refinement folded into the impl-landing commit since both belong to the same atomic GREEN landing)

**2. [Rule 1 — Test harness] Step interval-by-interval instead of bulk-advancing 2 intervals**
- **Found during:** Task 1 GREEN (same test as deviation 1)
- **Issue:** Initial test used `await vi.advanceTimersByTimeAsync(2 * 30 * 60 * 1000)` to assert 2 ticks landed at once. With async `tick()`, vitest's fake `setInterval` queues callbacks synchronously inside one advance call but the async tick's microtasks may not all drain in lockstep — call counts became non-deterministic.
- **Fix:** Step a single 30-min interval at a time. Each `await vi.advanceTimersByTimeAsync(30 * 60 * 1000)` fires exactly one interval and drains microtasks before the next assertion. Documented inline in the test.
- **Files modified:** `src/main/auth/proxyJwtFetcher.test.ts`
- **Verification:** Same as deviation 1 — 8/8 pass.
- **Committed in:** `4f74d61`

---

**Total deviations:** 2 auto-fixed (Rule 1 test bugs; no impl-side deviations).
**Impact on plan:** Both deviations are test-harness refinements that emerged from the interaction between `vi.useFakeTimers` + `setSystemTime` + a Date.now()-checking refresh threshold. Impl matches plan §action verbatim with one safety addition (the post-await `running` re-check in `setupJwtRotation`'s tick — defense in depth for the teardown-during-refresh race). No scope creep, no architectural changes.

## Issues Encountered

- Plan §Task 2 wording ("Locate the existing `parentPort.on('message', ...)` handler … Phase 10 added it for the initial `jwt-update` kind") was approximate: the actual existing handler lives on `initPort.on('message')` (port2 transferred from main), uses `data.type === 'jwt'` (not `kind: 'jwt-update'`), and `grep -rn "jwt-update\|jwtUpdate" src/` returned no hits. The Phase 10 implementation that landed picked `data.type === 'jwt'` for the kind discriminator. **Resolution:** Followed the plan's explicit truth ("new message kind 'cloud-jwt-update'") since `setupJwtRotation` already posts that exact shape, and added the new branch alongside the existing `data.type === 'jwt'` branch inside `initPort.on('message')`. The two channels now coexist with distinct discriminators (`type` vs `kind`) — clean handoff to 13-15 which owns the per-call `process.env.CLOUD_PROXY_JWT` read in `src/bot/brain/anthropicClient.js`.

## Verification

All 5 plan §verification gates pass:

| Gate | Result |
|------|--------|
| `npx vitest run src/main/auth/proxyJwtFetcher.test.ts` | 8/8 pass |
| `grep -c "REFRESH_THRESHOLD_MS = 5 \* 60 \* 1000" src/main/auth/proxyJwtFetcher.ts` | 1 |
| `grep -c "ROTATION_INTERVAL_MS = 30 \* 60 \* 1000" src/main/auth/proxyJwtFetcher.ts` | 1 |
| `grep -c "AbortController" src/main/auth/proxyJwtFetcher.ts` | 3 (≥ 1 required) |
| `grep -c "cloud-jwt-update" src/bot/index.js` | 1 (handler added) |

Full `src/main/auth/` vitest suite (10 files, 71 cases) passes after the change — no regressions on Phase 10's auth modules.

## Self-Check: PASSED

- `src/main/auth/proxyJwtFetcher.ts` exists.
- `src/main/auth/proxyJwtFetcher.test.ts` exists.
- `src/bot/index.js` contains the `cloud-jwt-update` branch (line ~496).
- Commits `70686d7`, `4f74d61`, `3adad81` are in `git log`.

## User Setup Required

None — no external service configuration. This plan only adds JWT plumbing inside the main process and bot utilityProcess; no Supabase config changes, no proxy env vars.

## Next Phase Readiness

- **13-15 (anthropicClient.js wiring):** Ready. Reads `process.env.CLOUD_PROXY_JWT` per call. The slot is populated by the seed tick (within ~ms of bot spawn) and refreshed every 30 min thereafter.
- **13-16 (cloud-proxy retry/UX):** Ready. Can catch `ProxyAuthError` and branch on `.code === 'PROXY_NO_SESSION'` (prompt sign-in) vs `.code === 'PROXY_REFRESH_FAILED'` (retry once, then surface).
- **botSupervisor wiring:** plan 13-15 (sibling-agent in-flight) is already touching `src/main/botSupervisor.ts` to branch on `getAiBackendKind()`; the supervisor will call `setupJwtRotation(initPort1)` on spawn (where `initPort1` is the port1 side of the same MessagePortMain pair the bot reads as `initPort`) and tear down on bot stop.
- **No blockers.** PROXY-08 satisfied end-to-end on the main-process side; the missing piece is the per-call `process.env.CLOUD_PROXY_JWT` read in `anthropicClient.js`, owned by 13-15.

---
*Phase: 13-ai-proxy-billing-usage-ui*
*Completed: 2026-05-22*
