// src/behaviors/place.js — place a block against a reference face (D-22)
import { Vec3 } from 'vec3'
import { resolveBlock, isStaleHandle } from '../observers/targeting.js'
import { reason } from '../../../brain/errStrings.js'
import { liveCount, hasLiveInventory, waitInventoryQuiet } from '../observers/liveInventory.js'
import { recordOwnStation } from '../observers/ownStations.js'
import { goTo } from './pathfind.js'
import { checkPlaceCell, findPlaceSpots, findOpenStandSpot, openKind } from './placeSpots.js'

export const DEFAULT_TIMEOUT_MS = 4000
const RETRY_TIMEOUT_MS = 2500 // later spots in one placeBlock
const MAX_TRIES = 3 // spots tried per position
const STEP_TIMEOUT_MS = 8000 // the one step to a more open spot

const AIR = new Set(['air', 'cave_air', 'void_air'])

// 261012 (quality pass 5): placeBlock resolving is not proof the block is
// there. The eval had "placed crafting_table on barrier" with the table still
// in her bag, and she walked off to use a table that did not exist. After the
// server has had its say, the target cell must hold a block and the item must
// have left the bag (or the block must be the item itself).
const EMPTY_AFTER_PLACE = new Set([...AIR, 'water', 'lava'])
const PLACE_SETTLE = { quietMs: 250, minMs: 300, maxMs: 1200 }

async function verifyPlaced(bot, dest, itemName, before, oldName, refLoc, signal) {
  if (!dest || !hasLiveInventory(bot) || typeof bot.blockAt !== 'function') return `placed ${itemName} on ${refLoc}`
  if (await waitInventoryQuiet(bot, { ...PLACE_SETTLE, signal }) === 'aborted') return 'aborted'
  let blk = null
  try { blk = bot.blockAt(dest) } catch { blk = null }
  const after = liveCount(bot, itemName)
  const empty = !blk || EMPTY_AFTER_PLACE.has(blk.name)
  // 261013: a block named unlike its item (torch -> wall_torch, oak_sign ->
  // oak_wall_sign) that replaced what was there is placed, even when the
  // count did not drop (creative, or a slot update still on its way).
  if (empty || (blk.name !== itemName && after >= before && blk.name === oldName)) {
    const there = empty ? 'the spot is still empty' : `the spot holds ${blk.name}`
    return `placing ${itemName} on ${refLoc} did not go through: ${there} and the ${itemName} is still in your inventory`
  }
  return `placed ${itemName} on ${refLoc}`
}

function tryPlace(bot, refBlock, faceVector, itemName, timeoutMs, signal) {
  const rp = refBlock.position
  const refLoc = rp ? `${refBlock.name ?? 'block'} @${rp.x},${rp.y},${rp.z}` : (refBlock.name ?? 'block')
  const dest = rp && faceVector ? new Vec3(rp.x + faceVector.x, rp.y + faceVector.y, rp.z + faceVector.z) : null
  const before = liveCount(bot, itemName)
  let oldName = null
  try { oldName = dest && typeof bot.blockAt === 'function' ? (bot.blockAt(dest)?.name ?? null) : null } catch { oldName = null }
  const op = bot.placeBlock(refBlock, faceVector)
    .then(() => verifyPlaced(bot, dest, itemName, before, oldName, refLoc, signal))
    .then((r) => {
      // 261017 (pass 14b): a station she put down is hers for the progression spine.
      if (dest && typeof r === 'string' && r.startsWith('placed ')) recordOwnStation(bot, itemName, dest)
      return r
    })
    .catch((err) => {
      const r = reason(err)
      return r ? `cannot place ${itemName} on ${refLoc}: ${r}` : `cannot place ${itemName} on ${refLoc}`
    })
  const tmo = new Promise((r) => setTimeout(() => r(`timeout placing ${itemName} on ${refLoc}`), timeoutMs))
  const abrt = new Promise((r) => {
    if (!signal) return
    signal.addEventListener('abort', () => r('aborted'), { once: true })
  })
  return Promise.race([op, tmo, abrt])
}

const placed = (r) => r === 'aborted' || (typeof r === 'string' && r.startsWith('placed '))

