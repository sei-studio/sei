---
phase: 07-pillar-up-scaffolding-behavior-place-equip-actions-and-pilla
plan: 02
subsystem: bot/adapter/minecraft/behaviors
tags: [build, scaffolding, cuboid, R-01, R-03, R-04]
requires: [07-01]
provides:
  - buildAction
  - scaffoldUp
  - enumerateBuildCells
  - pickReferenceFace
  - isOccupied
  - withinReach
  - BUILD_DESCRIPTION
  - ITERATION_ORDER
affects: [orchestrator wiring (later plan)]
tech-stack:
  added: []
  patterns: [mineVein-idiom result strings, hand-rolled jump+place loop]
key-files:
  created:
    - test/build-action.test.mjs
  modified:
    - src/bot/adapter/minecraft/behaviors/build.js
decisions:
  - "Hollow cell count uses perimeter formula (corners included once) × Y-layers → 36 for 4×3×4. Walls span full Y range; no floor, no ceiling — caller composes those via flat single-Y cuboids."
  - "Iteration order Y↑→X↑→Z↑ exported as ITERATION_ORDER documented constant (D-07)."
  - "Reference-face picker walks 6 neighbors in priority [below, north, south, east, west, above]; first non-air wins. Cell skipped if all-air."
  - "scaffoldUp timing constants APEX_MAX_MS=600, LANDING_MAX_MS=800 chosen heuristically; live-bot tuning deferred to a future checkpoint plan."
  - "Per-cell placement failures (no-inv mid-loop, cannot-place, timeout) count as skipped per mineVein discipline — aggregate failure surfaces via K<N."
metrics:
  duration: ~10min
  tasks_completed: 2
  completed: 2026-05-12
---

# Phase 7 Plan 2: buildAction Implementation Summary

Implemented `buildAction` with hand-rolled jump+place scaffolding, replacing the Plan 07-01 stub. Delivers R-01 (build action body), R-03 (jump+place scaffolding), and R-04 (inventory-miss short-circuit) — verified via 14 stub-bot tests, no live mineflayer required.

## Story

`buildAction(args, bot, config)` enumerates a cuboid in Y↑→X→Z order (D-07), skips occupied cells (D-05), picks a reference face from 6 neighbors in priority order (below first → horizontals → above last), and when the next target cell is above the bot's 4.5m reach falls into `scaffoldUp` — a hand-rolled `setControlState('jump') → waitForApex → bot.placeBlock(below, (0,1,0)) → waitForLanding` loop that walks the bot up one block at a time until its feet are at `targetY - 1`. Result strings mirror `mineVeinAction` (`built K placed, S skipped, of N cells` / `aborted after K placed of N cells`).

## Tasks Completed

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | Enumerator + helpers + BUILD_DESCRIPTION (TDD RED + GREEN) | 22ffa06 (test) | test/build-action.test.mjs |
| 2 | scaffoldUp + buildAction main loop (GREEN) | 2dc1ecd | src/bot/adapter/minecraft/behaviors/build.js |

The two source-code tasks were committed together in 2dc1ecd because helpers and the main loop coexist in one file and pass the test suite as a single GREEN gate.

## Decisions Made

### Hollow cell-count formula

For `hollow:true` the wall predicate is `(x===minX || x===maxX || z===minZ || z===maxZ)` evaluated at every Y in `[minY..maxY]`. Corners are counted once per Y. For the SPEC R1 acceptance shape (4×3×4 footprint × 3 Y layers): perimeter = 12 cells per layer (4+4+2+2, with corners shared between x-edges and z-edges so 12 unique perimeter cells in a 4×4 square), × 3 layers = **36** cells. Matches SPEC R1 acceptance verbatim.

### Timing constants

`APEX_MAX_MS=600`, `LANDING_MAX_MS=800` are conservative heuristics. Vanilla jump apex is ~12 ticks (~600ms) and a 1-block fall lands in ~10 ticks (~500ms). The 800ms landing budget allows for server lag. Live-bot tuning is deferred to a future checkpoint plan once we can observe actual physics latency in a real minecraft connection.

### Per-cell failure aggregation

Following the mineVein idiom, individual `placeBlockAction` failures (no-inv, cannot-place, timeout) are not surfaced verbatim — they count as `skipped` and the caller infers failure from `K<N`. Hard scaffold failures (e.g. `scaffold failed: no floor below`) DO short-circuit the whole call with a `build halted: <reason>` string, because continuing past a scaffolding failure is incoherent.

## Deviations from Plan

### [Rule 3] Force-added test file under gitignored `test/` directory

**Found during:** Task 1 staging.
**Issue:** The plan specifies `test/build-action.test.mjs`, but `.gitignore` has `test/` ignored project-wide (no existing tests in the repo).
**Fix:** Used `git add -f` to commit the test file. Did not modify `.gitignore` — that's an architectural change (Rule 4) for a future plan to address. Verifier may need to re-add `-f` or update gitignore.
**Files modified:** test/build-action.test.mjs
**Commit:** 22ffa06

No bugs, no missing critical functionality, no auth gates.

## Verification

- `node --test test/build-action.test.mjs` → **14/14 pass** (7 enumerator/description tests + 6 buildAction behavior tests + 1 scaffoldUp short-circuit test).
- `grep -nc "^export " src/bot/adapter/minecraft/behaviors/build.js` → 9 exports (≥5 required).
- `grep -c "setControlState('jump'" src/bot/adapter/minecraft/behaviors/build.js` → 2 (true + false, required ≥2).
- `grep -c "signal?.aborted" src/bot/adapter/minecraft/behaviors/build.js` → 3 (entry + per-cell + scaffold, required ≥3).
- File size: 189 lines (exceeds 120-line floor).
- `ITERATION_ORDER` exported as documented constant.

## Known Stubs

None. `buildAction` is fully wired; orchestrator integration (LLM-facing) is a downstream plan's responsibility.

## Self-Check: PASSED

- src/bot/adapter/minecraft/behaviors/build.js — FOUND
- test/build-action.test.mjs — FOUND
- Commit 22ffa06 — FOUND
- Commit 2dc1ecd — FOUND
- 14/14 tests pass
