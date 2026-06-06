---
phase: 11
plan: 11
subsystem: auth/export
tags: [export, gdpr, auth, characters, cloud, supabase]
dependency-graph:
  requires:
    - 11-01 (characters table + RLS — owner scope makes the select safe)
    - 11-07 (cloudCharacterClient — pattern reference for supabase + timeout)
    - 10-09 (AUTH-07 export envelope + writeFile pipeline)
  provides:
    - "exportBuilder.buildExport(session) → Promise<SeiExportV1> with characters[] filled from cloud"
    - "CLOUD_LIST_FAILED error contract surfaced through authHandlers.exportData"
  affects:
    - src/main/auth/authHandlers.ts (exportData now awaits buildExport)
tech-stack:
  added: []
  patterns:
    - "15s AbortController + try/finally clearTimeout (cloudCharacterClient mirror)"
    - "CLOUD_LIST_FAILED:<msg> error prefix (renderer ERROR_COPY routing)"
key-files:
  created:
    - "(none — exportBuilder.ts and exportBuilder.test.ts already existed; modified)"
  modified:
    - "src/main/auth/exportBuilder.ts — buildExport is async + selects characters by owner"
    - "src/main/auth/exportBuilder.test.ts — 11 tests (added 6 cloud-fill cases, kept invariants)"
    - "src/main/auth/authHandlers.ts — exportData awaits + maps CLOUD_LIST_FAILED to write_failed"
decisions:
  - "Inline supabase select in exportBuilder rather than calling cloudCharacterClient.listMyCharacters — preserves raw snake_case row shape for the JSON download (LIB-01 transparency) and avoids the camelCase Character wrap that listMyCharacters applies. exportBuilder stays decoupled from cloudCharacterClient internals."
  - "characters[] carries raw DB rows (snake_case) per plan must_haves[2] — the user sees a faithful cloud snapshot, not the renderer-side projection."
  - "Caught CLOUD_LIST_FAILED in authHandlers.exportData and returned the existing {ok:false, code:'write_failed', message} envelope rather than introducing a new error code — symmetric with the writeFile timeout path and keeps the renderer's ERROR_COPY map unchanged."
metrics:
  duration: ~12 minutes
  completed: 2026-05-21
  tasks_completed: 1
  files_modified: 3
  test_count: 11
---

# Phase 11 Plan 11: Cloud-fill the export envelope Summary

LIB-01 becomes observable in the AUTH-07 export download — `buildExport` is now async and fills `characters[]` with the user's cloud rows via `supabase.from('characters').select('*').eq('owner', session.user.id)` while keeping `schemaVersion=1` and the D-14 envelope contract intact.

## What changed

- **`src/main/auth/exportBuilder.ts`** — `buildExport(session)` is now `async`. It opens a 15s AbortController, runs the owner-scoped select, throws `CLOUD_LIST_FAILED: <msg>` on supabase error, and writes the raw rows (snake_case columns) into the envelope's `characters[]` slot. `sharing[]` stays empty (Phase 12). `schemaVersion` is preserved as the literal `1` (D-14 contract).
- **`src/main/auth/exportBuilder.test.ts`** — Restructured to 11 vitest cases that mock `./supabaseClient.getClient` with a `.from().select().eq().abortSignal()` chain. Covers empty cloud, non-empty cloud (asserts snake_case shape), supabase error → throw, owner filter capture, schemaVersion invariant, sharing empty, account.email/createdAt, null email coercion, top-level key shape, ISO `exportedAt`, and AbortSignal propagation.
- **`src/main/auth/authHandlers.ts`** — `exportData` now `await`s `buildExport(session)` inside a try/catch. CLOUD_LIST_FAILED (or any other thrown Error) is routed to the existing `{ ok: false, code: 'write_failed', message }` envelope — symmetric with the Phase 10 writeFile timeout path. The Phase 10 docblock was updated to drop the now-stale "pure" descriptor.

## Verification

