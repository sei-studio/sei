// src/bot/adapter/minecraft/behaviors/armor.js — wear the best armor she owns.
//
// 261111 (user feedback ae9a758e, "Sui won't put on or use what I give her"):
// nothing ever put armor on. A helmet the player tossed her sat in the bag
// until the model called equip with the right slot, and the model could not
// see what she wore: bot.inventory.items() leaves out the armor slots, so a
// piece she did put on vanished from the snapshot and read as a loss.
//
// Now, like the weapon (weaponSelect.js) and the dig tool (toolSelect.js),
// armor is handled by the body: when a piece comes into her possession and
// beats what she wears in that slot, she puts it on. Only a GAIN triggers it
// (bag + worn count of some armor went up), so a piece she takes off to hand
// over (takeOffWorn, used by give and drop) is not put straight back on.

const SLOT_OF = { helmet: 'head', chestplate: 'torso', leggings: 'legs', boots: 'feet' }
export const ARMOR_SLOTS = ['head', 'torso', 'legs', 'feet']

// Armor points per piece [head, torso, legs, feet] and toughness, Java 1.21.
const MATERIAL = {
  leather: { points: [1, 3, 2, 1], toughness: 0 },
  copper: { points: [2, 4, 3, 1], toughness: 0 },
  golden: { points: [2, 5, 3, 1], toughness: 0 },
  chainmail: { points: [2, 5, 4, 1], toughness: 0 },
  iron: { points: [2, 6, 5, 2], toughness: 0 },
  diamond: { points: [3, 8, 6, 3], toughness: 2 },
  netherite: { points: [3, 8, 6, 3], toughness: 3 },
}

const EQUIP_TIMEOUT_MS = 2000
const CHECK_DEBOUNCE_MS = 500
const RETRY_MS = 1500
const MAX_RETRIES = 20

/** The slot an armor piece is worn in ('head'|'torso'|'legs'|'feet'), or null. */
export function armorSlotFor(name) {
  if (typeof name !== 'string') return null
  if (name === 'turtle_helmet') return 'head'
  const m = /^([a-z]+)_(helmet|chestplate|leggings|boots)$/.exec(name)
  return m ? SLOT_OF[m[2]] : null
}

/** How good an armor piece is (points first, toughness breaks ties); 0 if unknown. */
export function armorScore(name) {
  if (name === 'turtle_helmet') return 20
  const m = typeof name === 'string' ? /^([a-z]+)_(helmet|chestplate|leggings|boots)$/.exec(name) : null
  const mat = m ? MATERIAL[m[1]] : null
  if (!mat) return 0
  return mat.points[ARMOR_SLOTS.indexOf(SLOT_OF[m[2]])] * 10 + mat.toughness
}

function slotIndex(bot, dest) {
  try {
    const i = bot?.getEquipmentDestSlot?.(dest)
    return Number.isInteger(i) ? i : null
  } catch { return null }
}

/** What she wears: [{slot, item}] for each filled armor slot, head to feet. */
export function wornArmor(bot) {
  const out = []
  for (const slot of ARMOR_SLOTS) {
    const i = slotIndex(bot, slot)
    const it = i == null ? null : bot?.inventory?.slots?.[i]
    if (it && it.name) out.push({ slot, item: it })
  }
  return out
}

/** The item in her off hand, or null. */
export function offHandItem(bot) {
  const i = slotIndex(bot, 'off-hand')
  const it = i == null ? null : bot?.inventory?.slots?.[i]
  return it && it.name ? it : null
}

/** Item counts she wears or holds in the off hand: { name: count }. */
export function wornCounts(bot) {
  const out = {}
  const add = (it) => { if (it?.name) out[it.name] = (out[it.name] ?? 0) + (it.count ?? 1) }
  for (const w of wornArmor(bot)) add(w.item)
  add(offHandItem(bot))
  return out
}

function hasBindingCurse(item) {
  return (item?.enchants ?? []).some((e) => /binding_curse/.test(String(e?.name ?? '')))
}

/**
 * The armor upgrades in her bag: [{slot, item}] where the bag piece beats
 * what she wears there. A worn item that is not known armor (an elytra, a
 * carved pumpkin) is left on. Pure over bot state.
 */
export function armorUpgrades(bot) {
  let bag = []
  try { bag = bot?.inventory?.items?.() ?? [] } catch { bag = [] }
  const worn = new Map(wornArmor(bot).map((w) => [w.slot, w.item]))
  const out = []
  for (const slot of ARMOR_SLOTS) {
    const cur = worn.get(slot)
    const curScore = cur ? armorScore(cur.name) : 0
    if (cur && curScore === 0) continue
    let best = null
    let bestScore = curScore
    for (const it of bag) {
      if (armorSlotFor(it?.name) !== slot || hasBindingCurse(it)) continue
      const s = armorScore(it.name)
      if (s > bestScore) { best = it; bestScore = s }
    }
    if (best) out.push({ slot, item: best })
  }
  return out
}

