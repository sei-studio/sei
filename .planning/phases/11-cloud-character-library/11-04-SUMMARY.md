---
phase: 11-cloud-character-library
plan: 04
subsystem: config
tags: [defaults, uuid, bundled-assets, d-22, d-23]

# Dependency graph
requires: []
provides:
  - "DEFAULT_CHARACTER_UUIDS const map exported from src/main/defaultCharacters.ts (3 frozen UUID v4 strings)"
  - "DefaultCharacterSlug type alias (keyof typeof DEFAULT_CHARACTER_UUIDS)"
  - "DEFAULT_CHARACTERS array entries now key on UUID instead of slug"
  - "Bundled JSON files (sui/lyra/clawd) now carry id=<UUID> and slug=<kebab-name>"
affects: [11-05-slug-uuid-migration, 11-06-portrait-storage, 11-07-cloud-character-client, 11-08-skin-store-uuid-resolution]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Frozen UUID map for bundled assets (D-22 + RESEARCH Pattern 8 + Assumption A6) — generate once, never re-roll"
    - "Cross-file UUID invariant: JSON id field MUST equal DEFAULT_CHARACTER_UUIDS[slug] entry"

key-files:
  created: []
  modified:
    - "src/main/defaultCharacters.ts"
    - "resources/default-characters/sui.json"
    - "resources/default-characters/lyra.json"
    - "resources/default-characters/clawd.json"

key-decisions:
  - "UUIDs generated via crypto.randomUUID() at plan execution time, hardcoded as string literals (D-22 stability requirement)"
  - "DEFAULT_CHARACTERS array uses spread + explicit id override ({...CharacterSchema.parse(json), id: DEFAULT_CHARACTER_UUIDS.X}) to guarantee the runtime id always matches the const map even if the JSON drifts"
  - "The new `slug` field on bundled JSON is stripped by CharacterSchema (no slug field in schema yet — Plan 11-03 adds it). For this plan in this worktree's base commit, slug lives in the JSON for future bundledSkinPath UUID→slug lookups but does not flow through Zod parsing"

patterns-established:
  - "DEFAULT_CHARACTER_UUIDS as frozen const — re-rolling breaks every existing install after slug→UUID migration (Plan 11-05)"
  - "Bundled defaults carry both `id` (UUID, canonical) and `slug` (kebab name, asset-path lookup)"

requirements-completed: [LIB-02]

# Metrics
duration: 12min
completed: 2026-05-21
---

# Phase 11 Plan 04: Bundled Default UUIDs Summary

**Three crypto-randomUUID-v4 strings frozen as DEFAULT_CHARACTER_UUIDS in src/main/defaultCharacters.ts and propagated into resources/default-characters/{sui,lyra,clawd}.json as the canonical `id` field, with `slug` retained as a sibling field for asset-path resolution.**

## The Three Frozen UUIDs

These UUIDs are immutable from this point on. Plan 11-05 (slug→UUID migration) reads them. Re-rolling breaks every existing install.

| Slug  | UUID                                   |
| ----- | -------------------------------------- |
| sui   | `bbf5b66f-2f0f-4918-a953-a2cf66d5a586` |
| lyra  | `e4511df2-fd20-470b-9131-f8f9968e1c01` |
| clawd | `25770cd6-a50b-409d-a7e2-6cc2026dd673` |

## Performance

- **Duration:** ~12 min
- **Started:** 2026-05-21T23:35Z
- **Completed:** 2026-05-21T23:50Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments

- Added `DEFAULT_CHARACTER_UUIDS` const map (3 entries, frozen UUIDs) + `DefaultCharacterSlug` type alias to `src/main/defaultCharacters.ts`
- `DEFAULT_CHARACTERS` array rewritten to spread the parsed JSON and explicitly override `id` from the const map — runtime invariant: array `.id` ≡ `DEFAULT_CHARACTER_UUIDS.X`
- Rekeyed all 3 bundled JSON files to UUID `id` + added `slug` sibling field; every other field (`name`, `persona`, `is_default`, `created`, `playtime_ms`, `portrait_image`, `skin`, `username`) is byte-identical to the pre-plan state
- Cross-file invariant verified: the 3 UUIDs in `defaultCharacters.ts` exactly match the 3 `id` values in the JSON files (programmatic check confirmed)

## Task Commits

1. **Task 1: Generate 3 frozen UUIDs and add DEFAULT_CHARACTER_UUIDS map** — `f7fd9c8` (feat)
2. **Task 2: Update bundled JSON files** — `6ec82e1` (feat)

## Files Created/Modified

- `src/main/defaultCharacters.ts` — added DEFAULT_CHARACTER_UUIDS const + type + reworked DEFAULT_CHARACTERS array to override id from const map
- `resources/default-characters/sui.json` — id → UUID, added slug:"sui"
- `resources/default-characters/lyra.json` — id → UUID, added slug:"lyra"
- `resources/default-characters/clawd.json` — id → UUID, added slug:"clawd"

## Decisions Made