- `npx vitest run src/main/auth/exportBuilder.test.ts` — 11/11 pass
- `npx vitest run src/main/auth/authHandlers.test.ts` — 12/12 pass (no regression)
- `npx tsc --noEmit -p tsconfig.json` — clean
- `grep -c "export async function buildExport" src/main/auth/exportBuilder.ts` → 1
- `grep -c "from('characters')" src/main/auth/exportBuilder.ts` → 3 (one select, two in docblock comments)
- `grep -c "CLOUD_LIST_FAILED" src/main/auth/exportBuilder.ts` → 3
- `grep -c "schemaVersion: 1" src/main/auth/exportBuilder.ts` → 2 (interface literal + return value)
- `grep -c "await buildExport" src/main/auth/authHandlers.ts` → 1

## Threat model status

- **T-11-11-01 (Info disclosure across users)** — Mitigated by both layers: `.eq('owner', session.user.id)` in the query plus the RLS policy from Plan 11-01 (`owner = auth.uid()`). Belt and suspenders.
- **T-11-11-02 (Hung select blocks export)** — Mitigated by the 15s `AbortController` wrapper, `try/finally clearTimeout`. Pattern mirrors `cloudCharacterClient.withTimeout`. Test asserts a real `AbortSignal` is passed to `.abortSignal()`.
- **T-11-11-03 (Silent schema version bump)** — Mitigated by `schemaVersion: 1` literal type + explicit test (`expect(out.schemaVersion).toBe(1)`).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 — Missing critical functionality] Catch CLOUD_LIST_FAILED inside authHandlers.exportData**

- **Found during:** Task 1, Step B (authHandlers wiring)
- **Issue:** Plan said to "await buildExport(session)" but did not explicitly wrap the await in try/catch. Without it, a CLOUD_LIST_FAILED throw would bubble up the IPC handler as an unhandled rejection — the renderer would see a generic IPC error instead of the documented `{ok:false, code:'write_failed', message}` envelope. The plan's must_haves[5] required the error envelope mapping, so the catch is mandatory.
- **Fix:** Wrapped `await buildExport(session)` in try/catch returning `{ ok: false, code: 'write_failed', message: (err as Error).message }` — same shape used elsewhere in the handler.
- **Files modified:** `src/main/auth/authHandlers.ts` (single hunk around the buildExport call)
- **Commit:** `213a6c9`

## Auth gates

None — Phase 11 plan 11 is pure code wiring; no external auth credentials, OAuth flows, or environment variables were touched.

## Known Stubs

None.

## TDD Gate Compliance

- RED gate: `5825abc test(11-11): add failing tests for cloud-fill of characters[] in buildExport` — 4 tests failed before implementation (error throw, owner filter, AbortSignal propagation, and the implicit async return signature).
- GREEN gate: `213a6c9 feat(11-11): fill characters[] in export envelope from cloud (LIB-01)` — all 11 tests pass.
- REFACTOR gate: not needed; implementation came in clean.

## Commits

| Phase   | Hash      | Message                                                                 |
| ------- | --------- | ----------------------------------------------------------------------- |
| RED     | `5825abc` | test(11-11): add failing tests for cloud-fill of characters[] in buildExport |
| GREEN   | `213a6c9` | feat(11-11): fill characters[] in export envelope from cloud (LIB-01) |

## Self-Check: PASSED

- FOUND: `src/main/auth/exportBuilder.ts` (modified — async buildExport)
- FOUND: `src/main/auth/exportBuilder.test.ts` (modified — 11 tests)
- FOUND: `src/main/auth/authHandlers.ts` (modified — await + catch)
- FOUND: commit `5825abc` in git log (RED)
- FOUND: commit `213a6c9` in git log (GREEN)
- VERIFIED: `npx vitest run src/main/auth/exportBuilder.test.ts` → 11 pass
- VERIFIED: `npx vitest run src/main/auth/authHandlers.test.ts` → 12 pass (no regression)
- VERIFIED: `npx tsc --noEmit` → clean
