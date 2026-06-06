# Phase 7: Cuboid build / dig primitive (with scaffolding) — Research

**Researched:** 2026-05-12
**Domain:** Mineflayer action composition (place + dig loops, jump+place scaffolding, Zod schema variants, orchestrator progress ticks)
**Confidence:** HIGH on existing patterns / file layout, MEDIUM on jump+place timing constants, LOW on a few mineflayer event semantics flagged below.

## Summary

Phase 7 layers a single cuboid abstraction (`build`, extended `dig`) on top of already-shipped per-cell primitives (`placeBlockAction`, `digAction`, `equipAction`). The work is mostly *composition discipline* rather than new mineflayer integration: 80% of the implementation is a loop with abort, timeout, and progress-tick wiring that mirrors `mineVeinAction` almost beat-for-beat. The novel parts are (1) the hand-rolled jump+place scaffolding subroutine inside `build`, (2) a schema-layer 256-cell cap, (3) a small orchestrator change for periodic progress ticks during long actions, and (4) a new cached system-prompt block teaching cuboid grammar.

CONTEXT.md decisions are tight — D-01 through D-11 lock essentially every shape question; planner discretion is limited to: jump timing constants, the vertical-margin threshold for the unreachable hint, progress-tick interval, and result-string format.

**Primary recommendation:** Model the implementation as **four code zones** that mirror existing precedents:
1. `behaviors/build.js` — new file, structured as `mineVein.js`'s loop with `place.js` as the per-cell op and an inline `jumpAndPlace()` subroutine.
2. `behaviors/dig.js` — extend with an optional `to` mode that delegates to a new `digCuboid()` helper iterating Y↓→X→Z; single-cell path unchanged.
3. `registry.js` — extend `dig` schema with `to`/`hollow`/refine, register new `build` action with refine + 256-cell volume check.
4. `orchestrator.js` — (a) add `seed_cuboid_grammar` text block to the cached prefix between `seed_diary` and the dynamic blocks; (b) add a periodic progress-tick scheduler in the action-await loop that injects a short text-block before the next LLM iteration when the action is taking >10s. Plus `BUILD_DESCRIPTION` + updated `DIG_DESCRIPTION` mirror + `placeBlock`/`equip` descriptions in `ACTION_DESCRIPTIONS`.

Also: the unreachable hint in D-09 is a *result-string composition change* in `goTo` (`registry.js` wrapper) and `dig.js`, not a new action.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| `build` cuboid loop | utilityProcess / adapter behavior | — | Bot-side: physics, equip, placement, abort wiring. Brain never touches mineflayer. |
| Jump+place scaffolding subroutine | utilityProcess / adapter behavior | — | Pure mineflayer primitives (`setControlState`, `placeBlock`, `bot.entity.position`). Lives inside `build`. |
| Extended `dig` cuboid loop | utilityProcess / adapter behavior | — | Identical tier to single-cell dig; just iterates. |
| `build` / `dig` schema (Zod, 256-cell cap) | adapter registry | — | Schema validation is registry-layer, runs before handler. |
| `seed_cuboid_grammar` cached block | brain / orchestrator | — | Cached system prompt construction is orchestrator territory (`composeSeedBlocks` neighbors at L268-324). |
| Progress-tick scheduler | brain / orchestrator | — | Touches `runWithInflight` + the iteration loop; conceptually a brain-side observation of a bot-side handle. |
| Unreachable hint in result string | adapter behavior (`goTo` wrapper, `dig.js`) | — | Result strings are composed where the action runs; LLM sees them via `tool_result` content. |
| LLM-facing action descriptions | adapter (`ACTION_DESCRIPTIONS` in `index.js`) + mirrored in orchestrator | — | Canonical string next to handler, mirror in orchestrator (established `DIG_DESCRIPTION` / `MINE_VEIN_DESCRIPTION` pattern). |

Sanity flag: nothing in this phase belongs in the renderer/main Electron processes.

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| REQ-1 | `build` cuboid action with Zod schema | `mineVein.js` loop pattern (existing); `place.js` per-cell op (existing). New file `behaviors/build.js`. |
| REQ-2 | `dig` cuboid mode via extended schema (D-01) | Extend `TargetShape` or split into a new schema in `registry.js:110`; iterate Y↓→X→Z using `digAction` per cell. |
| REQ-3 | Jump+place scaffolding inside `build` | `bot.setControlState('jump', ...)` + `bot.placeBlock(refBelow, Vec3(0,1,0))` — hand-rolled per D-04. |
| REQ-4 | `block` arg required | Zod `z.string()` (no `.optional()`); inventory miss returns `no <block> in inventory` (mirrors `place.js:17`). |
| REQ-5 | 256-cell volume cap at schema layer | Zod `.refine((a) => cellCount(a) <= 256, …)` on both `build` and cuboid `dig` schemas. |
| REQ-6 | Unreachable hint in `goTo` / `dig` | Compose result string in the `goTo` registry wrapper (`registry.js:82-93`) and `dig.js` when `target.y > bot.y + 2`. |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| mineflayer | ^4.23.0 (from `package.json`) [VERIFIED: package.json] | Bot core: `bot.placeBlock`, `bot.dig`, `bot.setControlState`, `bot.entity.position`, `bot.blockAt`, `bot.inventory` | Already pinned; no upgrade in scope. |
| mineflayer-pathfinder | ^2.4.5 [VERIFIED: package.json] | `goTo()` wrapper in `behaviors/pathfind.js` — used by `build` to walk to the next layer / next column | Already used; do NOT introduce `Movements.scafoldingBlocks` (D-04). |
| zod | (already a project dep) [VERIFIED: registry.js imports `z`] | Schema validation including refines for variant inputs and the 256-cell cap | Established pattern (`mine_vein` uses `.refine`). |
| vec3 | (already a project dep) [VERIFIED: `mineVein.js:23` imports `Vec3`] | Coordinate math, face vectors | Used by `place.js:2`. |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| minecraft-data | (already dep) [VERIFIED: `mineVein.js:24`] | Block name → id resolution if needed for reachability checks | Only if planner wants to verify "is the cell air?" via id rather than name; probably unnecessary — `bot.blockAt(p).name` is sufficient. |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Hand-rolled jump+place | `mineflayer-pathfinder` `Movements.scafoldingBlocks` | EXPLICITLY excluded by D-04. Pathfinder's flag is internal to its planner — not observable per-cell, not abortable cleanly, and couples cuboid behavior to pathfinder internals. |
| Separate `digRegion` action | Extended `dig` with optional `to` | D-01 locked extended `dig`. Keeps the action surface small; same handler dispatches single-cell vs cuboid based on schema variant. |
| Generic "any long action gets ticks" framework | Cuboid-scoped progress-tick callback | D-10 locked scoped version; deferred ideas section explicitly flags the general framework as out-of-scope. |

