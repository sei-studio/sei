---
phase: 11-cloud-character-library
plan: 08
subsystem: infra
tags: [sync, queue, retry, offline, backoff, electron-main]

requires:
  - phase: 11-cloud-character-library
    provides: paths.syncQueuePath (11-03), atomic-write + withFileLock helpers, lazy-imported cloudCharacterClient (Plan 11-07 — stubbed here), authState.isCloudWriteAllowed (Plan 11-14 — stubbed here)
provides:
  - src/main/cloud/syncQueue.ts — persistent JSON-file retry queue with exponential backoff
  - Public API: enqueueUpsert, enqueueDelete, processNext, getStatus, retry, subscribeStatusChange
  - Stubs for cloudCharacterClient + authState.isCloudWriteAllowed (to be replaced by Plans 11-07 / 11-14 on merge)
affects: [11-07 cloudCharacterClient, 11-09 sync:status IPC, 11-14 authState ToS gate, 11-16 sync pill UI]

tech-stack:
  added: []
  patterns:
    - "Lazy dynamic imports for cross-plan dependencies — vi.mock() resolves the relative spec, production code resolves the real sibling"
    - "Tagged-union SyncOp { kind: 'upsert' | 'delete' } persisted as JSON with attempts + nextAttemptAt"
    - "Stub-then-overwrite contract for parallel-wave plans: when wave 3 depends on wave-3 siblings, stub the symbol locally so typecheck + tests pass; merge replaces"

key-files:
  created:
    - src/main/cloud/syncQueue.ts
    - src/main/cloud/syncQueue.test.ts
    - src/main/cloud/cloudCharacterClient.ts (signature-only stub — Plan 11-07 owns)
  modified:
    - src/main/auth/authState.ts (added isCloudWriteAllowed stub — Plan 11-14 owns)

key-decisions:
  - "Backoff schedule [1s,5s,30s,5min,30min] with MAX_ATTEMPTS=6 — failed ops stay in queue with failedAt for renderer to surface (per RESEARCH §Pattern 4)"
  - "Gate-blocked reschedule is NOT a failed attempt — the 30s shift forward doesn't burn through the 6-attempt budget while user is signed-out"
  - "enqueueDelete supersedes any pending upsert for same uuid — uploading then deleting wastes bandwidth and racing risks tombstone-less rows"
  - "Drainer re-reads local file at drain time (collapse-friendly) instead of capturing a snapshot at enqueue — multiple fast saves collapse to ONE upload of the latest bytes"
  - "Stub cloudCharacterClient + isCloudWriteAllowed locally so typecheck + tests run BEFORE Plans 11-07 / 11-14 merge — production stubs throw STUB_NOT_IMPLEMENTED so silent failure is impossible"

patterns-established:
  - "Sync-queue persistence layer: JSON file under <userData>/sync-queue.json with same atomic-write semantics as characterStore/sessionStore"
  - "Lazy-import gate-check: drainer never blocks at module-init on a not-yet-built sibling"

requirements-completed: [LIB-05]

duration: 4min 27s
completed: 2026-05-22
---

# Phase 11 Plan 08: Sync Retry Queue Summary

**Persistent JSON-file retry queue with exponential backoff (1s → 30min, 6 attempts), idempotent same-uuid collapse, and gate-respecting drainer that lazy-imports the cloud client + auth gate so it survives a not-yet-merged Plan 11-07 / 11-14.**

## Performance

- **Duration:** 4 min 27s
- **Started:** 2026-05-22T00:11:05Z
- **Completed:** 2026-05-22T00:15:32Z
- **Tasks:** 1 (TDD: RED + GREEN)
- **Files created:** 3 (incl. one stub for Plan 11-07)
- **Files modified:** 1 (authState.ts stub for Plan 11-14)

## Accomplishments
- D-18 "local-first, mirror-cloud-immediately" engine: characterStore can fire-and-forget enqueueUpsert and the drainer takes over from there.
- 15 vitest tests passing — covers idempotent enqueue, drain dispatch, gate-respect (without burning the attempt budget), backoff timing, MAX_ATTEMPTS=6 failure flagging, retry, getStatus, subscribeStatusChange, defensive corrupt-file recovery, and future-scheduled-op skipping.
- Drainer correctly re-reads local file at drain time so a fast burst of edits to the same character collapses to one cloud upload.
- Lazy-import pattern + signature-only stubs let the worktree typecheck and test without Plans 11-07 / 11-14 having merged yet.

