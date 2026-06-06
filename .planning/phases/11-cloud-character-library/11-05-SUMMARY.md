---
phase: 11-cloud-character-library
plan: 05
subsystem: migration
tags: [migration, uuid, idempotent, first-launch, slug-rename, d-23, lib-02, lib-04]

# Dependency graph
requires:
  - phase: 11-03
    provides: "paths.migrationManifestPath() + paths.portraitPath()/portraitsDir() + paths.indexPath()"
  - phase: 11-04
    provides: "DEFAULT_CHARACTER_UUIDS frozen const map (sui/lyra/clawd UUID v4s)"
provides:
  - "runUuidRenameMigration() — idempotent one-shot slug→UUID rewrite of <userData> character/skin/memory/portrait files"
  - "Bootstrap step 1a in src/main/index.ts wiring the rename between runFirstLaunchMigration and seedDefaultCharacters"
  - "Idempotency manifest at <userData>/migration-uuid-rename.json that gates re-runs"
affects: [11-06-portrait-storage, 11-07-cloud-character-client, 11-08-skin-store-uuid-resolution]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Writes-then-renames-then-deletes-then-manifest sequencing — manifest is the idempotency gate, written LAST"
    - "Per-character failure isolation — log + skip + continue (the rest of the chars still migrate)"
    - "Frozen-UUID lookup for bundled defaults + crypto.randomUUID() for user-created (RESEARCH §Pattern 6)"
    - "Decoded data-URL portrait migrated to <userData>/portraits/<uuid>.png (the local-cache filename form; Plan 11-06 resolves to URL)"
    - "Grep gate as test — defense-in-depth check that migration.ts has zero supabase calls (LIB-02)"

key-files:
  created:
    - "src/main/migration.test.ts (300 lines, 9 vitest tests)"
  modified:
    - "src/main/migration.ts (+200 lines: runUuidRenameMigration + writeMigrationManifest helper)"
    - "src/main/index.ts (+10 lines: import + step 1a wiring with try/catch)"

key-decisions:
  - "Use existing paths.indexPath() (already canonical) rather than introducing a paths.characterIndexPath alias as suggested in the PLAN action block — single source of truth, no fallback needed"
  - "When defaults-seeded.json contains a slug NOT in the current run's manifest (e.g., sui was seeded in a prior run but no migration entry exists for it now), fall back to DEFAULT_CHARACTER_UUIDS[slug] for the remap. Prevents orphan slug entries from re-triggering seeding"
  - "Per-character read failures are logged and skipped (continue the loop) — a malformed sui.json shouldn't block lyra/clawd/lemon from migrating"
  - "Manifest is written even on the fresh-install case (no characters/index.json at all) so the idempotency gate fires next launch and we don't re-scan an empty userData every boot"
  - "atomicWrite + withFileLock used for ALL writes (manifest, new char JSON, portrait PNG, index.json, defaults-seeded.json) — matches the Phase 10 store conventions"

patterns-established:
  - "Pattern: idempotency-via-marker-file — last step of a one-shot migration is the marker write; absence of marker = re-run is safe"
  - "Pattern: per-character try/catch around the read step only — write/rename/unlink are inside the outer try (a hard failure there throws, manifest stays absent, next launch retries)"

requirements-completed: [LIB-02, LIB-04]

# Metrics
duration: 13min
completed: 2026-05-21
---

# Phase 11 Plan 05: Slug→UUID Rename Migration Summary

**One-shot idempotent migration that renames every slug-keyed local file (`<userData>/characters/sui.json`, `skins/sui.png`, `memory/sui/`) to UUID-keyed paths, decodes any `data:image` portrait into `<userData>/portraits/<uuid>.png`, rewrites `characters/index.json` + `defaults-seeded.json` to carry UUIDs, and writes `<userData>/migration-uuid-rename.json` as the gate so future launches no-op.**

## Performance

- **Duration:** ~13 min
- **Started:** 2026-05-21T16:58Z
- **Completed:** 2026-05-21T17:01Z
- **Tasks:** 2
- **Files modified:** 3 (1 created, 2 modified)

## Accomplishments

- `runUuidRenameMigration()` exported from `src/main/migration.ts`. Fully idempotent via `paths.migrationManifestPath()` existence gate (second invocation is a no-op even with slug-keyed files present).
- Wired into `src/main/index.ts` bootstrap as step **1a** — runs AFTER `runFirstLaunchMigration` (step 1) and BEFORE `seedDefaultCharacters` (step 1b), and BEFORE `createBotSupervisor` wiring (Pitfall 7).
- 9 vitest tests cover idempotency, fresh-install, default-slug rename, user-slug rename, portrait data-URL decode, memory-dir rename, skin-PNG rename, defaults-seeded remap, and a static grep gate over `migration.ts` source confirming zero supabase calls (LIB-02 invariant defense-in-depth).
- All writes go through `atomicWrite + withFileLock` for crash safety. Sequencing: write-new → rename-skins/memory → unlink-old-json → update-index → update-defaults-seeded → write-manifest (last).