**Installation:** No new dependencies. Verified via `grep "mineflayer\|pathfinder" package.json`.

## Architecture Patterns

### System Architecture Diagram

```
LLM (Haiku)
   │ tool_use { name: "build", input: { from, to, block, hollow? } }
   ▼
orchestrator.js (runWithInflight)
   │ - inflight.start({name:'build', args})       (snapshot shows in_flight:)
   │ - registry.execute('build', args, {signal})
   │ - schedules progress-tick timer (every ~10s while in flight)  ← D-10 NEW
   ▼
registry.js  → Zod parse  → refine: cell count ≤ 256, valid corners
   │ rejected here for >256 → handler never runs
   ▼
behaviors/build.js  buildAction(args, bot, config)
   │
   ├── enumerateCells(from, to, hollow) → ordered list (Y↑→X→Z) of {x,y,z}
   │
   ├── for each cell c:
   │     - check signal.aborted → return `aborted after K/N built`
   │     - skip if occupied (blockAt(c) non-air)         (D-05)
   │     - distance check: is c within reach from bot's stand pos?
   │           │ yes → composeFaceAndPlace(c, block)
   │           │ no  → jumpAndPlaceBelow(block) loop until standY+reach ≥ c.y
   │     - per-cell timeout from placeBlockAction internals (4000ms)
   │     - emit progress$ tick (placed/skipped/total/current y)
   │
   └── return `built K placed, S skipped, of N cells`
                                  │
                                  ▼
                            tool_result back to LLM
```

```
jumpAndPlaceBelow(block):                       (D-04 hand-rolled scaffolding)
   ┌──────────────────────────────────────────────┐
   │ 1. equip(block) if not held                 │
   │ 2. bot.setControlState('jump', true)        │
   │ 3. wait for apex                            │   ← ~250ms or poll
   │      - poll bot.entity.position.y           │     position.y until peak
   │      - or onGround=false → onGround=true edge
   │ 4. bot.setControlState('jump', false)       │
   │ 5. refBlock = bot.blockAt(bot.entity.       │
   │              position.offset(0,-1,0))       │
   │ 6. bot.placeBlock(refBlock, Vec3(0,1,0))    │   ← face up
   │ 7. wait for onGround (landing)              │   ← ~200ms or onGround event
   │ 8. return placed-y == standY+1              │
   └──────────────────────────────────────────────┘
```

```
extended dig path:
   LLM → dig({from, to, hollow?})
     ↓ registry refine routes to digCuboid()
     ↓ enumerate Y↓→X→Z (D-07: top-down so bot isn't stranded, gravity-blocks don't fall on bot)
     ↓ per cell: skip air (D-06) → goTo into dig reach → digAction({x,y,z})
     ↓ progress$ ticks
     ↓ result: `dug K of N (S skipped air)`
```

### Recommended Project Structure
```
src/bot/adapter/minecraft/behaviors/
├── build.js          # NEW — cuboid build with jump+place scaffolding; exports BUILD_DESCRIPTION
├── dig.js            # MODIFIED — adds digCuboid() helper; existing single-cell path untouched. Updated DIG_DESCRIPTION mentions cuboid mode briefly.
├── place.js          # UNCHANGED — composed by build.js per-cell
├── equip.js          # UNCHANGED — composed by build.js for held-block dance + LLM-facing description added in index.js
└── pathfind.js       # MODIFIED — goTo wrapper composes "unreachable — try build to Y=N" suffix when vertical-fail (D-09)

src/bot/adapter/minecraft/
├── registry.js       # MODIFIED — extend dig schema, register build, add 256-cell refines
└── index.js          # MODIFIED — ACTION_DESCRIPTIONS gains placeBlock, equip, build, updated dig

src/bot/brain/
└── orchestrator.js   # MODIFIED — seed_cuboid_grammar block in composeSeedBlocks (L282-289); progress-tick scheduler in the dispatch loop (around runWithInflight at L532, used at L1156)
```

### Pattern 1: Multi-step action with abort/timeout/result-string (mineVein precedent)
**What:** A single registry-registered action whose handler loops over many cells, calling per-cell ops with their own timeouts, checking `signal.aborted` between iterations, accumulating a count, and returning ONE final result string. The whole loop is one LLM iteration.
**When to use:** Cuboid `build` and extended cuboid `dig` — both fit this shape exactly.
**Example:** [VERIFIED: `src/bot/adapter/minecraft/behaviors/mineVein.js:133-166`]
```js
while (true) {
  if (signal?.aborted) return `aborted after ${dug}/${total} ${veinName}`
  // pick next cell
  await goTo(bot, np.x, np.y, np.z, 3, timeoutMs)        // per-step pathfind w/ timeout
  if (signal?.aborted) return `aborted after ${dug}/${total} ${veinName}`
  const r = await digAction({ x: np.x, y: np.y, z: np.z }, bot, config)
  if (r === 'aborted') return `aborted after ${dug}/${total} ${veinName}`
  if (typeof r === 'string' && r.startsWith('dug ')) dug++
  // mark done; continue
}
return `mined ${dug}/${total} ${veinName}${capNote}`
```

### Pattern 2: Promise.race(op, timeout, abort) — per-cell timeout, NOT outer
**What:** Each per-cell `placeBlock` / `dig` gets its own `Promise.race` with timeout+abort. The cuboid loop does NOT impose an outer wall-clock — 256 cells × 4000ms place timeout > any practical outer cap. [VERIFIED: `place.js:37-51`, `dig.js:73-112`]
**Example:** Already encoded in `placeBlockAction` and `digAction` — `buildAction` just calls them.

