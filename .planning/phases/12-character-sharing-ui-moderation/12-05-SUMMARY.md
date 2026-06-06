---
phase: 12-character-sharing-ui-moderation
plan: 05
subsystem: edge-function
tags: [supabase, edge-function, reports, rate-limit, tdd, security]

# Dependency graph
requires:
  - phase: 12-character-sharing-ui-moderation
    plan: 01
    provides: "public.reports table (RLS on, zero insert policies — service_role-only path), reason CHECK constraint with 4 canonical strings, AFTER INSERT triggers (auto-hide + pg_net.http_post webhook to notify-report)"
provides:
  - submit-report Edge Function (HTTP POST endpoint, the ONLY path from renderer → reports INSERT)
  - countReportsInLastHour pure helper (exported; strict-`>`-60min window; unit-tested in 5 cases)
  - FRIENDLY_RATE_LIMITED_MESSAGE exported constant ("You've reported a lot in the last hour…") — Plan 12-13 ReportModal will mirror this string
  - REASON_ENUM 4-string allowlist enforced server-side before INSERT (defense in depth alongside DB CHECK)
  - 5/reporter/hour rate-limit enforcement (D-34d) returning 429 with friendly copy
  - handler() function export so the test module can import countReportsInLastHour without binding port 8000
affects: [12-06-notify-report, 12-08-browse-ipc, 12-13-report-modal]

# Tech tracking
tech-stack:
  added: [deno (2.7.14 installed locally via Homebrew for TDD harness)]
  patterns:
    - "Edge Function as the rate-limit trust boundary (reports table has zero RLS insert policies — Pitfall 4 enforced)"
    - "Two-client pattern: userClient (anon + JWT) for identity, adminClient (service_role) for privileged DB read+insert"
    - "reporter_id sourced from verified JWT only — request body field IGNORED (T-12-05-01 spoofing mitigation)"
    - "Strict `>` 60-minute window in pure helper mirrors DB `created_at > now() - interval '1 hour'` semantic; DB query uses `.gte` as a cheap over-fetch and the pure function re-applies the boundary"
    - "Defense in depth on detail field length: UI maxLength (12-13) + Zod (12-08) + Edge Function `.slice(0, 500)` + DB CHECK (12-01)"
    - "Fail-closed on rate-check DB read failure (500 rate_check_failed) — fail-open would weaponize a Postgres outage into a spam vector"
    - "`import.meta.main` gate around `Deno.serve` so unit tests can import the module for the pure helper without side effects"
    - "Env reads deferred to request-handler scope (not module init) — keeps `deno test` runnable without `--allow-env`"

key-files:
  created:
    - supabase/functions/submit-report/index.ts
    - supabase/functions/submit-report/index.test.ts
    - supabase/functions/submit-report/deno.json
    - supabase/functions/submit-report/deno.lock
  modified: []

key-decisions:
  - "REASON_ENUM string-for-string matches Plan 12-01 reports.reason CHECK constraint ('sexual_content_minors', 'hate_speech_harassment', 'copyright_infringement', 'other')"
  - "Pure helper `countReportsInLastHour` exported and unit-tested with strict-greater-than-60-min boundary semantics; DB query uses `.gte` for a coarse over-fetch then the pure function re-applies the strict boundary"
  - "`handler` exported + `Deno.serve(handler)` gated on `import.meta.main` — required so `deno test` can import the module without binding a port (otherwise NotCapable: requires net access to 0.0.0.0:8000)"
  - "Env reads moved INTO the request handler scope; module-level `Deno.env.get('SUPABASE_URL')!` would throw at test-import time with NotCapable (requires env access)"
  - "Fail-closed rate-limit check: when the DB rate-limit SELECT errors, return 500 `rate_check_failed` rather than allowing the INSERT — preserves the per-reporter cap as an invariant"
  - "FRIENDLY_RATE_LIMITED_MESSAGE exported as a const so Plan 12-13 ReportModal can reuse the exact string without drift"

patterns-established:
  - "Deno test harness for Edge Functions: `deno.json` import map + `jsr:@std/assert` for assertions + `import.meta.main` gate around `Deno.serve` so the module is importable for unit tests"
  - "Exported `handler` + module-init guard is now the convention for any Edge Function whose pure helpers we want to unit-test"

