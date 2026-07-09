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
import { goTo as realGoTo, waitForReflexClear } from './pathfind.js'
import { digAction as realDigAction } from './dig.js'

const NEIGHBOR_OFFSETS = [
  [1, 0, 0], [-1, 0, 0],
  [0, 1, 0], [0, -1, 0],
  [0, 0, 1], [0, 0, -1],
]
const BATCH_CAP = 64

// End-of-gather drop sweep bounds (260709). Radius covers the trees just
// mined; the walk budget per drop is short because a resting item is almost
// always on open ground a few blocks away.
const SWEEP_RADIUS = 12
const SWEEP_MAX = 8
const SWEEP_WALK_MS = 3000
const SWEEP_SETTLE_MS = 250

function isItemEntity(e) {
  return !!e && (e.name === 'item' || e.objectType === 'Item' || e.displayName === 'Item')
}

/**
 * Walk to nearby dropped items so mineflayer's auto-pickup collects them.
 * The per-dig pickup walk (dig.js) catches the common case, but drops that
 * bounce off the trunk, land somewhere else, or spawn later from decaying
 * leaves (saplings, sticks, apples) were left behind — the live symptom was
 * a "finished" gather leaving a trail of items on the ground. Best-effort
 * and bounded: closest-first, each drop attempted once, drops well above
 * the bot (canopy) are skipped so the pathfinder never climbs for them.
 */
