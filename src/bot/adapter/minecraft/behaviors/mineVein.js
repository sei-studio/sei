// src/bot/adapter/minecraft/behaviors/mineVein.js — `gather` action.
//
// `gather` is a dig-wrapper for "harvest N of a block" tasks where the exact
// location of each mined block doesn't matter. It resolves a name (loose term
// OR exact MC ID) or a raw coordinate to an anchor block, flood-fills a
// connected component (6-neighbor, same exact ID only, up to `count` blocks —
// default 16, hard cap 64) for tree/ore shapes, walks into reach only when the
// block isn't already adjacent, and delegates the swing to digAction. The whole
// batch consumes ONE LLM iteration (big saving under the iteration cap).
//
// Result-string contract:
//   - 'aborted'                                     — signal already aborted at entry
//   - `aborted after K/N <name>`                    — player-chat preempt mid-batch
//   - `gathered K/N <name>`                         — completed (K may be < N if some
//                                                     individual digs failed)
//   - `gathered K/N <name> (cap reached)`           — flood-fill saturated at BATCH_CAP
//   - `no <term> in loaded chunks`                  — name resolved to nothing
//   - `no block at anchor`                          — anchor coord is air/null
//   - 'must specify name or x,y,z'                  — defensive (registry refine should catch)
//
// LLM-facing tool description moved to ../prompts.js → ACTION_DESCRIPTIONS.gather.

import { Vec3 } from 'vec3'
import mcDataLib from 'minecraft-data'
import { resolveTerm } from '../loose-terms.js'
import { goTo as realGoTo } from './pathfind.js'
import { digAction as realDigAction } from './dig.js'

const NEIGHBOR_OFFSETS = [
  [1, 0, 0], [-1, 0, 0],
  [0, 1, 0], [0, -1, 0],
  [0, 0, 1], [0, 0, -1],
]
const BATCH_CAP = 64

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
 * @param {{ signal?: AbortSignal, pathfinder_timeout_ms?: number }} [config]
 * @param {{ goTo?: typeof realGoTo, digAction?: typeof realDigAction }} [_deps]
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
  // ~30s batch, not a multi-minute solo grind that locks the loop and silences
  // the bot; the model raises it when it genuinely needs a stack. Hard-capped
  // at BATCH_CAP. (260618)
  const want = Math.max(1, Math.min(BATCH_CAP, Math.floor(Number(args?.count ?? 16)) || 16))
  // Per-block pathfinding is shorter than the whole-action budget: vein blocks
  // are adjacent, so a block that needs a long path usually isn't worth it —
  // cap the walk so one unreachable block can't burn the full 12s. (260618)
  const perBlockTimeoutMs = Math.min(timeoutMs, 6000)

  // 1. Resolve anchor.
  let anchor
  if (typeof args?.x === 'number' && typeof args?.y === 'number' && typeof args?.z === 'number') {
    anchor = new Vec3(args.x, args.y, args.z)
  } else if (typeof args?.name === 'string') {
    const ids = resolveTerm(args.name)
    let mcData
    try { mcData = mcDataLib(bot.version) } catch { mcData = null }
    let matching
    if (mcData?.blocksByName) {
      const idNums = ids.map(n => mcData.blocksByName[n]?.id).filter(v => typeof v === 'number')
      matching = idNums.length ? idNums : ((b) => ids.includes(b?.name))
    } else {
      matching = (b) => ids.includes(b?.name)
    }
    if (Array.isArray(matching) && matching.length === 0) {
      return `no ${args.name} in loaded chunks`
    }
    const origin = bot.entity?.position
    const point = origin && Number.isFinite(origin.x) ? origin : undefined
    const hits = bot.findBlocks({
      matching,
      maxDistance: args.maxDistance ?? 32,
      count: 1,
      point,
    })
    if (!hits || !hits.length) return `no ${args.name} in loaded chunks`
    const h = hits[0]
    anchor = new Vec3(h.x, h.y, h.z)
  } else {
    return 'must specify name or x,y,z'
  }

  // 2. Verify anchor + sweep same-name face-adjacent neighbors (cap BATCH_CAP).
  const seedBlk = bot.blockAt(anchor)
  if (!seedBlk || seedBlk.name === 'air' || seedBlk.name === 'cave_air' || seedBlk.name === 'void_air') {
    return 'no block at anchor'
  }
  const blockName = seedBlk.name

  const visited = new Set()
  const key = (x, y, z) => `${x},${y},${z}`
  const stack = [anchor]
  /** @type {Array<{p: Vec3, done: boolean}>} */
  const positions = []
  while (stack.length && positions.length < want) {
    const p = stack.pop()
    const pk = key(p.x, p.y, p.z)
    if (visited.has(pk)) continue
    visited.add(pk)
    const blk = bot.blockAt(p)
    if (!blk || blk.name !== blockName) continue
    positions.push({ p, done: false })
    for (const [dx, dy, dz] of NEIGHBOR_OFFSETS) {
      const nx = p.x + dx, ny = p.y + dy, nz = p.z + dz
      if (!visited.has(key(nx, ny, nz))) {
        stack.push(new Vec3(nx, ny, nz))
      }
    }
  }

  // 3. Mine block-by-block, closest-remaining-first, abort-aware.
  let dug = 0
  const total = positions.length
  // 260513-wkd: emit an initial 0/N progress tick the moment the batch is
  // known so the next snapshot's `in_flight:` line shows `dug 0/N` instead of
  // running progress-less for the first dig. Same onProgress channel as
  // cuboid build/dig — no new config field invented.
  try { config?.onProgress?.({ dug, total }) } catch {}
  while (true) {
    if (signal?.aborted) return `aborted after ${dug}/${total} ${blockName}`

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
    if (!nextEntry) break

    const np = nextEntry.p
    // Skip the pathfind when the block is already within dig reach — the common
    // case in a contiguous vein, where the previous swing left us adjacent. Only
    // walk when it's genuinely out of reach (dig.js wants ≤4.5m; 3.2 keeps a
    // safe margin). This is the bulk of the gather speed-up. (260618)
    const here = bot.entity?.position
    const reachD = here ? Math.hypot(np.x - here.x, np.y - here.y, np.z - here.z) : Infinity
    if (reachD > 3.2) {
      // Pre-pathfind to dig reach (Pitfall 2 — dig.js does NOT pathfind in).
      await goTo(bot, np.x, np.y, np.z, 3, perBlockTimeoutMs)
    }

    if (signal?.aborted) return `aborted after ${dug}/${total} ${blockName}`

    const r = await digAction({ x: np.x, y: np.y, z: np.z }, bot, config)
    if (r === 'aborted') {
      return `aborted after ${dug}/${total} ${blockName}`
    }
    if (typeof r === 'string' && r.startsWith('dug ')) {
      dug++
    }
    // Whether success, out-of-range, timeout, no-block, or target-changed:
    // mark done and continue. Failures are surfaced only via aggregate K<N.
    nextEntry.done = true
    // 260513-wkd: push progress tick after each entry is marked done so the
    // snapshot's `in_flight: gather(...) — K/N` line tracks the batch in real
    // time. Same onProgress channel as cuboid build/dig.
    try { config?.onProgress?.({ dug, total }) } catch {}
  }

  // "cap reached" = the flood-fill stopped at `count` with more of the same
  // block still queued (there's more to get if asked again).
  const capNote = (positions.length >= want && stack.length > 0) ? ' (cap reached)' : ''
  return `gathered ${dug}/${total} ${blockName}${capNote}`
}
