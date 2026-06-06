---
phase: 11
plan: 07
subsystem: cloud
tags: [cloud, supabase, storage, client, timeout, tdd]
requirements_addressed: [LIB-01, LIB-02, LIB-04, LIB-05]
dependency_graph:
  requires:
    - 11-01 (Supabase schema + storage buckets + RLS)
    - 11-03 (Character schema with shared/slug/metadata fields)
    - 11-04 (database.types.ts generated)
    - 11-06 (portrait_image path-reference refinement)
  provides:
    - "Typed cloud client: 9 CRUD + Storage operations with timeout + guard rails"
    - "CLOUD_* error vocabulary for the renderer ERROR_COPY map"
    - "Single source of truth for is_default rejection (D-22) + data: rejection (Pitfall 2)"
  affects:
    - "Plan 11-09 (IPC handlers will import upsertCharacter, deleteCharacter, etc.)"
    - "Plan 11-13 (delete-account flow calls deleteStorageObjects)"
    - "Plan 11-19 (cache-on-demand calls listMyCharacters, downloadSkin, downloadPortrait)"
tech_stack:
  added: []
  patterns:
    - "AbortController + setTimeout + try/finally clearTimeout (analog: edgeFunctionClient.ts:30-81)"
    - "Hand-rolled supabase mock with method-chain stubs (test pattern for the rest of Phase 11)"
    - "Prefix-coded error sentinels (CLOUD_*) — extends KEYCHAIN_/SESSION_/PORTRAIT_/TOS_ family"
key_files:
  created:
    - src/main/cloud/cloudErrors.ts
    - src/main/cloud/cloudCharacterClient.ts
    - src/main/cloud/cloudCharacterClient.test.ts
    - .planning/phases/11-cloud-character-library/deferred-items.md
  modified: []
decisions:
  - "Storage SDK has no AbortSignal support (supabase-js #1185 — open as of 2.106); storage timeouts deferred to Plan 11-19 renderer-side watchdog. Table queries (upsert/select/delete) get the full 15s wrap."
  - "rowToCharacter forces is_default=false on download — even if a row somehow had is_default=true (manual SQL, future regression). Local store re-derives is_default from the bundled persona id list."
  - "Test mock uses .catch(()=>{}) on the hung promise to prevent Node's transient unhandled-rejection warning before withTimeout's catch grabs it — purely a Node bookkeeping hint, doesn't affect SUT behavior."
metrics:
  duration_minutes: 5
  completed: 2026-05-22T00:14:00Z
  tasks_completed: 2
  files_changed: 4
  commits: 4
---

# Phase 11 Plan 07: Cloud Character Client Summary

Built `src/main/cloud/cloudCharacterClient.ts` — the typed Supabase wrapper that every Phase 11 cloud-write site will call. Single source of truth for: 15s timeouts, `is_default` rejection (D-22), `data:`-URL rejection (Pitfall 2), CLOUD_* error vocabulary, and the nested `<owner>/<uuid>.png` storage path layout that matches Plan 11-01 RLS.

## What landed

**`src/main/cloud/cloudErrors.ts`** — 9 prefix-coded error sentinel string constants:
- `CLOUD_SYNC_REFUSED_DEFAULT`, `CLOUD_SYNC_REFUSED_DATA_URL` (BEFORE-network guards)
- `CLOUD_SYNC_UPSERT_FAILED`, `CLOUD_SYNC_TIMEOUT`, `CLOUD_LIST_FAILED`, `CLOUD_DELETE_FAILED`, `CLOUD_DOWNLOAD_FAILED` (table errors)
- `CLOUD_STORAGE_UPLOAD_FAILED`, `CLOUD_STORAGE_DELETE_FAILED` (storage errors)
- `isCloudSyncError()` helper — matches `CLOUD_/TOS_/PORTRAIT_` prefixes so IPC re-raise stays clean.

**`src/main/cloud/cloudCharacterClient.ts`** — 10 exports:
| Export | Purpose |
|--------|---------|
| `upsertCharacter(c, ownerUuid)` | Mirror full-row character to characters table. Guards is_default + data: BEFORE network. |
| `deleteCharacter(uuid)` | Row delete by UUID (RLS scopes to owner). |
| `listMyCharacters(ownerUuid)` | Pull all rows for current user. Used by 11-19 cache-on-demand. |
| `downloadCharacter(uuid)` | Single-row fetch. |
| `uploadSkin(owner, char, bytes)` | Skin PNG → `skins/<owner>/<char>.png`, upsert:true. |
| `uploadPortrait(owner, char, bytes, format)` | Portrait → `portraits/<owner>/<char>.png` with content-type per format. |
| `downloadSkin / downloadPortrait` | Buffer bytes from bucket; null on 404. |
| `deleteStorageObjects(paths)` | Cross-bucket batched remove (grouped per bucket). |
| `getStoragePublicUrl(bucket, owner, char)` | Sync public-URL resolver for the renderer `<img>`. |