## Task Commits

1. **Task 1 RED: add failing tests** — `ef4ae22` (test)
2. **Task 1 GREEN: implement runUuidRenameMigration** — `a928591` (feat)
3. **Task 2: wire into bootstrap chain** — `add280b` (feat)

_TDD: Task 1 followed RED→GREEN. No REFACTOR commit — the GREEN implementation matched the plan's action block closely; no cleanup needed._

## Files Created/Modified

- `src/main/migration.test.ts` (NEW, 300 lines) — vitest suite with vi.mock('electron') stub + `_setUserDataOverride` to redirect `paths.*` at a per-test `os.tmpdir()` scratch dir
- `src/main/migration.ts` (modified, +200 lines) — appended `runUuidRenameMigration`, `writeMigrationManifest` helper, `UUID_V4_RE`/`DATA_URL_RE` constants. The existing `runFirstLaunchMigration` is unmodified.
- `src/main/index.ts` (modified, +10 lines) — import `runUuidRenameMigration` and insert the try/catch call block between steps 1 and 1b. Comment notes Pitfall 7 boot-order requirement.

## Verification Performed

- `grep -c "export async function runUuidRenameMigration" src/main/migration.ts` → `1` ✓
- `grep -c "DEFAULT_CHARACTER_UUIDS" src/main/migration.ts` → `4` (≥1 required) ✓
- `grep -c "migrationManifestPath" src/main/migration.ts` → `4` (≥2 required: idempotency check + manifest write) ✓
- `grep -c "portraitPath" src/main/migration.ts` → `2` (≥1 required: data-URL decode path) ✓
- `grep -E "supabase\.from|getClient|supabase\.storage" src/main/migration.ts | grep -v '^#' | wc -l` → `0` ✓ (GREP GATE: zero cloud calls in migration)
- `grep -c "await runUuidRenameMigration" src/main/index.ts` → `1` ✓
- `grep -c "runUuidRenameMigration" src/main/index.ts` → `2` (import + call site) ✓
- Boot-order grep: line(`await runFirstLaunchMigration`)=120 < line(`await runUuidRenameMigration`)=130 < line(`await seedDefaultCharacters`)=137 < line(`supervisor = createBotSupervisor`)=252 ✓ (Pitfall 7)
- `npx vitest run src/main/migration.test.ts` → 9/9 passing ✓
- `npx tsc --noEmit -p tsconfig.node.json` → 2 pre-existing errors (Phase 10 carryover, also reported by 11-04 SUMMARY); ZERO new errors introduced by this plan ✓

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 — typo/API-mismatch] Used existing `paths.indexPath()` instead of `paths.characterIndexPath?.() ?? path.join(...)` fallback**

- **Found during:** Task 1
- **Issue:** The plan's action block proposed `paths.characterIndexPath?.() ?? path.join(paths.userData(), 'characters', 'index.json')` with a comment "if the existing characterStore exposes a getter, use it; else use the same literal path it uses". The actual canonical accessor in `src/main/paths.ts:28` is named `indexPath`, not `characterIndexPath` — and it is exactly the literal path the migration needs.
- **Fix:** Use `paths.indexPath()` directly. Single source of truth, no optional-chain fallback needed.
- **Files modified:** `src/main/migration.ts`
- **Commit:** `a928591`

**2. [Rule 2 — robustness] Defaults-seeded remap falls back to DEFAULT_CHARACTER_UUIDS when slug not in manifest**