requirements-completed: [SHARE-08]

# Metrics
duration: 4min
completed: 2026-05-22
---

# Phase 12 Plan 05: submit-report Edge Function with 5/hr Rate Limit Summary

**Gated INSERT endpoint for the reports table — enforces the 5-per-reporter-per-hour rate limit (D-34d) before service_role hits the DB. Built via TDD-first: failing rate-limit window tests committed RED, then helper + full handler committed GREEN.**

## Performance

- **Duration:** ~4 min (incl. one-time Homebrew install of Deno 2.7.14 for the TDD harness — ~50s of that)
- **Started:** 2026-05-22T08:26:48Z
- **Completed:** 2026-05-22T08:30:33Z
- **Tasks:** 2 (TDD red → TDD green)
- **Files modified:** 4 created, 0 modified
- **Lines:** 259 (index.ts) + 73 (index.test.ts) = 332

## Accomplishments

- `countReportsInLastHour(reports, now)` pure helper with strict `>` 60-minute window semantic, pinned by 5 unit tests covering: empty, all-within-window, cap boundary at 5, over-cap with one excluded outside window, exactly-60-min boundary excluded.
- `handler(req)` exports the request handler so unit tests can `import` the module for the pure helper without binding port 8000. `Deno.serve(handler)` runs only when `import.meta.main` (i.e., Supabase's runtime executes `index.ts` as the entry module).
- Full Edge Function implementing the Plan 12-05 flow:
  1. CORS preflight → 200 `corsHeaders`
  2. Method !== POST → 405
  3. Missing Bearer → 401 `missing_jwt`
  4. `userClient.auth.getUser()` → reporter_id from verified JWT (NEVER from body)
  5. Body shape validation → 400 `bad_request` on miss
  6. `REASON_ENUM` allowlist → 400 `invalid_reason` if not one of the 4 canonical strings
  7. `detail.slice(0, 500)` server-side truncation
  8. Rate-limit SELECT `count where reporter_id = $1 AND created_at >= now - 1h` ordered DESC limit 6, then re-apply strict `>` via pure helper. ≥5 → 429 `rate_limited` with `FRIENDLY_RATE_LIMITED_MESSAGE`.
  9. service_role INSERT into `reports` → 202 `{ ok: true }` (DB AFTER INSERT trigger from 12-01 fans out to notify-report via pg_net.http_post)
- 5/5 unit tests passing under `deno test` (no permission flags required).
- `deno check index.ts` clean (TypeScript type-check passes).

## Task Commits

1. **Task 1 — TDD RED: failing rate-limit window tests** — `fe2ef7b` (test)
   Five `Deno.test` blocks; `deno test` fails with TS2307 `cannot find module index.ts` (the module under test does not yet exist).
2. **Task 2 — TDD GREEN: countReportsInLastHour + full handler** — `cf74fef` (feat)
   Implementation makes all 5 tests pass; `deno check` confirms type-correctness.

## Files Created/Modified

- `supabase/functions/submit-report/index.ts` — 259 lines, full Edge Function with JSDoc preamble documenting flow, threat-mitigation mappings, and the canonical REASON_ENUM cross-layer invariant.
- `supabase/functions/submit-report/index.test.ts` — 73 lines, 5 `Deno.test` blocks covering the window-math edge cases.
- `supabase/functions/submit-report/deno.json` — import map for `@supabase/supabase-js` (mirrors `delete-me/deno.json`).
- `supabase/functions/submit-report/deno.lock` — pinned dependency hashes from `deno test` resolving `jsr:@std/assert@1` + supabase-js.

## Canonical REASON_ENUM (cross-layer invariant)

| Value | DB layer (12-01 CHECK) | Edge layer (12-05 — THIS PLAN) | IPC layer (12-08 Zod, future) | Renderer layer (12-13 modal, future) |
|---|---|---|---|---|
| `sexual_content_minors` | ✓ | ✓ | — | — |
| `hate_speech_harassment` | ✓ | ✓ | — | — |
| `copyright_infringement` | ✓ | ✓ | — | — |
| `other` | ✓ | ✓ | — | — |

Adding/removing a value requires updating ALL four layers together. The DB CHECK constraint catches drift at INSERT time, surfacing fast.

## Friendly 429 Copy (cross-layer constant)

```
"You've reported a lot in the last hour. Try again later if you still need to report."
```

Exported from `supabase/functions/submit-report/index.ts` as `FRIENDLY_RATE_LIMITED_MESSAGE`. Plan 12-13 `ReportModal` MUST render this exact string when `{ ok: false, code: 'rate_limited' }` returns from the IPC. Either re-export the same const through `src/shared/ipc.ts` or duplicate it with a comment pointer back to this file — planner's choice in 12-13.

## Response Shape Reference

| Status | Body | When |
|---|---|---|
| 202 | `{ "ok": true }` | INSERT succeeded; webhook fan-out is async |
| 400 | `{ "error": "bad_request" }` | Missing/wrong type on `characterId` or `reason`, malformed JSON |
| 400 | `{ "error": "bad_request", "detail": "invalid_reason" }` | `reason` not in `REASON_ENUM` |
| 401 | `{ "error": "missing_jwt" }` | No `Authorization: Bearer ...` header |
| 401 | `{ "error": "invalid_jwt" }` | JWT not verifiable by `userClient.auth.getUser()` |
| 405 | `Method not allowed` (plaintext) | Not POST or OPTIONS |
| 429 | `{ "ok": false, "code": "rate_limited", "message": "<FRIENDLY_RATE_LIMITED_MESSAGE>" }` | ≥5 reports from same reporter in last hour |
| 500 | `{ "ok": false, "code": "rate_check_failed", "message": "Could not verify report eligibility. Please try again." }` | DB rate-limit SELECT errored (fail-closed) |
| 500 | `{ "ok": false, "code": "db_insert_failed", "message": "<pg-error-text>" }` | service_role INSERT errored |

## Decisions Made

1. **Strict `>` 60-min boundary in the pure helper** mirrors the Postgres expression `created_at > now() - interval '1 hour'` semantically. The DB query uses `.gte` as a coarse over-fetch (cheaper than two queries); the pure function then re-applies the strict boundary so the 6th-call-at-exactly-60-min-ago case lands deterministically OUT of the window, regardless of how lax the DB filter was.
2. **`handler` export + `import.meta.main` gate.** Without this, `deno test` fails because importing `index.ts` triggers `Deno.serve(...)` which requires `--allow-net` and binds port 8000 mid-test. The export + gate is the idiomatic Deno way to make a serve-style entry module unit-testable.
3. **Env reads at request scope, not module init.** Module-level `Deno.env.get('SUPABASE_URL')!` throws `NotCapable: requires env access` at import time under the test runner. Moving the reads into the handler body makes the module test-importable AND defers the assertion to runtime — meaning a missing env var produces a clear stack-traced 500 rather than a module-init crash.
4. **Fail-closed on rate-check DB error** (500 `rate_check_failed`) rather than fail-open. A fail-open path would let a Postgres read outage become a spam vector — sustained DoS via making the DB just-flaky-enough that rate checks miss.
5. **`detail.slice(0, 500)` silent truncation** rather than 400 rejection. If a malicious caller bypasses UI + IPC and POSTs 5000 chars, we silently truncate to 500 (matching the DB CHECK constraint) rather than 400 — the report itself is the user signal we want to preserve. UI/IPC rejection paths are the user-friendly experience; this is the last-resort defense.

## Threat Mitigations Mapped

| Threat ID | Category | Mitigation in this commit |
|-----------|----------|---------------------------|
| T-12-05-01 | Spoofing reporter_id | `reporterId = userData.user.id` — body field IGNORED |
| T-12-05-02 | Tampering invalid reason | REASON_ENUM allowlist returns 400 BEFORE INSERT |
| T-12-05-03 | DoS via single-account spam | RATE_LIMIT_PER_HOUR=5 returns 429 with friendly copy |
| T-12-05-06 | Repudiation | reports.reporter_id captured from verified JWT |
| T-12-05-07 | Tampering >500-char detail | `.slice(0, 500)` server-side + DB CHECK in 12-01 |

T-12-05-04 (distributed sock-puppet) and T-12-05-05 (rate-limit reflective disclosure) remain `accept` per plan threat model — v1.0 mitigations are the 3-distinct-reporter auto-hide trigger (12-01) + manual admin review.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 — Bug] Module-init `Deno.env.get('SUPABASE_URL')!` threw under test harness**
- **Found during:** Task 2 first test run (post-implementation).
- **Issue:** Top-of-file `const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!` ran at import time; `deno test` without `--allow-env` raised `NotCapable: Requires env access to "SUPABASE_URL"` before any test executed.
- **Fix:** Removed module-level `SUPABASE_URL` constant; replaced with `const supabaseUrl = Deno.env.get('SUPABASE_URL')!` inside the request handler scope. Env reads only occur when an actual request is being served. Bonus: in production, a missing env var now produces a clear stack-traced 500 from inside the handler rather than a module-init crash that takes down the whole isolate.
- **Files modified:** `supabase/functions/submit-report/index.ts`
- **Commit:** `cf74fef` (rolled into the GREEN commit alongside the rest of the implementation)

