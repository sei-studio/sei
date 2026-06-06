---
phase: 11
plan: 10
subsystem: cloud-character-library
tags: [delete, cascade, storage, deletion-queue, rls, orphan-cleanup]
requires:
  - 11-07 (cloudCharacterClient — singleton supabase getClient pattern, 15s timeout pattern)
  - 11-08 (syncQueue.enqueueDelete — direct-delete suspenders path)
  - 11-09 (characterStore.deleteCharacter cloud-mirror block — extended in-place)
  - 11-01 (deletion_queue table + storage_purge_extend cron with path-ownership filter)
provides:
  - enqueueStorageOrphans(ownerUuid, paths[]) for any module that needs to schedule
    a 30-day Storage object cleanup via the existing cron pipeline
  - RLS surface allowing signed-in users to insert their own deletion_queue rows
affects:
  - characterStore.deleteCharacter — now writes deletion_queue row BEFORE the
    direct cloud-delete enqueue (belt before suspenders)
  - Phase 10 deletion_queue table — net-new RLS policy allows user-self insert;
    select/update/delete remain service_role-only
tech-stack:
  added: []
  patterns:
    - AbortController-wrapped 15s timeout (cloned from cloudCharacterClient)
    - CLOUD_*-prefixed error sentinel for renderer ERROR_COPY routing
    - Lazy dynamic import inside characterStore async IIFE (matches existing 11-09 wiring)
key-files:
  created:
    - supabase/migrations/20260521000300_deletion_queue_user_insert.sql
    - src/main/cloud/deletionQueueWriter.ts
    - src/main/cloud/deletionQueueWriter.test.ts
  modified:
    - src/main/characterStore.ts (deleteCharacter — orphan-row insert before sync-queue enqueue)
decisions:
  - "deletion_queue insert is fire-before-suspenders: writing the orphan row first
    means even a sync-queue failure cannot strand objects past 30 days. Cost is a
    single cheap insert per delete."
  - "Empty-paths early return inside enqueueStorageOrphans keeps the API ergonomic
    for callers who may compute the list dynamically and end up with nothing."
  - "Signed-out delete path skips BOTH the deletion_queue insert AND the sync-queue
    enqueue — no cloud row was ever uploaded, so there's nothing to clean."
  - "CLOUD_DELETION_QUEUE_INSERT_FAILED is logged via console.warn and swallowed at
    the call site so the GUI delete still feels instant; the sync-queue path is the
    primary cleanup mechanism, this is the 30-day insurance."
metrics:
  duration_minutes: 8
  tasks_completed: 2
  files_created: 3
  files_modified: 1
  tests_added: 5
  tests_passing: 112
  completed: 2026-05-21
---

# Phase 11 Plan 10: Delete Cascade with Storage Cleanup Summary

Plan 11-10 closes Phase 11 Pitfall 6 (cloud row deleted but Storage delete fails leaving orphans) by wiring the deletion_queue belt to the existing sync-queue suspenders. Every signed-in `chars.delete` now writes a deletion_queue row first; the cron sweeps any Storage objects that escape the direct delete within 30 days.

## Tasks Executed

### Task 1 — deletion_queue user-insert RLS policy

Commit: `dad8212`

Added `supabase/migrations/20260521000300_deletion_queue_user_insert.sql` granting `insert` to authenticated users where `user_id = auth.uid()`. Phase 10's default-deny RLS would have forced an Edge Function for every character delete; the user-self-insert policy keeps the cost a single direct supabase-js call.

`select` / `update` / `delete` on `deletion_queue` remain service_role-only — only the cron (and any privileged maintenance task) reads or mutates beyond the user-owned insert.

### Task 2 — deletionQueueWriter + characterStore hook (TDD)

RED commit: `19d080b` — 5 failing tests
GREEN commit: `c0827a3` — implementation passes all tests

**`src/main/cloud/deletionQueueWriter.ts`** exports `enqueueStorageOrphans(ownerUuid, paths)`:
- No-op short-circuit on empty `paths` (caller may compute dynamically and land at zero)
- Single `.from('deletion_queue').insert({ user_id, storage_paths })` — DB default fills `deletion_requested_at = now()`
- 15s AbortController timeout (`cloudCharacterClient.ts` pattern, try/finally clearTimeout)
- Supabase error → `Error('CLOUD_DELETION_QUEUE_INSERT_FAILED: ' + message)` for renderer ERROR_COPY routing

