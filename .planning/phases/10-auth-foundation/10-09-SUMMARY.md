---
phase: 10-auth-foundation
plan: 09
title: export-data
status: complete
type: feature
created: 2026-05-20
completed: 2026-05-20
checkpoint_outcome: deferred-to-phase-verification
human_uat: 10-09-HUMAN-UAT.md
deferred_items_ref: deferred-items.md#11
---

# Plan 10-09 — Export My Data (AUTH-07)

## Goal

Ship a signed-in-user data export: click `Export as JSON`, get a native save dialog, write a pretty-printed JSON file whose top-level shape is the D-14 schemaVersion=1 contract. Lock the schema NOW so Phase 11 (characters) and Phase 12 (sharing) fill the empty arrays without bumping schemaVersion.

## D-14 schema-lock invariant

The JSON envelope is EXACTLY 5 top-level keys:

```json
{
  "schemaVersion": 1,
  "exportedAt": "<ISO timestamp>",
  "account":     { "email": "<user email>", "createdAt": "<ISO>" },
  "characters":  [],
  "sharing":     []
}
```

`characters: []` and `sharing: []` are **empty-but-present** in Phase 10. Phases 11+12 fill them. The schema does NOT bump on those fills — the array shapes themselves are part of the v1 contract.

This is the entire reason plan 10-09 exists: locking the contract now means no consumer (export readers, future import tooling in Phase 16) has to handle missing-key cases when 11/12 ship.

## What landed

### `src/main/auth/exportBuilder.ts` (new)

Pure function `buildExport(session)` that takes a Supabase session and returns the typed `SeiExportV1` envelope. No I/O. The 5 RED tests pin:

1. `schemaVersion === 1`
2. `exportedAt` is a parseable ISO timestamp
3. `account.email` mirrors session.user.email; null coerces to empty string
4. `characters` is always `[]`
5. `sharing` is always `[]`

### `src/main/auth/authHandlers.ts` — `exportData()`

Replaces 10-07's stub `{ok:false, code:'write_failed'}` placeholder:

1. Pull live session via `supabase.auth.getSession()`. If absent → return `{ok:false, code:'write_failed', message:'Not signed in'}` (T-10-09 fail-closed invariant).
2. Build the v1 envelope via `buildExport(session)`.
3. Lazy-import `electron.{dialog, BrowserWindow}` so the module stays test-isolable (the buildExport pure function tests run without an Electron mock).
4. Open native save dialog. Default filename `sei-export-${YYYY-MM-DD}.json`.
5. User cancels → return `{ok:true, path:null}` (silent, no error in UI).
6. User accepts → `writeFile(path, JSON.stringify(envelope, null, 2))`. Return `{ok:true, path}` on success; `{ok:false, code:'write_failed', message:'<error>'}` on filesystem failure.

### `src/renderer/src/screens/SettingsScreen.tsx` (no changes)

Plan 10-07 already wired the Export My Data row to call `sei.exportData()` and surface the result. Plan 10-09 only flips the IPC handler from a stub to the real implementation — no SettingsScreen changes required.

## Tests + gates

- `npx vitest run` — **35/35 phase-10 tests pass** (5 new in `exportBuilder.test.ts` locking the D-14 contract)
- `npx tsc --noEmit` clean
- D-14 acceptance grep gates all pass (schemaVersion=1, characters[], sharing[] present in code)

## Deviations

A handful of `==1` planner grep gates counted substring matches in code comments (same planner-template pattern as plan 10-07 deferred-items #9 and plan 10-08 deferred-items #10). Resolved inline by JSDoc rewording; no code action. Documented in deferred-items.md#11.

No implementation drift.

## Deferred: live 8-step UAT

Persisted in `10-09-HUMAN-UAT.md` with `status: partial` and every step `result:[pending]`. Step 5 (open the file, verify exactly 5 top-level keys with `characters` + `sharing` empty-but-present) is the CRITICAL D-14 verification — any violation blocks phase-10 close. The buildExport tests already verify this against synthetic inputs; the live UAT exercises the dialog + writeFile chain.

## Wiring contract for Phase 16 (import tooling)

Phase 16 (or any external consumer) reading the export file MUST handle:
- `schemaVersion` (gate on `===1`; throw on anything else, including 0 or undefined)
- `account` always present (Phase 10 onward)
- `characters` and `sharing` always arrays; empty in Phase 10, populated in Phase 11/12
- `exportedAt` is informational only — not used for any conflict resolution

Default filename pattern `sei-export-YYYY-MM-DD.json` should be recognised by import tooling for auto-detection.

## Commits (chronological)

- `477a216` test(10-09): add failing tests for buildExport envelope (RED)
- `cb1c292` feat(10-09): implement buildExport pure function + SeiExportV1 type (GREEN)
- `12afbc4` feat(10-09): implement exportData handler — session → envelope → save dialog → writeFile
- *(inline orchestrator commits: 10-09-HUMAN-UAT.md + deferred-items.md#11 + this SUMMARY.md, written after subagent worktrees were merged)*
