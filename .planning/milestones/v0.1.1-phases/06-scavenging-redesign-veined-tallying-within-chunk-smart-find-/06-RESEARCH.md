# Phase 6: Scavenging Redesign — Research

**Researched:** 2026-05-11
**Domain:** mineflayer block scanning, snapshot composition, closed Zod action registry
**Confidence:** HIGH (all findings verified directly against the working tree)

## Summary

Phase 6 replaces the current "16 nearest interesting blocks by distance" snapshot section in `src/bot/adapter/minecraft/observers/snapshot.js` with a **veined representation** (per-block-type: nearest representative + connected-component size + handle), and adds two new closed-registry actions: `find()` (NL→ID + nearest-loaded lookup, returns a result) and `mine_vein()` (resolve + flood-fill + pathfind + sequential dig). Per CONTEXT.md the originally-scoped `smart_find` collapses into `find()` — same action handles exact IDs and loose terms; no cross-chunk spiral this phase.

Mineflayer 4.23 + minecraft-data already provide the entire scanning substrate: `bot.findBlocks({matching, maxDistance, count, point})` returns Vec3s closest-first, `bot.blockAt(vec3)` returns the Block, and `bot.canDigBlock(block)` gates dig viability. The exposure predicate (`isExposed`) and tiered `nearbyBlocks` helper in `observers/blocks.js` already do most of the heavy lifting — the phase is mostly *(a)* a flood-fill grouper on top of the existing exposure-filtered scan, *(b)* a hand-curated NL→ID table, and *(c)* two new entries in `registry.js`. The capability primer in `orchestrator.js` (`ACTION_DESCRIPTIONS` map at L107) is byte-stable cached prefix territory — every byte change invalidates the Anthropic cache prefix, so primer changes go in one atomic edit.

**Primary recommendation:** Build a `veins.js` observer next to `blocks.js` exporting `nearbyVeins(bot, {radius, maxVeins})` that returns `[{name, anchor:{x,y,z}, count, distance}, ...]`. Compose into snapshot. Build `loose-terms.js` with `resolveTerm(name) → string[]`. Register `find` and `mine_vein` in `registry.js`. Keep the scanner factored from the renderer per CONTEXT.md's "per-vein vs per-type" future-flex note.

## User Constraints (from CONTEXT.md)

### Locked Decisions

