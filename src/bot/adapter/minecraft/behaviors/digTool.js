// src/bot/adapter/minecraft/behaviors/digTool.js
//
// 261025 (quality pass 27): the `dig` TOOL the model calls. digAction (dig.js)
// stays the raw single-block dig that gather and cuboid digs call after their
// own walk; this wrapper is what a model-issued dig adds on top of it.
//
// Free-play evidence from the 2026-10-23..25 eval runs:
//  - 33 of 105 dig({block}) calls came back "out of range" (median 6.8m). The
//    tool offers `{block}` as "the nearest of that type" with a 32m search, but
//    it never walked, so the model had to goTo and dig again. A goTo with
//    `range` measures the feet, so the second dig was often still out of range
//    ("out of range (5.1m)" right after goTo "reached"), and the judge marked
//    both calls broken. The dig now walks into reach first, the way gather
//    does (eyes to block, GoalDigReach).
//  - A successful dig said only "dug stone". She could not tell whether the
//    cobblestone reached her bag, so she followed digs with pickup() calls
//    that answered "no cobblestone on the ground; you already have 5". The
//    result now says what reached the inventory, or where the drop still lies.
import { Vec3 } from 'vec3'
import mcDataLib from 'minecraft-data'
import { digAction as realDigAction, digReachDistance, DIG_REACH } from './dig.js'
import { goTo as realGoTo, dropWalkOpts } from './pathfind.js'
import { isUnreachable, noteUnreachable, isUnreachableResult } from './unreachable.js'
import { inventoryCounts } from './pickup.js'
import { dropItemsFor } from './mineVein.js'
import { droppedItemName } from '../observers/entities.js'
import { resolveBlock, isStaleHandle } from '../observers/targeting.js'
import { resolveTerm } from '../loose-terms.js'

// An out-of-range dig only says something about the block when she ended up
// within this distance of it (the rule registry.js and unreachable.js keep).
export const UNREACHABLE_NEAR_M = 8
// A dig out of range with the block within this horizontal distance means she
// stands under it: walking closer would not have helped.
const DIG_UNDER_H = 2
// pathfind's vertical hint, which the dig result can carry as well.
const VERTICAL_HINT = / — unreachable — try build to Y=-?\d+(\.\d+)?/
// Name lookups look at this many hits, nearest first, so blocks she could not
// reach a moment ago can be skipped.
const NAME_CANDIDATES = 24
// After the dig: how long to wait for the drop to land in the bag, and how far
// to look for it on the ground when it did not.
const DROP_WAIT_MS = 1000
const DROP_POLL_MS = 100
const DROP_LOOK_M = 6
const DROP_WALK_MS = 3000

function isItemEntity(e) {
  return !!e && (e.name === 'item' || e.name === 'item_stack' || e.displayName === 'Item')
}

/** Ids of the item entities lying around right now. */
function itemIdsNow(bot) {
  const ids = new Set()
  for (const e of Object.values(bot.entities ?? {})) if (isItemEntity(e)) ids.add(e.id)
  return ids
}

/**
 * Whether an out-of-range dig after `walk` means the block cannot be reached
 * from here, so find, gather and name digs should skip it for a while.
 * 261025 review: only when she ended up near it, and only when the walk said
 * so. A timed-out walk says nothing about the block, and a walk that ended
 * for its own reason (stuck in a hole, aborted) is about her, not the block.
 */
function shouldMarkUnreachable(bot, pos, walk) {
  const p = bot.entity?.position
  if (!p) return false
  if (digReachDistance(bot, pos) > UNREACHABLE_NEAR_M) return false
  if (walk == null) {
    // No walk ran: she stands under it, or it is more than 2 above her feet.
    const horiz = Math.hypot(pos.x + 0.5 - p.x, pos.z + 0.5 - p.z)
    return horiz <= DIG_UNDER_H || pos.y > Math.floor(p.y + 0.01) + 2
  }
  const w = String(walk)
  if (w === 'reached') return true
  return isUnreachableResult(w) && !w.startsWith('timeout')
}

function blockIdsFor(bot, name) {
  let mcData
  try { mcData = mcDataLib(bot.version) } catch { mcData = null }
  const exact = mcData?.blocksByName?.[name]?.id
  if (typeof exact === 'number') return [exact]
  // A loose term ("log", "iron") the way gather reads it.
  const ids = resolveTerm(name).map((n) => mcData?.blocksByName?.[n]?.id).filter((v) => typeof v === 'number')
  return ids
}

