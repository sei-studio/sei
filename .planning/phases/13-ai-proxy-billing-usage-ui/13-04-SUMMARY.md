---
phase: 13
plan: 04
subsystem: proxy/auth
tags: [proxy, auth, jose, jwt, jwks, hono-middleware, tdd]
requirements_completed: [PROXY-08]
dependency_graph:
  requires:
    - proxy/src/env.ts (13-03 — Zod env loader provides SUPABASE_JWKS_URL)
    - hono 4.12.22 (13-03)
    - jose 6.2.3 (13-03)
  provides:
    - proxy/src/auth/jwks.ts (JWKS singleton, 1h cached per D-39)
    - proxy/src/auth/verifyJwt.ts (Hono middleware, sets c.var.userId)
    - AuthVars type ({ userId: string }) — consumed by every Wave 2+ handler
  affects:
    - proxy/src/app.ts (will mount `app.use('/v1/*', verifyJwt)` in plan 13-10)
    - proxy/src/middleware/preDeduct.ts (13-05/06 — reads c.var.userId)
    - proxy/src/middleware/rateLimitGate.ts (13-07 — reads c.var.userId)
    - proxy/src/forward.ts (13-08 — reads c.var.userId for ledger tagging)
tech_stack:
  added: []
  patterns:
    - "vitest mock pattern for jose (createRemoteJWKSet stub + per-test jwtVerify mock) — reusable for any future jose-touching middleware in proxy/"
    - "Hono typed Variables generic threaded through MiddlewareHandler<{Variables:{...}}> — c.var.userId is statically typed everywhere downstream"
    - "Single-line err.message in error envelopes — never err.stack (T-13-04-04)"
key_files:
  created:
    - proxy/src/auth/jwks.ts (15 lines)
    - proxy/src/auth/verifyJwt.ts (40 lines)
    - proxy/src/auth/verifyJwt.test.ts (180 lines, 9 vitest cases)
  modified: []
decisions:
  - "JWKS cache window = 1h via cacheMaxAge=3600000ms; cooldownDuration=30000ms (jose default kept explicit) — single Supabase JWKS round-trip per proxy boot under steady traffic (T-13-04-05)"
  - "Detail field on invalid_jwt = err.message ONLY (truncated to single line, no inner cause / no stack) — T-13-04-04 information-disclosure mitigation. Full diagnostic capture deferred to Sentry hook in plan 13-10"
  - "Bearer prefix check uses string startsWith + slice (not regex / split) — defensive against whitespace-after-Bearer edge cases; jose would already reject malformed tokens but failing fast at the prefix keeps the error envelope deterministic"
  - "payload.sub guard checks BOTH typeof==='string' AND length>0 (T-13-04-06) — JWT spec permits sub as number; explicit guard rejects, returns invalid_jwt with detail='no sub claim'"
metrics:
  duration_minutes: 2.2
  tasks_completed: 1
  files_created: 3
  files_modified: 0
  commits: 2
completed: 2026-05-22
---

# Phase 13 Plan 04: verifyJwt Middleware Summary

JWT verification middleware for the Fly.io proxy (PROXY-08) — `jose.createRemoteJWKSet` with 1h cache plus `jose.jwtVerify` against `audience='authenticated'`, exposing `userId` via Hono's typed `c.var`.

## What Shipped

Three files under `proxy/src/auth/`:

1. **`jwks.ts`** (15 lines) — module-level `createRemoteJWKSet(new URL(env.SUPABASE_JWKS_URL), { cacheMaxAge: 3600000, cooldownDuration: 30000 })` singleton. Called once at module load via `loadEnv()` from `../env.js`. Subsequent imports return the same cached `JWKS` getter — every `jwtVerify` call shares the in-memory JWK cache (T-13-04-05 DoS mitigation: at most one network round-trip per proxy boot under steady traffic, 30s cooldown if a never-seen `kid` arrives).

2. **`verifyJwt.ts`** (40 lines) — `MiddlewareHandler<{Variables: { userId: string }}>` exported as `verifyJwt`. Plus an exported `AuthVars` type so downstream Wave 2 handlers can declare their context generic verbatim:
   ```ts
   const handler: Handler<{ Variables: AuthVars & MyVars }> = ...
   ```

3. **`verifyJwt.test.ts`** (180 lines, **9 vitest cases**) — exceeds the plan's required 7 cases. Pattern documented in `<behavior>`: `vi.mock('jose')` returns a `createRemoteJWKSet` stub plus a per-test-controllable `jwtVerify` mock. Tests build a fresh `Hono<{Variables:{userId:string}}>` app, mount `verifyJwt` on `/v1/*`, and `app.request(...)` against the test routes (no port binding).

## Error Envelope Coverage

All four 401 envelopes are exhaustively tested:

| Trigger | Status | Body |
|---------|--------|------|
| No `Authorization` header | 401 | `{ error: 'missing_jwt' }` |
| Header without `Bearer ` prefix | 401 | `{ error: 'missing_jwt' }` |
| jose `ERR_JWT_EXPIRED` | 401 | `{ error: 'expired_jwt' }` |
| jose signature failure | 401 | `{ error: 'invalid_jwt', detail: 'signature verification failed' }` |
| jose audience mismatch | 401 | `{ error: 'invalid_jwt', detail: '<msg>' }` |
| `payload.sub` undefined | 401 | `{ error: 'invalid_jwt', detail: 'no sub claim' }` |
| `payload.sub` non-string (number) | 401 | `{ error: 'invalid_jwt', detail: 'no sub claim' }` |
| Valid JWT with `sub='abc-uuid'` | 200 (next handler) | `c.var.userId === 'abc-uuid'` |

