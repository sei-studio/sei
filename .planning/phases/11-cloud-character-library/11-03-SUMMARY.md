---
phase: 11
plan: 03
subsystem: shared-schema
tags: [schema, zod, types, paths, legal-versioning]
requirements_addressed: [LIB-01, LIB-04, LIB-05, LIB-06, LIB-07]
dependency_graph:
  requires: []
  provides:
    - CharacterSchema with shared/slug/metadata + UUID id
    - TOS_VERSION + PRIVACY_VERSION constants
    - portraitPath, portraitsDir, syncQueuePath, migrationManifestPath helpers
  affects:
    - Plan 11-05 (migration uses migrationManifestPath + slug field)
    - Plan 11-06 (portrait pipeline uses portraitPath + portraitsDir)
    - Plan 11-07 (cloudCharacterClient maps shared/slug/metadata to columns)
    - Plan 11-08 (syncWorker uses syncQueuePath)
    - Plan 11-14 (tosGate imports TOS_VERSION/PRIVACY_VERSION)
tech_stack:
  added: []
  patterns:
    - "Zod default(...) for forward-compat metadata escape hatch"
    - "Path helpers as `paths` object methods (mirrors existing skinPngPath/wizardStatePath style)"
key_files:
  created:
    - src/shared/legalVersions.ts
    - src/shared/characterSchema.test.ts
  modified:
    - src/shared/characterSchema.ts
    - src/main/paths.ts
    - src/main/migration.ts (Rule 3 — type-fix to satisfy new required fields)
    - src/renderer/src/screens/AddCharacterScreen.tsx (Rule 3 — type-fix)
decisions:
  - "D-16: shared defaults to true (signed-in characters cloud-shared by default)"
  - "D-23: id is UUID v4; slug carries human-readable label; no backward-compat shim — migration 11-05 rewrites legacy rows"
  - "D-24: metadata jsonb escape hatch for forward-compat schema additions"
  - "D-27: TOS_VERSION/PRIVACY_VERSION centralized constants, bumped to re-prompt"
  - "D-28: portrait_image stays permissive string|null this plan; strict refinement (no data: prefix) lands in Plan 11-06 ahead of any cloud upload path"
metrics:
  duration_minutes: 8
  tasks_completed: 3
  files_changed: 5
  tests_added: 10
  commits: 4
  completed: "2026-05-21"
---

# Phase 11 Plan 03: Schema + Paths Foundation Summary

UUID-id contracts + legal-version constants + portrait/sync/migration path helpers ship as the interface-first foundation that every downstream Phase 11 plan consumes.

## What Was Built

### Task 1 — CharacterSchema extension (TDD)

**RED gate (aaee4d8):** Added `src/shared/characterSchema.test.ts` with 10 tests covering:

- UUID id acceptance + slug-id rejection (D-23)
- `shared` default-true and explicit-false (D-16)
- `slug` default-null and explicit value (D-23)
- `metadata` default-`{}` and arbitrary payload (D-24)
- `portrait_image` accepts path-reference string and null (D-28)

Pre-implementation run: 7 failed / 3 passed → confirmed RED.

**GREEN gate (4c1d825):** Updated `src/shared/characterSchema.ts`:

- `id: z.string().uuid({ message: 'characterId must be a UUID v4' })` (replaces `z.string().min(1)`)
- Added `shared: z.boolean().default(true)` after `is_default`
- Added `slug: z.string().nullable().default(null)`
- Added `metadata: z.record(z.unknown()).default({})`
- Updated `portrait_image` block-comment to flag the deferred 11-06 refinement

Post-implementation run: **10/10 tests pass**.

### Task 2 — legalVersions.ts (1a40a6b)

Created `src/shared/legalVersions.ts` exporting `TOS_VERSION = '2026-05-21'` and `PRIVACY_VERSION = '2026-05-21'`. Date matches the Effective Date baked into Plan 11-02's `terms.html` and `privacy.html`. Cross-plan invariant — bumping either constant triggers AcceptToSModal mount on next sign-in (Plan 11-14).

### Task 3 — paths.ts helpers (bc21f61)

Added four helpers to the existing `paths` object (preserving member-function style):

| Helper | Resolves to | Caller plan |
|--------|-------------|-------------|
| `portraitPath(uuid)` | `<userData>/portraits/<uuid>.png` | 11-06 portrait pipeline |
| `portraitsDir()` | `<userData>/portraits` | 11-06 mkdir / cleanup |
| `syncQueuePath()` | `<userData>/sync-queue.json` | 11-08 sync worker |
| `migrationManifestPath()` | `<userData>/migration-uuid-rename.json` | 11-05 slug→UUID rename idempotency marker |