/**
 * The block a name asks for: the nearest one she has not just failed to
 * reach. Returns { block } or { reason } when there is none to dig.
 */
function findNamedBlock(bot, name, maxDistance) {
  const ids = blockIdsFor(bot, name)
  const origin = bot.entity?.position
  const point = origin && Number.isFinite(origin.x) ? origin : undefined
  let hits = []
  if (typeof bot.findBlocks === 'function') {
    try {
      hits = bot.findBlocks({
        matching: ids.length ? ids : (b) => b?.name === name,
        maxDistance,
        count: NAME_CANDIDATES,
        point,
      }) ?? []
    } catch { hits = [] }
  } else if (typeof bot.findBlock === 'function') {
    const b = bot.findBlock({ matching: ids.length ? ids : (x) => x?.name === name, maxDistance })
    return b ? { block: b } : { reason: `no ${name} within ${maxDistance}m` }
  }
  if (!hits.length) return { reason: `no ${name} within ${maxDistance}m` }
  const fresh = hits.find((h) => !isUnreachable(bot, h))
  if (!fresh) {
    return { reason: `every ${name} nearby (${hits.length}) is one you could not reach in the last few minutes. Explore to find others, or build or dig your way to one` }
  }
  const block = bot.blockAt?.(new Vec3(fresh.x, fresh.y, fresh.z))
  return block ? { block } : { reason: `no ${name} within ${maxDistance}m` }
}

async function resolveTarget(args, bot) {
  if (typeof args.x === 'number' && typeof args.y === 'number' && typeof args.z === 'number') {
    const block = bot.blockAt?.(new Vec3(args.x, args.y, args.z))
    return block ? { block } : { reason: 'no target' }
  }
  if (typeof args.target === 'string' && args.target.startsWith('#')) {
    const block = await resolveBlock(args, bot)
    return block ? { block } : { reason: isStaleHandle(args) ? 'stale target' : 'no target' }
  }
  const name = (typeof args.block === 'string' && args.block) || (typeof args.target === 'string' && args.target) || ''
  if (!name) return { reason: 'no target' }
  return findNamedBlock(bot, name, args.maxDistance ?? 32)
}

/**
 * Our block's drops lying near `around`, nearest first. Items that were
 * already lying there before the dig (`before`, a set of entity ids) are not
 * ours, even when their name has not decoded.
 */
function dropsOnGround(bot, items, around, before) {
  const out = []
  if (!around) return out
  for (const e of Object.values(bot.entities ?? {})) {
    if (!isItemEntity(e) || e.isValid === false || !e.position) continue
    if (before?.has(e.id)) continue
    const d = Math.hypot(e.position.x - around.x, e.position.y - around.y, e.position.z - around.z)
    if (d > DROP_LOOK_M) continue
    const it = droppedItemName(e)
    // An item whose name has not decoded yet may be ours.
    if (it && !items.includes(it.name)) continue
    out.push({ e, d })
  }
  out.sort((a, b) => a.d - b.d)
  return out.map((x) => x.e)
}

function gainOf(before, bot, items) {
  const now = inventoryCounts(bot)
  if (!before || !now) return 0
  let n = 0
  for (const name of items) n += Math.max(0, (now.get(name) ?? 0) - (before.get(name) ?? 0))
  return n
}

function haveOf(bot, items) {
  const now = inventoryCounts(bot)
  let n = 0
  for (const name of items) n += now?.get(name) ?? 0
  return n
}

/**
 * The model-facing dig: walk into reach of a single block, dig it, and say
 * what reached the inventory. Cuboids pass straight through to digAction,
 * which walks per cell.
 *
 * @param {object} args  DigSchema args
 * @param {import('mineflayer').Bot} bot
 * @param {{ signal?: AbortSignal, pathfinder_timeout_ms?: number }} [config]
 * @param {{ goTo?: Function, digAction?: Function, sleep?: (ms:number)=>Promise<void> }} [_deps]
 */
