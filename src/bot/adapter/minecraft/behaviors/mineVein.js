// src/bot/adapter/minecraft/behaviors/mineVein.js — `gather` action.
//
// `gather` is a dig-wrapper for "harvest N of a block" tasks where the exact
// location of each mined block doesn't matter. It resolves a name (loose term
// OR exact MC ID) or a raw coordinate to an anchor block, flood-fills a
// connected component (6-neighbor, same exact ID only, cap 64) for tree/ore
// shapes, pre-pathfinds to each member (Pitfall 2 — dig.js does NOT pathfind
// into reach), and delegates the swing to digAction. The whole batch consumes
// ONE LLM iteration (big saving under the 20-iteration cap).
//
// Result-string contract:
//   - 'aborted'                                     — signal already aborted at entry
//   - `aborted after K/N <name>`                    — owner-chat preempt mid-batch
//   - `gathered K/N <name>`                         — completed (K may be < N if some
//                                                     individual digs failed)
//   - `gathered K/N <name> (cap reached)`           — flood-fill saturated at BATCH_CAP
//   - `no <term> in loaded chunks`                  — name resolved to nothing
//   - `no block at anchor`                          — anchor coord is air/null
//   - 'must specify name or x,y,z'                  — defensive (registry refine should catch)
//
// GATHER_DESCRIPTION is colocated here and mirrored into orchestrator.js
// ACTION_DESCRIPTIONS (drift-discipline pattern from dig.js L10-20).

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
 * LLM-facing description (mirrored verbatim into orchestrator.js
 * ACTION_DESCRIPTIONS.gather). Keep this string in sync with the orchestrator
 * mirror — dig.js / DIG_DESCRIPTION sets the precedent.
 */
export const GATHER_DESCRIPTION = "Gather a batch of one block type in a single call — use when you want N of some block and don't care which specific instances. Pass `{name:\"<term>\"}` — loose terms (`wood`, `ore`, `stone`, `dirt`, `sand`, `log`, `planks`, `leaves`) expand server-side to the right MC block IDs; you can also pass an exact ID like `oak_log` or `cactus`. Or pass `{x,y,z}` of a known anchor block (from a `nearby blocks` `#N` handle or a prior `find()` result — never invent coords). The bot finds the nearest matching block, then sweeps any same-name neighbors face-adjacent to it (so trees and ore deposits chop together) up to a 64-block batch cap. Returns `gathered K/N <name>` on success, `gathered K/N <name> (cap reached)` when the connected batch exceeds 64 blocks, `aborted after K/N <name>` on owner-chat preempt, `no <name> in loaded chunks` when nothing matches, or `no block at anchor` when the coord is empty/air."

/**
 * Gather a batch of one block type from a name or coordinate anchor.
 *
 * Single registered-action token (FSM rule): returns ONE terminal Promise; the
 * outer loop watches `config.signal` between iterations while inner per-block
 * goTo + digAction each carry their own timeouts (CLAUDE.md "every external
 * call has a timeout").
 *
 * @param {{ name?:string, x?:number, y?:number, z?:number, maxDistance?:number }} args
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
  while (stack.length && positions.length < BATCH_CAP) {
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
    // Pre-pathfind to dig reach (Pitfall 2 — dig.js returns 'out of range'
    // beyond 4.5m; range:3 keeps us well inside).
    await goTo(bot, np.x, np.y, np.z, 3, timeoutMs)

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
  }

  const capNote = total >= BATCH_CAP ? ' (cap reached)' : ''
  return `gathered ${dug}/${total} ${blockName}${capNote}`
}
