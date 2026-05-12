---
phase: 07-pillar-up-scaffolding-behavior-place-equip-actions-and-pilla
plan: 07
subsystem: verification
tags: [verify, harness, phase-close, live-checkpoint]
requires: [07-01, 07-02, 07-03, 07-04, 07-05, 07-06]
provides:
  - "scripts/verify-phase7.mjs — 13-assertion offline harness covering R-01..R-06 + D-03..D-10"
  - "Live-bot checkpoint procedure for the three SPEC acceptance scenarios + mid-action preempt safety"
affects: [scripts/verify-phase7.mjs]
key-files:
  created:
    - scripts/verify-phase7.mjs
decisions:
  - "Live-bot scenarios are documented as a manual checkpoint, not automated. The harness covers every assertion that can be exercised against stub bots; in-world placeBlock face semantics, real pathfinder timing, and apex/landing physics still need eyes-on confirmation."
  - "Harness mirrors verify-phase5/6.mjs idiom: pure ESM, node:assert/strict, dynamic imports, stub bots with minimal mineflayer surface (blockAt/placeBlock/equip/setControlState/dig). No fs writes, no Anthropic call, no Electron/utilityProcess boot — re-runs are idempotent."
metrics:
  duration: ~10min
  tasks: 2
  files-created: 1
completed: 2026-05-12
---

# Phase 07 Plan 07: Phase-Close Verification Summary

Phase 7 closes with a 13-assertion offline harness (`scripts/verify-phase7.mjs`) and a documented live-bot checkpoint. The harness asserts every Phase 7 requirement (R-01..R-06) plus the decision-level invariants from CONTEXT (D-03 through D-10) against stub bots. The live-bot checkpoint is the final gate the developer drives in-world.

## Harness Results

```
$ node scripts/verify-phase7.mjs
PASS A - R-01 build schema (16 ok, hollow ok, single ok, 324 rejected, missing block rejected)
PASS B - R-02 dig schema (legacy block, legacy xyz, cuboid xyz+to, >256 reject, {block,to} reject)
PASS C - R-04 build({block}) with empty inventory short-circuits BEFORE placeBlock
PASS D - R-05 cell counts (solid=16, hollow walls-only=36, single=1)
PASS E - iteration order constants exported; build minY first, dig maxY first
PASS F - R-06 composeVerticalHint surfaces try-build-to-Y on elevated, suppresses on flat
PASS G - D-05 build skips occupied cells (2 placed, 2 skipped of 4)
PASS H - D-06 digCuboid skips air cells (3 skipped of 5)
PASS I - D-04 scaffoldUp issues jump and exits at targetY-1
PASS J - D-08 seed_cuboid_grammar precedes seed_diary; mentions pillar/wall/platform/tunnel/hollow/256
PASS K - D-03 adapter exposes build/placeBlock/equip descriptions; dig description mentions CUBOID MODE
PASS L - D-10 composeSnapshot renders progress 47/256 and y=66 on the in_flight line
PASS M - abort discipline (buildAction + digCuboid both honor pre-aborted signal)

Phase 7 harness: 13/13 PASS
```

Exit code 0. No flaky assertions.

## Coverage Map

| Assertion | Requirement / Decision         | What it locks down                                                                 |
|-----------|--------------------------------|------------------------------------------------------------------------------------|
| A         | R-01                           | `build` Zod schema validates good cuboids, rejects oversize / missing `block`     |
| B         | R-02                           | `dig` Zod schema accepts legacy + cuboid forms, rejects oversize / orphan `to`    |
| C         | R-04                           | Inventory miss short-circuits before any `placeBlock` side effect                 |
| D         | R-05                           | `enumerateBuildCells` cell counts: solid 16, hollow walls-only 36, single 1       |
| E         | D-07                           | Iteration order constants exported; build minY-first, dig maxY-first              |
| F         | R-06 / D-09                    | `composeVerticalHint` emits `try build to Y=N` only for vertical unreachability   |
| G         | D-05                           | Occupied cells skipped; placeBlock spy called K times for K available cells       |
| H         | D-06                           | `digCuboid` reports `<n> skipped air`                                              |
| I         | R-03 / D-04                    | `scaffoldUp` issues `setControlState('jump', true)` and exits at targetY-1        |
| J         | D-08                           | `seed_cuboid_grammar` block emitted in cached prefix BEFORE `seed_diary`; covers grammar |
| K         | D-03                           | `getActionDescription` non-empty for build/placeBlock/equip; dig contains `CUBOID MODE` |
| L         | D-10                           | `composeSnapshot` renders `47/256` + `y=66` on the `in_flight:` line              |
| M         | Constraints (abort discipline) | Both `buildAction` and `digCuboid` honor `signal.aborted` mid-loop                |

## Live-Bot Checkpoint Instructions (Task 2)

This task is **autonomous: false** by plan declaration. The harness covers everything that can be exercised against stub bots; the remaining acceptance criteria need eyes-on confirmation in a real Minecraft world. Drive the four scenarios below, then sign off (or file gaps for follow-up).

### Setup

