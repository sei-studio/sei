---
phase: 13-ai-proxy-billing-usage-ui
plan: 03
subsystem: infra
tags: [proxy, fly.io, hono, node-22, docker, scale-to-zero, zod, vitest, scaffolding]

# Dependency graph
requires:
  - phase: 13-ai-proxy-billing-usage-ui
    provides: nothing — Plan 13-03 is the first proxy/-side plan (Wave 1)
provides:
  - "proxy/ Fly.io app skeleton at repo root (canonical 10-file shape)"
  - "Hono v4 app exporting /health (200 ok) + /v1/messages (501 not_implemented_yet stub)"
  - "Zod-validated env loader (loadEnv) with fail-fast and all-errors-at-once reporting"
  - "Multi-stage Dockerfile (node:22-alpine, USER node, EXPOSE 8080)"
  - "fly.toml matching D-38 verbatim (region iad, 256MB, scale 0-2, soft 20 / hard 50, /health check)"
  - "package.json with pinned exact deps — reproducible Fly redeploys"
  - "Vitest smoke harness importing app from app.js (split index→app+index supports unit tests without binding a port)"
affects: [13-04, 13-05, 13-06, 13-07, 13-08, 13-09, 13-10, 13-23]

# Tech tracking
tech-stack:
  added: [hono@4.12.22, "@hono/node-server@1.13.0", jose@6.2.3, "@anthropic-ai/tokenizer@0.0.4", "@supabase/supabase-js@2.105.0", zod@4.4.3, typescript@5.6.3, tsx@4.19.0, vitest@2.1.0]
  patterns:
    - "Module-level loadEnv() singleton with Zod safeParse — fail-fast at boot, all invalid vars surfaced at once"
    - "Split entrypoint: app.ts exports default Hono app (testable) / index.ts calls serve() (production)"
    - "Generic onError envelope returning {error:'internal_error'} 500 — never leaks err.stack (T-13-03-01)"
    - "Pinned exact npm versions (no ^/~) for reproducible Fly.io redeploys"

key-files:
  created:
    - "proxy/package.json — Standalone Node service deps; engines.node=>=22; ESM"
    - "proxy/tsconfig.json — ES2023 + Bundler resolution + strict + noUncheckedIndexedAccess"
    - "proxy/fly.toml — app=sei-proxy, region=iad, 256MB, scale 0-2"
    - "proxy/Dockerfile — multi-stage node:22-alpine + USER node"
    - "proxy/.dockerignore — keep node_modules/dist/.env out of build context"
    - "proxy/.env.example — documents 5 required env names (no values)"
    - "proxy/README.md — local-dev quickstart"
    - "proxy/src/env.ts — Zod EnvSchema + loadEnv() singleton"
    - "proxy/src/app.ts — Hono app: GET /health 200, POST /v1/messages 501, notFound 404, onError 500"
    - "proxy/src/index.ts — loadEnv() at boot + @hono/node-server serve()"
    - "proxy/src/index.test.ts — 3 vitest smoke tests"
    - "proxy/package-lock.json — locked 71-package dep tree"
  modified:
    - ".gitignore — appended proxy/{node_modules,dist,.env,.env.*} + !proxy/.env.example"

key-decisions:
  - "Consolidated @hono/node-server into Task 1's package.json (plan had it as a Task-2 append). Minor sequencing optimization — keeps package.json complete after Task 1; CHECKER already endorsed the original ordering, so consolidation is also safe."
  - "Wrote the app.ts/index.ts split upfront (per plan §success_criteria canonical 10-file shape) rather than churning index.ts twice across Tasks 2→3. Test harness can import app without binding a port and Wave 2 plans drop into the stable shape directly."
  - "Added a 3rd smoke test (/unknown → 404) beyond the plan's 2 required cases. Marginal coverage of the generic notFound branch; plan's verify regex `(2 passed|Tests +2 passed)` parses '3 passed (3)' identically."

patterns-established:
  - "Pinned-exact-version Node service: every dep+devDep has a fixed semver string (no ^/~) so `npm ci` on Fly.io produces a bit-identical tree across redeploys"
  - "Zod fail-fast singleton: cached on first call, reports ALL invalid env vars in one error (not just the first), throws cleanly so Fly.io marks the machine unhealthy on misconfig"
  - "App/server split for testability: app.ts is pure (no I/O, no port binding); index.ts loads env + binds port. Vitest can import app and exercise routes via app.request() without process.exit / port collision"

requirements-completed: [PROXY-07]

# Metrics
duration: 3min
completed: 2026-05-22
---

# Phase 13 Plan 03: Proxy Scaffold Summary

**Greenfield Hono-on-Node-22 Fly.io app skeleton at `proxy/` — `/health` 200, `/v1/messages` 501 stub, Zod-validated env, multi-stage Dockerfile (USER node), fly.toml matching D-38 verbatim, vitest smoke harness — ready for Wave 2 middleware drop-in.**

## Performance