export async function placeBlockAction(args, bot, config) {
  const signal = config?.signal
  if (signal?.aborted) return 'aborted'

  const itemName = args.block
  let invItem = bot.inventory.items().find((i) => i.name === itemName)
  if (!invItem && hasLiveInventory(bot)) {
    // 261012: an item crafted or picked up a moment ago may still be landing.
    if (await waitInventoryQuiet(bot, { quietMs: 250, maxMs: 1000, signal }) === 'aborted') return 'aborted'
    invItem = bot.inventory.items().find((i) => i.name === itemName)
  }
  if (!invItem) return `no ${itemName} in inventory`

  try {
    await bot.equip(invItem, 'hand')
  } catch (err) {
    const r = reason(err)
    return r ? `cannot hold ${itemName} to place: ${r}` : `cannot hold ${itemName} to place`
  }

  const timeoutMs = args.timeout_ms ?? config?.place_timeout_ms ?? DEFAULT_TIMEOUT_MS
  // build (and any caller naming an exact face) owns its geometry: one strict
  // attempt against the cell it chose, no near-bot fallback.
  const hasExplicitFace = !!args.faceVector
  const referenceBlock = await resolveBlock(args.against ?? {}, bot)

  if (hasExplicitFace) {
    if (!referenceBlock) return isStaleHandle(args.against ?? {}) ? 'stale reference block' : 'no reference block'
    const fv = args.faceVector
    return tryPlace(bot, referenceBlock, new Vec3(fv.x, fv.y, fv.z), itemName, timeoutMs, signal)
  }

  // Model path ("place X near me"). 261108 (quality pass 46): every open cell
  // in reach is ranked (placeSpots.js) and the best few are tried; with none,
  // or none that took the block, she steps to the nearest open standing spot
  // once and tries again.
  const tried = new Set()
  const attempt = async (spots, budget) => {
    let last = null
    for (const s of spots) {
      if (budget <= 0) break
      const key = `${s.cell.x},${s.cell.y},${s.cell.z}`
      if (tried.has(key)) continue
      tried.add(key)
      budget--
      // A later try gets a shorter wait: a refused place never lands.
      const r = await tryPlace(bot, s.refBlk, s.face, itemName, tried.size === 1 ? timeoutMs : Math.min(timeoutMs, RETRY_TIMEOUT_MS), signal)
      if (placed(r)) return r
      last = r
      if (signal?.aborted) return 'aborted'
    }
    return last
  }
  // Her own aim first, when it names a cell a block can go in: the top of
  // `against`, or `against` itself when it is a grass tuft or water.
  let lastErr = null
  if (referenceBlock?.position) {
    const rp = referenceBlock.position
    const cell = openKind(referenceBlock) ? { x: rp.x, y: rp.y, z: rp.z } : { x: rp.x, y: rp.y + 1, z: rp.z }
    const own = checkPlaceCell(bot, cell)
    if (own) {
      const r = await attempt([own], 1)
      if (placed(r)) return r
      lastErr = r
    }
  }
  const spots = findPlaceSpots(bot)
  const dry = spots.filter((s) => s.kind !== 'wet')
  if (dry.length) {
    const r = await attempt(dry, MAX_TRIES)
    if (placed(r)) return r
    lastErr = r ?? lastErr
  }
  if (signal?.aborted) return 'aborted'
  // Nothing dry beside her took it: one step to an open spot, then again.
  const stand = findOpenStandSpot(bot)
  let stepped = null
  if (stand) {
    const walk = await goTo(bot, stand.x, stand.y, stand.z, 0.5, STEP_TIMEOUT_MS, signal)
    if (walk === 'aborted' || signal?.aborted) return 'aborted'
    stepped = stand
    const r = await attempt(findPlaceSpots(bot, { dryOnly: true }), MAX_TRIES)
    if (placed(r)) return `${r} (stepped to ${stand.x},${stand.y},${stand.z} first: no open spot right beside you)`
    lastErr = r ?? lastErr
  }
  // Last resort: the water around her.
  const wet = findPlaceSpots(bot).filter((s) => s.kind === 'wet')
  if (wet.length) {
    const r = await attempt(wet, 1)
    if (placed(r)) return `${r} (into the water: there was no dry spot in reach)`
    lastErr = r ?? lastErr
  }
  const why = lastErr && !/^no /.test(lastErr) ? ` Last try: ${lastErr}.` : ''
  const step = stepped ? `, even after stepping to ${stepped.x},${stepped.y},${stepped.z}` : ''
  return `couldn't place ${itemName}: no open spot in reach${step}.${why} Walk a few blocks onto open, flat ground and try placeBlock again.`
}
