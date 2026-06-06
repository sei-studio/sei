---
phase: 07-pillar-up-scaffolding-behavior-place-equip-actions-and-pilla
plan: 01
subsystem: minecraft-adapter/registry
tags: [registry, schema, build, dig, cuboid]
requires: []
provides:
  - "BuildSchema (registry-layer cuboid build contract)"
  - "DigSchema (extends dig with optional `to` cuboid mode)"
  - "buildAction stub import wiring"
affects:
  - src/bot/adapter/minecraft/registry.js
  - src/bot/adapter/minecraft/behaviors/build.js
tech-stack:
  added: []
  patterns: ["Zod refine for cell-count cap mirroring mine_vein idiom"]
key-files:
  created:
    - src/bot/adapter/minecraft/behaviors/build.js (stub — overwritten by 07-02)
  modified:
    - src/bot/adapter/minecraft/registry.js
decisions:
  - "Define DigSchema as a new schema rather than mutating TargetShape so sleep/openContainer remain on the original contract"
  - "Default `hollow` is `undefined` on dig (preserve legacy behavior) and `false` on build (explicit per spec)"
metrics:
  duration: "~5m"
  completed: "2026-05-12"
requirements: [R-01, R-02, R-04, R-05]
---

# Phase 07 Plan 01: Registry schema foundation Summary

Registered the new `build` action and extended `dig` with an optional `to` cuboid field, both gated by a schema-layer 256-cell cap that rejects oversized cuboids before any side effect.

## What was built

- `BuildSchema` — `{from, to, block:string(min 1), hollow?:boolean(default false)}` with a `.refine` enforcing `|Δx+1|·|Δy+1|·|Δz+1| ≤ 256` and a human-readable split-it-up error message.
- `DigSchema` — superset of `TargetShape` with optional `to:Vec3` and optional `hollow`, two refines: (1) at least one of `block`/`target`/`(x,y,z)`, (2) cell-count cap that also requires explicit `x,y,z` when `to` is present.
- `registry.register('build', BuildSchema, buildAction)` added after `placeBlock` registration.
- `registry.register('dig', DigSchema, digAction)` replaces the previous `TargetShape` registration. `sleep` and `openContainer` continue to use the unchanged `TargetShape`.
- Stub `behaviors/build.js` exporting `BUILD_DESCRIPTION=''` and a placeholder `buildAction` so this plan verifies independently; Plan 07-02 overwrites the file.

## Verification

Both inline verify scripts from the plan print `OK`:

- build: list-includes-build, 16-cell accept, 324-cell reject, missing-block reject, single-cell accept, hollow accept — all pass.
- dig: legacy-block, legacy-xyz, cuboid-ok, cuboid-big (reject), cuboid-no-from (reject), cuboid-hollow — all pass.

Greps:
- `grep -n "registry.register('build'" src/bot/adapter/minecraft/registry.js` → 1 match (L196).
- `grep -n "registry.register('dig', DigSchema" …` → 1 match (L126).
- `grep -n "registry.register('dig', TargetShape" …` → 0 matches.
- `sleep`/`openContainer` still bound to `TargetShape` (L330, L332).

## Deviations from Plan

None — plan executed exactly as written.

## Commits

- `16ebebc` feat(07-01): register build action with 256-cell schema cap
- `5d04bc6` feat(07-01): extend dig schema with optional cuboid `to` field

## Follow-ups

- Plan 07-02 must overwrite `behaviors/build.js` with the real implementation (BUILD_DESCRIPTION + buildAction). The stub currently returns `'build not yet implemented'`.
- Plan 07-03 will add a cuboid branch inside `behaviors/dig.js` keyed on `args.to`.

## Self-Check: PASSED

- src/bot/adapter/minecraft/registry.js — FOUND
- src/bot/adapter/minecraft/behaviors/build.js — FOUND
- commit 16ebebc — FOUND
- commit 5d04bc6 — FOUND
