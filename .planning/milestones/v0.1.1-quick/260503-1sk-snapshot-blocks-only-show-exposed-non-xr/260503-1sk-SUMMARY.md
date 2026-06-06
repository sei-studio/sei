---
phase: quick-260503-1sk
plan: 01
subsystem: observers
tags: [snapshot, blocks, exposure, terrain]
requires: [src/observers/blocks.js, src/observers/snapshot.js, src/observers/posHealer.js]
provides: [isExposed, aroundFeet, expanded INTERESTING_BLOCK_NAMES, exposure-filtered nearbyBlocks]
affects: [snapshot rendering for both LLM layers]
tech-stack:
  added: []
  patterns: ["node:test built-in for unit tests (no new deps)"]
key-files:
  created:
    - test/observers/blocks.test.js
  modified:
    - src/observers/blocks.js
    - src/observers/snapshot.js
decisions:
  - "Used Node built-in node:test runner — project had no prior test infrastructure and adding a test framework would have been an architectural change. node:test fits the no-new-deps constraint."
  - "Conservative on unloaded chunks: null neighbor in isExposed does NOT mark exposed (else chunk borders surface buried ores)."
  - "Sparse-expand fallback only fires when caller did NOT override radius (treat opts.radius==null as 'default')."
metrics:
  duration_min: ~12
  tasks_completed: 2
  tests_added: 10
  completed: 2026-05-03
---

# Quick Task 260503-1sk: Snapshot Blocks — Only Show Exposed (Non-XRay) + Around-Feet Line

## One-liner
Snapshot now hides buried/xray blocks (every `nearby blocks:` entry has a see-through neighbor) and adds an `around feet:` line summarizing every non-air block in a 5×4×5 cube around the bot, fixing the "get me 10 sand on a beach" bug where sand never appeared in the LLM's view.

## What Was Built

### Task 1 — `blocks.js`: exposure predicate + aroundFeet helper + expanded interesting set

- **`isExposed(bot, pos)`** — exported. Returns true iff at least one of 6 axis-neighbors satisfies any of:
  - `boundingBox === 'empty'` (torches, plants, fence-shaped non-occluders)
  - `name ∈ {air, cave_air, void_air, water, lava}` (the `SEE_THROUGH_NAMES` set)
  - Conservative on null (unloaded chunk → not exposed) so chunk borders don't leak xray candidates.
- **`nearbyBlocks(bot, opts)`** — same signature, but candidates and probe set are both filtered through `isExposed`. The `more` counter now reflects exposed-only candidates (D-1sk-08), so the LLM never gets a false "+K more" hint pointing at buried blocks.
- **Sparse-expand fallback** — if `exposedFound.length < min(count, 3)` AND the caller used the default radius (`opts.radius == null`), retries once at `radius * 2` (32 by default). One retry only, no recursion.
- **`aroundFeet(bot)`** — new export. Iterates a 5×4×5 cube (dx=±2, dy=-1..+2, dz=±2; 100 voxels) around `floor(getHealedPos(bot))`. Skips `air`/`cave_air`/`void_air`. Returns `{ groups: [{name,count}], total, more }` sorted by count desc then name asc, capped at 8 distinct names.
- **`INTERESTING_BLOCK_NAMES`** — added 22 terrain/structure names: `sand, red_sand, sandstone, red_sandstone, gravel, clay, dirt, coarse_dirt, grass_block, podzol, mycelium, snow, snow_block, ice, packed_ice, blue_ice, obsidian, glass, terracotta, cobblestone, mossy_cobblestone, stone`. Stone is included because in caves the bot needs that context; the new exposure filter prevents stone-spam in open terrain.

### Task 2 — `snapshot.js`: render `around feet:` line

- Imports `aroundFeet` alongside the existing `nearbyBlocks` / `INTERESTING_BLOCK_NAMES`.
- Renders the new line between `inventory:` and `nearby blocks:`:
  - Empty cube → `around feet: (clear)`
  - Otherwise → `around feet: sand×12 grass_block×3 water×2 oak_log×1`
  - >8 distinct names → suffix ` (+N more types)`
- No `#N` handles minted for around-feet entries (per D-1sk-03 — coords implicit, would flood handle table).
- Existing handle numbering for `nearby blocks:` and `nearby entities:` is unchanged; `createSnapshotComposer` (stateful delta wrapper from 260503-1bu) continues to work because `composeSnapshot`'s contract is preserved.

