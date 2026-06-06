---
phase: 10-auth-foundation
plan: 02
subsystem: auth
tags: [safestorage, session, persistence, supabase, electron]

# Dependency graph
requires:
  - phase: 10
    provides: "Plan 10-01 will provide the canonical StorageAdapter interface in src/main/auth/supabaseClient.ts. This plan ran in parallel with 10-01, so the type is defined locally and must be reconciled post-wave."
provides:
  - "saveJson(key,value) / loadJson(key) / removeJson(key) — single sealed <userData>/session.bin blob with tmp+rename atomic writes"
  - "createSessionStorageAdapter() factory returning the Supabase-shaped StorageAdapter (plan 03 will pass this to setStorageAdapter())"
  - "sessionBackendKind() exposing the safeStorage backend name so plan 03/07 can surface the Linux 'basic_text' warning"
  - "Corrupt-blob auto-recovery: a decrypt failure clears session.bin and returns null instead of throwing into Supabase JS (Pitfall A3)"
  - "paths.sessionPath() — the canonical <userData>/session.bin location"
affects: [10-03 bootstrap, 10-07 linux-keyring-banner, 11 cloud-character-library, 12 sharing, 13 billing]

# Tech tracking
tech-stack:
  added: [vitest (devDep — test runner needed for the safeStorage round-trip suite)]
  patterns:
    - "Single sealed session blob: StorageAdapter key argument is ignored (multi-account is v1.x per CONTEXT)"
    - "Corrupt-blob recovery as a non-error: decrypt failure → unlink + return null, never propagate"
    - "tmp+rename atomic write cloned verbatim from src/main/apiKeyStore.ts"

key-files:
  created:
    - "src/main/auth/sessionStore.ts (125 lines — adapter, factory, backend probe)"
    - "src/main/auth/sessionStore.test.ts (vitest — 5 cases covering round-trip, ENOENT, corrupt-blob, no-op remove, backend kind)"
    - ".planning/phases/10-auth-foundation/10-02-SUMMARY.md (this file)"
  modified:
    - "src/main/paths.ts (one new line: sessionPath())"
    - "package.json (added vitest devDep)"
    - "package-lock.json (vitest tree)"

key-decisions:
  - "Defined StorageAdapter locally inside sessionStore.ts instead of importing from supabaseClient.ts — required because plan 10-01 runs in the same parallel wave and the canonical file does not yet exist in this worktree. A code comment marks the post-wave reconciliation step."
  - "Installed vitest as a devDependency (Rule 3 blocking issue) — the plan's verification command runs `npx vitest run` but vitest was not present in the project before this plan."

patterns-established:
  - "Pitfall A3 contract: any safeStorage-decryption failure in this module ALWAYS clears the offending blob and returns a null/empty state rather than propagating the throw to consumers. Future plans that read other safeStorage blobs (e.g., the eventual encrypted memory cache) should mirror this exactly."
  - "Single-blob convention for v1.0: Supabase's StorageAdapter is per-key by contract, but Sei's single-bot/single-session design ignores the key argument. Multi-account work in v1.x will need to either prefix the blob filename with the key or move to a manifest file."

requirements-completed: [AUTH-03]

# Metrics
duration: 7min
completed: 2026-05-19
---

# Phase 10 Plan 02: Session Store Summary

**safeStorage-backed Supabase StorageAdapter persisting session JSON across launches with auto-recovery from corrupt blobs**

## Performance

- **Duration:** 7 min
- **Started:** 2026-05-19T22:52:00Z
- **Completed:** 2026-05-19T22:59:13Z
- **Tasks:** 2
- **Files modified:** 5 (created: 3; modified: 2)

## Accomplishments

