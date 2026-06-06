---
phase: 07-pillar-up-scaffolding-behavior-place-equip-actions-and-pilla
plan: 03
subsystem: bot/adapter/minecraft/behaviors
tags: [dig, cuboid, pathfind, scaffolding-hint]
requires: [07-01]
provides:
  - digCuboid
  - composeVerticalHint
  - enumerateDigCells
  - CUBOID_ITERATION_ORDER
affects:
  - dig.js (digAction now branches on args.to)
  - pathfind.js (goTo composes vertical hint post-pathfind)
tech-stack:
  added: []
  patterns:
    - "mirror-mineVein-loop-discipline (per-cell signal check, pre-pathfind only when out of reach)"
    - "post-process result string compositor (composeVerticalHint)"
key-files:
  created: []
  modified:
    - src/bot/adapter/minecraft/behaviors/dig.js
    - src/bot/adapter/minecraft/behaviors/pathfind.js
decisions:
  - "Export DIG_REACH so digCuboid shares the constant (was module-local in 07-01)"
  - "Export composeVerticalHint to enable unit testing without stubbing full mineflayer registry"
metrics:
  duration: "~10 minutes"
  completed: "2026-05-12"
requirements: [R-02, R-06]
---

# Phase 07 Plan 03: Dig cuboid + vertical unreachable hint Summary

Extend single-cell `dig` with a cuboid branch (`args.to` present) and inject `unreachable — try build to Y=N` from both `goTo` and `dig` when failure has vertical character.

## What changed

### dig.js
- Imported `Vec3` (needed for `bot.blockAt(new Vec3(...))` in cuboid loop).
- Exported `DIG_REACH` (was module-local) so callers share the constant.
- `DIG_DESCRIPTION` extended with a CUBOID MODE paragraph mentioning `to:`, `hollow?`, the 256-cell cap, top-down iteration, and `seed_cuboid_grammar`. Single-cell semantics preserved verbatim.
- Added `CUBOID_ITERATION_ORDER` constant documenting D-07 order (`Y-desc → X-asc → Z-asc`).
- Added `enumerateDigCells(from, to, hollow)` — produces axis-aligned region cells, descending Y, ascending X, ascending Z. `hollow` keeps only x/z perimeter walls.
- Added `digCuboid(args, bot, config)` — mirrors `mineVeinAction` loop discipline: per-cell signal check, silently skip air (`air`/`cave_air`/`void_air`) per D-06, pre-pathfind with `goTo(np, range:3)` only when `dist > DIG_REACH`, accumulate `K/N` plus optional ` (S skipped air)`.
- `digAction` branches on `args.to` plus explicit `{x,y,z}` to dispatch `digCuboid`.
- Single-cell `out of range` return now appends ` — unreachable — try build to Y=N` when `by > bp.y + 2` (D-09). Existing `startsWith('dug ')` consumer logic is unaffected because the hint is appended, not prepended.

### pathfind.js
- Added `composeVerticalHint(bot, x, y, z, result)` — post-processes `goTo` return strings. Appends `— unreachable — try build to Y=N` to `cant_reach`/`timeout` (and any non-reached/no_bot string) when `y > bp.y + 2`. `reached` and `no_bot` pass through.
- `goTo` now awaits the race, then runs the composer before returning.
- `composeVerticalHint` is exported (deliberate testability decision — see below).

## Verification

Inline node verify scripts (per plan):

- **Task 1** (dig.js): `enumerateDigCells({x:0,y:64,z:0},{x:0,y:65,z:4},false)` → 10 cells, first y=65, last y=64; `DIG_DESCRIPTION` contains `cuboid` and `seed_cuboid_grammar`; `digCuboid` is exported function. → `OK`
- **Task 1 extra**: hollow shell math (4×3×4 → 36 perimeter cells, no interior leak); `digCuboid` with stub bot returning alternating air/stone returns exactly `dug 1/2 (1 skipped air)` for a 2-cell column. → `OK`
- **Task 2** (pathfind.js): all 8 composeVerticalHint cases pass: cant_reach+high-y appends hint, cant_reach+low-y does not, timeout+high-y appends, reached/no_bot pass through, no-bot-entity passes through, `y == bot.y + 2` boundary does NOT trigger (strict `>`), `y == bot.y + 3` does trigger. → `OK`

Grep acceptance criteria:
- `composeVerticalHint` occurrences in pathfind.js: 2 (def + call)
- `try build to Y=` in pathfind.js: 1; in dig.js: 1
- `export async function digCuboid` in dig.js: 1
- `CUBOID_ITERATION_ORDER` in dig.js: 1
- `args.to` in dig.js: 2
- `seed_cuboid_grammar` in dig.js (excluding comments): 1
- `bp.y + 2` margin in pathfind.js: 1 (line 16)

## Commits

- `5456d73` feat(07-03): add digCuboid + vertical unreachable hint in dig.js
- `269aa7c` feat(07-03): vertical unreachable hint on goTo failures (D-09)

## Deviations from Plan

### Auto-fixed / Adjustments

**1. [Rule 3 — Blocking] Export `composeVerticalHint`**
- **Found during:** Task 2 verification
- **Issue:** The plan's verify script constructs `new Movements(bot)` indirectly by calling `goTo`. That ctor reads ~20 fields off `bot.registry` (blocksByName.chest, blocksArray, items, prismarine-block init) and dies with `Cannot read properties of undefined (reading 'NaN')` on stub bots. Building a stub registry comprehensive enough to survive Movements + prismarine-block init is impractical for a unit-level verify (would need full minecraft-data plumbing).
- **Fix:** Export `composeVerticalHint` so it can be unit-tested directly with a trivial bot stub. The behavior under test (string composition based on `y` vs `bp.y + 2`) is pure; testing it without invoking pathfinder ctor preserves test fidelity while avoiding a 50-line registry stub.
- **Files modified:** `pathfind.js` (added `export` keyword to the helper).
- **Commit:** `269aa7c`

**2. [Rule 3 — Blocking] Export `DIG_REACH`**
- **Issue:** `DIG_REACH` was module-local in dig.js; `digCuboid` (also in dig.js — so technically same-module access works) consumes it for the in-reach short-circuit. Promoted to `export` so the constant is part of the documented interface and external callers (tests, future ranged-action wrappers) can share it without magic numbers.
- **Files modified:** `dig.js`
- **Commit:** `5456d73`

No architectural changes. No auth gates. No deferred items.

## Self-Check: PASSED

- `src/bot/adapter/minecraft/behaviors/dig.js` exists, contains `digCuboid`, `enumerateDigCells`, `CUBOID_ITERATION_ORDER`, cuboid branch in `digAction`, and vertical hint in single-cell out-of-range return.
- `src/bot/adapter/minecraft/behaviors/pathfind.js` exists, contains `composeVerticalHint` (exported), called post-race inside `goTo`.
- Commit `5456d73` present in `git log`.
- Commit `269aa7c` present in `git log`.
- Both inline verify scripts print `OK`.
- All grep acceptance criteria satisfied.

## Threat Flags

None. No new network surface, no auth, no trust-boundary schema changes. Cuboid cap (256 cells) enforced at the schema layer in 07-01; this plan does not relax it.
