---
phase: 11
plan: 09
subsystem: ipc / cloud-mirror wiring
tags: [ipc, cloud-mirror, chars, sync]
requires:
  - 11-03 (UUID rename migration → IdSchema is safe to bump)
  - 11-05 (cloud chars row schema → characters.shared / is_default semantics)
  - 11-07 (cloudCharacterClient — upsert/delete/upload primitives)
  - 11-08 (syncQueue — enqueueUpsert / enqueueDelete / getStatus / retry / subscribeStatusChange)
provides:
  - "characterStore.saveCharacter auto-enqueues a cloud-mirror upsert after every local write (fire-and-forget, gated on !is_default)"
  - "characterStore.deleteCharacter auto-enqueues a cloud-mirror delete (with owner-prefixed Storage paths) after every local delete"
  - "skinStore.applyPng auto-enqueues a cloud-mirror upsert after every skin change"
  - "chars:set-shared IPC channel + handler + preload binding (rejects defaults)"
  - "sync:status / sync:retry / sync:status:update IPC surface for the renderer pill driver"
  - "IdSchema accepts only UUID v4 at the IPC boundary"
affects:
  - "src/main/ipc.ts: IdSchema regex changed; chars:delete now fetches the character to check is_default; three new handlers + status broadcast subscriber"
  - "src/main/characterStore.ts: saveCharacter + deleteCharacter mirror to cloud"
  - "src/main/skinStore.ts: applyPng mirrors to cloud"
  - "src/shared/ipc.ts: IpcChannel.chars.setShared + IpcChannel.sync.* group + SyncStatus / SyncStatusPushEvent types"
  - "src/preload/index.ts: charsSetShared, syncStatus, syncRetry, onSyncStatusUpdate bindings"
tech-stack:
  added: []
  patterns:
    - "fire-and-forget cloud-mirror via void IIFE so cloud failures never block GUI writes (D-18)"
    - "is_default short-circuit at every cloud-mirror enqueue site — defense-in-depth alongside cloudCharacterClient's CLOUD_SYNC_REFUSED_DEFAULT throw (D-22)"
    - "lazy-imported syncQueue + supabaseClient at each call site to avoid module-init cycles"
key-files:
  modified:
    - src/main/ipc.ts
    - src/main/characterStore.ts
    - src/main/skinStore.ts
    - src/shared/ipc.ts
    - src/preload/index.ts
  created: []
decisions:
  - "deleteCharacter snapshots is_default via getCharacter BEFORE the unlink; if the JSON is already gone (idempotent re-delete), treat is_default as false and let the cloud-mirror enqueue proceed — cloudCharacterClient.deleteCharacter is itself idempotent against missing rows"
  - "skinStore.applyPng's enqueueUpsert is partially redundant with saveCharacter's enqueue (saveCharacter already enqueues), but the same-uuid collapse rule in enqueueUpsert makes the second enqueue a no-op write; keeping it makes the cloud-mirror path visible at the skin call site"
  - "subscribeStatusChange wiring lives at the END of registerIpcHandlers in a void IIFE so failed wiring (e.g., a future cyclic import bug) logs a warn but never blocks IPC handler registration"
metrics:
  duration: 25min
  completed: 2026-05-22
requirements: [LIB-01, LIB-04, LIB-05]
---

# Phase 11 Plan 09: Wire IPC Cloud-Mirror Call Sites Summary

Local store mutations (chars create / edit / delete, skin apply) now fire a fire-and-forget cloud-mirror enqueue, the IdSchema at the IPC boundary accepts only UUID v4 (D-23), and the renderer has a typed surface (chars:set-shared, sync:status, sync:retry, sync:status:update) to drive the per-card pill and toggle public/private visibility.

## Tasks Completed

| Task | Name | Commit | Files |
| ---- | ---- | ------ | ----- |
| 1 | Bump IdSchema to UUID v4 + generalize sui check | b7b509f | src/main/ipc.ts |
| 2 | Wire cloud-mirror calls in characterStore + skinStore | 6fc52f9 | src/main/characterStore.ts, src/main/skinStore.ts |
| 3 | Add chars:set-shared + sync:status + sync:retry IPC + preload bindings | 6e48382 | src/shared/ipc.ts, src/main/ipc.ts, src/preload/index.ts |

## What Changed

### Task 1 — IdSchema + sui generalization
- `IdSchema` in `src/main/ipc.ts` switched from the kebab-case slug regex (`^[a-z0-9][a-z0-9-]{0,62}$`) to UUID v4 (`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`). Justification baked into the comment: runUuidRenameMigration (Plan 11-03) already rewrote any pre-existing slug-keyed files.
- The `if (id === 'sui') throw ...` literal at `chars:delete` was generalized to fetch the character + check `is_default`. Cannot delete a default character now applies to every default (sui, lyra, clawd, plus any future bundle additions).

