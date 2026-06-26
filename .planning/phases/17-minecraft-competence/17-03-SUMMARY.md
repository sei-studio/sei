---
phase: 17-minecraft-competence
plan: 03
subsystem: bot/minecraft-adapter
tags: [minecraft, registry, behaviors, furnace, signs, doors, shelter, security]
requires:
  - container.js session template
  - activate.js handler skeleton
  - build.js / dig.js cuboid primitives
  - targeting.js resolveBlock / isStaleHandle
provides:
  - "openFurnace + smeltInput + addFuel + takeSmelted (furnace 3-slot smelting)"
  - "activateBlock (door/gate/lever)"
  - "readSign (bounded + sanitized sign text)"
  - "shelter (hollow box + roof + doorway composition)"
affects:
  - src/bot/adapter/minecraft/registry.js
  - src/bot/adapter/minecraft/index.js
tech-stack:
  added: []
  patterns:
    - "single-flight module-scoped session (FURNACE_SESSION) + global close hook"
    - "signal-abort guard + timeout race + reason() formatting handler skeleton"
    - "sanitize-at-source for untrusted server text (sign-text T-17-07)"
    - "composition over new primitive (shelter = build + dig)"
key-files:
  created:
    - src/bot/adapter/minecraft/behaviors/furnace.js
    - src/bot/adapter/minecraft/behaviors/furnace.test.js
    - src/bot/adapter/minecraft/behaviors/activateBlock.js
    - src/bot/adapter/minecraft/behaviors/readSign.js
    - src/bot/adapter/minecraft/behaviors/interact.test.js
    - src/bot/adapter/minecraft/behaviors/shelter.js
    - src/bot/adapter/minecraft/behaviors/shelter.test.js
  modified:
    - src/bot/adapter/minecraft/registry.js
    - src/bot/adapter/minecraft/index.js
decisions:
  - "Furnace slot ops reuse the container.js deposit/withdraw template verbatim (reach check, timeout race, abort race) with a separate FURNACE_SESSION."
  - "closeFurnaceSession wired into index.js closeAnySessions beside closeContainerSession so a furnace window never leaks into the next open."
  - "readSign sanitizes BEFORE returning: strips section-codes + ASCII control chars, collapses whitespace, caps to MAX_SIGN_CHARS=200 — the T-17-07 prompt-injection/bloat mitigation at the source."
  - "shelter is a composition of build()+dig(), not a new world primitive — keeps the closed registry closed and the 256-cell guarantee (size capped to 5)."
  - "activateBlock uses bot.activateBlock (block-interact packet), unaffected by #3742; distinct from the broken activateItem."
metrics:
  duration: ~25m
  completed: 2026-06-26
  tasks: 3
  files: 9
---

# Phase 17 Plan 03: Minecraft Competence — Furnace / Doors / Signs / Shelter Summary

Added the four missing world primitives as new typed, Zod-validated closed-registry actions, each following the established signal-abort + timeout-race + `reason()` handler skeleton with no new npm dependency.

## Registered Action Names + Arg Schemas (for Plan 05 advertisement)

| Action | Schema | Returns |
|--------|--------|---------|
| `openFurnace` | `TargetShape` ({ block?, target?, x/y/z, maxDistance }) | `opened <name>` / `no target` / out-of-reach |
| `smeltInput` | `{ item: string, count: int 1..64 = 1 }` | `smelting N <item>` / `no furnace open` / `no <item> to smelt` |
| `addFuel` | `{ item: string, count: int 1..64 = 1 }` | `added N <item> fuel` / `no furnace open` / `no <item> to fuel` |
| `takeSmelted` | `{}` (no args) | `took N <item>` / `nothing smelted yet` / `no furnace open` |
| `activateBlock` | `TargetShape` | `opened <name>` / `no target` / `stale target` / out-of-reach |
| `readSign` | `TargetShape` | `sign: "<sanitized text>"` / `sign is blank` / `no sign there` |
| `shelter` | `{ center?: {x,y,z}, size: int 3..5 = 3, material: string = 'cobblestone' }` | `built shelter NxNxH with a doorway (...)` |