- `src/main/auth/sessionStore.ts` implements the Supabase JS `StorageAdapter` contract over a single sealed `<userData>/session.bin` blob using Electron's `safeStorage`.
- Corrupt-blob recovery wired exactly per RESEARCH Pitfall A3: a decrypt throw triggers a silent `unlink` and returns `null`. Supabase JS never sees the decrypt error, so the user lands cleanly on the logged-out state instead of a confusing crash.
- `sessionBackendKind()` exposes the `safeStorage.getSelectedStorageBackend()` value (e.g., `'gnome_libsecret'`, `'basic_text'`) so plan 03 can wire `app:warnings` and plan 07 can render the Linux keyring banner without reaching into the api-key module.
- `createSessionStorageAdapter()` returns the `{ getItem, setItem, removeItem }` shape Supabase JS expects — plan 03's bootstrap will call this once and pass the result to `setStorageAdapter()` before the first `getClient()` call.
- `paths.sessionPath()` added as a single line in the canonical paths object, inheriting the existing `_setUserDataOverride` test hook automatically.

## Task Commits

1. **Task 1: Add `sessionPath()` to paths.ts** — `972b78a` (feat)
2. **Task 2 RED: Failing tests for sessionStore + install vitest** — `62dfae1` (test)
3. **Task 2 GREEN: Implement sessionStore.ts** — `9f8d5ab` (feat)

_Task 2 followed the TDD cycle from the plan's `tdd="true"` annotation. No refactor commit was needed because the GREEN implementation is the verbatim research template and passed all 5 tests on the first run._

## Files Created/Modified

- **Created** `src/main/auth/sessionStore.ts` — adapter functions (`saveJson`/`loadJson`/`removeJson`), `sessionBackendKind()`, `createSessionStorageAdapter()` factory, and a locally-defined `StorageAdapter` interface (see Deviations).
- **Created** `src/main/auth/sessionStore.test.ts` — vitest suite with 5 cases: round-trip JSON, ENOENT-as-null, corrupt-blob-clears-file, removeJson no-op on missing file, and `sessionBackendKind()` returns the stubbed backend string.
- **Created** `.planning/phases/10-auth-foundation/10-02-SUMMARY.md` (this file).
- **Modified** `src/main/paths.ts` — added one line: `sessionPath: () => path.join(userDataRoot(), 'session.bin'),` directly after `apiKeyPath`.
- **Modified** `package.json` / `package-lock.json` — added vitest as a devDependency (deviation Rule 3).

## Decisions Made

- **Local `StorageAdapter` interface in sessionStore.ts.** Plan 10-01 (parallel wave) is the canonical home for the `StorageAdapter` type, but `src/main/auth/supabaseClient.ts` does not yet exist in this worktree. Per the parallel_execution rule, the same-shape interface is defined inline with a `Parallel-wave note` comment pointing at the reconciliation step (switch back to `import type { StorageAdapter } from './supabaseClient'` after the wave merges). The shape is byte-for-byte identical to plan 10-01's definition, so the merge is mechanical.
- **vitest as a new devDependency.** The plan's verification command runs `npx vitest run` but the project had no test runner installed (package.json had no `test` script and no vitest entry). Installing it is the cheapest path to compliance; alternatives (skipping the test verification, hand-rolling a test harness with Node's `node:test`) would either violate the plan's acceptance criteria or duplicate effort that plan 10-01 will also need.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Installed vitest as a devDependency**
- **Found during:** Task 2 (before writing the RED test commit, while checking `node_modules/.bin/vitest`)
- **Issue:** The plan's `<verify>` and `<acceptance_criteria>` blocks both shell out to `npx vitest run`, but vitest was not in `package.json`. Without it the test step cannot complete and the plan cannot be marked done.
- **Fix:** `npm install --save-dev --no-audit --no-fund vitest`. Pinned to whatever floor npm picks (resolved to `^4.1.6`). Tests pass with the stub `vi.mock('electron', …)` pattern verbatim from the plan.
- **Files modified:** `package.json`, `package-lock.json`
- **Verification:** `node_modules/.bin/vitest` now exists; `npx vitest run src/main/auth/sessionStore.test.ts` exits 0 with 5/5 passing; `npx tsc --noEmit` still clean.
- **Committed in:** `62dfae1` (RED commit — vitest install bundled with the test file since the test file is unrunnable without it)