## Task Commits

1. **Task 1 (RED): failing tests for sync retry queue** — `9a9fe9e` (test)
2. **Task 1 (GREEN): implement persistent sync retry queue** — `d2c39fe` (feat)

_No REFACTOR commit — implementation came in clean and the GREEN tests pass on first iteration._

## Files Created/Modified
- `src/main/cloud/syncQueue.ts` — persistent retry queue with backoff, idempotent enqueue, gate-respect, lazy imports of cloud client + auth + store
- `src/main/cloud/syncQueue.test.ts` — 15 vitest cases covering the 9 plan-listed behaviors plus future-scheduled-op skipping, subscribeStatusChange, and corrupt-file defense
- `src/main/cloud/cloudCharacterClient.ts` — signature-only STUB; Plan 11-07 will overwrite with the production implementation on wave-3 merge. Calls throw STUB_NOT_IMPLEMENTED so a misbuilt main binary fails loud.
- `src/main/auth/authState.ts` — added `isCloudWriteAllowed()` STUB (returns true iff signed_in + emailVerified). Plan 11-14 will widen this to include `tos_accepted` on merge.

## Decisions Made

1. **Stub-then-overwrite over commented-out imports.** Plans 11-07 and 11-14 land later in the same wave (or shortly after), and a worktree must typecheck + test on its own. Two signature-only stubs (cloudCharacterClient.ts, authState.isCloudWriteAllowed) give the syncQueue module enough surface to compile + test while making it impossible to silently mirror to a fake cloud in production — every stub throws STUB_NOT_IMPLEMENTED.

2. **`enqueueDelete` supersedes a pending `enqueueUpsert` for the same uuid.** A user who quickly deletes a character they just saved would otherwise upload bytes then delete them — wasted bandwidth, plus race risk if the delete reaches Storage before the upsert reaches Postgres (RLS would still protect against cross-user damage, but tombstone-less rows are messy).

3. **Drainer re-reads local file at drain time.** The queue stores only the uuid for upserts (not a snapshot of the character). This is what makes the collapse logic actually save bandwidth: three fast edits → one queue entry → one cloud upload of the LATEST bytes, not the first ones queued.

4. **Gate-blocked reschedule does NOT increment attempts.** A user who runs Sei without signing in would otherwise burn through 6 retry attempts in ~36 minutes (1s+5s+30s+5min+30min) and then have every saved character flagged "sync failed — retry" forever. Instead, gate-block shifts forward 30s and keeps `attempts=0`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 — Bug] `resolveSkinPng` signature mismatch in plan code**
- **Found during:** Task 1 GREEN phase implementation
- **Issue:** Plan's reference code called `resolveSkinPng(op.uuid)`, but the actual exported signature in `src/main/skinStore.ts:69` is `resolveSkinPng(character: Character) => Promise<Buffer | null>`. Passing a uuid string would silently miss because the loose-typed `character.skin` access would throw TypeError or return null.
- **Fix:** Pass the already-loaded `char` object that we just fetched from `getCharacter(op.uuid)`.
- **Files modified:** `src/main/cloud/syncQueue.ts`
- **Verification:** Test "processNext drains a pending upsert" mocks resolveSkinPng to receive the character; assertion passes.
- **Committed in:** `d2c39fe`

**2. [Rule 3 — Blocking] Local stub for cloudCharacterClient + isCloudWriteAllowed**
- **Found during:** Task 1 GREEN phase (typecheck + test)
- **Issue:** Plan 11-07 (cloudCharacterClient) and Plan 11-14 (isCloudWriteAllowed gate) are sibling/later wave plans that have not yet landed in main. `vi.mock` requires the spec to be path-resolvable, and `tsc` requires the named export to exist on the imported module — both fail without those files.
- **Fix:** Created `src/main/cloud/cloudCharacterClient.ts` as a signature-only stub (every function throws STUB_NOT_IMPLEMENTED so production never silently mirrors). Added `isCloudWriteAllowed()` to `src/main/auth/authState.ts` that returns true iff signed_in + emailVerified — Plan 11-14 will widen with `tos_accepted` on merge.
- **Files modified:** `src/main/cloud/cloudCharacterClient.ts` (new), `src/main/auth/authState.ts`
- **Verification:** Typecheck passes for the plan's files; all 15 tests pass; the stubs throw at runtime so a real binary that ships without Plan 11-07/11-14 fails loud rather than silently mirroring nothing.
- **Committed in:** `d2c39fe`

