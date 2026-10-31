// src/bot/adapter/minecraft/behaviors/pickup.js — `pickup` action.
//
// 261011: there was no way to pick up dropped items on purpose. In the
// combat_night quality run she died, her stone sword and food lay a few
// blocks away, and she spent five goTo calls standing on the spot she was
// already on ("goTo -> reached") without collecting anything, then fought
// the rest of the night bare-handed. pickup walks onto each dropped item near
// her, closest first, so mineflayer's auto-collect takes it, and reports what
// actually reached the inventory.

import { goTo as realGoTo, dropWalkOpts } from './pathfind.js'
import { droppedItemName } from '../observers/entities.js'
import { givenDropFor } from '../observers/givenDrops.js'
import { lostWeaponDrop } from './weaponSelect.js'

const MAX_ITEMS = 10
const WALK_MS = 4000
// 261031 (pass 33 review): she walks about 4 blocks a second (no sprint), so
// a 4s walk ended short of drops 16 to 32 blocks away ("could not pick up").
const WALK_MS_PER_BLOCK = 280
const SETTLE_MS = 300
const ABOVE_LIMIT = 3

function isItemEntity(e) {
  return !!e && (e.name === 'item' || e.name === 'item_stack' || e.displayName === 'Item')
}

/** Item name -> count over the whole inventory; null when the bot has no inventory API. */
export function inventoryCounts(bot) {
  if (typeof bot?.inventory?.items !== 'function') return null
  const out = new Map()
  let items = []
  try { items = bot?.inventory?.items?.() ?? [] } catch { items = [] }
  for (const it of items) {
    if (!it?.name) continue
    out.set(it.name, (out.get(it.name) ?? 0) + (it.count ?? 1))
  }
  return out
}

/** "N name" for every item that went up between two inventoryCounts maps. */
export function gained(before, after) {
  const parts = []
  if (!before || !after) return parts
  for (const [name, n] of after) {
    const d = n - (before.get(name) ?? 0)
    if (d > 0) parts.push(`${d} ${name}`)
  }
  return parts
}

/**
 * @param {{ item?: string, maxDistance?: number }} args
 * @param {import('mineflayer').Bot} bot
 * @param {{ signal?: AbortSignal }} [config]
 * @param {{ goTo?: typeof realGoTo, sleep?: (ms:number)=>Promise<void> }} [_deps]
 */
export async function pickupAction(args, bot, config, _deps) {
  const goTo = _deps?.goTo ?? realGoTo
  const sleep = _deps?.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const signal = config?.signal
  if (signal?.aborted) return 'aborted'

  const maxDistance = Number.isFinite(args?.maxDistance) ? args.maxDistance : 16
  const want = typeof args?.item === 'string' && args.item.trim() ? args.item.trim().toLowerCase() : null
  const before = inventoryCounts(bot)
  const attempted = new Set()
  let seen = 0
  // 261017 (pass 14): items she tossed to the player stay theirs.
  const left = new Map()
  let skipped = null // { d, pos, above } nearest drop out of range or too high
  // 261031 (pass 33 review): picking up the weapon a death took. The player
  // in the same fight often dropped the same sword next to hers; pickup took
  // both and the bread lying with the second, and she kept them. Go for the
  // drop nearest her own death spot and stop once one is in her inventory.
  let ownWeapon = null // { pos } when `want` is the weapon her death dropped
  if (want) {
    try {
      const d = lostWeaponDrop(bot)
      if (d && d.weapon === want) ownWeapon = { pos: d.pos && !d.otherDim ? d.pos : null }
    } catch { /* plain pickup */ }
  }

  for (let i = 0; i < MAX_ITEMS; i++) {
    if (signal?.aborted) break
    const here = bot.entity?.position
    if (!here) break
    let best = null
    let bestD = Infinity
    for (const e of Object.values(bot.entities ?? {})) {
      if (!isItemEntity(e) || !e.position || e.isValid === false) continue
      if (attempted.has(e.id)) continue
      if (want) {
        const it = droppedItemName(e)
        if (!it || it.name !== want) continue
      }
      const d = e.position.distanceTo(here)
      // 261019 (pass 19): remember the nearest one left out, so "nothing
      // here" can say where the closest one actually is.
      if (e.position.y > here.y + ABOVE_LIMIT || d > maxDistance) {
        if (!givenDropFor(bot, e) && (!skipped || d < skipped.d)) {
          skipped = { d, pos: e.position, above: e.position.y > here.y + ABOVE_LIMIT ? Math.round(e.position.y - here.y) : 0 }
        }
        continue
      }
      const given = givenDropFor(bot, e)
      if (given) {
        if (!left.has(e.id)) left.set(e.id, given)
        continue
      }
      const rank = ownWeapon?.pos
        ? Math.hypot(e.position.x - ownWeapon.pos.x, e.position.y - ownWeapon.pos.y, e.position.z - ownWeapon.pos.z)
        : d
      if (rank < bestD) { bestD = rank; best = e }
    }
    if (!best) break
    seen++
    attempted.add(best.id)
    // Digging is allowed unless the drop is wood (dropWalkOpts): a mined
    // block's drop usually sits in the hole it left. goTo cancels a dig the
    // pathfinder leaves running when the walk ends.
    const it = droppedItemName(best)
    // 261019 (pass 19): resume, so a mob hit on the way does not end the
    // walk to the drop.
    const walkMs = Math.max(WALK_MS, 1500 + Math.ceil(best.position.distanceTo(here) * WALK_MS_PER_BLOCK))
    await goTo(bot, Math.floor(best.position.x), Math.floor(best.position.y), Math.floor(best.position.z), 0, walkMs, signal, { ...dropWalkOpts(it?.name), resume: true })
    if (signal?.aborted) break
    await sleep(SETTLE_MS)
    if (ownWeapon && (inventoryCounts(bot)?.get(want) ?? 0) > (before?.get(want) ?? 0)) break
  }

  const got = gained(before, inventoryCounts(bot))
  const what = want ?? 'dropped items'
  if (got.length) {
    const prefix = signal?.aborted ? 'aborted after picking up' : 'picked up'
    return `${prefix} ${got.join(', ')}`
  }
  if (signal?.aborted) return 'aborted'
  if (seen === 0 && left.size > 0) {
    const g = [...left.values()][0]
    return `nothing picked up: the ${g.item} on the ground is what you gave ${g.to ?? 'the player'}, left there for them`
  }
  if (seen === 0) {
    // 261019 (pass 19): "no stone_sword within 4m" while the sword was
    // already in her inventory (auto-collected on the walk) sent her looking
    // for it again. Say what she has and where the nearest drop really is.
    const parts = [`no ${what} on the ground within ${maxDistance}m`]
    const have = want ? (before?.get(want) ?? 0) : 0
    if (have > 0) parts.push(`you already have ${have} ${want} in your inventory`)
    if (skipped) {
      const at = `${Math.floor(skipped.pos.x)},${Math.floor(skipped.pos.y)},${Math.floor(skipped.pos.z)}`
      parts.push(skipped.above > 0
        ? `the nearest is ${skipped.above} blocks above you at ${at}; get up there first`
        : `the nearest is ${skipped.d.toFixed(0)}m away at ${at}; goTo near it first${maxDistance < 32 ? ', or pickup with a larger maxDistance (up to 32)' : ''}`)
    }
    return parts.join('; ')
  }
  return `could not pick up the ${what} (walked to ${seen}, nothing reached your inventory; they may be out of reach or your inventory is full)`
}