**2. [Rule 3 - Parallel-wave shim] Defined `StorageAdapter` locally instead of importing from `./supabaseClient`**
- **Found during:** Task 2 (writing sessionStore.ts, line `import type { StorageAdapter } from './supabaseClient'`)
- **Issue:** The plan's `<action>` block instructs the import, but plan 10-01 (which creates `src/main/auth/supabaseClient.ts` with the canonical `StorageAdapter` export) runs in the same parallel wave; the file does not exist in this worktree.
- **Fix:** Defined the interface inline with the exact same shape as plan 10-01's definition (`{ getItem, setItem, removeItem }`, all returning Promises), and added a `Parallel-wave note` comment block at the top of the file flagging the reconciliation step. This is exactly the workflow the `<parallel_execution>` block in my prompt prescribes.
- **Files modified:** `src/main/auth/sessionStore.ts`
- **Verification:** `npx tsc --noEmit` exits 0; the test file imports `StorageAdapter` indirectly through `sessionStore.ts` and 5/5 tests pass; the shape matches plan 10-01's source-of-truth definition verbatim.
- **Committed in:** `9f8d5ab` (GREEN commit — inseparable from the implementation)

---

**Total deviations:** 2 auto-fixed (both Rule 3 — blocking).
**Impact on plan:** Both are mechanical infrastructure deviations forced by the parallel-wave execution model. No scope creep, no behavior change, no extra files. Post-wave reconciliation: a single `import type { StorageAdapter } from './supabaseClient';` swap plus removing the local interface in `sessionStore.ts` (~10 lines including the doc comment). vitest install is a permanent improvement the project needed anyway.

## Issues Encountered

- A literal reading of acceptance criterion `grep -c 'SESSION_UNAVAILABLE' src/main/auth/sessionStore.ts equals 1` returns 2 because the doc comment at the top of the file mentions the error class name in a sentence describing the file's contract. The plan's own `<action>` template embeds the same comment, so the criterion is unsatisfiable as written. The semantic intent (the error class exists and is thrown exactly once in code) is met: there is exactly one `throw new Error('SESSION_UNAVAILABLE')`. Flagging for the verifier — no code change made.

## User Setup Required

None — this plan adds no external service configuration. Plan 10-01 owns the Supabase env-var setup; plan 02 is purely an on-disk persistence module.

## Notes for Plan 03 (bootstrap)

- Call `setStorageAdapter(createSessionStorageAdapter())` from `src/main/auth/supabaseClient.ts` BEFORE the first `getClient()` call. Plan 10-01 makes `getClient()` throw `SUPABASE_NO_STORAGE_ADAPTER` if you forget — the ordering bug surfaces immediately.
- For the Linux keyring warning: `import { sessionBackendKind } from './sessionStore'` and check `=== 'basic_text'`. Don't re-implement; the apiKey-side `backendKind()` reports the identical value but the dedicated session-side getter keeps call sites readable.
- Do NOT wrap `loadJson` with another try/catch around decrypt errors. The corrupt-blob branch already returns `null` cleanly — a second catch would mask legitimate `EACCES`/`ENOSPC` errors that DO need to propagate.

## Next Phase Readiness

- AUTH-03 (encrypted session persistence across restart) requirement is implemented and tested.
- Plan 03 can wire the adapter unchanged once plan 10-01 lands in the merged tree.
- No blockers.

## Self-Check: PASSED

All claimed files exist and all claimed commits are present in the git log.

- FOUND: `src/main/auth/sessionStore.ts`
- FOUND: `src/main/auth/sessionStore.test.ts`
- FOUND: `src/main/paths.ts` (modified)
- FOUND: `.planning/phases/10-auth-foundation/10-02-SUMMARY.md`
- FOUND: commit `972b78a` (Task 1 — paths.sessionPath)
- FOUND: commit `62dfae1` (Task 2 RED — tests + vitest install)
- FOUND: commit `9f8d5ab` (Task 2 GREEN — sessionStore.ts)

---
*Phase: 10-auth-foundation*
*Plan: 02 (session-store)*
*Completed: 2026-05-19*