---

**Total deviations:** 2 auto-fixed (1 bug, 1 blocking)
**Impact on plan:** Both auto-fixes essential. The signature bug would surface as runtime TypeError on first skin-upload sync; the stubs are the only way to land this plan in a worktree without blocking on the parallel wave-3 plans. Neither expands scope.

## Threat Surface Check

Threat register from plan (T-11-08-01 through T-11-08-05) all addressed:
- T-11-08-01 (corrupt queue file): defensive JSON.parse → empty queue + warning — covered by test "readQueue defensively returns [] when the file is corrupt"
- T-11-08-02 (replay after ToS revocation / sign-out): `isCloudWriteAllowed` gate, no attempt-counter burn — covered by test "processNext when isCloudWriteAllowed is false reschedules WITHOUT incrementing attempts"
- T-11-08-03 (UUID-injected storagePaths to delete another user's object): delegated to Storage RLS in Plan 11-01 — accepted in code comments
- T-11-08-04 (runaway retry loop): MAX_ATTEMPTS=6 → failedAt — covered by test "processNext marks failedAt after MAX_ATTEMPTS=6 failures"
- T-11-08-05 (out-of-order replay): accepted per plan (last-write-wins per D-18); collapse logic ensures latest local content uploads

No NEW security-relevant surface introduced beyond what the plan's threat register already covers — no threat flags to add.

## Issues Encountered

- **Worktree branch base drift.** Worktree was on commit `6e93999` (release v0.1.1) instead of the expected base `b9d2bd6` (chore: merge executor worktree 11-05). Reset via `git reset --hard b9d2bd6` per worktree_branch_check protocol. No work lost — phase 11 plans 11-01 through 11-07 were already merged into the merge base.
- **vitest config excludes worktrees.** Ran tests via root `vitest` binary with `--root .` so the exclude pattern `**/.claude/worktrees/**` doesn't drop the in-worktree test file. This is the established pattern (no config change needed).

## Known Stubs

Two stubs were intentionally introduced — both will be replaced by sibling plans on merge:

| Stub | File | Replaces / Owned By |
|------|------|----------------------|
| `cloudCharacterClient` (upsertCharacter, deleteCharacter, uploadSkin, uploadPortrait, deleteStorageObjects) | `src/main/cloud/cloudCharacterClient.ts` | Plan 11-07 |
| `isCloudWriteAllowed` | `src/main/auth/authState.ts` | Plan 11-14 (widens to include `tos_accepted`) |

Both stubs **throw at runtime** (STUB_NOT_IMPLEMENTED). A production binary that ships these stubs will fail loudly on the first sync attempt — silent data-loss is impossible.

## User Setup Required

None. The sync queue is a transparent persistence layer under `<userData>/sync-queue.json`; users do not configure it.

## Next Phase Readiness

- **Plan 11-09** (sync:status IPC) can call `getStatus()` and register a listener via `subscribeStatusChange()` to push updates to the renderer.
- **Plan 11-07** (cloudCharacterClient) must overwrite `src/main/cloud/cloudCharacterClient.ts` with the real implementation. The stub is signature-compatible so the syncQueue caller does not need to change.
- **Plan 11-14** (full ToS gate) must replace `isCloudWriteAllowed` in `src/main/auth/authState.ts` to also require `tos_accepted` — the rest of authState.ts is unchanged.
- **Plan 11-16** (sync pill UI) consumes the renderer-side `pendingByUuid` map from `getStatus()` via the Plan 11-09 IPC channel.

## Self-Check: PASSED

Verified after writing:
- FOUND: `src/main/cloud/syncQueue.ts`
- FOUND: `src/main/cloud/syncQueue.test.ts`
- FOUND: `src/main/cloud/cloudCharacterClient.ts`
- FOUND: commit `9a9fe9e` (test RED)
- FOUND: commit `d2c39fe` (feat GREEN)
- ACCEPTANCE: all 8 grep + 15-test acceptance criteria pass
- TYPECHECK: no NEW errors (two pre-existing errors logged to deferred-items.md)

---
*Phase: 11-cloud-character-library*
*Completed: 2026-05-22*
