---
phase: 11
plan: 12
subsystem: auth / tos-gate
tags: [tos, gdpr, signup, oauth, gate, ipc]
requires:
  - 11-01 (tos_acceptance table + RLS)
  - 11-02 (sei.gg/{terms,privacy}.html legal pages)
  - 11-03 (legalVersions.ts TOS_VERSION + PRIVACY_VERSION)
provides:
  - tosGate.isTosAccepted (read, fail-closed)
  - tosGate.recordAcceptance (write, throws TOS_RECORD_FAILED)
  - IpcChannel.tos.status / tos.accept / app.openExternal
  - SignInModal signup-mode ToS checkbox + required gate
  - signUpWithPassword post-success recordAcceptance (fire-and-forget)
affects:
  - Plan 11-13 (consumes tos:status + tos:accept via launch-time AcceptToSModal)
  - Plan 11-14 (cloud-write gate isCloudWriteAllowed reads isTosAccepted)
tech-stack:
  added:
    - "no new deps"
  patterns:
    - "supabase.from(...).select(...).eq(...).limit(1).abortSignal() with 15s timeout, fail-closed (mirrors exportBuilder)"
    - "supabase.from(...).insert(...).abortSignal() with 15s timeout, throws on error"
    - "shell.openExternal URL-allowlist defense (T-11-12-01)"
    - "fire-and-forget post-signup acceptance insert (logger.warn on failure; next-launch blocking modal recovers)"
key-files:
  created:
    - src/main/auth/tosGate.ts
    - src/main/auth/tosGate.test.ts
  modified:
    - src/shared/ipc.ts
    - src/main/ipc.ts
    - src/preload/index.ts
    - src/main/auth/authHandlers.ts
    - src/main/auth/loopbackCallback.ts
    - src/renderer/src/components/SignInModal.tsx
    - src/renderer/src/components/SignInModal.module.css
decisions:
  - "D-26 acceptance-at-sign-up is implemented for the email/password branch only; Google OAuth defers to Plan 11-13's launch-time AcceptToSModal (documented in loopbackCallback.ts comment) — the loopback callback HTML is not a suitable surface for a checkbox, and the cloud-write gate in Plan 11-14 closes any compliance window between OAuth success and modal confirmation"
  - "Fire-and-forget recordAcceptance after signUpWithPassword success: failure is logged but NOT propagated to the renderer — Plan 11-13's launch-time blocking modal re-prompts when isTosAccepted returns false, so a transient INSERT failure is recoverable without surfacing a UX-confusing error after the user has already explicitly clicked the checkbox + submit"
  - "isTosAccepted is fail-closed (returns false on any supabase error / timeout / abort) — better to over-prompt than to grant cloud-write access on a transient read failure"
  - "app:open-external allowlists https://sei.gg (and www.) — javascript:, file:, http:, and any other host are rejected at the main-side handler (T-11-12-01)"
metrics:
  duration_minutes: 12
  completed_date: 2026-05-21
---

# Phase 11 Plan 12: ToS Acceptance at Sign-up Summary

ToS acceptance landed for the email/password sign-up flow: a tosGate module backed by the Plan 11-01 tos_acceptance table, three new IPC channels (tos:status, tos:accept, app:open-external — the last URL-allowlisted to sei.gg), a required checkbox in SignInModal's signup mode that gates submission, and a fire-and-forget recordAcceptance immediately after supabase.auth.signUp resolves. Google OAuth deliberately defers ToS to Plan 11-13's launch-time AcceptToSModal because the loopback callback HTML is the wrong surface for a checkbox; the cloud-write gate (Plan 11-14) prevents any compliance gap in the interim.

## Task Outcomes

