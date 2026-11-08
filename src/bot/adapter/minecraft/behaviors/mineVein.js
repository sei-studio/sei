// src/bot/adapter/minecraft/behaviors/mineVein.js — `gather` action.
//
// `gather` is a dig-wrapper for "harvest N of a block" tasks where the exact
// location of each mined block doesn't matter. It resolves a name (loose term
// OR exact MC ID) or a raw coordinate to an anchor block, flood-fills a
// connected component (6-neighbor, same exact ID only) for tree/ore shapes,
// walks into reach only when the block isn't already adjacent, and delegates
// the swing to digAction. The whole batch consumes ONE LLM iteration (big
// saving under the iteration cap).
//
// 260708: name-mode no longer stops at one connected component. A single oak
// tree is often 1-5 logs, so `gather(oak_log, count:16)` used to finish after
// one tree and report `gathered 1/1` — a tiny harvest that READ as full
// success, so the model believed the wood task was done (Lyra post-mortem).
// Now it re-anchors on the next unvisited component and keeps going until the
// REQUESTED count is attempted or no more of the block is findable. An
// explicit x,y,z anchor still means "this vein here" and stays single-component.
//
// Result-string contract (W = requested count, K = actually dug):
//   - 'aborted'                                     — signal already aborted at entry
//   - `aborted after K/W <name>`                    — player-chat preempt mid-batch
//   - `gathered K/W <name>`                         — completed the requested count
//                                                     (K may be < W if some digs failed)
//   - `gathered K/W <name> (no more <name> reachable nearby)`
//                                                   — ran out of findable blocks first;
//                                                     if K < W the model should NOT
//                                                     treat the task as satisfied
//   - `gathered K/W <name> (that vein had only A)`  — coord-mode: the explicit vein
//                                                     was smaller than the request
//   - `no <term> in loaded chunks`                  — name resolved to nothing
//   - `no block at anchor`                          — anchor coord is air/null
//   - 'must specify name or x,y,z'                  — defensive (registry refine should catch)
//
// LLM-facing tool description moved to ../prompts.js → ACTION_DESCRIPTIONS.gather.

import { Vec3 } from 'vec3'
import mcDataLib from 'minecraft-data'
import { resolveTerm } from '../loose-terms.js'
import { goTo as realGoTo, waitForReflexClear, dropWalkOpts } from './pathfind.js'
import { digAction as realDigAction, digReachDistance, DIG_REACH, closeInForDig, AIR_STOP_PREFIX } from './dig.js'
import { lowOnAir, surfaceForAir, isUnderwaterBlock } from './air.js'
import { isUnreachable, noteUnreachable } from './unreachable.js'
import { inventoryCounts, gained } from './pickup.js'
import { droppedItemName } from '../observers/entities.js'
import { givenDropFor } from '../observers/givenDrops.js'

const NEIGHBOR_OFFSETS = [
  [1, 0, 0], [-1, 0, 0],
  [0, 1, 0], [0, -1, 0],
  [0, 0, 1], [0, 0, -1],
]
const BATCH_CAP = 64

// Items that come from mining a different block.
const MINED_FROM = { cobblestone: 'stone', cobbled_deepslate: 'deepslate' }

// End-of-gather drop sweep bounds (260709). Radius covers the trees just
// mined; the walk budget per drop is short because a resting item is almost
// always on open ground a few blocks away.
const SWEEP_RADIUS = 12
const SWEEP_MAX = 8
const SWEEP_WALK_MS = 4000
const SWEEP_SETTLE_MS = 250
const SWEEP_BUDGET_MS = 30000
// 261012: when drops are lost (buried, knocked out of reach), the batch keeps
// mining to make up the count, up to this many extra digs.
const extraDigs = (want) => Math.max(4, Math.ceil(want / 2))
// Mine-then-sweep cycles: a sweep that leaves the batch short sends it back
// to mining, at most this many times in all.
const MAX_CYCLES = 3
// 261108 (quality pass 47): a gather stops after swimming up for air this
// many times (the rest of what is near is under water).
export const MAX_AIR_BREAKS = 2

function isItemEntity(e) {
  // No objectType: the getter is deprecated in prismarine-entity and prints a
  // stack trace on every read, including for every mob and player checked.
  return !!e && (e.name === 'item' || e.name === 'item_stack' || e.displayName === 'Item')
}

