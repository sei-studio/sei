---
phase: 07-pillar-up-scaffolding-behavior-place-equip-actions-and-pilla
plan: 04
subsystem: bot/brain + bot/adapter/minecraft
tags: [llm-surface, action-descriptions, drift-elimination]
requires: [07-02, 07-03]
provides:
  - "LLM-facing visibility for placeBlock, equip, build"
  - "Cuboid-aware dig description (CUBOID MODE)"
  - "Canonical DIG_DESCRIPTION / BUILD_DESCRIPTION imports in both ACTION_DESCRIPTIONS maps"
affects:
  - src/bot/adapter/minecraft/index.js
  - src/bot/brain/orchestrator.js
tech-stack:
  added: []
  patterns: ["import canonical strings from behavior modules (mirrors mine_vein pattern)"]
key-files:
  modified:
    - src/bot/adapter/minecraft/index.js
    - src/bot/brain/orchestrator.js
decisions: []
metrics:
  tasks_completed: 2
  files_modified: 2
  duration_minutes: ~5
  completed: 2026-05-12
---

# Phase 07 Plan 04: Surface placeBlock/equip/build + cuboid-aware dig to LLM Summary

Wired placeBlock, equip, build, and the cuboid-aware DIG_DESCRIPTION into both ACTION_DESCRIPTIONS maps (adapter index.js + brain orchestrator.js), importing canonical strings from `behaviors/dig.js` and `behaviors/build.js` to eliminate drift.

## What changed

### Task 1 — `src/bot/adapter/minecraft/index.js` (commit `fb4e001`)
- Added imports: `DIG_DESCRIPTION` (from `./behaviors/dig.js`), `BUILD_DESCRIPTION` (from `./behaviors/build.js`).
- Replaced hard-coded dig literal with `dig: DIG_DESCRIPTION` (the prior comment on L29-30 explicitly flagged drift risk — now resolved by import).
- Appended three entries: `placeBlock`, `equip`, `build`.

### Task 2 — `src/bot/brain/orchestrator.js` (commit `f9480cd`)
- Added imports adjacent to existing `MINE_VEIN_DESCRIPTION` import (line 25).
- Replaced inline dig literal with `dig: DIG_DESCRIPTION`.
- Appended `placeBlock`, `equip`, `build` after `find:`. The placeBlock and equip strings are byte-identical to those in adapter index.js (verified by diff).

## Verification

| Check | Result |
|-------|--------|
| `grep "import { DIG_DESCRIPTION }" index.js` | 1 match |
| `grep "import { BUILD_DESCRIPTION }" index.js` | 1 match |
| 3 new keys in index.js ACTION_DESCRIPTIONS | 3 (placeBlock, equip, build) |
| `dig: DIG_DESCRIPTION` in index.js | 1 match |
| Verify script for adapter (`getActionDescription` returns expected text) | `OK` |
| `grep "import { DIG_DESCRIPTION }" orchestrator.js` | 1 match |
| `grep "import { BUILD_DESCRIPTION }" orchestrator.js` | 1 match |
| 3 new keys in orchestrator.js | 3 |
| `dig: DIG_DESCRIPTION` in orchestrator.js | 1 match |
| orchestrator.js imports cleanly (`node -e import(...)`) | `import-ok` |
| `placeBlock`/`equip` strings byte-identical across both maps | `BYTE-IDENTICAL` |

## Deviations from Plan

None — plan executed exactly as written.

## Flagged Follow-up

Two `ACTION_DESCRIPTIONS` maps still coexist (`src/bot/adapter/minecraft/index.js` and `src/bot/brain/orchestrator.js`). Per planner-brief item 2 / D-03, this plan intentionally updated both rather than consolidating. **Recommendation:** schedule a follow-up phase to consolidate into a single source of truth — likely promoting the adapter map as canonical and having the orchestrator consume `adapter.getActionDescription()` instead of maintaining its own mirror. The risk surface is now smaller because all non-trivial strings (`dig`, `mine_vein`, `build`) are imported from behavior modules; only the simple inline strings (`goTo`, `setGoals`, `say`, `follow`, `unfollow`, `attackEntity`, `find`, `placeBlock`, `equip`) still duplicate between the two maps.

## Commits

- `fb4e001` — feat(07-04): surface placeBlock/equip/build + import DIG/BUILD_DESCRIPTION in adapter map
- `f9480cd` — feat(07-04): mirror placeBlock/equip/build + DIG/BUILD_DESCRIPTION imports in orchestrator map

## Self-Check: PASSED

- `src/bot/adapter/minecraft/index.js`: FOUND (modified)
- `src/bot/brain/orchestrator.js`: FOUND (modified)
- commit `fb4e001`: FOUND
- commit `f9480cd`: FOUND