### Task 2 — characterStore + skinStore cloud-mirror
- `characterStore.saveCharacter`: appended a void-IIFE that lazy-imports syncQueue, calls `enqueueUpsert(validated.id)`, then `processNext()` to attempt an immediate drain. Gated on `!validated.is_default` so the sui/lyra/clawd bundle never uploads.
- `characterStore.deleteCharacter`: snapshots `is_default` before the unlink (so the cloud-delete decision survives the local delete), then after the index update enqueues a delete with the two owner-prefixed Storage paths `{owner}/{uuid}.png` in the skins + portraits buckets. Skipped for defaults.
- `skinStore.applyPng`: after the existing single `saveCharacter` call, appended a second void-IIFE that enqueues an upsert at the skin call site. enqueueUpsert's same-uuid filter collapses this with saveCharacter's enqueue — kept for site-level visibility.

### Task 3 — set-shared + sync IPC surface
- `shared/ipc.ts`: added `IpcChannel.chars.setShared = 'chars:set-shared'`, new group `IpcChannel.sync` (`status`, `retry`, `statusUpdate`), updated `IpcChannelName` union to include sync channels, added `SyncStatus` + `SyncStatusPushEvent` types, extended `RendererApi` with `charsSetShared`, `syncStatus`, `syncRetry`, `onSyncStatusUpdate`.
- `main/ipc.ts`: three new handlers (`chars:set-shared` refuses `is_default`; `sync:status` delegates to `syncQueue.getStatus`; `sync:retry` calls `syncQueue.retry`). Appended a void-IIFE at the end of `registerIpcHandlers` that calls `subscribeStatusChange` to broadcast the slim push payload over `sync:status:update` to all renderer windows (with `isDestroyed()` guard).
- `preload/index.ts`: contextBridge bindings for the three new methods + the `onSyncStatusUpdate` listener.

## Verification Results

| Check | Result |
| ----- | ------ |
| `grep -c "characterId must be a UUID" src/main/ipc.ts` | 1 |
| `grep -c "=== 'sui'" src/main/ipc.ts` | 0 |
| `grep -c "char.is_default" src/main/ipc.ts` | matches the chars:delete + chars:set-shared guards |
| `grep -c "enqueueUpsert" src/main/characterStore.ts` | 2 |
| `grep -c "enqueueDelete" src/main/characterStore.ts` | 2 |
| `grep -c "enqueueUpsert" src/main/skinStore.ts` | 3 |
| `grep -c "chars:set-shared" src/shared/ipc.ts` | 1 |
| `grep -c "sync:status" src/shared/ipc.ts` | 3 (status + status:update channel + type reference) |
| `grep -c "subscribeStatusChange" src/main/ipc.ts` | 2 |
| `grep -c "onSyncStatusUpdate" src/preload/index.ts` | 1 |
| `grep -c "Cannot share a default" src/main/ipc.ts` | 1 |
| `tsc --noEmit -p tsconfig.node.json` | clean (pre-existing errors in loopbackPkce.ts + supabaseClient.test.ts only — out of scope, see Deferred) |
| `tsc --noEmit -p tsconfig.web.json` | clean |

## Deviations from Plan

None of the auto-fix rules triggered.

Two minor adjustments documented in `decisions` above (none of them are deviations — they are clarifications of plan intent):
- deleteCharacter has to fetch the prior character BEFORE unlinking to read is_default. The plan's sample code referenced `character.is_default` but didn't show the fetch — implemented the obvious thing.
- The `processNext` call after `enqueueUpsert` in characterStore.saveCharacter pulls both functions from a SINGLE dynamic import (the plan's sample showed two separate dynamic imports of the same module — flattened to one for clarity; result is identical because the module loader caches imports).

## Threat Model Outcomes

| Threat ID | Status |
| --------- | ------ |
| T-11-09-01 (path traversal via crafted id) | mitigated — IdSchema bumped to UUID v4 in Task 1 |
| T-11-09-02 (default char uploaded by accident) | mitigated — characterStore.saveCharacter + skinStore.applyPng both gate on !is_default in Task 2; cloudCharacterClient still throws CLOUD_SYNC_REFUSED_DEFAULT as defense-in-depth |
| T-11-09-03 (renderer sets shared=true on a default) | mitigated — chars:set-shared handler rejects when char.is_default in Task 3 |
| T-11-09-04 (status broadcast leaks to unauth window) | accepted — single renderer window in v1.0 |
| T-11-09-05 (status broadcast spam) | mitigated — subscribeStatusChange fires only on enqueue/dequeue/retry, not on every processNext tick |

## Deferred Items

Pre-existing typecheck failures NOT introduced by this plan:
- `src/main/auth/loopbackPkce.ts:83` — `flowType` not in OAuth options type (Supabase API drift). Out of scope; flagged for an auth-side cleanup phase.
- `src/main/auth/supabaseClient.test.ts:19` — spread-args tuple type mismatch in the test setup. Out of scope.

Both errors are observable on the baseline commit `06ec601` and survive unchanged across this plan's three commits.

## Self-Check: PASSED

- src/main/ipc.ts: FOUND
- src/main/characterStore.ts: FOUND
- src/main/skinStore.ts: FOUND
- src/shared/ipc.ts: FOUND
- src/preload/index.ts: FOUND
- Commit b7b509f: FOUND
- Commit 6fc52f9: FOUND
- Commit 6e48382: FOUND