/**
 * Walk to nearby dropped items so mineflayer's auto-pickup collects them.
 * The per-dig pickup walk (dig.js) catches the common case, but drops that
 * bounce off the trunk, land somewhere else, or spawn later from decaying
 * leaves (saplings, sticks, apples) were left behind — the live symptom was
 * a "finished" gather leaving a trail of items on the ground. Best-effort
 * and bounded: closest-first, drops well above the bot (canopy) are skipped
 * so the pathfinder never climbs for them.
 *
 * 261012: each drop gets a second try with the walk ending IN the drop's own
 * cell. The first walk stops within one block, which can leave the bot a
 * layer above a drop lying in a hole it dug (the pickup box reaches only half
 * a block below the feet), so mine_stone gathers left cobblestone behind.
 * Whether a drop was collected is read from the world (the entity is gone),
 * not from the walk's result.
 */
async function sweepDrops(bot, goTo, signal, sleep = (ms) => new Promise(r => setTimeout(r, ms)), blockName) {
  const attempted = new Set()
  const deadline = Date.now() + SWEEP_BUDGET_MS
  const gone = (e) => e.isValid === false || (bot.entities && e.id != null && bot.entities[e.id] !== e)
  for (let i = 0; i < SWEEP_MAX; i++) {
    if (signal?.aborted || Date.now() > deadline) return
    // 261108 (pass 47): drops in the water are not worth the air.
    if (lowOnAir(bot)) { await surfaceForAir(bot, signal); return }
    const here = bot.entity?.position
    if (!here) return
    let best = null, bestD = Infinity
    for (const e of Object.values(bot.entities ?? {})) {
      if (!isItemEntity(e) || !e.position || e.isValid === false) continue
      if (attempted.has(e.id ?? e)) continue
      if (e.position.y > here.y + 2) continue // canopy drop — never climb for one item
      if (givenDropFor(bot, e)) continue // 261017: tossed to the player, theirs
      const d = e.position.distanceTo(here)
      if (d <= SWEEP_RADIUS && d < bestD) { bestD = d; best = e }
    }
    if (!best) return
    attempted.add(best.id ?? best)
    // No digging under a tree; a stone or ore drop may need a dig to get into
    // its hole. Never placing (dropWalkOpts).
    for (const range of [1, 0]) {
      if (signal?.aborted || Date.now() > deadline) return
      const p = best.position
      await goTo(bot, Math.floor(p.x), Math.floor(p.y + 0.1), Math.floor(p.z), range, SWEEP_WALK_MS, signal, dropWalkOpts(blockName))
      if (signal?.aborted) return
      // Give the collect a beat to register before rescanning, so a stack the
      // walk just absorbed doesn't get re-picked as the next target.
      await sleep(SWEEP_SETTLE_MS)
      if (gone(best)) break
    }
  }
}

/** Item names a block drops (minecraft-data), [] when unknown or none. */
export function dropItemsFor(bot, blockName) {
  let mcData
  try { mcData = mcDataLib(bot.version) } catch { return [] }
  const drops = mcData?.blocksByName?.[blockName]?.drops
  if (!Array.isArray(drops)) return []
  const names = new Set()
  for (const d of drops) {
    const id = typeof d === 'number' ? d : (d?.drop?.id ?? d?.drop)
    const n = typeof id === 'number' ? mcData.items?.[id]?.name : null
    if (n) names.add(n)
  }
  return [...names]
}

/**
 * Gather a batch of one block type from a name or coordinate anchor.
 *
 * Single registered-action token (FSM rule): returns ONE terminal Promise; the
 * outer loop watches `config.signal` between iterations while inner per-block
 * goTo + digAction each carry their own timeouts (CLAUDE.md "every external
 * call has a timeout").
 *
 * @param {{ name?:string, x?:number, y?:number, z?:number, maxDistance?:number, count?:number }} args
 * @param {import('mineflayer').Bot} bot
 * @param {{ signal?: AbortSignal, pathfinder_timeout_ms?: number, onProgress?: (p:{dug:number,total:number,items?:string[],before?:number})=>void }} [config]
 * @param {{ goTo?: typeof realGoTo, digAction?: typeof realDigAction, sleep?: (ms:number)=>Promise<void> }} [_deps]
 *        Optional dependency injection — used by unit tests to stub the
 *        per-block side effects. Defaults fall through to the real imports
 *        so the registry call site `(args, bot, config)` is unaffected.
 * @returns {Promise<string>}
 */