async function sweepDrops(bot, goTo, signal, sleep = (ms) => new Promise(r => setTimeout(r, ms))) {
  const attempted = new Set()
  for (let i = 0; i < SWEEP_MAX; i++) {
    if (signal?.aborted) return
    const here = bot.entity?.position
    if (!here) return
    let best = null, bestD = Infinity
    for (const e of Object.values(bot.entities ?? {})) {
      if (!isItemEntity(e) || !e.position || e.isValid === false) continue
      if (attempted.has(e.id ?? e)) continue
      if (e.position.y > here.y + 2) continue // canopy drop — never climb for one item
      const d = e.position.distanceTo(here)
      if (d <= SWEEP_RADIUS && d < bestD) { bestD = d; best = e }
    }
    if (!best) return
    attempted.add(best.id ?? best)
    await goTo(bot, Math.floor(best.position.x), Math.floor(best.position.y), Math.floor(best.position.z), 0, SWEEP_WALK_MS, signal)
    if (signal?.aborted) return
    // Give the collect a beat to register before rescanning, so a stack the
    // walk just absorbed doesn't get re-picked as the next target.
    await sleep(SWEEP_SETTLE_MS)
  }
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
 * @param {{ signal?: AbortSignal, pathfinder_timeout_ms?: number, onProgress?: (p:{dug:number,total:number})=>void }} [config]
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
  if (!coordMode) {
    if (typeof args?.name !== 'string') return 'must specify name or x,y,z'
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
  }

  // Shared across re-anchor rounds: every position ever swept by a flood-fill
  // (dug or failed) stays in `visited`, so a component whose digs all failed
  // can never be re-anchored — that is the no-infinite-loop guarantee.
  const visited = new Set()
  const key = (x, y, z) => `${x},${y},${z}`

  // Resolve the next anchor: nearest matching block whose component we have
  // not already swept. findBlocks returns closest-first, so the first
  // unvisited hit is the nearest fresh component.
  function nextAnchor() {
    const origin = bot.entity?.position
    const point = origin && Number.isFinite(origin.x) ? origin : undefined
    const hits = bot.findBlocks({
      matching,
      maxDistance: args.maxDistance ?? 32,
      count: 8,
      point,
    })
    for (const h of hits ?? []) {
      if (!visited.has(key(h.x, h.y, h.z))) return new Vec3(h.x, h.y, h.z)
    }
    return null
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

      const bp = bot.entity?.position
      let nextEntry = null
      let bestD = Infinity
      for (const entry of positions) {
        if (entry.done) continue
        const dx = bp ? entry.p.x - bp.x : 0
        const dy = bp ? entry.p.y - bp.y : 0
        const dz = bp ? entry.p.z - bp.z : 0
        const d = bp ? Math.hypot(dx, dy, dz) : 0
        if (d < bestD) { bestD = d; nextEntry = entry }
      }
      if (!nextEntry) return dug

      const np = nextEntry.p
      // Skip the pathfind when the block is already within dig reach — the common
      // case in a contiguous vein, where the previous swing left us adjacent. Only
      // walk when it's genuinely out of reach. 260709: measured from the EYES
      // (dig reach is eye-anchored), threshold just under dig.js's 4.5 — so the
      // upper trunk logs of a tree are dug from the ground instead of sending
      // the pathfinder on a climb to "get closer" to a block 4 up.
      const here = bot.entity?.position
      const eyeY = here ? here.y + (Number.isFinite(bot.entity?.eyeHeight) ? bot.entity.eyeHeight : 1.62) : 0
      const reachD = here ? Math.hypot(np.x - here.x, np.y - eyeY, np.z - here.z) : Infinity
      if (reachD > 4.2) {
        // Pre-pathfind to dig reach (Pitfall 2 — dig.js does NOT pathfind in).
        await goTo(bot, np.x, np.y, np.z, 3, perBlockTimeoutMs)
      }

      if (signal?.aborted) return 'aborted'

      const r = await digAction({ x: np.x, y: np.y, z: np.z }, bot, config)
      if (r === 'aborted') return 'aborted'
      if (typeof r === 'string' && r.startsWith('dug ')) {
        dug++
        progress.dug++
        outOfRangeRun = 0
      } else if (typeof r === 'string' && r.startsWith('out of range')) {
        outOfRangeRun++
        if (outOfRangeRun >= 2) {
          // Unreachable tail — mark the whole remainder done and move on to
          // the next component (or finish). Only out-of-range counts here: a
          // slow dig ('timeout') or a stale block is not a reachability signal.
          for (const entry of positions) entry.done = true
          nextEntry.done = true
          try { config?.onProgress?.({ dug: progress.dug, total: want }) } catch {}
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
      try { config?.onProgress?.({ dug: progress.dug, total: want }) } catch {}
    }
  }

  // Resolve the first anchor (and, coord-mode, the only one).
  let anchor
  if (coordMode) {
    anchor = new Vec3(args.x, args.y, args.z)
  } else {
    anchor = nextAnchor()
    if (!anchor) return `no ${args.name} in loaded chunks`
  }
  const seedBlk = bot.blockAt(anchor)
  if (!seedBlk || seedBlk.name === 'air' || seedBlk.name === 'cave_air' || seedBlk.name === 'void_air') {
    return 'no block at anchor'
  }
  const blockName = seedBlk.name

  // 260513-wkd: emit an initial 0/W progress tick the moment the batch is
  // known so the next snapshot's `in_flight:` line shows `dug 0/W` instead of
  // running progress-less for the first dig.
  const progress = { dug: 0 }
  try { config?.onProgress?.({ dug: 0, total: want }) } catch {}

  let attempted = 0
  let exhausted = false
  let firstRound = true
  while (attempted < want) {
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

    const positions = sweepComponent(roundAnchor, blockName, want - attempted)
    if (positions.length === 0) {
      // Anchor swept to nothing (already visited / name changed under us).
      visited.add(key(roundAnchor.x, roundAnchor.y, roundAnchor.z))
      continue
    }
    attempted += positions.length

    const r = await mineComponent(positions, blockName, progress)
    if (r === 'aborted') return `aborted after ${progress.dug}/${want} ${blockName}`
  }

  // Collect what the digs dropped before reporting done (skipped when nothing
  // was dug — no drops of ours to chase, and a failed gather should not stall).
  if (progress.dug > 0) {
    await sweepDrops(bot, goTo, signal, _deps?.sleep)
    if (signal?.aborted) return `aborted after ${progress.dug}/${want} ${blockName}`
  }

  let note = ''
  if (exhausted && progress.dug < want) {
    note = ` (no more ${blockName} reachable nearby)`
  } else if (coordMode && attempted < want) {
    note = ` (that vein had only ${attempted})`
  }
  return `gathered ${progress.dug}/${want} ${blockName}${note}`
}