### Pattern 3: Description-next-to-handler with orchestrator mirror
**What:** Canonical LLM-facing string is `export const X_DESCRIPTION = "…"` in the behavior file. Mirrored into `ACTION_DESCRIPTIONS` in `adapter/minecraft/index.js:22` and (currently also) `brain/orchestrator.js:108`. The orchestrator's mirror is the one the LLM actually sees today; the adapter copy is the contract. [VERIFIED: `dig.js:20`, `mineVein.js:41`, `orchestrator.js:121`]
**Note for planner:** There are currently TWO `ACTION_DESCRIPTIONS` maps — one in `adapter/minecraft/index.js:22` and one in `brain/orchestrator.js:108`. The orchestrator map is the one that flows into the cached system prompt. Phase 7 should update BOTH (or at minimum the orchestrator copy, since that is what reaches the LLM). The adapter copy is consumed by `getActionDescription()` at `index.js:56` — used when the orchestrator queries `registry.description(name)` as a fallback at `orchestrator.js:350`. Confirm planner decision before duplicating.

### Pattern 4: Zod variant via `.refine`
**What:** Single schema accepts multiple input shapes; `.refine` rejects invalid combinations with a useful message. [VERIFIED: `registry.js:158-169` (`mine_vein`), `:40-43` (`TargetShape`)]
**Example:**
```js
z.object({
  from: Vec3Shape,
  to: Vec3Shape.optional(),         // dig: optional; build: required
  block: z.string().optional(),     // build: required, dig: not present
  hollow: z.boolean().optional(),
}).refine(a => cellCount(a) <= 256, { message: 'cuboid too large (>256 cells) — split into smaller calls' })
```

### Pattern 5: Cached prefix injection
**What:** New named text blocks are pushed into the array returned by `composeSeedBlocks` BEFORE the `cache_control: { type: 'ephemeral' }` boundary so they join the cached prefix. [VERIFIED: `orchestrator.js:282-289`]
**Example for `seed_cuboid_grammar`:** Insert as a non-cache-control block AFTER `seed_owner` and BEFORE `seed_diary` (which carries the `cache_control` marker). Alternative: insert AFTER `seed_diary` and MOVE the `cache_control` to the new block — same caching behavior, but planner should choose one and document it. The CONTEXT D-08 phrasing "added to the cached prefix near `seed_owner` / `seed_diary` in `orchestrator.js:283-288`" is satisfied either way.

### Anti-Patterns to Avoid
- **Outer cuboid timeout:** Don't impose a single 4-second timeout on the whole `build` call; legitimate 256-cell builds will time out. Per-cell timeouts from `place.js` / `dig.js` are sufficient. (Repeats the `mineVein` precedent.)
- **Auto-pillaring in `goTo`:** EXPLICITLY out of scope (SPEC boundary). `goTo` and `dig` ONLY emit the hint — the LLM decides to call `build`.
- **Block-replacement in `build`:** D-05 — skip occupied cells. Do NOT dig-then-place.
- **Floor/ceiling in `hollow:true`:** Walls only (4 vertical faces). Caller composes floor/ceiling via flat single-Y cuboids. (SPEC R1, D-04 derivative.)
- **Generating cell coordinates in the LLM:** The whole point of the primitive is that the LLM provides two corners only. Tool description must NOT hint the LLM at per-cell enumeration.
- **Using `placeBlock`'s `against` arg from `build`:** `placeBlock` requires a reference block + face vector. `build` should compute the reference block and face vector itself (look at the 6 face-neighbors of the target cell and pick the first one that is non-air and bot can reach), then call `bot.placeBlock(refBlock, faceVector)` directly — OR construct an `args.against = {x,y,z}` for `placeBlockAction`. Inspect the resolver in `targeting.js`'s `resolveBlock` before choosing. [LOW CONFIDENCE — planner should read `observers/targeting.js`.]

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Pathfinding from cell to cell | Custom A* | `behaviors/pathfind.js::goTo` (existing wrapper) | Already wraps mineflayer-pathfinder with timeout. |
| Single-cell placement | New place primitive | `placeBlockAction` (existing) | Handles equip, timeout, abort, inventory-miss. |
| Single-cell breaking | New dig primitive | `digAction` (existing) | Single-flight guard, reach check, pickup walk, target-changed detection. |
| Equipping the build block | Custom equip dance | `equipAction` OR `bot.equip(invItem, 'hand')` (already done inside `placeBlockAction:21`) | `placeBlockAction` already equips before placing — `build` may not need to equip separately at all. |
| Result-string formatting | Ad-hoc strings | Mirror `mineVein` idiom: `built K placed, S skipped` / `aborted after K of N` / `no <block> in inventory` | LLM has learned these shapes; consistency reduces hallucination. |
| Abort plumbing | New AbortController | `config.signal` is already threaded by `orchestrator.js:1156-1159` through `runWithInflight` | Standard. |
| Cached prefix invalidation | Don't add memory-shaped content | Per `assertNoMemoryInSystemBlocks` at `orchestrator.js:544` | The seed_cuboid_grammar block must NOT contain `# Owner` or `# Diary` headers. Static grammar/example text only. |

**Key insight:** Phase 7 is a composition exercise. The mineflayer surface area is already covered by `place.js`, `dig.js`, `equip.js`, and `pathfind.js`. The novelty is the loop, the schema, the scaffolding subroutine, and the orchestrator's progress-tick scheduler.

## Runtime State Inventory

Not applicable — Phase 7 is a greenfield addition (new action + extension), not a rename/refactor/migration. No stored data, no live service config, no OS-registered state needs migration. Verified by inspecting CONTEXT.md and SPEC.md — both describe net-new functionality with backward-compatible schema changes only.

## Common Pitfalls

### Pitfall 1: Jump apex/landing timing is server-dependent
**What goes wrong:** Hardcoded sleep (`await sleep(250)`) for apex assumes ~4.3 blocks/sec vertical velocity peak around 250ms; but server tick rate, latency, soul-sand/honey blocks, water, slowness effects can all change the actual apex moment. Result: `placeBlock` fires while bot is still rising (`bot.entity.position.y` not yet at peak, block-below reference still air) OR after the bot has begun falling (reference block is now further below than expected).
**Why it happens:** Mineflayer doesn't expose a clean "apex reached" event. `bot.entity.onGround` only flips on landing, not on apex.
**How to avoid:** Poll `bot.entity.position.y` on a short interval (e.g. every 50ms) and detect the peak — when the next sample's y ≤ current sample's y AND `onGround === false`, we're at or just past apex. This is more robust than a fixed sleep. The reference block in step 5 is `bot.blockAt(bot.entity.position.floored().offset(0,-1,0))` — confirm it's air (we want to place INTO air, with the floor-below as the actual reference).