export async function digToolAction(args, bot, config, _deps) {
  const goTo = _deps?.goTo ?? realGoTo
  const digAction = _deps?.digAction ?? realDigAction
  const sleep = _deps?.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const signal = config?.signal
  if (signal?.aborted) return 'aborted'
  if (args?.to != null) return digAction(args, bot, config)

  const target = await resolveTarget(args ?? {}, bot)
  if (!target.block) return target.reason
  const block = target.block
  const pos = block.position
  const name = block.name
  if (name === 'air' || name === 'cave_air' || name === 'void_air') {
    return `no block at ${pos.x},${pos.y},${pos.z} (target was ${name})`
  }
  const items = dropItemsFor(bot, name)

  // Walk into reach first, measured the way the dig measures it.
  let walk = null
  if (digReachDistance(bot, pos) > DIG_REACH) {
    const timeoutMs = config?.pathfinder_timeout_ms ?? 12000
    walk = await goTo(bot, pos.x, pos.y, pos.z, 3, timeoutMs, signal, {
      reach: DIG_REACH - 0.3,
      // Never scaffold with what she came to dig.
      ...(items.length ? { keepItems: items } : {}),
    })
    if (walk === 'aborted' || signal?.aborted) return 'aborted'
  }

  const before = inventoryCounts(bot)
  const itemsBefore = itemIdsNow(bot)
  const dig = () => digAction({ x: pos.x, y: pos.y, z: pos.z }, bot, config)
  let r = await dig()
  if (typeof r === 'string' && (r.startsWith('busy ') || /^dig failed: digging aborted/i.test(r))) {
    // The walk's pathfinder can still be finishing a dig of its own, or cancel
    // ours as it stops. Give it a moment and try once more, as gather does.
    await sleep(400)
    if (signal?.aborted) return 'aborted'
    r = await dig()
  }
  if (r === 'aborted') return 'aborted'

  if (typeof r === 'string' && r.startsWith('out of range')) {
    // She ended up near it and still could not reach it: the next find,
    // gather or dig should pick another block.
    if (shouldMarkUnreachable(bot, pos, walk)) noteUnreachable(bot, pos, 'out of reach')
    if (walk != null) {
      // Say the vertical hint once.
      const w = VERTICAL_HINT.test(r) ? String(walk).replace(VERTICAL_HINT, '') : walk
      r = `${r} (the walk toward it ended: ${w})`
    }
    return r
  }
  if (typeof r !== 'string' || !r.startsWith('dug ')) return r
  // No drop without the right tool: dig.js already says so.
  if (r.includes('(no drop') || !items.length || !before) return r

  const deadline = Date.now() + DROP_WAIT_MS
  let got = gainOf(before, bot, items)
  while (got === 0 && Date.now() < deadline && !signal?.aborted) {
    await sleep(DROP_POLL_MS)
    got = gainOf(before, bot, items)
  }
  if (signal?.aborted) return 'aborted'
  // Still not in the bag: one short walk onto the drop where it actually lies
  // (it can bounce or roll off the spot the dig walked to).
  let lying = got === 0 ? dropsOnGround(bot, items, pos, itemsBefore) : []
  if (got === 0 && lying.length && !signal?.aborted) {
    const ep = lying[0].position
    await goTo(bot, Math.floor(ep.x), Math.floor(ep.y), Math.floor(ep.z), 1, DROP_WALK_MS, signal, dropWalkOpts(name))
    if (signal?.aborted) return 'aborted'
    const until = Date.now() + DROP_WAIT_MS / 2
    got = gainOf(before, bot, items)
    while (got === 0 && Date.now() < until && !signal?.aborted) {
      await sleep(DROP_POLL_MS)
      got = gainOf(before, bot, items)
    }
    if (signal?.aborted) return 'aborted'
    lying = got === 0 ? dropsOnGround(bot, items, pos, itemsBefore) : []
  }

  const base = r.replace(' (pickup walk did not reach)', '')
  const what = items.length === 1 ? items[0] : 'drop'
  if (got > 0) {
    const label = items.length === 1 ? items[0] : 'of its drops'
    return `${base}; ${got} ${label} reached your inventory (you have ${haveOf(bot, items)} now)`
  }
  if (lying.length) {
    const ep = lying[0].position
    return `${base}, but the ${what} it dropped is still on the ground at ${Math.floor(ep.x)},${Math.floor(ep.y)},${Math.floor(ep.z)}, not in your inventory (pickup collects it)`
  }
  if (r.includes('(pickup walk did not reach)')) {
    return `${base}, but the ${what} it dropped did not reach your inventory`
  }
  return base
}