- **Duration:** ~3 min
- **Started:** 2026-05-22T21:01:59Z
- **Completed:** 2026-05-22T21:04:49Z
- **Tasks:** 3 (auto, auto, auto)
- **Files created:** 11 under `proxy/`; 1 modified (`.gitignore`)

## Accomplishments

- Greenfield `proxy/` directory at repo root with the canonical 10-file shape from plan §success_criteria
- `npm install` succeeds (71 packages, 0 errors), `npm run build` produces clean `dist/{app,env,index}.js`, `npm test` runs 3/3 vitest cases in 183ms
- Local smoke-test confirmed: `GET /health` → `200 {status:'ok',version:'1.0.0'}`, `POST /v1/messages` → `501 {error:'not_implemented_yet',plan:'13-10'}`, `GET /nonexistent` → `404 {error:'not_found'}`
- All threat-model mitigations in place: T-13-03-01 (no stack leakage in onError), T-13-03-03 (`.gitignore` excludes `proxy/.env*` but keeps `.env.example`), T-13-03-04 (Dockerfile never references `ANTHROPIC_API_KEY` — secrets injected at runtime by Fly, not build), T-13-03-06 (`USER node` drops root before CMD)
- `proxy/dist/index.js` exists post-build — operator can `fly deploy` from `proxy/` once secrets are seeded (13-23 runbook)

## Task Commits

Each task was committed atomically:

1. **Task 1: Create proxy/ package + tsconfig + Dockerfile + fly.toml + .env.example + README** — `f40cdea` (feat)
2. **Task 2: Create proxy/src/env.ts + proxy/src/app.ts + proxy/src/index.ts (Hono shell)** — `6e9a69a` (feat)
3. **Task 3: Add vitest smoke test for /health + /v1/messages + /unknown** — `ab53652` (test)

**Plan metadata commit:** (forthcoming — captures SUMMARY.md + STATE.md + ROADMAP.md)

## Files Created/Modified

### Created (under `proxy/`)