**`src/main/characterStore.ts deleteCharacter`** updated the cloud-mirror IIFE that Plan 11-09 added:
- Reads the session up front; signed-out deletes early-return BOTH the deletion_queue insert AND the sync-queue enqueue (nothing was ever uploaded, nothing to clean)
- Inserts the deletion_queue row first (belt) — failure is logged but does not block
- Enqueues the direct delete via `syncQueue.enqueueDelete` (suspenders)
- The cron's `storage.objects DELETE WHERE name = ANY(...)` is idempotent — if the direct delete already removed the bytes, the next sweep is a no-op

## Verification

- `npx vitest run src/main/cloud/deletionQueueWriter.test.ts` — 5/5 pass
- `npx vitest run` (full suite) — 112/112 pass (no regressions in 11-07, 11-08, 11-09 tests)
- `grep -c "enqueueStorageOrphans" src/main/characterStore.ts` — 2 (call site + comment)
- Migration `grep` checks satisfied:
  - `grep -c "deletion_queue_user_insert"` → 1
  - `grep -c "with check (user_id = auth.uid())"` → 1

`tsc --noEmit -p tsconfig.node.json` reports zero errors in `deletionQueueWriter.ts` or `characterStore.ts`. Two pre-existing errors in `src/main/auth/loopbackPkce.ts` and `src/main/auth/supabaseClient.test.ts` are unchanged from base (already documented in commit `9b7ac95` "record pre-existing typecheck errors discovered during 11-07") — out of scope per executor's scope-boundary rule.

## Deviations from Plan

None — plan executed exactly as written.

The plan called out one cross-plan follow-up (T-11-10-01: cron-body path-ownership guard); on inspection of the base, this guard was already present in `supabase/migrations/20260521000200_storage_purge_extend.sql` lines 25-33 (the `safe_paths` CTE filters `split_part(obj_path, '/', 1) = user_id::text`). No additional migration was needed — the threat is already mitigated. The original plan anticipated needing a follow-up migration; the prior plan author folded the guard into Plan 11-01's storage_purge_extend during that plan's execution, so this plan benefits from it without further work.

## Threat Model Compliance

| Threat ID | Disposition | Status |
|-----------|-------------|--------|
| T-11-10-01 (cross-user storage delete via deletion_queue spoof) | mitigate | Mitigated. RLS `with check (user_id = auth.uid())` blocks wrong-user inserts; the cron's `safe_paths` CTE adds defense-in-depth path-ownership filtering. |
| T-11-10-02 (deletion_queue spam) | mitigate (accepted for v1.0) | Same disposition as plan; no Phase 11 rate-limit. |
| T-11-10-03 (deletion_queue UUID leak via select) | accept | RLS select stays service_role-only; users cannot read others' rows. |

## TDD Gate Compliance

- RED commit `19d080b` — `test(11-10): add failing tests for deletionQueueWriter (RED)` — confirmed 5 failures before implementation.
- GREEN commit `c0827a3` — `feat(11-10): implement deletionQueueWriter + characterStore hook (GREEN)` — all 5 tests pass.
- REFACTOR — not needed; the implementation was minimal-and-clear at GREEN.

## Cross-Plan Follow-ups

- **T-11-10-01 cron-body guard**: already shipped in `20260521000200_storage_purge_extend.sql`. No action needed for Phase 11. If a future migration touches that cron body, preserve the `safe_paths` CTE.
- **Schema push**: the new `20260521000300_deletion_queue_user_insert.sql` must be applied alongside the rest of the Phase 11 migration batch — Plan 11-01's executor (or whichever wave pushes the schema) needs to include this filename.

## Self-Check: PASSED

- `supabase/migrations/20260521000300_deletion_queue_user_insert.sql` — FOUND
- `src/main/cloud/deletionQueueWriter.ts` — FOUND
- `src/main/cloud/deletionQueueWriter.test.ts` — FOUND
- `src/main/characterStore.ts` — modified, contains `enqueueStorageOrphans`
- Commit `dad8212` (Task 1) — FOUND in git log
- Commit `19d080b` (Task 2 RED) — FOUND in git log
- Commit `c0827a3` (Task 2 GREEN) — FOUND in git log
- All 112 vitest tests pass