Correction: re-read D-04 — placement is "against block-below with `faceVector={x:0,y:1,z:0}`". So the *referenceBlock* is the block at `(stand_x, stand_y - 1, stand_z)` BEFORE the jump (the floor we jumped off). Face vector `(0,1,0)` means "place on the TOP face of that floor block", which puts the new block at `(stand_x, stand_y, stand_z)` — exactly where the bot's feet are, at the apex. After placement, gravity pulls the bot onto the just-placed block (now standing at stand_y+1). This is the standard vanilla pillar-up mechanic. [MEDIUM CONFIDENCE — verified against mineflayer-pathfinder source intent; planner should sanity-check experimentally.]

**Warning signs:** "no reference block" / "out of range" returned from `placeBlock`; bot oscillates jumping but doesn't gain height; observed in logs as repeated `placeBlock` failures in tight succession.

### Pitfall 2: `bot.placeBlock` requires bot to be looking at the placement face
**What goes wrong:** Mineflayer's `placeBlock(refBlock, faceVector)` internally rotates the bot to look at the face before sending the place packet. If the rotation hasn't settled (`bot.lookAt` is async-ish), the place can fail or place in the wrong direction.
**How to avoid:** `placeBlockAction` already handles this — `bot.placeBlock` awaits internally. Stick to calling `placeBlockAction` or `bot.placeBlock` directly and awaiting; do not race them.
**Confidence:** [MEDIUM — based on mineflayer 4.x API knowledge; CITED: mineflayer placeBlock semantics commonly noted in mineflayer GitHub issues.]

### Pitfall 3: Empty cuboid (from === to) is volume 1 — allowed
**What goes wrong:** Planner-side bug: if cell count formula uses `(to.x - from.x)` instead of `(|to.x - from.x| + 1)`, a single-cell cuboid (from==to) computes as 0 cells and silently no-ops.
**How to avoid:** Use the formula from D-11 exactly: `|to.x - from.x + 1| * |to.y - from.y + 1| * |to.z - from.z + 1|`. Note absolute values: callers may pass corners in either order. Normalize to min/max in the handler.
**Warning signs:** "built 0 of 0 cells" on what should be a single-cell call.

### Pitfall 4: `hollow:true` semantics — only 4 vertical wall faces
**What goes wrong:** Naïve "border" iteration places the floor and ceiling too. SPEC R1 + CONTEXT D-04 derivative: hollow = the 4 vertical PLANES at x==minX, x==maxX, z==minZ, z==maxZ. Floor and ceiling are NOT placed.
**How to avoid:** Predicate per-cell — `isWall = (x===minX || x===maxX || z===minZ || z===maxZ)`. Single-Y-plane cuboids (where minY===maxY) with hollow:true become a hollow rectangle (4 edges only, no fill) — confirm with acceptance test in SPEC R1.

### Pitfall 5: Iteration order matters for both build and dig
**What goes wrong:**
- `build` iterating Y descending → impossible to scaffold (need support block from BELOW the next placement).
- `dig` iterating Y ascending → bot stranded on a column above its current position; gravity blocks (sand, gravel) fall onto bot.
**How to avoid:** D-07 locked: `build` Y↑→X→Z; `dig` Y↓→X→Z. Encode as exported constants in each behavior file so tests can assert.

### Pitfall 6: Progress-tick scheduler must not interleave with abort
**What goes wrong:** The progress-tick timer fires, the orchestrator pushes a "build progress: K/N" text block into the next LLM turn, the LLM emits a new action — but the build is still in flight. Result: violates single-flight; two actions race.
**How to avoid:**
- Option A: Progress ticks are *informational only* — they update an in-memory "latest progress" line, and the snapshot's `in_flight:` rendering at `snapshot.js:68` is enriched to include progress. The LLM doesn't get a new dispatch turn until the action completes.
- Option B: True LLM tick — the orchestrator schedules a fresh LLM iteration WHILE the action is still in flight, with the snapshot showing `in_flight: build …` so the system instructions ("if `in_flight:` line, do NOT call any movement this turn") naturally prevent racing. The LLM can `say()` or `abort` (via a new abort tool) but cannot start new movement.
- CONTEXT D-10 reads closer to Option B: "the LLM may choose to abort, continue waiting, or take other action". Planner should clarify the abort mechanism — there is no explicit `abort_current_action` tool; today, owner chat is the only path to abort. Phase 7 may need to add one, OR rely on "abort by emitting a new dispatched movement" (which would then be blocked by the in_flight rule — chicken/egg). RECOMMEND: Option A for v1 (just enriches the snapshot during the action), and defer LLM-driven mid-action abort to a follow-up.
**Confidence:** [LOW — D-10 is the most ambiguous decision in CONTEXT. Planner should propose a concrete mechanism and confirm with discuss-phase if needed.]

### Pitfall 7: Distinguishing vertical-fail from generic pathfinder-fail (D-09)
**What goes wrong:** `goTo` returns `cant_reach (closest=8.4m to target X,Y,Z)` for both "wall in the way" and "elevated target unreachable". The unreachable hint should only fire for the latter.
**How to avoid:** Compose hint based on the *target* and *bot* positions, not the failure reason. Predicate: `target.y > bot.y + VERTICAL_MARGIN` (recommend 2 — vanilla jump height is 1.25 blocks, so anything > 2 above bot is definitively unreachable without scaffolding). Apply hint regardless of which `cant_reach` flavor was returned, as long as the elevation condition holds. CONTEXT D-09 confirms: "trigger is a pathfinder failure of any kind ... when the elevation condition holds".

### Pitfall 8: `placeBlock` against a face that doesn't exist (air on all sides)
**What goes wrong:** First cell of a cuboid is a floating cell with no adjacent solid block — `placeBlock` returns "no reference block".
**How to avoid:** For the first cell at `(x, minY, z)`, the reference block should be the floor (block at `y = minY - 1`). For subsequent cells in the same column, the just-placed cell below is the reference. For wall-extension cells, an X- or Z-neighbor already-placed cell is the reference. The face-pick logic should iterate the 6 face-neighbors in priority order: floor (0,-1,0) first, then horizontal neighbors, then ceiling. If all 6 are air → return `cell unreachable: no support` for that cell and continue.

## Code Examples

Verified patterns from existing codebase:

