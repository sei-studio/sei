// src/behaviors/toolSelect.js — pick and equip the right tool before a dig.
//
// 260731: nothing on the dig path ever equipped anything. bot.dig() swings
// whatever happens to be in hand, and mineflayer's canDigBlock() only checks
// diggability + reach — it never looks at the held item — so dig.js's
// "unbreakable or wrong tool" branch could not fire on a bare-handed stone.
// Two live failures came out of that:
//
//   1. Stone bare-handed is 7500ms against dig.js's 8000ms DEFAULT_TIMEOUT_MS,
//      so every hand-mined stone raced the timer and usually lost
//      ("timeout digging stone" three times in a row, then `dug stone` the
//      instant the model happened to equip a wooden_pickaxe).
//   2. Stone mined without a pickaxe DROPS NOTHING, so gather('cobblestone')
//      could never accumulate — it reported 0/6, 0/7, 0/8 forever.
//
// The whole burden sat on the LLM remembering to call equip() first, and Haiku
// forgot most turns. The adapter does it now, the same way place/build/consume
// already equip what they need before acting.
//
// Also exported: `harvestNote`, so a dig that still cannot harvest the block
// (no pickaxe anywhere in the inventory) SAYS so in its result string instead
// of silently returning nothing — the attack.js weakWeaponNote pattern.

const WATER = new Set(['water', 'flowing_water'])

// Mirror the dig-speed context mineflayer's own bot.digTime() builds, so our
// estimate matches what bot.dig() will actually experience (helmet Aqua
// Affinity, submersion, airborne 5x penalty, Haste/Mining Fatigue).
function digContext(bot) {
  let helmet = []
  try {
    const slot = bot.getEquipmentDestSlot?.('head')
    helmet = (slot != null ? bot.inventory?.slots?.[slot]?.enchants : null) ?? []
  } catch (_) { helmet = [] }
  let inWater = false
  try { inWater = WATER.has(bot._getBlockAtEyeLevel?.()?.name) } catch (_) { inWater = false }
  return {
    creative: bot.game?.gameMode === 'creative',
    inWater,
    notOnGround: bot.entity?.onGround === false,
    helmet,
    effects: bot.entity?.effects ?? {},
  }
}

// ms to break `block` while holding `item` (null = bare hand). Infinity means
// unbreakable in survival (bedrock). null means we could not compute it.
export function digTimeWith(block, item, ctx) {
  if (typeof block?.digTime !== 'function') return null
  const ench = (item?.enchants ?? []).concat(ctx.helmet)
  try {
    return block.digTime(item ? item.type : null, ctx.creative, ctx.inWater, ctx.notOnGround, ench, ctx.effects)
  } catch (_) { return null }
}

// Whether the block will actually DROP its item when broken with this held
// item. Distinct from breakability: stone breaks bare-handed, it just yields
// nothing.
export function canHarvestWith(block, item) {
  if (typeof block?.canHarvest !== 'function') return true
  try { return !!block.canHarvest(item ? item.type : null) } catch (_) { return true }
}

function score(block, item, ctx) {
  const ms = digTimeWith(block, item, ctx)
  return {
    item,
    ms: ms == null ? Number.POSITIVE_INFINITY : ms,
    harvest: canHarvestWith(block, item),
  }
}

// A drops-the-block tool always beats a faster one that does not; ties on
// harvest go to the faster swing.
function better(a, b) {
  if (a.harvest !== b.harvest) return a.harvest
  return a.ms < b.ms
}

/**
 * Choose what should be in hand to break `block`. Returns
 * `{ item, ms, harvest, current }` where `item` is the winning inventory item
 * (possibly the one already held, possibly null for bare hand) and `current`
 * is the same shape for what is held right now.
 *
 * Pure apart from reading bot state — exported for the tests.
 */
export function chooseDigTool(bot, block) {
  const ctx = digContext(bot)
  const held = bot.heldItem ?? null
  const current = score(block, held, ctx)

  // Bare hand is a real candidate: it keeps a shovel from being "upgraded" to
  // whatever junk item happens to sit first in the inventory, since a non-tool
  // digs at exactly hand speed and would otherwise win an ms tie.
  let best = score(block, null, ctx)
  if (held && better(current, best)) best = current

  let items = []
  try { items = bot.inventory?.items?.() ?? [] } catch (_) { items = [] }
  for (const it of items) {
    if (!it) continue
    const cand = score(block, it, ctx)
    if (better(cand, best)) best = cand
  }
  return { ...best, current }
}

// Don't burn an equip round-trip on a marginal gain: a swap is worth it when it
// makes the block actually drop, or when it is meaningfully faster.
const SPEED_GAIN = 0.9

export function shouldSwap(best, current) {
  if (best.item == null) return false                      // never unequip
  if (current.item && best.item === current.item) return false
  if (best.harvest && !current.harvest) return true
  if (!best.harvest && current.harvest) return false
  if (!Number.isFinite(current.ms)) return Number.isFinite(best.ms)
  return best.ms < current.ms * SPEED_GAIN
}

const EQUIP_TIMEOUT_MS = 2000

/**
 * Equip the best available tool for `block`. Best-effort: an equip that fails
 * or hangs never blocks the dig, it just leaves whatever was in hand.
 *
 * Returns `{ equipped, ms, harvest }` — `equipped` is the item name we moved
 * into the hand (null if we kept what was there), `ms` the expected dig time
 * with what is now held, `harvest` whether the block will drop.
 */
export async function equipBestTool(bot, block, config) {
  const signal = config?.signal
  const { item, ms, harvest, current } = chooseDigTool(bot, block)
  if (signal?.aborted) return { equipped: null, ms: current.ms, harvest: current.harvest }
  if (!shouldSwap({ item, ms, harvest }, current)) {
    return { equipped: null, ms: current.ms, harvest: current.harvest }
  }

  const op = bot.equip(item, 'hand').then(() => true).catch(() => false)
  const tmo = new Promise((r) => setTimeout(() => r(false), EQUIP_TIMEOUT_MS))
  const ok = await Promise.race([op, tmo])
  if (!ok) return { equipped: null, ms: current.ms, harvest: current.harvest }
  return { equipped: item.name ?? null, ms, harvest }
}

/**
 * Suffix for a successful dig that produced no drop because nothing in the
 * inventory can harvest it. Tells the model WHY the count never moves, which
 * is otherwise invisible — a gather just reports 0/6 forever.
 */
export function harvestNote(blockName) {
  return ` (no drop — you have no tool that can harvest ${blockName}; craft the right pickaxe first)`
}