async function equipWithTimeout(bot, item, slot) {
  const op = Promise.resolve().then(() => bot.equip(item, slot)).then(() => true).catch(() => false)
  let timer
  const tmo = new Promise((r) => { timer = setTimeout(() => r(false), EQUIP_TIMEOUT_MS) })
  const ok = await Promise.race([op, tmo])
  clearTimeout(timer)
  return ok
}

/** Something else is using her hands or inventory right now. */
function busy(bot) {
  if (!bot || bot._seiPaused) return true
  if (bot.currentWindow && bot.currentWindow !== bot.inventory) return true
  if (bot.autoEat?.isEating || bot.usingHeldItem) return true
  if (bot.targetDigBlock || bot._seiWeaponEquipping || bot._seiArmorEquipping) return true
  return false
}

/**
 * Put on every armor upgrade in the bag. Returns the names put on.
 * Best-effort: a failed or slow equip is skipped.
 */
export async function wearBestArmor(bot) {
  const put = []
  if (typeof bot?.equip !== 'function') return put
  bot._seiArmorEquipping = true
  try {
    for (const { slot, item } of armorUpgrades(bot)) {
      if (bot._seiPaused) break
      if (await equipWithTimeout(bot, item, slot)) put.push(item.name)
    }
  } finally {
    bot._seiArmorEquipping = false
  }
  return put
}

function ownedArmorCounts(bot) {
  const out = {}
  let bag = []
  try { bag = bot?.inventory?.items?.() ?? [] } catch { bag = [] }
  for (const it of bag) if (armorSlotFor(it?.name)) out[it.name] = (out[it.name] ?? 0) + (it.count ?? 1)
  for (const w of wornArmor(bot)) out[w.item.name] = (out[w.item.name] ?? 0) + 1
  return out
}

/**
 * Watch the inventory and put on better armor when some comes in. Returns a
 * disposer. Started on every spawn (a respawn gets a fresh check too).
 */
export function startAutoArmor(bot, { logger } = {}) {
  const inv = bot?.inventory
  if (!inv || typeof inv.on !== 'function') return () => {}
  try { bot._seiAutoArmorStop?.() } catch {}
  let seen = {}
  let pending = true // first check: wear what she already carries
  let timer = null
  let retries = 0
  let stopped = false

  const schedule = (ms) => {
    if (stopped || timer) return
    timer = setTimeout(run, ms)
    timer.unref?.()
  }
  async function run() {
    timer = null
    if (stopped) return
    const now = ownedArmorCounts(bot)
    for (const [name, n] of Object.entries(now)) if (n > (seen[name] ?? 0)) pending = true
    seen = now
    if (!pending) return
    if (armorUpgrades(bot).length === 0) { pending = false; retries = 0; return }
    if (busy(bot)) {
      if (++retries <= MAX_RETRIES) schedule(RETRY_MS)
      else { pending = false; retries = 0 }
      return
    }
    pending = false
    retries = 0
    const put = await wearBestArmor(bot)
    seen = ownedArmorCounts(bot)
    if (put.length) logger?.info?.(`[sei/armor] put on ${put.join(', ')}`)
  }
  const onSlot = () => schedule(CHECK_DEBOUNCE_MS)
  inv.on('updateSlot', onSlot)
  schedule(CHECK_DEBOUNCE_MS)
  const stop = () => {
    stopped = true
    if (timer) clearTimeout(timer)
    timer = null
    try { inv.removeListener('updateSlot', onSlot) } catch {}
    if (bot._seiAutoArmorStop === stop) bot._seiAutoArmorStop = null
  }
  bot._seiAutoArmorStop = stop
  return stop
}

/**
 * Take off worn pieces named `item` until the bag holds `count` of it, so give
 * and drop can hand over armor she has on. Returns how many were taken off.
 */
export async function takeOffWorn(bot, item, count = 1) {
  if (typeof bot?.unequip !== 'function') return 0
  let bagCount = 0
  try { bagCount = (bot.inventory.items() ?? []).filter((i) => i?.name === item).reduce((s, i) => s + (i.count ?? 1), 0) } catch { bagCount = 0 }
  let off = 0
  for (const w of wornArmor(bot)) {
    if (bagCount + off >= count) break
    if (w.item.name !== item) continue
    const op = Promise.resolve().then(() => bot.unequip(w.slot)).then(() => true).catch(() => false)
    let timer
    const tmo = new Promise((r) => { timer = setTimeout(() => r(false), EQUIP_TIMEOUT_MS) })
    const ok = await Promise.race([op, tmo])
    clearTimeout(timer)
    if (ok) off++
  }
  return off
}