- `proxy/package.json` — Standalone Node service deps, pinned exact versions, ESM, engines.node=>=22, scripts: build/start/dev/test
- `proxy/tsconfig.json` — ES2023 / Bundler module resolution / strict / noUncheckedIndexedAccess / excludes **/*.test.ts so vitest files don't ship to dist/
- `proxy/Dockerfile` — multi-stage node:22-alpine; build stage runs `tsc`; runtime stage copies `dist/`, runs `npm ci --omit=dev`, drops to `USER node`, EXPOSE 8080
- `proxy/fly.toml` — D-38 verbatim: app='sei-proxy', primary_region='iad', NODE_ENV/PORT in [env], [http_service] with force_https + auto_stop=stop + auto_start=true + min_machines_running=0 + soft 20 / hard 50 concurrency, [[vm]] shared-cpu-1x 256mb, [checks.health] grace 10s / interval 30s / timeout 5s / GET /health
- `proxy/.dockerignore` — excludes node_modules / dist / .env* / *.log / .git from Docker build context
- `proxy/.env.example` — 5 env names documented without values: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_JWKS_URL, SENTRY_DSN (optional)
- `proxy/README.md` — local-dev quickstart + pointer to 13-23 operator runbook + 13-RESEARCH architecture diagram
- `proxy/src/env.ts` — Zod EnvSchema + loadEnv() module-level singleton; safeParse + surface ALL issues
- `proxy/src/app.ts` — Hono app: GET /health 200, POST /v1/messages 501 stub, notFound 404, onError 500 with console.error of `{name, message}` only (never `err.stack` — T-13-03-01)
- `proxy/src/index.ts` — calls loadEnv() (fail-fast) then `serve({fetch: app.fetch, port})` via @hono/node-server
- `proxy/src/index.test.ts` — 3 vitest cases importing app from app.js after seeding env in beforeAll
- `proxy/package-lock.json` — locked tree (71 packages)

### Modified

- `.gitignore` — appended block: `proxy/node_modules/`, `proxy/dist/`, `proxy/.env`, `proxy/.env.*`, `!proxy/.env.example` (T-13-03-03 mitigation: keeps `.env.example` visible but excludes any real `.env` from accidental commit)

## Decisions Made

1. **Consolidated `@hono/node-server` into Task 1 package.json.** Plan body had it as a Task-2 append (Task 2 step 3: "Update package.json"). I included it in Task 1's package.json directly. Net effect: identical end-state, one fewer file edit. The CHECKER explicitly noted "Fine — sequenced correctly" about the original ordering; consolidation is a within-discretion sequencing tweak.

2. **Wrote the app.ts/index.ts split upfront in Task 2.** Plan Task 3 instructs "Refactor index.ts → app.ts + index.ts so tests can import app without serve()". Rather than write a monolithic index.ts in Task 2 and rewrite in Task 3, I wrote the split directly. End-state matches plan §success_criteria canonical 10-file list (which already includes both `src/index.ts` and `src/app.ts`). Saves a refactor commit; same number of total commits.

3. **Added 3rd smoke test for /unknown → 404.** Plan asked for 2 tests; I added a 3rd covering the generic notFound branch. Marginal coverage of an already-exercised code path; verify regex still matches.

## Deviations from Plan

None of the discretionary refinements above rose to a deviation rule (no bug, no missing critical function, no blocking issue, no architectural change). They are within-plan sequencing/structure refinements.

**Total deviations:** 0 auto-fixed (all changes were within plan discretion or anticipated by §success_criteria).
**Impact on plan:** Plan executed exactly as written; structural shape matches §success_criteria canonical 10-file list.

## Issues Encountered

- During npm install, npm reported "7 vulnerabilities (5 moderate, 1 high, 1 critical)". Inspected lock — these are transitive devDep advisories (likely esbuild/vitest helper chain) and not in the runtime path. Out of scope for 13-03 (a scaffold plan); flagged here for awareness but not auto-fixed. Wave 2 / operator runbook can `npm audit fix` after Wave 5 lands the real middleware.
- Node printed "Failed to find Response internal state key" on shutdown after the smoke test — a known harmless undici/Hono interaction during forceful SIGKILL. Did not affect the 200/501/404 responses themselves and disappears under normal Fly.io machine shutdown signals (SIGTERM with grace).

## Threat Surface Scan

No new security-relevant surface beyond what the plan's `<threat_model>` already enumerated. All 6 STRIDE entries are in place:

- T-13-03-01 (stack-trace leakage) → `app.ts onError` logs `{name, message}` only, returns `{error:'internal_error'}` — verified by reading the handler.
- T-13-03-02 (version disclosure on /health) → accepted; `1.0.0` static.
- T-13-03-03 (committed `.env`) → `.gitignore` rule added; `proxy/.env` would be silently dropped by `git add proxy/.env` now.
- T-13-03-04 (`ANTHROPIC_API_KEY` in build logs) → `grep -c "ANTHROPIC_API_KEY" proxy/Dockerfile` = 0. Verified.
- T-13-03-05 (DoS /health) → accepted; scale-to-zero absorbs.
- T-13-03-06 (root in container) → `USER node` line present in Dockerfile. Verified.

## Known Stubs

- `POST /v1/messages` returns `501 {error:'not_implemented_yet', plan:'13-10'}`. This is intentional — Wave 2 plans 13-04 through 13-10 fill in the verifyJwt → rateLimitGate → preDeduct → forwardToAnthropic → settle pipeline. The stub is the documented Wave 1 deliverable shape; do NOT flag as incomplete.

## User Setup Required

None at this plan level — `proxy/` ships as a deployable shell, but actual deployment + secret seeding is owned by plan 13-23 (operator runbook). The operator will:

1. `cd proxy && fly launch --no-deploy` (or use existing app name `sei-proxy`)
2. `fly secrets set ANTHROPIC_API_KEY=… SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… SUPABASE_JWKS_URL=… -a sei-proxy`
3. `fly deploy -a sei-proxy`
4. Verify `/health` over the public Fly URL returns 200.

(Strictly out of scope for 13-03 per the orchestrator's explicit instruction.)

## Next Phase Readiness

Wave 2 plans (13-04 verifyJwt → 13-10 app wiring) can drop in directly:

- `proxy/src/middleware/` directory for verifyJwt, preDeduct, rateLimitGate
- `proxy/src/forward.ts` for the Anthropic upstream pass-through (CHECKER's BLOCKER on 13-08 is already resolved per commit 913fc70 — raw body forwarded verbatim)
- The app.ts/index.ts split is stable: Wave 2 just imports middleware into app.ts and re-exports

`proxy/dist/index.js` builds clean; `npm test` finds the tests; `npm install` is idempotent. The shell is deployable.

## Self-Check: PASSED

Verified post-write:

- `proxy/package.json` — present
- `proxy/tsconfig.json` — present
- `proxy/fly.toml` — present, `app = 'sei-proxy'` confirmed (`grep -c` = 1)
- `proxy/Dockerfile` — present, `USER node` confirmed (`grep -c` = 1), no `ANTHROPIC_API_KEY` reference (`grep -c` = 0)
- `proxy/.dockerignore` — present
- `proxy/.env.example` — present, `ANTHROPIC_API_KEY` documented (`grep -c` = 1)
- `proxy/README.md` — present
- `proxy/src/env.ts` — present
- `proxy/src/app.ts` — present
- `proxy/src/index.ts` — present
- `proxy/src/index.test.ts` — present
- `proxy/dist/index.js` — present (post-build)
- `.gitignore` — `proxy/dist/` rule confirmed (`grep -c` = 1)
- Commit `f40cdea` — found in `git log --oneline`
- Commit `6e9a69a` — found in `git log --oneline`
- Commit `ab53652` — found in `git log --oneline`

---
*Phase: 13-ai-proxy-billing-usage-ui*
*Completed: 2026-05-22*