- **Found during:** Task 1 (writing the defaults-seeded.json rewrite tests showed an edge case)
- **Issue:** The plan's action block remaps `defaults-seeded.json.ids` strictly by `manifest.find(e => e.oldSlug === id)`. But `defaults-seeded.json` can contain slugs (`sui`, `lyra`, `clawd`) that have NO matching manifest entry — e.g., the user deleted sui's character file but the tracker still records the seeding event so re-seeding doesn't happen. Without the fallback, those entries would be left as raw slugs in a UUID-keyed world, which would break `seedDefaultCharacters` (line 124: `if (already.has(c.id)) continue;` where `c.id` is now a UUID — the slug entry would never match).
- **Fix:** When no manifest entry exists, check `id === 'sui' | 'lyra' | 'clawd'` and substitute `DEFAULT_CHARACTER_UUIDS[id]`. Otherwise pass through unchanged (legitimate forward-compat for slugs we don't recognize).
- **Files modified:** `src/main/migration.ts`
- **Commit:** `a928591`

### Pre-existing Issues (Out of Scope — Not Fixed)

- `npx tsc --noEmit -p tsconfig.node.json` reports 2 errors that were ALREADY present at the worktree base commit (`b80997c`) before any 11-05 changes:
  - `src/main/auth/loopbackPkce.ts:83` — Supabase `flowType` typing
  - `src/main/auth/supabaseClient.test.ts:19` — rest-parameter spread typing
- Both are Phase 10 carryover and were documented in `11-04-SUMMARY.md`. My changes introduce ZERO new typecheck errors. Per scope-boundary rules these are not in 11-05's scope.

## Threat Model Compliance

| Threat ID  | Mitigation                                                                                          | Verified                                                                                                                            |
| ---------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| T-11-05-01 | New UUIDs come from `crypto.randomUUID()`, never from user input. Pre-rename slugs come from disk. | Visual review of migration.ts — `randomUUID()` is the only id generator; no `id` is interpolated from arbitrary user-supplied text. |
| T-11-05-02 | Manifest write is LAST step; partial completion → next launch re-runs idempotently on survivors.    | Test `is idempotent: returns immediately when manifest exists` covers the second-run case.                                          |
| T-11-05-03 | Migration code path has zero supabase calls — purely local rewrite (LIB-02).                       | GREP GATE test `grep gate: migration.ts source contains zero supabase/getClient references` PASSES.                                 |
| T-11-05-04 | Migration runs in bootstrap step 1a BEFORE step 4 botSupervisor wiring.                            | Boot-order grep shows line 130 (uuid-rename) precedes line 252 (createBotSupervisor) by 122 lines.                                  |
| T-11-05-05 | `DEFAULT_CHARACTER_UUIDS` is `as const` in Plan 11-04 + the migration imports the single map.       | `import { DEFAULT_CHARACTER_UUIDS } from './defaultCharacters'` at line 9 — single source of truth.                                 |

No new threat surface introduced. (No new network endpoints, no schema changes; only file rewrites under `<userData>`.)

## Patterns Established

- **Idempotency-via-marker pattern:** Last step of a one-shot migration is the marker write; absence of marker = re-run is safe; presence = early return. Reused by any future migration that needs to "do this exactly once per install".
- **Per-character failure isolation pattern:** The inner read step is wrapped in its own try/catch (log + continue). The outer write/rename/unlink path lets errors propagate so the manifest doesn't get written if the loop didn't complete. This split lets a malformed `lemon.json` not block `sui` from migrating, while a hard fs error (`EACCES` on userData) correctly leaves the manifest absent for next-launch retry.

## TDD Gate Compliance

- **RED gate (test):** `ef4ae22 test(11-05): add failing tests for runUuidRenameMigration` — confirmed 8 tests failing, 1 passing (the grep gate; passes because the function didn't exist yet so no supabase calls existed)
- **GREEN gate (feat):** `a928591 feat(11-05): implement runUuidRenameMigration slug→UUID rename` — confirmed all 9 tests pass
- **REFACTOR gate:** Skipped — GREEN implementation matched the plan's action block closely; no cleanup needed.

## Notes for Downstream Plans

- **Plan 11-06 (portrait storage):** This plan sets `portrait_image = '<uuid>.png'` (just the filename) for any character whose previous value was a `data:image/...` URL. 11-06 owns the resolution of that filename → either `file://<userData>/portraits/<uuid>.png` (local cache hit) or the public Supabase Storage URL (cloud fallback). The migration breadcrumb is the bare filename — Plan 11-06 must accept it as-is, not as a path.
- **Plan 11-07/11-08 (cloud sync):** The migration is purely local. Cloud upload of migrated characters happens later, gated on `isCloudWriteAllowed()` (which checks signed-in + email-verified + tos-accepted per Pitfall 8). The migration manifest's existence is also a useful signal: "this install is on the UUID schema, safe to cloud-mirror".
- **`runFirstLaunchMigration` interaction:** The existing legacy `runFirstLaunchMigration` writes `characters/sui.json` (slug-keyed). The new `runUuidRenameMigration` runs AFTER it (step 1 → step 1a) so the freshly-written sui.json from a legacy CLI clone is immediately picked up and renamed to its frozen UUID. Confirmed via boot-order grep.

## Self-Check: PASSED

- `src/main/migration.test.ts` FOUND ✓
- `src/main/migration.ts` FOUND (modified) ✓
- `src/main/index.ts` FOUND (modified) ✓
- Commit `ef4ae22` FOUND in git log ✓
- Commit `a928591` FOUND in git log ✓
- Commit `add280b` FOUND in git log ✓