1. Open a Minecraft world to LAN (Singleplayer → Esc → "Open to LAN" → "Allow Cheats: On" recommended for spawning materials).
2. Note the LAN port from the chat banner.
3. Start the GUI: `npm run dev` from repo root (or `sei start` if installed). Configure the bot to connect to `localhost:<port>` if not already pointed there.
4. Confirm in the GUI debug log that the bot connected, ran the spawn handshake, and emitted at least one snapshot.
5. As the owner (the player whose username matches the bot's owner config), give the bot a stack of `oak_planks` (or `dirt`) — `/give <owner> oak_planks 64` — and any tools you want it to have.

### Scenario 1 — 4×4 wall (R-01 acceptance)

- Stand somewhere with ~5 blocks of clearance in front of you.
- In chat: `build a 4x4 wall in front of you using oak_planks`.
- **Expected:** bot resolves two corners forming a 4-wide × 4-tall vertical wall (16 cells), places 16 `oak_planks`, ends with chat similar to `built 16 placed, 0 skipped, of 16 cells`.
- **Look for in debug log:** an `in_flight: build oak_planks (Ns) — K/16, y=<currentY>` line ticking as cells fill. (D-10 / assertion L is a stub proof; this is the live proof.)
- **PASS** if the wall is contiguous and visually correct.

### Scenario 2 — 1×2×5 tunnel (R-02 acceptance)

- Stand near a hillside or a wall of solid blocks the bot can reach.
- In chat: `dig a 1x2x5 tunnel forward`.
- **Expected:** bot resolves a 1-wide × 2-tall × 5-long region, iterates cells top-down (Y-desc per `CUBOID_ITERATION_ORDER`), and walks into the tunnel afterward.
- **PASS** if the tunnel is walkable end-to-end and the bot did not get stuck mid-loop.

### Scenario 3 — elevated target hint chain (R-06 acceptance)

- Find or build a tall structure (tree with high leaves, a tower) whose top is at least 5 blocks above the bot's feet.
- In chat: `go up to the top of that tree` (or substitute the structure label).
- **Expected:**
  - bot calls `goTo` to an elevated point;
  - pathfinder returns `cant_reach (closest=...m to target X,Y,Z) — unreachable — try build to Y=N` (see `composeVerticalHint` in `src/bot/adapter/minecraft/behaviors/pathfind.js`);
  - Haiku reads the hint and issues `build` for a pillar;
  - bot ends up at or near the target Y, ideally on top of its own pillar.
- **PASS** if (a) the unreachable hint appears in the debug log, (b) the bot subsequently calls `build`, (c) bot reaches the target Y.

### Scenario 4 — mid-action preempt safety

- While a `build` is in flight (Scenario 1 mid-loop is ideal — the wall is 16 cells, you have a few seconds), send chat: `stop, come here`.
- **Expected:** cuboid loop aborts mid-iteration; action result is `aborted after K placed of 16 cells`; bot disengages safely (not stuck mid-jump, not falling) and complies with the new instruction.
- **PASS** if the bot is in a safe state after preempt and responds to the new chat.

### What to record

- **Timing tuning (D-04):** during Scenario 1, watch the pillaring rhythm if scaffolding activates (place a pillar request). Plan 07-02 set `APEX_MAX_MS=600` and `LANDING_MAX_MS=800` as upper bounds. If real pillars feel hitchy (failed placements, repeated jumps, bot falls off the pillar), record the observed apex/landing milliseconds and file a follow-up tuning task in `.planning/BACKLOG.md`.
- **Progress-tick line (D-10):** confirm at least one `in_flight: build oak_planks (Ns) — K/16, y=...` line appears during Scenario 1. Format proof for assertion L.

### Files to read if anything misbehaves

- `src/bot/adapter/minecraft/behaviors/build.js` — buildAction loop, scaffoldUp jump+place
- `src/bot/adapter/minecraft/behaviors/dig.js` — digCuboid loop, single-cell digAction
- `src/bot/adapter/minecraft/behaviors/pathfind.js` — composeVerticalHint (R-06)
- `src/bot/adapter/minecraft/registry.js` — BuildSchema / DigSchema (R-01, R-02, R-05)
- `src/bot/brain/orchestrator.js` — SEED_CUBOID_GRAMMAR, composeSeedBlocks, runWithInflight
- `src/bot/adapter/minecraft/observers/snapshot.js` — in_flight progressSuffix (D-10)
- `src/bot/brain/inflight.js` — updateProgress + stale-handle guard

### Resume signal

After running the four scenarios, sign off in chat with `approved` to mark Phase 7 complete, or describe specific failures so they can be filed as gap-closure plans.

## Deviations from Plan

None — Task 1 executed exactly as authored. Task 2 (live-bot checkpoint) is delivered as documented instructions per the executor's autonomous=false handling rather than a live run.

## Deferred Items

- **Live-bot acceptance run:** awaiting the developer's in-world signoff for Scenarios 1–4 above.
- **D-04 timing tuning:** APEX_MAX_MS / LANDING_MAX_MS values are conservative upper bounds; tighten only if Scenario 1's pillaring rhythm shows it is needed.
- **Crouch-to-edge-and-place** (overhang/cantilever placement): explicitly out of scope per SPEC; remains in backlog for a future phase.

## Self-Check

- `scripts/verify-phase7.mjs` exists: FOUND (`scripts/verify-phase7.mjs`).
- `node scripts/verify-phase7.mjs` exit code: 0.
- `grep -c "PASS" scripts/verify-phase7.mjs`: 17 (≥13 required).
- `grep -c "node:assert" scripts/verify-phase7.mjs`: 1 (≥1 required).
- Task 1 commit `581af39` in git log: FOUND (`test(07-07): add Phase 7 end-to-end verification harness`).

## Self-Check: PASSED