**2. [Rule 1 — Bug] Module-init `Deno.serve(...)` bound port 8000 during tests**
- **Found during:** Task 2 second test run (after fixing #1).
- **Issue:** `Deno.serve(async (req) => {...})` at module top fired during `deno test`'s import phase, raising `NotCapable: Requires net access to "0.0.0.0:8000"`. The plan reference code calls `Deno.serve` directly at module init (matching `delete-me/index.ts`), which prevents the very unit test the plan also asks for.
- **Fix:** Refactored to `export async function handler(req): Promise<Response> { ... }` and added a trailing `if (import.meta.main) Deno.serve(handler);` gate. When Supabase's runtime executes `index.ts` as the entry module, `import.meta.main === true` and the serve call fires. When the test file imports the module for the pure helper, `import.meta.main === false` and no port is bound.
- **Files modified:** `supabase/functions/submit-report/index.ts`
- **Commit:** `cf74fef`

**3. [Rule 3 — Blocker] Deno not installed on the executor's machine**
- **Found during:** Pre-Task 1 verification.
- **Issue:** Plan's `<verify><automated>` invokes `deno test`, but `deno` was not on PATH. Without it, the RED gate can't be observed and the GREEN gate can't be proven.
- **Fix:** Installed Deno 2.7.14 via `brew install deno`. This is a local-developer-environment concern; CI/Supabase already has Deno. No code change required.
- **Files modified:** none (system install)
- **Commit:** n/a

## Issues Encountered

None blocking. The two test-harness bugs (#1, #2 above) were caught and fixed inside Task 2's GREEN phase before the commit.

## Verification

```bash
$ cd supabase/functions/submit-report && deno test
running 5 tests from ./index.test.ts
countReportsInLastHour: empty array returns 0 ... ok (0ms)
countReportsInLastHour: 3 reports within last hour returns 3 ... ok (0ms)
countReportsInLastHour: 5 reports at 5/15/25/35/45 minutes ago returns 5 ... ok (0ms)
countReportsInLastHour: 6 reports incl. one at 61min ago returns 5 ... ok (0ms)
countReportsInLastHour: 1 report at exactly 60 minutes ago returns 0 (strict >) ... ok (0ms)
ok | 5 passed | 0 failed (2ms)

$ deno check index.ts
Check index.ts
(clean — no output)
```

Production deploy verification (deferred to operator runbook — requires `supabase functions deploy submit-report` + Supabase project, neither of which is in scope for the executor's local TDD-only sandbox):

- `supabase functions deploy submit-report` succeeds.
- POST with invalid JWT → 401.
- POST with invalid reason → 400 `invalid_reason`.
- Six rapid POSTs from one signed-in user → first 5 return 202, 6th returns 429 with FRIENDLY_RATE_LIMITED_MESSAGE.
- After 60-min wait (or DB time-travel), 6th attempt succeeds.
- DB CHECK on reports.reason rejects any malformed Edge Function bypass attempt (would only matter if REASON_ENUM ever drifts — caught by allowlist before INSERT in practice).

## TDD Gate Compliance

| Gate | Commit | Type |
|---|---|---|
| RED | `fe2ef7b` | `test(12-05): add failing rate-limit window tests` |
| GREEN | `cf74fef` | `feat(12-05): implement submit-report with rate limit` |
| REFACTOR | n/a | No separate refactor commit; refactors (env scope, `import.meta.main` gate) folded into the GREEN commit because they were prerequisite to the tests passing at all under `deno test`. |

Gate sequence verified in git log:
```
$ git log --oneline -3
cf74fef feat(12-05): implement submit-report with rate limit
fe2ef7b test(12-05): add failing rate-limit window tests
7931556 chore: merge executor worktree (11-14) — kept 11-12's real tosGate over 11-14's stub
```

## Next Phase Readiness

**Plan 12-06 `notify-report` Edge Function (Wave 2)** — receives the pg_net.http_post webhook payload after this function INSERTs a row, emails `dmca@sei.app` + posts to Discord. The webhook payload shape is `{ type: 'INSERT', table: 'reports', record: {...} }` per the Supabase webhook contract — 12-06 will parse `record.id` and SELECT the full report row (plus character row) for the email body.

**Plan 12-08 `browse:report` IPC handler (Wave 3)** — `src/main/ipc.ts` will call this Edge Function via `callEdgeFunction('submit-report', ...)` after `isCloudWriteAllowed()` passes. The Zod `ReportReasonSchema` MUST mirror the REASON_ENUM in this commit exactly (`z.enum(['sexual_content_minors','hate_speech_harassment','copyright_infringement','other'])`). The handler translates `{ ok: false, code: 'rate_limited' }` into a `CLOUD_REPORT_RATE_LIMITED`-prefixed sentinel for renderer ERROR_COPY routing.

**Plan 12-13 `ReportModal` (Wave 4)** — radio values MUST use the REASON_ENUM strings; the rate-limit 429 path renders the FRIENDLY_RATE_LIMITED_MESSAGE exported from this commit (re-import via `src/shared/ipc.ts` or duplicate-with-pointer-comment — pick in 12-13).

## Operator Runbook — Deployment

```bash
# From repo root:
supabase functions deploy submit-report

# Verify secrets are present (auto-injected by Supabase, no manual set needed):
#   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY

# Verify the function is reachable:
curl -i -X POST "https://<project-ref>.supabase.co/functions/v1/submit-report" \
  -H "Authorization: Bearer <user-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"characterId":"00000000-0000-0000-0000-000000000000","reason":"other"}'
# Expect 202 { "ok": true } if character_id exists in characters,
# OR 500 db_insert_failed (FK violation) if not.
```

The function does NOT require any out-of-band secret config (in contrast to the Database Webhook from 12-01 which needs `app.settings.edge_url` and `app.settings.service_role_key`).

## Self-Check: PASSED

- `supabase/functions/submit-report/index.ts` — FOUND (259 lines)
- `supabase/functions/submit-report/index.test.ts` — FOUND (73 lines, well above min_lines: 40 from the plan's must_haves.artifacts contract)
- `supabase/functions/submit-report/deno.json` — FOUND
- `supabase/functions/submit-report/deno.lock` — FOUND
- Commit `fe2ef7b` (Task 1 — TDD RED) — FOUND in git log
- Commit `cf74fef` (Task 2 — TDD GREEN) — FOUND in git log
- `deno test` — 5/5 passed
- `deno check index.ts` — clean
- `RATE_LIMIT_PER_HOUR` constant — present in index.ts (must_haves.artifacts.contains)
- `from('reports').*insert` key link — present in index.ts (must_haves.key_links.pattern)
- REASON_ENUM string-for-string matches `supabase/migrations/20260523000000_moderation_and_reports.sql` CHECK constraint (sexual_content_minors / hate_speech_harassment / copyright_infringement / other)
- reporter_id sourced from `userData.user.id` (verified JWT) — body's reporter_id field IGNORED (T-12-05-01)

---
*Phase: 12-character-sharing-ui-moderation*
*Completed: 2026-05-22*