| # | Task | Result |
|---|------|--------|
| 1 | Implement tosGate.ts (TDD) | RED commit (`dd0ef86`) added 9 failing tests; GREEN commit (`cf98264`) made all 9 pass; 15s AbortController on both reads and writes |
| 2 | Wire tos:status + tos:accept + app:open-external IPC | shared/ipc.ts adds IpcChannel.tos.{status,accept} + IpcChannel.app.openExternal + TosStatus/TosAcceptResult types + 3 RendererApi methods; main/ipc.ts handlers gate on session presence and URL-allowlist external URLs to sei.gg; preload/index.ts binds tosStatus/tosAccept/openExternal (commit `ccf143d`) |
| 3 | SignInModal checkbox + signup → recordAcceptance + Google OAuth defer comment | SignInModal renders a required checkbox in signup mode with sei.openExternal links; submit disabled until checked; signUpWithPassword fires recordAcceptance for the new user.id (errors logger.warn'd, not surfaced); loopbackCallback adds a Plan 11-13 defer comment near exchangeCodeForSession (commit `49751ea`) |

## Commits

| Hash | Type | Description |
|------|------|-------------|
| `dd0ef86` | test | RED: 9 failing tests for tosGate (isTosAccepted + recordAcceptance) |
| `cf98264` | feat | GREEN: tosGate implementation passing all 9 tests |
| `ccf143d` | feat | tos:status + tos:accept + app:open-external IPC channels + types + preload bindings |
| `49751ea` | feat | SignInModal ToS checkbox + signup → recordAcceptance + Google OAuth defer comment |

## Verification

- `npx vitest run src/main/auth/tosGate.test.ts` — 9 passed
- `npx vitest run` (full suite) — 131 passed (16 files); no regressions
- `npx tsc -b` — only the 2 pre-existing baseline errors (`loopbackPkce.ts` flowType + `supabaseClient.test.ts` spread); no new errors introduced
- All Task-1/2/3 acceptance-criteria grep counters match (1 each for isTosAccepted/recordAcceptance exports; 3 for TOS_VERSION + 3 for PRIVACY_VERSION; 2 for TOS_RECORD_FAILED; 2 each for tos:status|tos:accept + IpcChannel.tos.*; 1 for app:open-external + IpcChannel.app.openExternal; 2 for allowedHosts; 3 for preload tos/openExternal bindings; 3 for tosChecked + 2 for "I agree to the" + 2 for openExternal in SignInModal; 2 for recordAcceptance in authHandlers; 2 for "Plan 11-13" in loopbackCallback)

## Deviations from Plan

None — plan executed as written. Three small comments-and-clarification expansions (not deviations):

- Added a `TosStatus` interface and `TosAcceptResult` union to `src/shared/ipc.ts` rather than inlining the shapes on RendererApi methods. The plan inlined the shapes; types make the renderer-side consumption in Plan 11-13's blocking modal cleaner. No behavior change.
- Documented in `signUpWithPassword` that re-signup attempts against an already-registered email (the empty-identities-array branch) intentionally do NOT call recordAcceptance — there's no new user.id to attach acceptance to, and the existing user's prior tos_acceptance row is authoritative.
- The `recordAcceptance` post-signup call uses a fire-and-forget `try { await ... } catch { logger.warn }` rather than `void recordAcceptance(...)` — the await ensures the success path's eventual return value reflects whether the awaited insert completed by the time `signUpWithPassword` returns (without rejecting the outer promise on insert failure). This matches the plan's "failure does NOT block sign-up" rule while keeping the timing deterministic for tests.

## Known Stubs

None. Every UI element added wires through to a working main-side handler. The renderer-side ToS consumption (blocking modal, gate enforcement on cloud-write sites) is Plan 11-13 + 11-14 — explicitly out of scope here per the plan's objective.

## Threat Flags

None — STRIDE threats from the plan's `<threat_model>` (T-11-12-01..04) are mitigated as specified. T-11-12-01 (renderer-injected malicious URL): app:open-external rejects anything outside `https://{sei.gg, www.sei.gg}`. T-11-12-02 (user repudiation): tos_acceptance row records user_id + version + timestamp, RLS in Plan 11-01 is insert+select-own with no update/delete policy. T-11-12-03 (DevTools bypass of checkbox): Plan 11-14's `isCloudWriteAllowed` is the defense-in-depth gate at every cloud-write site (not this plan's surface). T-11-12-04 (row enumeration): RLS select-own-only.

## Auth Gates

None — the plan executed end-to-end without hitting any external auth requirement.

## Notes on Generated Artifacts

Running `npx tsc -b` during local verification emits sibling `.js` files for every `.ts` file under `src/renderer/src/`, `src/shared/`, and the new `src/shared/legalVersions.js`. These are NOT staged or committed — they are tsc build artifacts the project's `.gitignore` does not currently cover, but other Phase 11 plan summaries (e.g. 11-03) note the same emission behavior. Logging here as a deferred item rather than modifying the gitignore in this plan; a future cleanup plan could add `src/**/*.js` exclusions (with care not to break `src/bot/cli/index.js`).

## TDD Gate Compliance

- RED gate satisfied: commit `dd0ef86` is a `test(...)` commit adding 9 failing tests (verified by `vitest run src/main/auth/tosGate.test.ts` immediately after: 9 failed).
- GREEN gate satisfied: commit `cf98264` is a `feat(...)` commit making all 9 tests pass.
- REFACTOR gate: not needed — the GREEN implementation is already the simplest expression of the contract (two small functions, each one supabase call wrapped in AbortController).

## Self-Check

- [x] `src/main/auth/tosGate.ts` exists (`grep -c 'export async function isTosAccepted' = 1`, `recordAcceptance = 1`)
- [x] `src/main/auth/tosGate.test.ts` exists with 9 tests, all passing under `vitest run`
- [x] `src/shared/ipc.ts` has `IpcChannel.tos.{status, accept}` + `IpcChannel.app.openExternal`
- [x] `src/main/ipc.ts` has handlers for all three new channels + `allowedHosts` allowlist
- [x] `src/preload/index.ts` has `tosStatus`, `tosAccept`, `openExternal` bindings
- [x] `src/renderer/src/components/SignInModal.tsx` has `tosChecked` state + required checkbox + submit gate
- [x] `src/main/auth/authHandlers.ts` calls `recordAcceptance` in the signup success branch (fire-and-forget)
- [x] `src/main/auth/loopbackCallback.ts` has "Plan 11-13" defer comment near exchangeCodeForSession
- [x] Commits `dd0ef86`, `cf98264`, `ccf143d`, `49751ea` all exist in `git log`

## Self-Check: PASSED