Test #9 is a structural assertion that `jose.jwtVerify` is invoked with `{ audience: 'authenticated' }` as its third argument — T-13-04-02 (wrong-audience spoofing) mitigation enforced at the call site, not just relied on as documentation.

## TDD Discipline

Two commits, RGR cycle visible in `git log`:

| Hash | Type | Description |
|------|------|-------------|
| `42b72b0` | `test(13-04)` | RED — 9 failing vitest cases for verifyJwt |
| `320b283` | `feat(13-04)` | GREEN — jwks.ts + verifyJwt.ts impl; 9/9 tests pass |

No REFACTOR commit needed: the implementation matches the plan's `<implementation>` block almost verbatim (only doc-comments added). No cleanup pass produced meaningful diff.

RED run confirmed: 9 tests failed with `Failed to load url ./verifyJwt.js` — files didn't exist yet, vitest collection-time error. GREEN run on the same test file: `9 passed (9)`, 37ms total.

## Verification

Plan `<verification>` block — all 5 checks pass:

- [x] 9 vitest tests in `proxy/src/auth/verifyJwt.test.ts`, all passing (`npx vitest run src/auth/verifyJwt.test.ts` → 9/9 in 223ms).
- [x] TDD commit history: `42b72b0` test RED → `320b283` feat GREEN, both compile and pass tests after GREEN.
- [x] `npm run build` in `proxy/` produces `dist/auth/verifyJwt.js` + `dist/auth/jwks.js`.
- [x] `grep -c "audience: 'authenticated'" proxy/src/auth/verifyJwt.ts` → 1.
- [x] `grep -c "cacheMaxAge: 60 \* 60 \* 1000" proxy/src/auth/jwks.ts` → 1.

## Threat Mitigations Realized

All 6 STRIDE entries from `<threat_model>` have concrete code or test evidence:

| ID | Category | Where | Evidence |
|----|----------|-------|----------|
| T-13-04-01 | Spoofing (forged JWT) | `jwtVerify(token, JWKS, ...)` | Signature failures throw → catch branch returns 401 invalid_jwt; test #4 mocks signature-failure error code |
| T-13-04-02 | Spoofing (wrong audience) | `{ audience: 'authenticated' }` arg | Hard-coded in verifyJwt.ts; test #9 asserts the call shape; test #5 simulates aud-mismatch error path |
| T-13-04-03 | Replay (expired JWT) | `ERR_JWT_EXPIRED` branch | Discriminated 401 envelope `expired_jwt`; client must refresh; test #3 covers |
| T-13-04-04 | Info Disclosure (error leak) | `detail: err instanceof Error ? err.message : ...` | Only `.message` — never `.stack` or inner cause; truncated implicitly to one line by JS Error semantics; test #4 asserts exact detail string |
| T-13-04-05 | DoS (JWKS endpoint flood) | `cacheMaxAge: 3600000`, `cooldownDuration: 30000` | jose's internal cache; single round-trip per proxy boot under steady traffic |
| T-13-04-06 | Tampering (sub=null/number) | `typeof payload.sub !== 'string' || payload.sub.length === 0` | Explicit guard before `c.set`; tests #6 (undefined) + #7 (numeric) cover both cases |

## Threat Flags

None. No new network endpoints, no new auth paths, no schema changes. verifyJwt is purely a trust-anchor function whose threat surface is documented at the plan level.

## Deviations from Plan

### Auto-fixed Issues

None. Plan executed exactly as written — implementation block was directly usable.

### Minor refinements within plan discretion

1. **9 tests instead of 7.** Plan called for "7+ vitest tests". Split `payload.sub` invalid case into two tests (`sub=undefined` + `sub=number`) for explicit coverage of both T-13-04-06 attack vectors. Added a 9th test asserting `jwtVerify` is called with `{ audience: 'authenticated' }` — guards against an accidental future refactor that drops the audience arg (silent regression of T-13-04-02).

2. **Test harness builds a fresh Hono app per test.** Plan sketched directly invoking `verifyJwt(ctx, next)` with a hand-rolled context. Used `new Hono<{Variables:{userId:string}}>()` + `app.request(...)` instead — exercises the real Hono dispatch path including how Hono translates `c.json(..., 401)` into a `Response` object, so we're testing what production runs (not a context shim).

3. **JSDoc comment on `verifyJwt`** added beyond what the plan's `<implementation>` block contains — enumerates all four error envelopes inline with the implementation so anyone editing the function sees the contract without bouncing to plan/SUMMARY. Plan-compliant: implementation block was a sketch, comments are documentation overlay.

## Deferred Items

None.

## Known Stubs

None — verifyJwt is fully functional; no placeholder data, no mock-data-flowing-to-UI patterns.

## Next Action

Wave 2 continues. Plan 13-05 (preDeduct middleware) is already in-flight on a sibling agent (uncommitted `proxy/src/ledger/preDeduct.test.ts` + `proxy/src/supabase.ts` observed in worktree status — out of scope for 13-04). Plans 13-05 → 13-10 mount on top of `verifyJwt` via `app.use('/v1/*', verifyJwt)` (plan 13-10's wire-up) and read `c.var.userId` from the typed context.

## Self-Check: PASSED

Files verified to exist:
- FOUND: `/Users/ouen/slop/sei/proxy/src/auth/jwks.ts`
- FOUND: `/Users/ouen/slop/sei/proxy/src/auth/verifyJwt.ts`
- FOUND: `/Users/ouen/slop/sei/proxy/src/auth/verifyJwt.test.ts`

Commits verified in git log:
- FOUND: `42b72b0` (test RED)
- FOUND: `320b283` (feat GREEN)