## Final Cube Dimensions
**5 × 4 × 5 = 100 voxels** (dx=−2..+2, dy=−1..+2, dz=−2..+2). Y range covers ground (−1, 0), torso (+1), and head (+2). 100 `blockAt` calls per snapshot — cheap (existing exposure scan can do up to ~240 in the worst case).

## Final Exposure Predicate
```
SEE_THROUGH_NAMES = { air, cave_air, void_air, water, lava }
isExposed(pos) = ∃ axis-neighbor n: n.boundingBox === 'empty' || SEE_THROUGH_NAMES.has(n.name)
```
Null neighbor → not exposed (conservative; avoids chunk-border xray leaks).

## Names Added to INTERESTING_BLOCK_NAMES
sand, red_sand, sandstone, red_sandstone, gravel, clay, dirt, coarse_dirt, grass_block, podzol, mycelium, snow, snow_block, ice, packed_ice, blue_ice, obsidian, glass, terracotta, cobblestone, mossy_cobblestone, stone (22 new entries; existing entries — woods, ores, beds, chests, water/lava — kept).

## Test Fixtures Created
`test/observers/blocks.test.js` — uses Node's built-in `node:test` runner (no new deps). Hand-rolled fake bot with a `Map<key,block>` store and stubbable `findBlocks`. 10 cases:

| # | Case | Verifies |
|---|------|----------|
| 1 | isExposed: encased in stone | false |
| 2 | isExposed: 1 air neighbor | true |
| 3 | isExposed: 1 water neighbor | true (D-1sk-01) |
| 4 | isExposed: torch neighbor (boundingBox=empty) | true |
| 5 | aroundFeet: 6 sand + 2 grass_block | groups sorted, total=8, more=0 |
| 6 | aroundFeet: empty cube | `{ groups:[], total:0, more:0 }` |
| 7 | aroundFeet: 10 distinct names | groups capped at 8, more=2 |
| 8 | nearbyBlocks: encased iron_ore | filtered out (xray fix) |
| 9 | nearbyBlocks: sparse-expand | fires retry at 2× radius |
| 10 | INTERESTING_BLOCK_NAMES | includes sand/sandstone/gravel/grass_block/dirt/stone |

Run with: `node --test test/observers/blocks.test.js`

## Smoke Test Result
Stubbed a beach scenario (5×5 sand at y=63, exposed iron_ore at (5,64,0)) and ran `composeSnapshot`:
```
inventory: empty
around feet: sand×25
nearby blocks:
  #1 iron_ore @5,64,0
```
Layout correct, sand surfaced, no xray candidates, handle numbering intact.

## Sparse-Expand Fallback in Manual Sessions
Not exercised live (no Minecraft server in agent sandbox). Covered by Test 9. **Live verification deferred to user** (see below).

## Deviations from Plan
**[Rule 3 — Blocking issue] No test framework configured.** The plan called for TDD but the project has no `test` script and no test runner installed. Resolved by using Node's built-in `node:test` (added in 18.x, stable in 20.x), which requires no new dependencies and fits the project's "no new deps" constraint (D-no-new-deps). Run command: `node --test test/observers/blocks.test.js`. No `package.json` script added in this commit; orchestrator can wire one later if desired.

No other deviations. All 10 tests green on first GREEN attempt.

## Live Verification (Deferred to User)

Live in-game verification requires a running Minecraft server, which isn't available in the executor sandbox. Please run the bot on a beach biome and confirm:

- [ ] `around feet:` line appears in the snapshot between `inventory:` and `nearby blocks:`
- [ ] On a beach, `around feet:` shows `sand×N` (N>0)
- [ ] `nearby blocks:` no longer fabricates buried ores in stone (e.g., walking through a cave does NOT list iron_ore that's fully encased)
- [ ] When you say "get me 10 sand" on a beach, the bot's response references the sand it can now see
- [ ] If sand is sparse (e.g., a small island), confirm the snapshot still finds nearby sand (sparse-expand widening to radius=32)

## Self-Check: PASSED
- src/observers/blocks.js — FOUND
- src/observers/snapshot.js — FOUND (modified)
- test/observers/blocks.test.js — FOUND
- Commit c19d81f (RED tests) — FOUND
- Commit 8e8373b (GREEN blocks.js) — FOUND
- Commit 5abc8a8 (snapshot.js feat) — FOUND
- All 10 tests pass via `node --test test/observers/blocks.test.js`
- Smoke test of composeSnapshot with stub bot produces expected `around feet:` layout