### `mineVeinAction` loop skeleton (template for `buildAction`)
```js
// Source: src/bot/adapter/minecraft/behaviors/mineVein.js:60-170 [VERIFIED]
export async function buildAction(args, bot, config) {
  const signal = config?.signal
  if (signal?.aborted) return 'aborted'
  // 1. Inventory check
  const invItem = bot.inventory.items().find(i => i.name === args.block)
  if (!invItem) return `no ${args.block} in inventory`
  // 2. Enumerate cells (Y↑→X→Z, hollow filter)
  const cells = enumerateBuildCells(args.from, args.to, args.hollow)
  // 3. Per-cell loop
  let placed = 0, skipped = 0
  for (const c of cells) {
    if (signal?.aborted) return `aborted after ${placed} placed, ${skipped} skipped of ${cells.length}`
    if (isOccupied(bot, c)) { skipped++; continue }
    if (!withinReach(bot, c)) {
      const r = await scaffoldUp(bot, args.block, c.y, config)
      if (r !== 'ok') return `build halted: ${r} (placed ${placed}/${cells.length})`
    }
    const ref = pickReferenceFace(bot, c)
    if (!ref) { skipped++; continue }  // cell has no support — skip with note
    const r = await placeBlockAction(
      { block: args.block, against: { x: ref.pos.x, y: ref.pos.y, z: ref.pos.z }, faceVector: ref.face },
      bot, config
    )
    if (r === 'aborted') return `aborted after ${placed} placed of ${cells.length}`
    if (typeof r === 'string' && r.startsWith('placed ')) placed++
  }
  return `built ${placed} placed, ${skipped} skipped, of ${cells.length} cells`
}
```

### Jump+place scaffolding subroutine
```js
// Source: composed from D-04 + mineflayer primitives [VERIFIED: bot.setControlState exists in mineflayer 4.x]
async function scaffoldUp(bot, blockName, targetY, config) {
  while (Math.floor(bot.entity.position.y) < targetY - 1) {  // -1 because we want feet level with targetY-1 so we can place at targetY
    if (config?.signal?.aborted) return 'aborted'
    const startY = bot.entity.position.y
    // ensure block held
    const invItem = bot.inventory.items().find(i => i.name === blockName)
    if (!invItem) return `no ${blockName} in inventory`
    try { await bot.equip(invItem, 'hand') } catch (e) { return `cannot hold ${blockName}` }
    // Jump
    bot.setControlState('jump', true)
    // Wait for apex via polling — robust to server tick variation (Pitfall 1)
    await waitForApex(bot, /*maxMs*/ 600)
    bot.setControlState('jump', false)
    // Reference block = floor we jumped off (still at startY - 1)
    const refPos = new Vec3(Math.floor(bot.entity.position.x), Math.floor(startY) - 1, Math.floor(bot.entity.position.z))
    const refBlock = bot.blockAt(refPos)
    if (!refBlock || refBlock.name === 'air') return 'scaffold failed: no floor below'
    try {
      await bot.placeBlock(refBlock, new Vec3(0, 1, 0))
    } catch (e) {
      return `scaffold place failed: ${e.message}`
    }
    // Wait for landing onto the just-placed block
    await waitForLanding(bot, /*maxMs*/ 800)
  }
  return 'ok'
}

async function waitForApex(bot, maxMs) {
  const start = Date.now()
  let lastY = bot.entity.position.y
  while (Date.now() - start < maxMs) {
    await new Promise(r => setTimeout(r, 40))
    const y = bot.entity.position.y
    if (y <= lastY && !bot.entity.onGround) return  // peaked
    lastY = y
  }
}

async function waitForLanding(bot, maxMs) {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    if (bot.entity.onGround) return
    await new Promise(r => setTimeout(r, 40))
  }
}
```
[MEDIUM CONFIDENCE — structure verified against mineflayer 4.x API; exact timing constants are CONTEXT discretion items. Planner verifies experimentally.]

### Zod schema for `build` (with 256-cell cap)
```js
// Source: pattern from registry.js:158-169 (mine_vein refine) [VERIFIED]
const BuildSchema = z.object({
  from: Vec3Shape,
  to: Vec3Shape,
  block: z.string().min(1),
  hollow: z.boolean().optional().default(false),
}).refine(
  ({ from, to }) => {
    const dx = Math.abs(to.x - from.x) + 1
    const dy = Math.abs(to.y - from.y) + 1
    const dz = Math.abs(to.z - from.z) + 1
    return dx * dy * dz <= 256
  },
  { message: 'cuboid too large (>256 cells) — split into smaller calls (e.g. build one floor at a time)' }
)
registry.register('build', BuildSchema, buildAction)
```

### Extended `dig` schema with optional `to`
```js
// Source: combines existing TargetShape (registry.js:33-43) with mine_vein refine pattern [VERIFIED]
const DigSchema = z.object({
  block: z.string().optional(),
  target: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  z: z.number().optional(),
  to: Vec3Shape.optional(),
  hollow: z.boolean().optional(),
  maxDistance: z.number().min(1).max(64).default(32),
}).refine(
  (a) => a.block || a.target || (a.x != null && a.y != null && a.z != null),
  { message: 'must specify block, #N target, or x/y/z' }
).refine(
  (a) => {
    if (a.to == null) return true
    if (a.x == null || a.y == null || a.z == null) return false  // cuboid mode requires explicit from
    const dx = Math.abs(a.to.x - a.x) + 1
    const dy = Math.abs(a.to.y - a.y) + 1
    const dz = Math.abs(a.to.z - a.z) + 1
    return dx * dy * dz <= 256
  },
  { message: 'cuboid dig too large (>256 cells) or missing explicit from coords' }
)
```

### `seed_cuboid_grammar` cached block (insertion into composeSeedBlocks)
```js
// Source: pattern from orchestrator.js:282-289 [VERIFIED]
const SEED_CUBOID_GRAMMAR = `# Cuboid grammar (for build and dig)

build and dig take TWO ABSOLUTE CORNERS {from:{x,y,z}, to:{x,y,z}}. Every shape is a special case of the two-corner box:

- pillar (vertical column): keep two dims constant, vary Y.
  e.g. build({from:{x:5,y:64,z:5}, to:{x:5,y:68,z:5}, block:"dirt"}) → 5-block pillar at (5,*,5)

- wall (vertical plane): keep one dim constant, vary the other two.
  e.g. build({from:{x:0,y:64,z:5}, to:{x:3,y:67,z:5}, block:"oak_planks"}) → 4×4 wall along z=5

- platform / floor: keep Y constant, vary X and Z.
  e.g. build({from:{x:0,y:64,z:0}, to:{x:3,y:64,z:3}, block:"dirt"}) → 4×4 floor at y=64