No existing helpers removed.

## Verification

- `npx vitest run src/shared/characterSchema.test.ts` — **10 passed**
- `npx tsc -b` — only the 2 pre-existing baseline errors (`loopbackPkce.ts` `flowType` and `supabaseClient.test.ts` spread); **no new errors introduced** by this plan
- All seven acceptance-criteria grep counters across tasks 1–3 match (1 each for shared/slug/metadata/uuid; 1 each for TOS/PRIVACY constants; 1 each for the four path helpers and their literal targets)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Blocking issue] Updated two downstream Character literal constructions**

- **Found during:** Task 1 typecheck verification
- **Issue:** Adding `shared`, `slug`, `metadata` as required schema fields broke two existing call sites that build `Character` literals via TypeScript type assertion (Zod defaults apply only at parse time, not at literal-construction time): `src/main/migration.ts` (legacy `sui` migration row) and `src/renderer/src/screens/AddCharacterScreen.tsx` (Add Character wizard draft).
- **Fix:** Added explicit `shared: true`, `slug: 'sui'`/`null`, `metadata: {}` to each Character literal with inline comments pointing at the future plans that will rewire them (11-05 for migration, 11-09 for the wizard's shared checkbox). Migration `id: 'sui'` is deliberately left as-is — Plan 11-05 owns the slug→UUID rename and is expected to overwrite the runtime value before Zod ever parses it.
- **Files modified:** `src/main/migration.ts`, `src/renderer/src/screens/AddCharacterScreen.tsx`
- **Commit:** 4c1d825 (folded into Task 1 GREEN commit)

The plan body explicitly green-lights "No backward-compat shims for legacy slug-based ids in CharacterSchema… migration 11-05 handles the data rewrite," so leaving the legacy `'sui'` literal in `migration.ts` is intentional. The Rule 3 fix is purely about keeping typecheck green for fields that have schema defaults.

### Notes

- The plan references `npm run typecheck` / `npm test` scripts that do not exist in `package.json`. Used the underlying tools directly: `npx tsc -b` and `npx vitest run`. This matches how other test files in the repo (e.g., `src/main/auth/*.test.ts`) are run.
- Vitest's transform cache caused stale module reads after editing `characterSchema.ts`; cleared `node_modules/.vite` + `node_modules/.vitest` once and tests then picked up the new schema correctly.

## TDD Gate Compliance

| Gate | Commit | Status |
|------|--------|--------|
| RED | aaee4d8 `test(11-03): add failing schema tests…` | Verified — 7 failed, 3 passed pre-impl |
| GREEN | 4c1d825 `feat(11-03): extend CharacterSchema…` | Verified — 10/10 pass post-impl |
| REFACTOR | — | Not needed (schema additions were minimal field declarations) |

## Threat Surface Scan

No new threat surface beyond what the plan's `<threat_model>` already enumerated. T-11-03-01 mitigation (Zod `uuid()` on `id`) is in place. T-11-03-02 acceptance (permissive portrait_image, refinement deferred to 11-06) is documented inline with a comment naming the future enforcing plan. T-11-03-03 mitigation (TOS_VERSION = terms.html Effective Date) is upheld by the exact string `'2026-05-21'`.

## Commits

| Hash | Subject |
|------|---------|
| aaee4d8 | test(11-03): add failing schema tests for UUID id + shared/slug/metadata defaults |
| 4c1d825 | feat(11-03): extend CharacterSchema with shared/slug/metadata + UUID id |
| 1a40a6b | feat(11-03): add legalVersions.ts with TOS_VERSION and PRIVACY_VERSION |
| bc21f61 | feat(11-03): add portraitPath, portraitsDir, syncQueuePath, migrationManifestPath |

## Self-Check: PASSED

- `src/shared/characterSchema.ts` modified — FOUND
- `src/shared/characterSchema.test.ts` created — FOUND
- `src/shared/legalVersions.ts` created — FOUND
- `src/main/paths.ts` modified — FOUND
- `src/main/migration.ts` modified (Rule 3 fix) — FOUND
- `src/renderer/src/screens/AddCharacterScreen.tsx` modified (Rule 3 fix) — FOUND
- Commit aaee4d8 — FOUND in git log
- Commit 4c1d825 — FOUND in git log
- Commit 1a40a6b — FOUND in git log
- Commit bc21f61 — FOUND in git log