- **DEFAULT_CHARACTERS array shape:** plan's literal "id: 'sui' → id: DEFAULT_CHARACTER_UUIDS.sui AND add slug" assumed an object literal with explicit `id` field. The actual existing code uses `CharacterSchema.parse(sui)` (the JSON-imported object). To satisfy the spirit of the plan AND the grep-based acceptance criterion that requires `DEFAULT_CHARACTER_UUIDS` to appear at least 4 times in the file (declaration + 3 usages), I rewrote each array entry as `{ ...CharacterSchema.parse(sui), id: DEFAULT_CHARACTER_UUIDS.sui }`. This also adds a defensive guarantee: even if a bundled JSON's `id` field were ever to drift from `DEFAULT_CHARACTER_UUIDS`, the runtime array would still emit the canonical const-map UUID.
- **Slug field in JSON without schema support:** `slug` is added to the JSON files per the plan, but `CharacterSchema` in this worktree's base commit (0a6a986) does NOT have a `slug` field — that schema update lives in Plan 11-03 (`test(11-03)` commit `aaee4d8` is on a separate branch). Zod's default behavior strips unknown keys, so the slug field lives in the JSON source-of-truth for future bundledSkinPath UUID→slug lookups (per the plan's must_haves) but does not flow through CharacterSchema.parse(). When Plan 11-03 merges and adds the `slug` field to the schema, the existing JSON data will round-trip cleanly.

## Deviations from Plan

None — plan executed as specified. The tracker-key-rewriting note in the plan ("If existing tracker contains slug strings, the slug→UUID migration in Plan 11-05 will rewrite it; this plan just emits UUIDs going forward") explicitly defers tracker rewriting to 11-05, so no change to `seedDefaultCharacters` body was required: the loop body already keys on `c.id`, which is now a UUID via the spread+override pattern.

## Issues Encountered

- **Pre-existing typecheck errors (out of scope):** `npx tsc -b` in this worktree reports 2 errors, both pre-existing in Phase 10 code (`src/main/auth/loopbackPkce.ts:83` Supabase `flowType` typing; `src/main/auth/supabaseClient.test.ts:19` rest-parameter spread). Verified pre-existing by `git stash` baseline run before my changes — same 2 errors with no diff. My changes introduce ZERO new typecheck errors. Per scope boundary rules (deviation_rules §Scope Boundary), these are not in 11-04's scope; tracked here for visibility, not for fix.
- **tsc emit pollution from typecheck:** Running `npx tsc -b` (instead of `npx tsc --noEmit`) emitted `.js` files alongside the `.ts` source plus a `tsconfig.web.tsbuildinfo` file because the `tsconfig.web.json` doesn't set `noEmit: true`. These are pure typecheck artifacts (not part of any task). Cleaned up via plain `rm` on the specific generated files (no `git clean` per worktree safety rules). Tracked here for visibility; a future cleanup plan could add `"noEmit": true` to the tsconfigs.

## Threat Model Compliance

| Threat ID  | Status     | Notes                                                                                                                                                                                                                            |
| ---------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-11-04-01 | Mitigated  | UUIDs hardcoded as `as const` string literals + docblock explicitly says "FROZEN — re-rolling them breaks every existing install" + RESEARCH Assumption A6 cited inline.                                                          |
| T-11-04-02 | Mitigated  | `is_default: true` preserved in all 3 JSON files (byte-identical to pre-plan state on this field). Plan 11-07's cloud-upload guard relies on this invariant.                                                                      |

## Verification Performed

- `grep -c "export const DEFAULT_CHARACTER_UUIDS" src/main/defaultCharacters.ts` → `1`
- 3× UUID regex `grep -cE "(sui|lyra|clawd):\s+'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'"` → `1` each
- `grep -c "DEFAULT_CHARACTER_UUIDS" src/main/defaultCharacters.ts` → `7` (≥ 4 required: 1 declaration + 3 array usages + 3 docblock mentions)
- 3× `grep -c '"slug": "<slug>"' resources/default-characters/<slug>.json` → `1` each
- 3× `JSON.parse(fs.readFileSync(...))` exits 0 (valid JSON)
- Cross-file invariant: programmatic check confirms the 3 UUIDs in defaultCharacters.ts equal the 3 `id` values in the JSON files
- `npx tsc -b` → 2 pre-existing errors, 0 new errors from this plan

## Next Phase Readiness

- **Plan 11-05 (slug→UUID migration)** can now import `DEFAULT_CHARACTER_UUIDS` and `DefaultCharacterSlug` from `src/main/defaultCharacters.ts` to rewrite legacy slug-keyed `<userData>/characters/<slug>.json` → `<userData>/characters/<uuid>.json` paths and rewrite `defaults-seeded.json` tracker entries.
- **Plan 11-08 (skinStore UUID→slug reverse lookup)** can build a UUID→slug map from `Object.fromEntries(Object.entries(DEFAULT_CHARACTER_UUIDS).map(([k,v]) => [v,k]))` to resolve `resources/skins/<slug>.png` from a UUID.
- **Plan 11-07 (cloud character client)** can rely on `is_default: true` continuing to live in the bundled JSON to enforce the D-22 cloud-upload guard.

## Self-Check: PASSED

- FOUND: src/main/defaultCharacters.ts
- FOUND: resources/default-characters/sui.json
- FOUND: resources/default-characters/lyra.json
- FOUND: resources/default-characters/clawd.json
- FOUND: .planning/phases/11-cloud-character-library/11-04-SUMMARY.md
- FOUND: commit f7fd9c8 (Task 1)
- FOUND: commit 6ec82e1 (Task 2)

---
*Phase: 11-cloud-character-library*
*Completed: 2026-05-21*