- tunnel: dig with Y constant and Z constant (or X constant).
  e.g. dig({x:0,y:64,z:0, to:{x:0,y:65,z:4}, block:"stone"}) → 1×2×5 tunnel along the z axis (1 wide, 2 tall, 5 long)

- hollow room shell: hollow:true gives the 4 vertical wall faces only; add floor + ceiling with two flat single-Y cuboids.

Volume cap: 256 cells per call. Build skips occupied cells (it will not break-and-replace). Dig silently skips air cells.`

// In composeSeedBlocks, after seed_owner and before seed_diary:
blocks.splice(1, 0, { type: 'text', name: 'seed_cuboid_grammar', text: SEED_CUBOID_GRAMMAR })
// (or before seed_diary — either ordering preserves caching as long as cache_control is on the LAST static block)
```

### Progress-tick scheduler (Option A — snapshot enrichment, RECOMMENDED)
```js
// Source: pattern adapted from inflight.js:22-49 + snapshot.js:64-68 [VERIFIED files]
// In behaviors/build.js: pass a progress callback via config
export async function buildAction(args, bot, config) {
  // ... loop ...
  for (const c of cells) {
    config?.onProgress?.({ placed, skipped, total: cells.length, currentY: c.y })
    // ... do work ...
  }
}

// In orchestrator.js runWithInflight (around L532):
async function runWithInflight(name, args, execOpts) {
  const handle = inflight.start({ name, args })
  let latestProgress = null
  if (name === 'build' || (name === 'dig' && args.to)) {
    execOpts = { ...execOpts, onProgress: (p) => { latestProgress = p; inflight.updateProgress(handle, p) } }
  }
  try {
    return await registry.execute(name, args, null, execOpts)
  } finally {
    inflight.end(handle)
  }
}
// inflight.js: add updateProgress(handle, p) to store p on entry; expose progress on currentBlocking()
// snapshot.js:68: include progress when present:
//   `in_flight: build dirt (12s) — 47/256 placed, current y=66`
```
This is Option A (no extra LLM iteration during the action). For Option B (true LLM tick mid-action) the planner needs a clear story on what tools the LLM can call while a movement is in flight — see Pitfall 6.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Pathfinder `Movements.scafoldingBlocks` flag | Hand-rolled jump+place loop | This phase (D-04) | Per-cell observable, abortable, deterministic — no coupling to pathfinder's internal scaffolding heuristics. |
| Single-cell `placeBlock` only exposed via low-level tools | `build` cuboid primitive exposed to LLM | This phase | LLM no longer needs to enumerate per-cell coordinates; can request shapes by two corners. |
| `placeBlock` + `equip` invisible to LLM (SPEC background) | LLM-facing descriptions in `ACTION_DESCRIPTIONS` | This phase (D-03) | Closes the user-reported defect ("tried to place dirt block under it" — zero placeBlock calls in logs). |

**Deprecated/outdated:** None in scope — Phase 7 is purely additive.

## Project Constraints (from CLAUDE.md)