**`src/main/cloud/cloudCharacterClient.test.ts`** — 14 vitest tests covering:
- is_default guard fires BEFORE any network call (mock.payload remains null)
- data: portrait_image guard fires BEFORE any network call
- upsert payload force-sets is_default=false (defense-in-depth)
- AbortController wraps the upsert call (signal instance asserted)
- Hung call (>15s) → CLOUD_SYNC_TIMEOUT via fake timers + signal listener
- Storage paths match `<owner>/<uuid>.png` for both buckets
- Portrait content-type honors `png` / `jpeg` / `webp`
- Storage upload errors → CLOUD_STORAGE_UPLOAD_FAILED with detail suffix
- listMyCharacters → rowToCharacter mapping for all D-24 fields
- List error → CLOUD_LIST_FAILED with detail suffix
- deleteStorageObjects groups by bucket and emits one remove() per bucket
- deleteStorageObjects no-ops on empty input
- getStoragePublicUrl returns the bucket public URL

## TDD Gate Compliance

This plan executed Task 2 under `tdd="true"`:
- **RED** — commit `f804e7a` (`test(11-07): add failing tests ... (RED)`) — 14 tests, all failing because the module didn't exist.
- **GREEN** — commit `a12bab9` (`feat(11-07): implement cloudCharacterClient ... (GREEN)`) — implementation lands, all 14 tests pass.
- **REFACTOR** — none required; the GREEN commit also contained the one-line test fix (no-op `.catch()`) to suppress a transient Node unhandled-rejection warning, which is co-located with the implementation that exposes it.

## Threat-model compliance

All 6 threats from `<threat_model>` mitigated as planned:

| Threat | How |
|--------|-----|
| T-11-07-01 (I — default leaked) | `if (c.is_default) throw CLOUD_SYNC_REFUSED_DEFAULT` BEFORE network; test asserts payload remains null on the guard path |
| T-11-07-02 (D — base64 portrait leaks) | `if (c.portrait_image?.startsWith('data:')) throw CLOUD_SYNC_REFUSED_DATA_URL`; test asserts payload remains null |
| T-11-07-03 (T — cross-user storage write) | Nested storage path `<owner>/<uuid>.png` matches Plan 11-01 RLS `storage.foldername(name)[1] = auth.uid()` |
| T-11-07-04 (D — hung connection) | 15s AbortController timeout → CLOUD_SYNC_TIMEOUT; test asserts behavior with fake timers |
| T-11-07-05 (E — renderer bypass) | Module main-only docblock; renderer-import grep gate = 0 matches |
| T-11-07-06 (I — DB internals leak) | Errors wrapped with CLOUD_* prefix; raw supabase message is the `: detail` suffix only |

## Deviations from plan

**None — plan executed exactly as written.**

One out-of-scope discovery during typecheck (logged in `deferred-items.md`):
- Two pre-existing TS errors in `src/main/auth/loopbackPkce.ts:83` and `src/main/auth/supabaseClient.test.ts:19`, confirmed pre-existing on the base via `git stash && tsc`. Not fixed (scope boundary). Plan 11-07's two new TS files compile cleanly.

## Verification

- [x] `src/main/cloud/cloudErrors.ts` exists with 9 sentinel constants + `isCloudSyncError` helper
- [x] `src/main/cloud/cloudCharacterClient.ts` exists with 10 exports
- [x] `npx vitest run src/main/cloud/cloudCharacterClient.test.ts` → 14/14 pass
- [x] `npx tsc -p tsconfig.node.json --noEmit` → no NEW errors (only 2 pre-existing)
- [x] grep `is_default` in client = 9 (>= 3 required)
- [x] grep `CLOUD_SYNC_REFUSED_*` in client = 6 (>= 2 required)
- [x] grep `AbortController` in client = 3 (>= 1 required)
- [x] grep `TIMEOUT_MS = 15_000` in client = 1 (== 1 required)
- [x] grep renderer-imports of `cloudCharacterClient` = 0 (Phase 10 invariant)

## Commits

| Commit  | Type | Description |
|---------|------|-------------|
| `340e81c` | feat | add CLOUD_SYNC_* error sentinel constants |
| `f804e7a` | test | add failing tests for cloudCharacterClient (RED) |
| `a12bab9` | feat | implement cloudCharacterClient with typed wrappers (GREEN) |
| `9b7ac95` | docs | record pre-existing typecheck errors discovered during 11-07 |

## Self-Check: PASSED

- src/main/cloud/cloudErrors.ts: FOUND
- src/main/cloud/cloudCharacterClient.ts: FOUND
- src/main/cloud/cloudCharacterClient.test.ts: FOUND
- .planning/phases/11-cloud-character-library/deferred-items.md: FOUND
- commit 340e81c: FOUND
- commit f804e7a: FOUND
- commit a12bab9: FOUND
- commit 9b7ac95: FOUND