## What Was Built

**Task 1 — Furnace 3-slot smelting (MCRAFT-01).** `furnace.js` mirrors `container.js`: a module-scoped single-flight `FURNACE_SESSION = { furnace, blockPos }` with `closeFurnaceSession()`. `openFurnaceAction` resolves the furnace block (`resolveBlock`), reach-checks (REACH 4), and races `bot.openFurnace(target)` against a timeout (closes the session) and the abort signal. The three slot ops (`smeltInput`/`addFuel`/`takeSmelted`) follow the deposit/withdraw template — `no furnace open` guard → resolve item id → `putInput`/`putFuel`/`takeOutput` raced against timeout + abort. `closeFurnaceSession` is wired into `index.js` `closeAnySessions` beside the container close.

**Task 2 — Door/gate activation + sign reading (MCRAFT-05, MCRAFT-04).** `activateBlock.js` clones `activate.js`'s shell but calls `bot.activateBlock(target)` (block-interact packet, unaffected by #3742), resolving + reach-checking the target first. `readSign.js` reads `block.getSignText()` and **sanitizes before returning** (T-17-07): strips `§`-color sequences, strips ASCII control chars (incl. newlines), collapses whitespace, and caps the joined faces to `MAX_SIGN_CHARS = 200`; blank → `sign is blank`, non-sign → `no sign there`. Read-only, no world mutation.

**Task 3 — Shelter convenience (MCRAFT-06).** `shelter.js` composes `buildAction` (hollow walls across a 3-layer height range + a solid single-Y roof layer) and `digAction` (a 1-wide, 2-tall front doorway). Base sits one block above the bot (build-on-terrain). `ShelterSchema` caps `size` to 5, keeping the composed cuboids (≤48 wall + 25 roof cells) well under the 256-cell guarantee.

## TDD Gate Compliance

Tasks 1 and 2 (`tdd="true"`) followed RED → GREEN: a failing `test(...)` commit (module-not-found) preceded each `feat(...)` implementation commit. Task 3 (`type="auto"`) shipped its `shelter.test.js` alongside the implementation in one `feat(...)` commit.

- `test(17-03): add failing furnace 3-slot smelting tests` → `feat(17-03): furnace 3-slot smelting actions`
- `test(17-03): add failing door-activate + sign-read tests` → `feat(17-03): door/gate activation + bounded sign reading`
- `feat(17-03): shelter convenience action`

## Tests

`npx vitest run` on the three new suites: **27 passed** (furnace 13, interact 10, shelter 4). Full minecraft-adapter suite regression: **135 passed (18 files)** — registry/index edits broke nothing.

## Threat Model Compliance

- **T-17-07 (sign-text injection, high):** mitigated — `readSign` strips control chars + section codes and caps to 200 chars before returning; asserted by the oversized+control-char test.
- **T-17-08 (furnace session leak):** mitigated — single-flight `FURNACE_SESSION` with open/transfer timeouts + `closeFurnaceSession` in chain-end cleanup.
- **T-17-09 (shelter cell blow-up):** mitigated — `size.max(5)` bounds the composed cuboids.
- **T-17-10 (coordinate injection):** mitigated — all four actions use typed `TargetShape`/`Vec3Shape`/`{item,count}` schemas; no free-form path.
- **T-17-SC (dependency installs):** n/a — no new npm packages.

## Deviations from Plan

None — plan executed as written. Implementation notes: `attachAbort` and `itemIdByName` were copied into `furnace.js` (they are not exported from `container.js`), per the plan's "copy or import" allowance. The control-char and section-code strip regexes use explicit hex/unicode escapes (`/[\x00-\x1F\x7F]/`, `/§./`) for readability and robustness.

## Known Stubs

None.

## Self-Check: PASSED

All 8 created files present on disk; all 6 task commits + the docs commit present in `git log`. New-action suites green (27), full adapter suite green (135).