- **Three-process Electron** — All Phase 7 work lives in utilityProcess (bot + LLM); no main/renderer changes. [VERIFIED via inspection of file layout — src/bot/* is utilityProcess]
- **Closed action registry** — `build` and extended `dig` must be Zod-typed actions in the registry, not free-form code. [Satisfied by registry.js registration]
- **Every external call has a timeout** — Per-cell place/dig already have timeouts (4000ms / 8000ms); pathfind timeouts inherit from `pathfinder_timeout_ms` config. The scaffolding loop's `bot.placeBlock` call needs a timeout — `placeBlockAction` provides it. The `waitForApex` and `waitForLanding` helpers have explicit maxMs caps. **All covered.**
- **Single outstanding action token with AbortController** — `signal` already threaded; cuboid handlers check `signal.aborted` per-cell. **Covered.**
- **Owner chat preempts mid-action** — Already wired via FSM. The cuboid loop's per-cell `signal.aborted` check + `placeBlockAction`'s internal abort path handle this.
- **Pathfinder silent hangs** — `goTo` wrapper at `pathfind.js:51-56` has wall-clock timeout. The unreachable hint composition at the wrapper site does not affect this.
- **Always read STATE.md + roadmap before work** — STATE.md shows Phase 6 currently executing; Phase 7 follows. Planner should confirm Phase 6 complete before /gsd-execute-phase 7.

## User Constraints (from CONTEXT.md)

### Locked Decisions

(Verbatim from CONTEXT.md `## Decisions`:)

- **D-01:** Extend `dig` with optional `to:{x,y,z}` (not separate `digRegion`). Zod refine: `(block) | ({x,y,z}) | ({x,y,z}+to)`.
- **D-02:** `build` is a brand-new registry action — no overload of `placeBlock`.
- **D-03:** `placeBlock` and `equip` get LLM-facing descriptions added to `ACTION_DESCRIPTIONS` in `src/bot/adapter/minecraft/index.js`. Canonical strings live next to their handlers.
- **D-04:** Custom hand-rolled jump+place loop inside `build`. Do NOT use mineflayer-pathfinder `Movements.scafoldingBlocks`. Sequence: detect target cell unreachable due to height → `setControlState('jump',true)` → wait apex (~250ms; verify) → `setControlState('jump',false)` → `placeBlock` against block-below with `faceVector={x:0,y:1,z:0}` → wait landing → continue.
- **D-05:** `build` skips occupied cells. No break-and-replace.
- **D-06:** `dig` silently skips air cells.
- **D-07:** `build` iterates Y↑→X→Z; `dig` iterates Y↓→X→Z. Documented constants.
- **D-08:** New `seed_cuboid_grammar` cached system-prompt block near `seed_owner` / `seed_diary` in `orchestrator.js:283-288`. Teaches pillar / wall / platform / tunnel / hollow shell.
- **D-09:** `goTo` and `dig` emit `unreachable — try build to Y=N` when pathfinder fails AND `target.y > bot.y + small margin`.
- **D-10:** Cuboid actions emit periodic progress ticks (~10s) while in flight. LLM may abort, continue, or take other action. Owner chat / safety still preempts via existing AbortController.
- **D-11:** 256-cell cap checked at Zod schema layer. Formula: `|to.x-from.x+1| * |to.y-from.y+1| * |to.z-from.z+1|`. Error suggests splitting.

### Claude's Discretion
- Exact apex/landing timing constants in D-04 (recommended: poll `position.y` with 40ms cadence rather than fixed sleep).
- Exact vertical margin in D-09 (recommend 2 blocks — vanilla jump is ~1.25 blocks, so >2 above bot is definitively unreachable).
- Progress tick interval in D-10 (recommend 10s).
- Result string format for `build` / cuboid `dig` — concise count summary mirroring `mineVein`'s `mined K/N <name>` idiom.

### Deferred Ideas (OUT OF SCOPE)
- Crouch-to-edge-and-place behavior.
- Bot-relative `{forward, up, right}` corner spec.
- Default block selection / inventory priority list.
- Generalized async-action LLM tick framework (D-10 ships a minimal scoped version only).
- Aesthetic shapes (stairs, roofs, arches, spheres).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Jump apex at ~250ms with vanilla jump strength on flat ground | Common Pitfalls / Code Examples | Misses placement window; recommended fix is polling, not sleep, so risk is mitigated. [ASSUMED — verify experimentally per D-04 wording.] |
| A2 | `bot.entity.onGround` flips reliably on landing | Code Examples (waitForLanding) | If unreliable, fallback to position.y plateau detection. [ASSUMED — based on mineflayer 4.x knowledge; planner can confirm via test bot or mineflayer docs lookup.] |
| A3 | `bot.placeBlock(refBlock, Vec3(0,1,0))` against the floor-below correctly produces a block at the bot's apex foot position | Pitfall 1 correction | If face semantics are inverted (`Vec3(0,1,0)` means "place on bottom face" in mineflayer's convention), placements go the wrong way. [ASSUMED based on standard convention; recommend planner verify against existing `placeBlock` usage in any other project file or with a one-off test.] |
| A4 | Vertical margin of 2 blocks for D-09 unreachable hint matches vanilla jump physics | Common Pitfalls | Off-by-one in either direction either suppresses hint when it should fire or fires it for reachable targets. Low blast radius — LLM either gets useful hint or doesn't. |
| A5 | Option A (snapshot enrichment) satisfies D-10 spirit | Pitfall 6 + Code Examples | D-10 wording ("LLM may choose to abort, continue waiting, or take other action") suggests Option B; Option A doesn't fully deliver "may take other action" unless there's a mid-action abort tool. **Planner should clarify or escalate to /gsd-discuss-phase before committing.** |
| A6 | `ACTION_DESCRIPTIONS` map in `orchestrator.js:108` is the one the LLM actually sees (the `index.js:22` map is fallback only) | Pattern 3 | If both feed in via different paths, updates must hit both to avoid drift. **Planner should verify by tracing how `getActionDescription()` flows into `buildAnthropicTools`.** |

## Open Questions (RESOLVED)

1. **Mid-action abort mechanism (D-10 ambiguity). RESOLVED:** Option A (snapshot enrichment) — Plan 07-06 ships periodic progress lines via snapshot; no `abortCurrentAction` tool. LLM-driven mid-action abort deferred to backlog per CONTEXT "Generalized async-action LLM tick framework" deferred item.
   - What we know: D-10 says "LLM may choose to abort, continue waiting, or take other action". Today, the LLM has no direct abort tool — owner chat is the only abort path.
   - What's unclear: Does Phase 7 add an `abortCurrentAction` tool, OR does the progress-tick deliver an LLM iteration where the LLM can implicitly abort by emitting a new action (which would conflict with the in_flight rule)?
   - Recommendation: Default to Option A (snapshot enrichment, no extra LLM iterations during the action). Document the limitation in `BUILD_DESCRIPTION` so the LLM knows builds run to completion unless owner chat preempts. Promote "LLM-initiated abort" to a deferred follow-up if user pushes back.

2. **Reference-face picking for the first cell of a build. RESOLVED:** Plan 07-02 iterates 6 neighbors in priority order (down, N, S, E, W, up); first non-air wins; all-air → per-cell skip with "no support — cell floats" note.
   - What we know: SPEC R3 acceptance: "with the bot standing on flat ground at y=64 and inventory containing dirt, build({from:{x:0,y:65,z:0}, to:{x:0,y:69,z:0}, block:'dirt'}) produces a 5-block pillar". This implies the first placement at y=65 uses the ground at y=64 as reference, with `faceVector=(0,1,0)`.
   - What's unclear: For a non-pillar cuboid where the first cell to place has no neighbors yet (e.g., a floating platform far from the bot), what's the reference?
   - Recommendation: For each cell, iterate 6 neighbors in priority order (down, north, south, east, west, up); pick the first that is non-air. If all 6 are air, return a per-cell skip with note "no support — cell floats". For the typical pillar/wall case this falls out naturally because the ground / already-placed cells provide support.

3. **Which `ACTION_DESCRIPTIONS` map is canonical? RESOLVED:** Update BOTH maps in Phase 7 (Plan 07-04). Consolidation flagged as follow-up backlog item.
   - What we know: There are two maps (`adapter/minecraft/index.js:22` and `brain/orchestrator.js:108`). Both currently contain `dig`. The orchestrator one is what `buildAnthropicTools` reads. The adapter one is a fallback at `index.js:56`.
   - What's unclear: Why the duplication? Is the long-term plan to consolidate?
   - Recommendation: Update both for Phase 7. Plan a refactor task (out of scope for this phase) to consolidate. Or flag for /gsd-discuss-phase decision.

4. **Should the cuboid `dig` mode call `goTo` per cell, or only when out of reach? RESOLVED:** Plan 07-03 checks `bot.entity.position.distanceTo(cellPos) <= DIG_REACH` first; only calls `goTo` when out of reach.
   - What we know: `mineVeinAction:152` pre-pathfinds to each cell at range:3.
   - What's unclear: For a tightly-packed cuboid where adjacent cells are all within reach, repeated `goTo` calls add overhead.
   - Recommendation: Check distance first (`bot.entity.position.distanceTo(cellPos) <= DIG_REACH`); only call `goTo` when needed. Mirrors what `dig.js:50-53` already does internally.

## Environment Availability

Not applicable — Phase 7 introduces no new external dependencies. All required tools (`mineflayer`, `mineflayer-pathfinder`, `zod`, `vec3`, `minecraft-data`) are already in `package.json` and used by existing phases. [VERIFIED: `package.json` grep above]

## Validation Architecture

`workflow.nyquist_validation` is `false` in `.planning/config.json` [VERIFIED]. Section omitted.

## Security Domain

`security_enforcement` not set in `.planning/config.json` [VERIFIED — config has only `workflow` keys]. Section omitted per spec.

(Note: Phase 7 has no external-network surface, no user-supplied untrusted input — `build` and `dig` args come from a locked closed registry validated by Zod. No new auth, session, or cryptography concerns.)

## Sources

### Primary (HIGH confidence)
- `/Users/ouen/slop/sei/src/bot/adapter/minecraft/behaviors/dig.js` — DIG_DESCRIPTION pattern, Promise.race idiom, reach check, target-changed detection
- `/Users/ouen/slop/sei/src/bot/adapter/minecraft/behaviors/mineVein.js` — Multi-step loop precedent with abort + per-cell pathfind + result accumulation
- `/Users/ouen/slop/sei/src/bot/adapter/minecraft/behaviors/place.js` — placeBlockAction internals (equip-then-place, face vector default, timeout)
- `/Users/ouen/slop/sei/src/bot/adapter/minecraft/behaviors/equip.js` — equipAction structure
- `/Users/ouen/slop/sei/src/bot/adapter/minecraft/behaviors/pathfind.js` — goTo wrapper, cant_reach distance hint pattern (extension site for D-09)
- `/Users/ouen/slop/sei/src/bot/adapter/minecraft/registry.js` — Zod refine patterns, registration site, TargetShape
- `/Users/ouen/slop/sei/src/bot/adapter/minecraft/index.js` — ACTION_DESCRIPTIONS at L22, executeAction at L57
- `/Users/ouen/slop/sei/src/bot/brain/orchestrator.js` — composeSeedBlocks L268-324, runWithInflight L532, action dispatch L1153-1170, ACTION_DESCRIPTIONS L108
- `/Users/ouen/slop/sei/src/bot/brain/inflight.js` — Inflight tracker (extension site for progress)
- `/Users/ouen/slop/sei/package.json` — mineflayer ^4.23.0, mineflayer-pathfinder ^2.4.5
- `.planning/phases/07-pillar-up-scaffolding-behavior-place-equip-actions-and-pilla/07-SPEC.md` — Locked requirements
- `.planning/phases/07-pillar-up-scaffolding-behavior-place-equip-actions-and-pilla/07-CONTEXT.md` — D-01..D-11 locked decisions

### Secondary (MEDIUM confidence)
- Mineflayer 4.x API surface for `bot.setControlState`, `bot.placeBlock`, `bot.entity.onGround` — used by existing code in this repo (place.js, behaviors)

### Tertiary (LOW confidence)
- Specific apex/landing millisecond timings (CONTEXT D-04 itself flags as "planner verifies experimentally")
- Exact face vector convention in `bot.placeBlock(ref, vec)` — placement-direction semantics. Verified against `place.js:28` (`new Vec3(0, 1, 0)` default) which strongly implies "face we place on" convention, but worth a one-off live confirmation.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — every library already in use, versions verified against `package.json`.
- Architecture: HIGH — composition pattern is a near-direct copy of `mineVeinAction` shape; integration points all identified at exact line numbers.
- Scaffolding (jump+place): MEDIUM — sequence is clear, timing constants flagged as planner-verifiable per D-04.
- Progress-tick mechanism: MEDIUM — Option A is unambiguous; Option B (mid-action LLM iteration) needs a discuss-phase decision on the abort tool surface.
- Pitfalls: HIGH — drawn from existing pitfall comments in dig.js / mineVein.js / orchestrator.js and CLAUDE.md.
- ACTION_DESCRIPTIONS duplication: MEDIUM — confirmed via grep but underlying reason not investigated.

**Research date:** 2026-05-12
**Valid until:** 2026-06-11 (30 days — stable codebase, no upstream churn expected)

## RESEARCH COMPLETE

**Phase:** 7 - Cuboid build / dig primitive (with scaffolding)
**Confidence:** HIGH (HIGH on existing patterns and integration points; MEDIUM on jump+place timing constants per D-04 wording; MEDIUM on D-10 progress-tick mechanism specifics)

### Key Findings
- Phase 7 is composition over existing primitives — `placeBlockAction`, `digAction`, `equipAction`, and `goTo` already do the per-cell work with timeouts and abort wiring. The new code is a loop + a scaffolding subroutine + a Zod refine + a cached system-prompt block + a progress-tick scheduler.
- The `mineVeinAction` file is a near-perfect template for `buildAction`'s loop structure (and for `digCuboid()`).
- Two `ACTION_DESCRIPTIONS` maps exist (orchestrator + adapter) — planner must update both or consolidate.
- D-10 progress-tick mechanism has one real ambiguity worth surfacing pre-plan: snapshot enrichment (recommended) vs true mid-action LLM iteration with a new abort tool. Default to snapshot enrichment and document the limitation.
- Jump+place timing constants (D-04, ~250ms apex / ~200ms landing) are better implemented as polling on `bot.entity.position.y` / `bot.entity.onGround` than fixed sleeps — robust to server tick variation and Pitfall 1.

### File Created
`/Users/ouen/slop/sei/.planning/phases/07-pillar-up-scaffolding-behavior-place-equip-actions-and-pilla/07-RESEARCH.md`

### Confidence Assessment
| Area | Level | Reason |
|------|-------|--------|
| Standard Stack | HIGH | Versions verified against package.json; no new deps. |
| Architecture | HIGH | Composition pattern matches mineVeinAction line-for-line; integration points identified at exact file:line. |
| Scaffolding subroutine | MEDIUM | Structure clear, exact timing per-server (D-04 acknowledges this). |
| Progress-tick mechanism | MEDIUM | Option A clean; Option B needs a discuss-phase clarification on mid-action abort. |
| Pitfalls | HIGH | Drawn from in-codebase pitfall comments and CLAUDE.md. |

### Open Questions (planner should resolve before final plan)
1. Snapshot enrichment vs true mid-action LLM iteration for D-10.
2. Which `ACTION_DESCRIPTIONS` map is canonical — update both or consolidate?
3. Per-cell `goTo` policy for cuboid `dig` (always vs only when out of reach).
4. Reference-face picking algorithm for non-pillar first cells.

### Ready for Planning
Research complete. Planner can now create PLAN.md files covering: (1) `behaviors/build.js` + tests, (2) `dig.js` cuboid extension + tests, (3) registry schema + 256-cell cap + tests, (4) `ACTION_DESCRIPTIONS` updates in both maps, (5) orchestrator `seed_cuboid_grammar` block, (6) orchestrator progress-tick scheduler (Option A), (7) `goTo` + `dig` unreachable hint in pathfind.js / dig.js result-string composition.
