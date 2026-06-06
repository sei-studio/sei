---
phase: 06
plan: 01
subsystem: veined-snapshot
tags: [minecraft, mineflayer, observer, scavenging, flood-fill]
requirements: [D-NEW-SCAV-1]
dependency_graph:
  requires: [observers/blocks.js, observers/posHealer.js]
  provides: [nearbyVeins]
  affects: []
tech_stack:
  added: []
  patterns: [flood-fill-6-neighbor-same-id, mcData-id-array-matching, NaN-healed-origin]
key_files:
  created:
    - src/bot/adapter/minecraft/observers/veins.js
    - scripts/test-nearbyVeins.mjs
  modified: []
decisions:
  - Same-name-only connectivity preserved by splitting per-vein 'tried' set from cross-vein 'visited' set
  - veinCap stack-drain prevents truncated-vein-tail from restarting as second vein
  - Conservative cross-chunk behavior (null blockAt terminates branch silently, documented in JSDoc)
metrics:
  duration_sec: 118
  tasks_completed: 2
  files_changed: 2
completed: "2026-05-12"
---

# Phase 6 Plan 1: Veins Observer Summary

`nearbyVeins(bot, opts)` returns top-K 6-neighbor same-ID connected components of interesting blocks within radius 16, capped at 64 blocks per vein and 8 veins per call.

## What Shipped

- **`src/bot/adapter/minecraft/observers/veins.js`** — pure observer exporting `nearbyVeins`. Mirrors blocks.js patterns: `getHealedPos` for NaN-safe origin, `mcDataLib` id-array matching with function-form fallback, `isExposed` gate on seeds. Returns `{ veins: [{ name, anchor:{x,y,z}, count, distance }], more }` sorted by anchor distance ascending.
- **`scripts/test-nearbyVeins.mjs`** — four-scenario unit test with a tiny mineflayer stub. All four PASS (A: two-vein same-name-only separation, B: NaN guard, C: veinCap truncation, D: maxVeins+more).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Visited-set was over-marking wrong-name neighbors**
- **Found during:** Task 2 test execution (Test A failed: only 1 vein instead of 2; Test C produced 2 veins instead of 1)
- **Issue:** Initial impl unconditionally added every popped position to the global `visited` set, including wrong-name neighbors. This violated same-name-only semantics by silently consuming the spruce_log seed (its key was already in `visited` from the oak flood-fill marking its boundary). It also caused veinCap truncation to leave un-traversed members that re-seeded as a second truncated vein.
- **Fix:** Introduced a per-vein `tried` set (stack-thrash dedup, local) separate from cross-vein `visited` (only same-name members of completed veins). When veinCap fires, drain the remaining stack into `visited` so the truncated component's tail doesn't restart.
- **Files modified:** `src/bot/adapter/minecraft/observers/veins.js`
- **Commit:** 91ace13

## Verification

- `node -e "import('./src/bot/adapter/minecraft/observers/veins.js').then(m => console.log(typeof m.nearbyVeins))"` → `function`
- `node scripts/test-nearbyVeins.mjs` → exit 0; PASS A/B/C/D
- `grep -v '^//\|^ \*' src/bot/adapter/minecraft/observers/veins.js | grep -c 'setHandles'` → 0 (no handle minting in observer tier)

## Commits

- `b4c2077` — feat(06-01): add nearbyVeins flood-fill observer
- `91ace13` — test(06-01): unit test for nearbyVeins (4 scenarios) + visited-set fix

## Known Stubs

None. nearbyVeins is structurally complete; no callers wired yet (snapshot integration is plan 06-04 per the plan objective).

## Self-Check: PASSED

- FOUND: src/bot/adapter/minecraft/observers/veins.js
- FOUND: scripts/test-nearbyVeins.mjs
- FOUND: b4c2077
- FOUND: 91ace13