export async function gatherAction(args, bot, config, _deps) {
  const goTo = _deps?.goTo ?? realGoTo
  const digAction = _deps?.digAction ?? realDigAction

  const signal = config?.signal
  if (signal?.aborted) return 'aborted'

  const timeoutMs = config?.pathfinder_timeout_ms ?? 12000
  // How many to harvest this call. Default kept modest so a bare gather() is a
  // bounded batch, not a multi-minute solo grind that locks the loop and
  // silences the bot; the model raises it when it genuinely needs a stack.
  // Hard-capped at BATCH_CAP. (260618)
  const want = Math.max(1, Math.min(BATCH_CAP, Math.floor(Number(args?.count ?? 16)) || 16))
  // Per-block pathfinding is shorter than the whole-action budget: vein blocks
  // are adjacent, so a block that needs a long path usually isn't worth it —
  // cap the walk so one unreachable block can't burn the full 12s. (260618)
  const perBlockTimeoutMs = Math.min(timeoutMs, 6000)

  const coordMode = typeof args?.x === 'number' && typeof args?.y === 'number' && typeof args?.z === 'number'

  // Name-mode block matcher, resolved once. `matching` is either an array of
  // numeric block ids or a predicate, both accepted by bot.findBlocks.
  let matching = null
  let wideMatching = null
  let dropNote = ''
  if (!coordMode) {
    if (typeof args?.name !== 'string') return 'must specify name or x,y,z'
    // 261011: cobblestone is the DROP of stone. gather("cobblestone") used to
    // look for placed cobblestone blocks, which is usually a player's build.
    const sourceBlock = MINED_FROM[String(args.name).toLowerCase().trim()]
    if (sourceBlock) {
      dropNote = ` (${sourceBlock} drops ${String(args.name).toLowerCase().trim()})`
      args = { ...args, name: sourceBlock }
    }
    const ids = resolveTerm(args.name)
    let mcData
    try { mcData = mcDataLib(bot.version) } catch { mcData = null }
    if (mcData?.blocksByName) {
      const idNums = ids.map(n => mcData.blocksByName[n]?.id).filter(v => typeof v === 'number')
      matching = idNums.length ? idNums : ((b) => ids.includes(b?.name))
    } else {
      matching = (b) => ids.includes(b?.name)
    }
    if (Array.isArray(matching) && matching.length === 0) {
      return `no ${args.name} in loaded chunks`
    }
    // 261011: a loose term that is also a real block ID ("stone", "dirt",
    // "sand") looks for that exact block first and widens to the variants
    // only when none is in range. gather("stone") used to lock onto the
    // nearest diorite and report "gathered 1/12 diorite".
    const exact = String(args.name).toLowerCase().trim()
    const exactId = mcData?.blocksByName?.[exact]?.id
    if (ids.length > 1 && typeof exactId === 'number') {
      wideMatching = matching
      matching = [exactId]
    }
  }

  // Set once the anchor block is known (below); mineComponent reads them.
  let dropItems = []
  let got = () => 0
  // 261014: the drop items and how many of them she held at the start ride on
  // every progress tick, so the snapshot can say what she holds right now
  // instead of a count that lags one pickup behind.
  let progressExtra = {}
  const tick = () => { try { config?.onProgress?.({ dug: got(), total: want, ...progressExtra }) } catch {} }

  // Shared across re-anchor rounds: every position ever swept by a flood-fill
  // (dug or failed) stays in `visited`, so a component whose digs all failed
  // can never be re-anchored — that is the no-infinite-loop guarantee.
  const visited = new Set()
  const key = (x, y, z) => `${x},${y},${z}`
  let skippedUnreachable = 0

  // Resolve the next anchor: nearest matching block whose component we have
  // not already swept. findBlocks returns closest-first, so the first
  // unvisited hit is the nearest fresh component.
  function nextAnchor() {
    const origin = bot.entity?.position
    const point = origin && Number.isFinite(origin.x) ? origin : undefined
    // 261011: count was 8. Blocks a round gave up on (an unreachable top
    // log) stay solid and stay `visited`, so a few failed trees filled all 8
    // slots and the next tree over was never seen: "no more oak_log
    // reachable nearby" with logs in plain sight.
    const hits = bot.findBlocks({
      matching,
      maxDistance: args.maxDistance ?? 32,
      count: 64,
      point,
    })
    // 261108 (quality pass 47): the nearest block NOT under water first. A
    // river bed is often the nearest stone, and digging it means floating in
    // the water at a fraction of the speed until the air runs out (02-B
    // drowned that way). Under-water blocks only when nothing dry is in range.
    let wet = null
    for (const h of hits ?? []) {
      if (visited.has(key(h.x, h.y, h.z))) continue
      // 261015: blocks an earlier walk or dig could not reach (this call or
      // a recent one) are not worth a 6s walk again; take the next one.
      if (isUnreachable(bot, h)) { skippedUnreachable++; visited.add(key(h.x, h.y, h.z)); continue }
      if (isUnderwaterBlock(bot, h)) { wet ??= h; continue }
      return new Vec3(h.x, h.y, h.z)
    }
    return wet ? new Vec3(wet.x, wet.y, wet.z) : null
  }

  // Flood-fill the same-name component from `anchor`, up to `limit` blocks.
  // Marks everything it sweeps in `visited`.
  function sweepComponent(anchor, blockName, limit) {
    const stack = [anchor]
    /** @type {Array<{p: Vec3, done: boolean}>} */
    const positions = []
    const localSeen = new Set()
    while (stack.length && positions.length < limit) {
      const p = stack.pop()
      const pk = key(p.x, p.y, p.z)
      if (localSeen.has(pk) || visited.has(pk)) continue
      localSeen.add(pk)
      const blk = bot.blockAt(p)
      if (!blk || blk.name !== blockName) continue
      visited.add(pk)
      positions.push({ p, done: false })
      for (const [dx, dy, dz] of NEIGHBOR_OFFSETS) {
        const nx = p.x + dx, ny = p.y + dy, nz = p.z + dz
        const nk = key(nx, ny, nz)
        if (!localSeen.has(nk) && !visited.has(nk)) {
          stack.push(new Vec3(nx, ny, nz))
        }
      }
    }
    return positions
  }

  // Mine one component's positions, closest-remaining-first, abort-aware.
  // Returns 'aborted' or the number of successful digs.
  async function mineComponent(positions, blockName, progress) {
    let dug = 0
    // 260709: two CONSECUTIVE out-of-range digs mean the rest of this
    // component is a canopy/high-branch tail the pathfinder can't stand
    // under; positions are closest-first, so everything after is farther
    // still. Abandon the remainder instead of burning a 6s goTo timeout per
    // block (the visible symptom was minutes-long gathers that climbed trees).
    let outOfRangeRun = 0
    while (true) {
      if (signal?.aborted) return 'aborted'

      // 17-02: yield to a reflex creeper-flee that owns the goal (bot._seiReflexActive,
      // Plan 01 mutex). Pause the batch — non-destructively, the vein is not
      // cancelled — until the flee releases the goal, then resume mining the same
      // remaining blocks. (goTo below also yields internally; this stands the
      // whole batch down so we don't even pick/dig the next block mid-flee.)
      if (bot._seiReflexActive) {
        const w = await waitForReflexClear(bot, signal, timeoutMs)
        if (w === 'aborted') return 'aborted'
        // on 'timeout' fall through — re-check abort and retry the block next loop
      }

      // 261108 (quality pass 47): low on air under water: stop, swim up and
      // let the air come back before the next block (air.js).
      if (lowOnAir(bot)) {
        const s = await surfaceForAir(bot, signal)
        if (s === 'aborted' || signal?.aborted) return 'aborted'
        progress.airBreaks++
        if (progress.airBreaks >= MAX_AIR_BREAKS) return dug
      }

      const bp = bot.entity?.position
      let nextEntry = null
      let bestD = Infinity
      // Dry blocks before under-water ones (see nextAnchor).
      let nextWet = null
      let bestWetD = Infinity
      for (const entry of positions) {
        if (entry.done) continue
        const dx = bp ? entry.p.x - bp.x : 0
        const dy = bp ? entry.p.y - bp.y : 0
        const dz = bp ? entry.p.z - bp.z : 0
        const d = bp ? Math.hypot(dx, dy, dz) : 0
        if (entry.wet ??= isUnderwaterBlock(bot, entry.p)) {
          if (d < bestWetD) { bestWetD = d; nextWet = entry }
        } else if (d < bestD) { bestD = d; nextEntry = entry }
      }
      nextEntry ??= nextWet
      if (!nextEntry) return dug
      // Enough already reached the inventory (a block can drop several).
      if (got() >= want) return dug

      const np = nextEntry.p
      // Skip the pathfind when the block is already within dig reach — the common
      // case in a contiguous vein, where the previous swing left us adjacent. Only
      // walk when it's genuinely out of reach. 260709: measured from the EYES
      // (dig reach is eye-anchored), so the upper trunk logs of a tree are dug
      // from the ground instead of sending the pathfinder on a climb. 261011:
      // the same metric dig.js checks (eyes to block center), and the walk
      // aims for dig reach rather than "feet within 3", which for a high log
      // meant climbing.
      let walk = null
      if (digReachDistance(bot, np) > DIG_REACH) {
        // Pre-pathfind to dig reach (Pitfall 2 — dig.js does NOT pathfind in).
        // 261012: never scaffold with what we are gathering.
        walk = await goTo(bot, np.x, np.y, np.z, 3, perBlockTimeoutMs, signal, { reach: DIG_REACH - 0.3, ...(dropItems.length ? { keepItems: dropItems } : {}) })
      }

      if (signal?.aborted) return 'aborted'

      let r = await digAction({ x: np.x, y: np.y, z: np.z }, bot, config)
      if (typeof r === 'string' && (r.startsWith('busy ') || /^dig failed: digging aborted/i.test(r))) {
        // Another dig was still finishing (dig.js cancels a walk's leftover
        // dig, so this is rare); give it a moment and try the block once more
        // instead of writing off the rest of the tree. 261012: the same for a
        // dig the ending walk's pathfinder cancelled under us ("Digging
        // aborted", twice per mine_stone trial).
        await (_deps?.sleep ?? ((ms) => new Promise((res) => setTimeout(res, ms))))(400)
        if (signal?.aborted) return 'aborted'
        r = await digAction({ x: np.x, y: np.y, z: np.z }, bot, config)
      }
      if (r === 'aborted') return 'aborted'
      // 261108 (pass 47): the dig stopped to swim up for air.
      if (typeof r === 'string' && r.startsWith(AIR_STOP_PREFIX)) {
        nextEntry.done = true
        progress.airBreaks++
        tick()
        if (progress.airBreaks >= MAX_AIR_BREAKS) return dug
        continue
      }
      // 261107 (pass 45): the walk said "reached" but stopped a step or two
      // short (at the edge of its goal): one more short walk before calling
      // the block unreachable. Not after a failed walk.
      if (typeof r === 'string' && r.startsWith('out of range') && walk === 'reached') {
        const step = await closeInForDig(bot, np, goTo, signal, dropItems.length ? { keepItems: dropItems } : {})
        if (step === 'aborted' || signal?.aborted) return 'aborted'
        if (step != null) {
          r = await digAction({ x: np.x, y: np.y, z: np.z }, bot, config)
          if (r === 'aborted') return 'aborted'
        }
      }
      if (typeof r === 'string' && r.startsWith('dug ')) {
        dug++
        progress.dug++
        outOfRangeRun = 0
        // 261012: the block broke but cannot drop anything with the tools we
        // own. Breaking more of it gets nothing either; stop and say so.
        if (r.includes('(no drop')) {
          progress.noHarvest = true
          nextEntry.done = true
          return dug
        }
      } else if (typeof r === 'string' && r.startsWith('out of range')) {
        // The walk above ran and still could not get in reach: remember the
        // block, so the next gather or find does not walk at it again.
        noteUnreachable(bot, np, 'out of reach')
        outOfRangeRun++
        if (outOfRangeRun >= 2) {
          // Unreachable tail — mark the whole remainder done and move on to
          // the next component (or finish). Only out-of-range counts here: a
          // slow dig ('timeout') or a stale block is not a reachability signal.
          for (const entry of positions) entry.done = true
          nextEntry.done = true
          tick()
          return dug
        }
      } else {
        outOfRangeRun = 0
      }
      // Whether success, out-of-range, timeout, no-block, or target-changed:
      // mark done and continue. Failures are surfaced only via aggregate K<W.
      nextEntry.done = true
      // 260513-wkd: push progress tick after each entry is marked done so the
      // snapshot's `in_flight: gather(...) — K/W` line tracks the batch in real
      // time. Same onProgress channel as cuboid build/dig.
      tick()
    }
  }

  // Resolve the first anchor (and, coord-mode, the only one).
  let anchor
  if (coordMode) {
    anchor = new Vec3(args.x, args.y, args.z)
  } else {
    anchor = nextAnchor()
    if (!anchor && wideMatching) {
      matching = wideMatching
      anchor = nextAnchor()
    }
    if (!anchor && skippedUnreachable) {
      return `gathered 0/${want} ${args.name}: every ${args.name} nearby (${skippedUnreachable}) is one you could not reach in the last few minutes. Explore to find others, or build or dig your way to one`
    }
    if (!anchor) return `no ${args.name} in loaded chunks`
  }
  const seedBlk = bot.blockAt(anchor)
  if (!seedBlk || seedBlk.name === 'air' || seedBlk.name === 'cave_air' || seedBlk.name === 'void_air') {
    return 'no block at anchor'
  }
  const blockName = seedBlk.name

  // 261012: count what reaches the INVENTORY, not blocks broken. The
  // mine_stone eval reported "gathered 10/10 stone" with 7 to 9 cobblestone
  // delivered: drops left in the trench, buried by the walk's dirt, or never
  // reached. `got()` is the inventory gain in the items this block drops
  // (stone -> cobblestone, iron_ore -> raw_iron, oak_log -> oak_log); the
  // batch keeps mining until that reaches the request. Blocks whose drops are
  // unknown or empty (or a bot without an inventory) fall back to counting
  // digs.
  const progress = { dug: 0, noHarvest: false, airBreaks: 0 }
  const invBefore = inventoryCounts(bot)
  dropItems = invBefore ? dropItemsFor(bot, blockName) : []
  const countItems = dropItems.length > 0
  got = () => {
    if (!countItems) return progress.dug
    const now = inventoryCounts(bot)
    let n = 0
    for (const name of dropItems) n += Math.max(0, (now?.get(name) ?? 0) - (invBefore.get(name) ?? 0))
    return n
  }
  if (countItems) {
    let before = 0
    for (const name of dropItems) before += invBefore.get(name) ?? 0
    progressExtra = { items: dropItems.slice(), before }
  }
  // 260513-wkd: emit an initial 0/W progress tick the moment the batch is
  // known so the next snapshot's `in_flight:` line shows `dug 0/W` instead of
  // running progress-less for the first dig.
  tick()

  // What the result calls the haul: the dropped item when it differs from the
  // block ("cobblestone (mined from stone)").
  const label = countItems && dropItems.length === 1 && dropItems[0] !== blockName
    ? `${dropItems[0]} (mined from ${blockName})`
    : blockName
  const digCap = countItems ? want + extraDigs(want) : want
  const abortedMsg = () => `aborted after ${got()}/${want} ${label}`

  // 261011: keep going until `want` blocks are actually DUG (or nothing fresh
  // is left), not until `want` blocks were attempted. A round whose top logs
  // were out of reach used to count them against the request, so
  // gather(oak_log, 8) stopped after two trees with 5/8. The `visited` set
  // still guarantees termination: every round sweeps at least one new block.
  let attempted = 0
  let exhausted = false
  let firstRound = true
  for (let cycle = 0; cycle < MAX_CYCLES; cycle++) {
    // The first pass digs at most `want` blocks: drops still falling or not
    // yet walked over would otherwise read as lost and pull extra digs (a
    // gather of 8 logs came back with 13). Only a sweep that leaves the batch
    // short opens the extra digs, up to digCap.
    const cycleCap = cycle === 0 ? Math.min(want, digCap) : digCap
    while (got() < want && progress.dug < cycleCap && !progress.noHarvest && progress.airBreaks < MAX_AIR_BREAKS) {
      let roundAnchor
      if (firstRound) {
        firstRound = false
        roundAnchor = anchor
      } else if (coordMode) {
        // Explicit x,y,z means "this vein here" — never wander to another one.
        break
      } else {
        roundAnchor = nextAnchor()
        if (!roundAnchor) { exhausted = true; break }
        const blk = bot.blockAt(roundAnchor)
        if (!blk || blk.name !== blockName) {
          // Different matching block (e.g. loose term spans oak_log + birch_log):
          // mark and skip; keep the batch to one block type per call.
          visited.add(key(roundAnchor.x, roundAnchor.y, roundAnchor.z))
          continue
        }
      }

      const limit = Math.max(1, Math.min(want - got(), cycleCap - progress.dug))
      const positions = sweepComponent(roundAnchor, blockName, limit)
      if (positions.length === 0) {
        // Anchor swept to nothing (already visited / name changed under us).
        visited.add(key(roundAnchor.x, roundAnchor.y, roundAnchor.z))
        continue
      }
      attempted += positions.length

      const r = await mineComponent(positions, blockName, progress)
      if (r === 'aborted') return abortedMsg()
    }

    // Collect what the digs dropped before reporting done (skipped when
    // nothing was dug — no drops of ours to chase, and a failed gather should
    // not stall).
    if (progress.dug > 0 && !progress.noHarvest) {
      await sweepDrops(bot, goTo, signal, _deps?.sleep, blockName)
      if (signal?.aborted) return abortedMsg()
    }
    // Still short after the sweep: lost drops. Mine more if there is more to
    // mine and dig budget left; otherwise report what actually arrived.
    if (got() >= want || exhausted || coordMode || progress.noHarvest || progress.dug >= digCap || progress.airBreaks >= MAX_AIR_BREAKS) break
  }

  const have = got()
  let note = ''
  if (progress.noHarvest) {
    note = ` (stopped: ${blockName} drops nothing unless you hold the right tool, and you have none that can harvest it. Craft the right pickaxe first)`
  } else if (exhausted && have < want) {
    note = skippedUnreachable
      ? ` (no more ${blockName} reachable nearby; skipped ${skippedUnreachable} you could not reach recently)`
      : ` (no more ${blockName} reachable nearby)`
  } else if (progress.airBreaks >= MAX_AIR_BREAKS && have < want) {
    note = ` (stopped: you ran low on air under water ${progress.airBreaks} times and swam up each time; the ${blockName} left here is under water. Gather somewhere dry)`
  } else if (progress.airBreaks > 0) {
    note = ' (you swam up for air on the way)'
  } else if (coordMode && attempted < want && have < want) {
    note = ` (that vein had only ${attempted})`
  }
  // 261012: say where the rest went when blocks broke but fewer drops
  // arrived. Never report a count that did not reach the inventory.
  let lostNote = ''
  if (countItems && progress.dug > have && have < want && !progress.noHarvest) {
    // Drops of ours still lying nearby (an item whose name has not decoded
    // may be one of them, so it counts).
    let left = 0
    for (const e of Object.values(bot.entities ?? {})) {
      if (!isItemEntity(e) || e.isValid === false || !e.position || !bot.entity?.position) continue
      if (e.position.distanceTo(bot.entity.position) > SWEEP_RADIUS) continue
      const it = droppedItemName(e)
      if (!it) left++
      else if (dropItems.includes(it.name)) left += it.count
    }
    lostNote = ` (broke ${progress.dug} ${blockName}, but ${have ? `only ${have}` : 'none'} reached your inventory${left ? `; about ${left} ${left === 1 ? 'is' : 'are'} still on the ground nearby, pickup collects them` : ''})`
  }
  // 261011: the count is blocks broken, not items collected. Quality eval
  // 2026-10-11-pass1 (building): three coal gathers reported 4/4, 4/4 and
  // 5/5 while her coal count never moved, and she told the player she had
  // coal. Say so when nothing new reached the inventory (dig-count mode).
  let pickNote = ''
  if (!countItems && progress.dug > 0 && invBefore) {
    if (gained(invBefore, inventoryCounts(bot)).length === 0) {
      pickNote = ' but nothing new reached your inventory (the drops may still be on the ground; pickup collects them)'
    }
  }
  return `gathered ${have}/${want} ${label}${note}${lostNote}${countItems ? '' : dropNote}${pickNote}`
}