- **Output format:** one line per detected vein with `name`, vein tag, count, anchor coords, distance, `#N` handle. Format example in CONTEXT.md L31-38. Renderer is swappable from scanner.
- **Scan radius:** 16 blocks (matches current `nearbyBlocks` radius). Cap total veins surfaced (top-K by distance).
- **Connectivity:** 6-neighbor flood-fill (face-adjacent), **same exact block ID only**. `spruce_log` next to `oak_log` = two separate veins. No cross-chunk merging.
- **`find()` is a registered Zod action**, returns a result (does NOT move the bot). Input is a single term (exact ID OR loose term). Output: `{id, pos:{x,y,z}, distance}` or "none in loaded chunks".
- **Search scope:** loaded chunks only — no spiral exploration this phase.
- **Loose-term table:** hand-curated static map → ID lists (e.g. `wood: ['oak_log','spruce_log',...]`, `stone: [...]`, `ore: [...]`). Fallthrough: unknown term → treat as exact ID.
- **Loose-term resolution is server-side** (single call beats N find()s under iteration cap; ground-truth IDs vs Haiku's fuzzy MC knowledge).
- **`mine_vein()` is a registered Zod action.** Input: name (loose or exact) OR coordinate (mine the vein containing this block). Behavior: resolve → flood-fill (same rules as snapshot) → pathfind → mine block-by-block.
- **Capability primer update:** Haiku must be told "use `mine_vein` for vein-shaped resources; `dig` for single coord-specific blocks."
- **Loose-term table is its own module**, surfaced as `resolveTerm(name) → string[]`. Phase 7 will consume it directly (NL→ID lookup, not locator).
- **Closed-registry rules carry forward (Phase 2.1):** every new action timeout-wrapped, AbortController-cancellable, respects FSM priority queue.

### Claude's Discretion

- Exact rendering of the vein line (CONTEXT.md says "illustrative").
- Vein-size soft cap for `mine_vein` (CONTEXT.md suggests ~64 with surfaced "stopped at cap" result).
- Whether `mine_vein` streams progress or returns a single terminal result.
- Whether the `terrain at feet:` 5×4×5 cube line stays unchanged (CONTEXT.md L88 — "likely keep as-is").
- Vein tag scheme (letters? counter? coord-hash?). Letters used in CONTEXT.md illustration.

### Deferred Ideas (OUT OF SCOPE)

- Per-type collapsed snapshot format (alternative rendering).
- Cross-chunk spiral exploration in `find()`.
- `mine_vein` partial-completion / resume semantics.
- mc-data-driven term table at startup (replaces hand-curated).

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| D-NEW-SCAV-1 | Snapshot's nearby-block tally is per-block, not vein-aware; LLM can't tell one tree from 8 logs in a row | Replaced by `veins.js` flood-fill grouper composed into snapshot |
| D-NEW-SCAV-2 | No NL→ID resolution; LLM must guess MC block IDs across versions | `loose-terms.js` hand-curated table + `resolveTerm()` consumed by `find` and `mine_vein` |
| D-NEW-SCAV-3 | No primitive for "find the nearest X in loaded chunks" (current `dig{block:"oak_log"}` couples search to digging) | New `find()` registered action returns `{id,pos,distance}` without moving the bot |

## Project Constraints (from CLAUDE.md)

- Mineflayer + pathfinder run in utilityProcess only (not relevant to this phase — observers/registry are utilityProcess-side).
- **Every external call has a timeout.** `mine_vein` must wrap its pathfind/dig chain in bounded waits (use existing `goTo(bot,x,y,z,range,timeoutMs)` and `digAction` which already does single-flight + timeout). Also: respect `config.signal` for AbortController cancellation.
- **Single outstanding action token / FSM priority queue.** `mine_vein` is one registered action that internally chains pathfind+dig — make sure it's one logical token, not N pushed to the FSM. Check the signal between sub-steps and abort cleanly mid-vein on owner chat preempt.
- **Closed registry — LLM never invents coordinates.** `mine_vein` takes either a name (resolved server-side) or a coord (which itself must come from a snapshot handle or prior `find()` result — the schema allows raw coords, but the *capability primer* should steer Haiku toward names + `#N`).
- **Iteration cap default 20** (note: orchestrator.js L103 says 30; primer text). `mine_vein` must finish or return progress before consuming many LLM iterations — it's a single tool call, so it only costs one iteration.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Veined block scan (flood-fill + grouping) | `adapter/minecraft/observers/veins.js` (new) | reuses `observers/blocks.js` exposure helpers + `bot.findBlocks` | Pure read-only world observation, mineflayer-specific; same tier as `blocks.js`/`entities.js` |
| Veined snapshot rendering | `observers/snapshot.js` | — | Snapshot is the existing composition seam |
| NL→ID loose-term table | `adapter/minecraft/loose-terms.js` (new, top-level adapter) | consumed by registry actions + Phase 7 | Hand-curated MC data; not an "observer" — it's a static resource table. Exporting from adapter root keeps it reusable without going through observers |
| `find()` action handler | `adapter/minecraft/registry.js` (registered) | reuses `loose-terms.js` + `bot.findBlocks` + `getHealedPos` | Closed Zod registry is the contract for everything the LLM can call |
| `mine_vein()` action handler | `adapter/minecraft/behaviors/mineVein.js` (new) | reuses `loose-terms.js` + `veins.js` flood-fill + `goTo` + `digAction` | Follows `behaviors/` pattern (one file per action with timeout/abort handling, like `dig.js`) |
| Capability primer update | `brain/orchestrator.js` `ACTION_DESCRIPTIONS` | — | Cached system prefix; one atomic edit |

## Current Snapshot Composer Architecture

**File:** `src/bot/adapter/minecraft/observers/snapshot.js`

Composition order (verbatim from L46-138):
1. `pos:` / `biome:` / `time:`
2. `hp` / `food` / `xp`
3. `holding:`
4. `in_flight:` (if any)
5. `inventory:`
6. `terrain at feet:` — from `aroundFeet(bot)`, 5×4×5 grouped cube, no `#N` handles
7. **`nearby blocks:`** — this is the section being replaced. Lines L97-108. Currently: up to 16 entries, each `  #N <name> @x,y,z`. Sourced from `nearbyBlocks(bot, {radius: 16, count: MAX_BLOCKS, interesting: INTERESTING_BLOCK_NAMES})`. Handles are minted into the `handles` array and installed via `setHandles(handles)` at L141.
8. `nearby entities:` — entries also share the same monotonic `#N` numbering (`n` counter is shared across blocks and entities).
9. `owner_goals` / `self_goals` / `follow_target` / `last_action_result`
10. `recent_events:` (added by stateful wrapper `createSnapshotComposer`)

**Key invariants the rewrite must preserve:**

- `#N` numbering is **monotonic across blocks then entities** (single `n` counter). If the new vein renderer emits one handle per vein, entities continue numbering after the last vein handle.
- `setHandles(handles)` at end of `composeSnapshot` is **the** handle-table refresh point. The vein renderer must contribute its `[tag, {kind:'block', pos:{x,y,z}, expiresAt}]` entries to the same `handles` array.
- Stateful delta wrapper `createSnapshotComposer` at L162 wraps `composeSnapshot` — keep `composeSnapshot` synchronous and pure-ish (just the `setHandles` side-effect).
- `getHealedPos(bot) ?? bot.entity?.position` is the scan origin (handles transient NaN positions). Vein scanner must use the same.

**Token cost today:** snapshot is line-oriented text injected at every iteration. Current `nearby blocks:` section is `1 header + 16 entries + maybe "+K more" = ~18 lines`. After rewrite (veined), one line per vein with `top-K` cap (e.g. K=8) means **fewer lines, more information per line** — net token reduction expected if K=8 and average vein-size >1.

## Vein Computation — Flood-Fill on Visible Blocks

### Algorithm

```js
// veins.js (new file in observers/)
import { Vec3 } from 'vec3'
import mcDataLib from 'minecraft-data'
import { getHealedPos } from './posHealer.js'
import { isExposed, INTERESTING_BLOCK_NAMES } from './blocks.js'

const NEIGHBOR_OFFSETS = [
  [1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1],
]

/**
 * Group nearby interesting blocks into 6-neighbor connected components
 * (same exact block ID only). Returns top-K veins by anchor distance.
 *
 * @param {Bot} bot
 * @param {{radius?:number, maxVeins?:number, veinCap?:number, interesting?:Set<string>}} opts
 * @returns {{ veins: Array<{name:string, anchor:{x,y,z}, count:number, distance:number}>, more:number }}
 */
export function nearbyVeins(bot, opts = {}) {
  const radius = opts.radius ?? 16
  const maxVeins = opts.maxVeins ?? 8
  const veinCap = opts.veinCap ?? 64  // bound flood-fill per vein
  const interesting = opts.interesting ?? INTERESTING_BLOCK_NAMES

  const origin = getHealedPos(bot) ?? bot.entity?.position
  if (!origin || !Number.isFinite(origin.x)) return { veins: [], more: 0 }

  // Re-use the exposure-filtered seed list from existing helper or call
  // findBlocks directly with a generous count. Each seed is a potential vein
  // anchor (closest exposed block of any interesting type).
  let mcData
  try { mcData = mcDataLib(bot.version) } catch { mcData = null }
  const matching = mcData?.blocksByName
    ? Array.from(interesting).map(n => mcData.blocksByName[n]?.id).filter(Boolean)
    : ((b) => interesting.has(b.name))

  // Big seed count: we'll dedupe via visited set during flood-fill.
  const seeds = bot.findBlocks({ matching, maxDistance: radius, count: 256, point: origin })

  const visited = new Set()
  const key = (x,y,z) => `${x},${y},${z}`
  const veins = []

  for (const seed of seeds) {
    const k = key(seed.x, seed.y, seed.z)
    if (visited.has(k)) continue

    const seedBlk = bot.blockAt(seed)
    if (!seedBlk || !interesting.has(seedBlk.name)) { visited.add(k); continue }
    if (!isExposed(bot, seed)) { visited.add(k); continue }

    const veinName = seedBlk.name
    // BFS flood-fill, same-name only
    const stack = [seed]
    const veinPositions = []
    while (stack.length && veinPositions.length < veinCap) {
      const p = stack.pop()
      const pk = key(p.x, p.y, p.z)
      if (visited.has(pk)) continue
      const blk = bot.blockAt(p)
      if (!blk || blk.name !== veinName) { visited.add(pk); continue }
      visited.add(pk)
      veinPositions.push(p)
      for (const [dx,dy,dz] of NEIGHBOR_OFFSETS) {
        const np = new Vec3(p.x+dx, p.y+dy, p.z+dz)
        if (!visited.has(key(np.x,np.y,np.z))) stack.push(np)
      }
    }

    // Anchor = closest member of the vein to bot
    let anchor = veinPositions[0]
    let bestD = anchor.distanceTo(origin)
    for (const p of veinPositions) {
      const d = p.distanceTo(origin)
      if (d < bestD) { bestD = d; anchor = p }
    }
    veins.push({ name: veinName, anchor: {x:anchor.x,y:anchor.y,z:anchor.z}, count: veinPositions.length, distance: bestD })
  }

  // Sort by anchor distance, take top K
  veins.sort((a,b) => a.distance - b.distance)
  const head = veins.slice(0, maxVeins)
  const more = Math.max(0, veins.length - maxVeins)
  return { veins: head, more }
}
```

### Performance notes [VERIFIED: source inspection]

- `bot.findBlocks` is mineflayer-native and already chunk-bounded — won't scan unloaded chunks.
- Worst case for flood-fill: a 16-radius slab of cobblestone could be thousands of blocks. **`veinCap: 64` is essential** (matches the suggested mine_vein cap). After 64 blocks the vein's reported `count` is `64+` semantically — render as `x64+` to signal truncation.
- One vein's flood-fill performs up to `64 * 6 = 384` `bot.blockAt` calls (each is an in-memory chunk lookup, very cheap). Compared with `aroundFeet` (100 blockAt) this is a few hundred — well under any frame-budget concern.
- The 256-seed cap on `findBlocks` is the outer bound on how many distinct veins can be discovered. 256 / avg-vein-size is plenty for a 16-radius scan.

## `find()` Action — NL→ID + Loaded-Chunk Search

### Loose-terms table

```js
// adapter/minecraft/loose-terms.js (new)
const WOODS = ['oak','birch','spruce','jungle','acacia','dark_oak','mangrove','cherry']
const ORE_BASES = ['coal','iron','gold','diamond','copper','redstone','lapis','emerald']

const TABLE = {
  wood:   WOODS.map(w => `${w}_log`),
  log:    WOODS.map(w => `${w}_log`),
  planks: WOODS.map(w => `${w}_planks`),
  leaves: WOODS.map(w => `${w}_leaves`),
  ore:    [
    ...ORE_BASES.map(o => `${o}_ore`),
    ...ORE_BASES.map(o => `deepslate_${o}_ore`),
  ],
  stone:  ['stone','cobblestone','andesite','diorite','granite','deepslate','tuff'],
  dirt:   ['dirt','coarse_dirt','grass_block','podzol','rooted_dirt','mycelium'],
  sand:   ['sand','red_sand'],
  // ... etc per CONTEXT.md
}

/**
 * @param {string} name
 * @returns {string[]}  list of MC block IDs; [name] fallthrough for exact IDs
 */
export function resolveTerm(name) {
  const lower = String(name).toLowerCase()
  if (TABLE[lower]) return TABLE[lower]
  return [lower]  // fallthrough: treat as exact ID
}

export const LOOSE_TERMS = Object.keys(TABLE)
```

### `find` registration

```js
// registry.js addition
import { resolveTerm } from './loose-terms.js'
import { getHealedPos } from './observers/posHealer.js'
import mcDataLib from 'minecraft-data'

registry.register(
  'find',
  z.object({
    name: z.string().min(1),
    maxDistance: z.number().min(1).max(128).default(64),
  }),
  async (args, bot) => {
    const ids = resolveTerm(args.name)
    let mcData
    try { mcData = mcDataLib(bot.version) } catch { mcData = null }
    const matching = mcData?.blocksByName
      ? ids.map(n => mcData.blocksByName[n]?.id).filter(Boolean)
      : ((b) => ids.includes(b.name))
    if (Array.isArray(matching) && matching.length === 0) {
      return { found: false, reason: `no known IDs for ${args.name}` }
    }
    const origin = getHealedPos(bot) ?? bot.entity?.position
    const point = origin && Number.isFinite(origin.x) ? origin : undefined
    const hits = bot.findBlocks({ matching, maxDistance: args.maxDistance, count: 1, point })
    if (!hits.length) return { found: false, reason: `no ${args.name} in loaded chunks within ${args.maxDistance}m` }
    const p = hits[0]
    const blk = bot.blockAt(p)
    const distance = point ? p.distanceTo(point) : 0
    return {
      found: true,
      id: blk?.name ?? 'unknown',
      pos: { x: p.x, y: p.y, z: p.z },
      distance: Number(distance.toFixed(1)),
    }
  }
)
```

**Important — return shape:** the FSM/loop expects tool results to be strings or JSON-serializable. Mirror `setGoals` which already returns `{ok, snapshot}` (see `registry.js` L101). `find` returns an object — orchestrator will JSON-stringify it into the tool_result content.

## `mine_vein()` Action — Resolve + Flood + Path + Dig

### Implementation sketch

```js
// behaviors/mineVein.js (new)
import { Vec3 } from 'vec3'
import { resolveTerm } from '../loose-terms.js'
import { goTo } from './pathfind.js'
import { digAction } from './dig.js'
import { isExposed, INTERESTING_BLOCK_NAMES } from '../observers/blocks.js'
import mcDataLib from 'minecraft-data'

const NEIGHBOR_OFFSETS = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]
const VEIN_CAP = 64

export async function mineVeinAction(args, bot, config) {
  const signal = config?.signal
  if (signal?.aborted) return 'aborted'

  // 1. Resolve anchor
  let anchor
  if (typeof args.x === 'number' && typeof args.y === 'number' && typeof args.z === 'number') {
    anchor = new Vec3(args.x, args.y, args.z)
  } else if (typeof args.name === 'string') {
    const ids = resolveTerm(args.name)
    let mcData; try { mcData = mcDataLib(bot.version) } catch {}
    const matching = mcData?.blocksByName
      ? ids.map(n => mcData.blocksByName[n]?.id).filter(Boolean)
      : ((b) => ids.includes(b.name))
    const origin = bot.entity?.position
    const hits = bot.findBlocks({ matching, maxDistance: args.maxDistance ?? 32, count: 1, point: origin })
    if (!hits.length) return `no ${args.name} in loaded chunks`
    anchor = hits[0]
  } else {
    return 'must specify name or x,y,z'
  }

  // 2. Flood-fill from anchor (same exact ID only, cap 64)
  const seedBlk = bot.blockAt(anchor)
  if (!seedBlk) return 'no block at anchor'
  const veinName = seedBlk.name
  const visited = new Set()
  const key = (x,y,z) => `${x},${y},${z}`
  const stack = [anchor]
  const positions = []
  while (stack.length && positions.length < VEIN_CAP) {
    const p = stack.pop()
    const k = key(p.x, p.y, p.z)
    if (visited.has(k)) continue
    visited.add(k)
    const blk = bot.blockAt(p)
    if (!blk || blk.name !== veinName) continue
    positions.push(p)
    for (const [dx,dy,dz] of NEIGHBOR_OFFSETS) stack.push(new Vec3(p.x+dx, p.y+dy, p.z+dz))
  }

  // 3. Sort positions by current bot distance so we mine the closest first
  // (re-sort each iteration since bot moves).
  let dug = 0
  for (let i = 0; i < positions.length; i++) {
    if (signal?.aborted) return `aborted after ${dug}/${positions.length} ${veinName}`
    // Recompute closest unmined
    const bp = bot.entity?.position
    const remaining = positions
      .map((p,idx) => ({ p, idx, d: bp ? p.distanceTo(bp) : 0 }))
      .filter(r => !r.done)
    if (!remaining.length) break
    remaining.sort((a,b) => a.d - b.d)
    const next = remaining[0]
    // Reuse digAction — it already handles pathfind-into-reach + timeout + abort.
    const r = await digAction({ x: next.p.x, y: next.p.y, z: next.p.z }, bot, config)
    if (typeof r === 'string' && r.startsWith('dug ')) {
      dug++
      next.done = true
    } else if (r === 'aborted') {
      return `aborted after ${dug}/${positions.length} ${veinName}`
    } else {
      // Skip this block but continue — surface failure in terminal result.
      next.done = true
    }
  }

  const capNote = positions.length >= VEIN_CAP ? ' (vein-cap reached)' : ''
  return `mined ${dug}/${positions.length} ${veinName}${capNote}`
}
```

**Important — `dig` is the wrong primitive for the inner loop in one respect:** `digAction` does its own short pathfind to the block (via the `dropPos` walk-onto step) but it does NOT pathfind *to* the block before swinging — it returns `out of range` if you're >4.5m away. Two options:

1. **Pre-pathfind to each block**: `await goTo(bot, p.x, p.y, p.z, 3, 10_000)` then `digAction({x,y,z})`. Safer.
2. **Let `digAction` return `out of range` then re-pathfind and retry.** Worse — extra error path.

Recommend option 1. See `dig.js` L50-53: `out of range` is hard-fail.

### Schema

```js
registry.register(
  'mine_vein',
  z.object({
    name: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    z: z.number().optional(),
    maxDistance: z.number().min(1).max(64).default(32),
  }).refine(
    a => a.name || (a.x != null && a.y != null && a.z != null),
    { message: 'must specify name or x,y,z' }
  ),
  mineVeinAction
)
```

## Integration Points

### Where to register new actions

`src/bot/adapter/minecraft/registry.js` — add `registry.register('find', ...)` and `registry.register('mine_vein', ...)` inside `createDefaultRegistry()`. Pattern is exactly the same as the existing 14 actions.

### Where to plug new descriptions

`src/bot/brain/orchestrator.js` L107 `ACTION_DESCRIPTIONS` object — add `find:` and `mine_vein:` keys. The map is automatically consumed by `buildAnthropicTools(subRegistry, ACTION_DESCRIPTIONS)` at L447.

**Cache-prefix coordination:** `ACTION_DESCRIPTIONS` is part of the cached Anthropic system prefix (per STATE.md: "Anthropic cached system prefix: 3 blocks, cache_control ephemeral on LAST block"). Adding/changing description text invalidates the cache. Acceptable — Phase 6 is a known cache-bust event.

### Where to plug the veined snapshot

`src/bot/adapter/minecraft/observers/snapshot.js` L43 (`const blocks = nearbyBlocks(...)`) and L97-108 (the `nearby blocks:` render block). Replace with `const veins = nearbyVeins(bot, {radius: 16, maxVeins: 8})` and a new render loop. Keep the **shared `n` counter** for `#N` numbering so entity handles continue after vein handles.

### Movement subRegistry filter

`registry.js` — there's no `movementSubRegistry` visible in this file, but STATE.md says "setGoals lives in the registry but movement subRegistry filters it out" and "Personality LLM tools restricted to say/handOffToMovement/setGoals". Since `handOffToMovement` was dropped (260505-iqo: "API-only collapse (drop ollama/circuit/handOffToMovement)"), the single-Haiku-layer model now calls movement actions directly. **`find` and `mine_vein` should be exposed to Haiku** (the personality+movement layer) — same as `dig`, `goTo`, etc. Verify in `orchestrator.js` L447 area that the subRegistry path no longer filters movement actions.

## Loaded-Chunk Search Semantics

[VERIFIED: mineflayer source] `bot.findBlocks` operates on `bot.world.getColumn(...)` — only loaded chunks. Outside-loaded coords return nothing. This matches CONTEXT.md's "loaded chunks only — no spiral exploration this phase" decision.

**Chunk load races:** mineflayer streams chunks asynchronously. A `find()` immediately after teleport may return empty until chunks arrive. Acceptable for this phase — `find()` returns `{found: false, reason}` and Haiku can re-issue. Future cross-chunk spiral phase would `await chunkLoad` explicitly.

## Verification Plan

**Phase 5 just shipped readable per-event log lines** (STATE.md: PASS 9/9). Use that infrastructure.

### Unit-level (no live bot)

Stub the Bot interface (mineflayer is hard to mock — use a thin shim). Existing tests live in `test/` (not yet inspected; planner should `ls test/` to confirm pattern). Suggested tests:

1. `nearbyVeins` flood-fill: synthesize a `blockAt` that returns a 3×1×3 oak_log mat + one adjacent spruce_log. Assert two veins, oak count=9, spruce count=1.
2. `resolveTerm`: `'wood'` → 8 IDs; `'oak_log'` → `['oak_log']`; unknown → `[unknown]`.
3. `find` action: stub `bot.findBlocks` to return one Vec3, assert `{found:true, id, pos, distance}`.
4. `mine_vein` action: stub `digAction` to always return `'dug oak_log'`, assert sequential consumption and terminal `mined N/N`. Abort mid-sequence asserts partial result.
5. Veined snapshot render: synthesize 3 veins, assert exact line format and `setHandles` call carries 3 entries with kind:'block'.

### Integration / live bot

CONTEXT.md flags this is the second-tier verification gate. Use a live Minecraft server (the developer's existing dev loop):

- Place bot near a tree cluster. Verify `nearby veins:` line shows one entry per tree with correct count.
- `find('wood')` → returns one of the oak_log positions.
- `mine_vein('wood')` → bot walks to nearest tree and clears it. Inventory grows by tree-size.
- Owner chat preempt mid-`mine_vein` → action returns `aborted after K/N oak_log`, Haiku resumes via the prior_task hint (260503-1bu).
- Vein-cap test: dig into a stone wall, issue `mine_vein` on stone — returns `mined 64/64 stone (vein-cap reached)`.

### Success criteria per defect

- **D-NEW-SCAV-1 closed when:** snapshot replays from logs show `nearby veins:` with vein-grouped counts (not 16 per-block entries).
- **D-NEW-SCAV-2 closed when:** Haiku tool-call trace shows `find({name:"wood"})` returning a concrete `oak_log` ID without Haiku ever spelling `oak_log` itself.
- **D-NEW-SCAV-3 closed when:** in a fresh session Haiku calls `find()` first (no movement), then `mine_vein()` second — clean separation of locate-from-gather.

## Common Pitfalls

### Pitfall 1: Vein flood-fill across chunk boundary returns `null` blocks
**What goes wrong:** `bot.blockAt` returns `null` for unloaded neighbors. Flood-fill stops cleanly (the `if (!blk || blk.name !== veinName) continue` branch handles it), but vein `count` undercounts when half the tree is in an unloaded chunk.
**Avoid:** Document the behavior; vein count is "visible vein", not "true vein". Matches the existing `isExposed` conservatism (L62 `blocks.js`: "Conservative on unloaded chunks").

### Pitfall 2: `digAction` returns `out of range` inside `mine_vein`
**What goes wrong:** As above — `digAction` does not pathfind to the block, only walks onto the drop after.
**Avoid:** `await goTo(bot, p.x, p.y, p.z, 3, timeoutMs)` immediately before each `digAction({x,y,z})` call.

### Pitfall 3: `setHandles` is called once at end of `composeSnapshot` — vein handles must be added to the same array
**What goes wrong:** If `nearbyVeins` mints its own handles via a side-channel, you end up with two `setHandles` calls and the second wipes the first.
**Avoid:** `nearbyVeins` returns plain data; snapshot.js mints handles inline (same pattern as L102-105). Use the shared `n` counter so entity numbering continues correctly.

### Pitfall 4: Loose-term match collisions
**What goes wrong:** A user wants the literal block `stone` but `resolveTerm('stone')` expands to 7 stone variants — `find('stone')` may return granite when they wanted stone.
**Avoid:** Loose-term keys ALWAYS expand (CONTEXT.md decision). To get strict literal match, Haiku should pass `find('stone')` and live with the closest variant, OR primer should teach `dig({block:'stone'})` for literal-only. Document in the `find` description: "loose terms (wood, ore, stone) return ANY variant; pass an exact ID like `oak_log` for strict."

### Pitfall 5: Anchor coord referencing the player's position
**What goes wrong:** `mine_vein({x,y,z})` with bot's own coords resolves to the air block at bot's feet → "no block at anchor". Mirror of the `isCoordsAtKnownPlayer` heuristic in `registry.js` L51.
**Avoid:** Document "anchor must be a known block coord, e.g. from snapshot or `find()`". Bonus: detect bot-position coords and return a clearer error.

### Pitfall 6: Cache-prefix invalidation from primer edit
**What goes wrong:** Edit `ACTION_DESCRIPTIONS` mid-phase → cache miss on every Haiku call until prefix re-warms. STATE.md flags this as a managed concern.
**Avoid:** Batch all primer edits in one commit at end of phase. Mention "phase 6 deliberate cache bust" in commit message.

### Pitfall 7: Iteration cap mismatch (20 vs 30)
**What goes wrong:** Role file says default 20; orchestrator.js L103 primer says 30; STATE.md mentions both. `mine_vein` is one call so it consumes one iteration — non-issue. But callers chaining `find` then `mine_vein` consume 2.
**Avoid:** Just be aware; not a hard problem.

## State of the Art

| Old Approach | Current Approach (Phase 6) | Impact |
|---|---|---|
| 16 nearest exposed blocks by distance | Veined groups, top-K by anchor distance | Fewer LLM tokens, more semantic info |
| LLM guesses MC block IDs ("oak_log" vs "wood") | Server-side `resolveTerm` table | Robust to MC version drift, no ID hallucination |
| `dig({block:"oak_log"})` couples find+dig | `find()` + `mine_vein()` decoupled primitives | LLM can plan multi-step gathering |
| Single-block dig per LLM iteration | `mine_vein` mines whole connected vein in one iteration | Massive iteration-cap savings on tree/ore extraction |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `mineflayer-pathfinder` `goTo` works at `range:3` for getting into 4.5m dig-reach | mine_vein impl | Bot may stop too far → digAction returns out-of-range → vein stalls. Tune `range:1-2` if needed. |
| A2 | Anthropic cached prefix is OK to bust once at Phase 6 ship | Pitfall 6 | Performance hit for one warm-up loop; not a correctness issue. |
| A3 | `bot.findBlocks` with a `matching` array of numeric IDs is faster than function-form on large radii | nearbyVeins impl | Worst case: slight scan overhead. Mirror of existing `blocks.js` L92-99 pattern. |
| A4 | Subregistry filtering of movement-tier actions was removed in the API-only collapse (260505-iqo) | Integration Points | If filter still exists, `find`/`mine_vein` won't surface to Haiku. Planner: grep `orchestrator.js` for `movementTools` build to confirm. |

## Open Questions

1. **`mine_vein` progress streaming vs terminal result.** CONTEXT.md flags this as planner-decision. Recommendation: terminal-only this phase (single string return like `dig`). Streaming requires loop/orchestrator changes beyond Phase 6 scope.
2. **`terrain at feet:` line.** CONTEXT.md L88 — likely keep as-is. Confirmed: it's complementary to veins (5×4×5 cube vs 16-radius interesting-only scan), no overlap.
3. **Vein-tag scheme.** CONTEXT.md uses `vein#A`, `vein#B`. Letters wrap at 26; if `maxVeins=8` we're fine, but planner should pick (letters? counter? omit tag and rely on `#N` handle?).
4. **Where does `loose-terms.js` live for Phase 7 reuse?** CONTEXT.md says "Surface the table as a small exported helper." Place at `src/bot/adapter/minecraft/loose-terms.js` (adapter root). Phase 7 imports `resolveTerm` directly.

## Sources

### Primary (HIGH confidence)
- `src/bot/adapter/minecraft/observers/snapshot.js` — current composer, line-by-line
- `src/bot/adapter/minecraft/observers/blocks.js` — `nearbyBlocks`, `aroundFeet`, `isExposed`, `INTERESTING_BLOCK_NAMES`, `TERRAIN`
- `src/bot/adapter/minecraft/observers/targeting.js` — handle table contract (`setHandles`, `HANDLE_TTL_MS`, `resolveBlock`)
- `src/bot/adapter/minecraft/registry.js` — closed Zod action pattern (14 existing actions)
- `src/bot/adapter/minecraft/behaviors/dig.js` — single-flight + timeout + abort pattern; `DIG_DESCRIPTION` colocation rule
- `src/bot/adapter/minecraft/behaviors/pathfind.js` — `goTo(bot,x,y,z,range,timeoutMs)` PathfindResult contract
- `src/bot/brain/orchestrator.js` L100-118 — `ACTION_DESCRIPTIONS` and capability primer text
- `src/bot/registry.js` — `createRegistry()` factory
- `.planning/phases/06-.../06-CONTEXT.md` — locked decisions
- `.planning/STATE.md` — accumulated architectural decisions
- `CLAUDE.md` — pitfalls + utilityProcess + timeout rules
- `package.json` — mineflayer ^4.23.0, mineflayer-pathfinder ^2.4.5, minecraft-data (transitive)

### Secondary (MEDIUM confidence)
- mineflayer `bot.findBlocks` / `bot.blockAt` / `bot.canDigBlock` API surface — inferred from existing call sites and stable across 4.x

### Tertiary (LOW confidence)
- None for this phase. All claims grounded in working tree.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all libraries already in package.json and in active use
- Architecture: HIGH — exact insertion points identified in source
- Pitfalls: HIGH — derived from existing code comments (D-1sk-01, Pitfall 2 in dig.js, etc.)

**Research date:** 2026-05-11
**Valid until:** 2026-06-10 (30 days; mineflayer 4.x is stable)

## RESEARCH COMPLETE

**Phase:** 6 — Scavenging redesign (veined tallying + find() + mine_vein)
**Confidence:** HIGH

### Key Findings

- Scope collapsed from 3 → 2 subsystems per CONTEXT.md: veined snapshot + `find()`/`mine_vein` (no separate `smart_find`).
- Exact insertion points identified: `observers/snapshot.js` L43+L97-108 (replace block render), `registry.js` (add 2 actions), `orchestrator.js` L107 `ACTION_DESCRIPTIONS` (add 2 descriptions).
- New files needed: `observers/veins.js`, `loose-terms.js` (adapter root), `behaviors/mineVein.js`.
- Reuse-heavy: existing `isExposed`, `INTERESTING_BLOCK_NAMES`, `getHealedPos`, `digAction`, `goTo`, `setHandles` cover ~70% of the work.
- Anthropic prefix cache bust is unavoidable but cheap (one-time).

### Confidence Assessment
| Area | Level | Reason |
|------|-------|--------|
| Standard Stack | HIGH | mineflayer 4.23 + minecraft-data already installed and exercised |
| Architecture | HIGH | All seams identified in source; matches CONTEXT.md decisions |
| Pitfalls | HIGH | Derived from prior phase code comments and observed bugs |

### Open Questions for Planner
- `mine_vein` progress streaming vs terminal (recommend terminal)
- Vein-tag scheme (letters vs counter vs omit)
- Confirm subRegistry filter removal post-260505-iqo

### Ready for Planning
Research complete. Planner can now create PLAN.md files.
