// src/bot/adapter/minecraft/behaviors/weaponSelect.js — hold the best melee
// weapon before a fight.
//
// 261011: nothing on the fight path equipped anything. Quality eval
// 2026-10-11 (combat_night): after crafting she held planks or nothing while
// two zombies hit her, the auto-retaliation swung bare-handed, and she died
// from full health with a stone sword in her inventory. attackEntity and the
// automatic swing-back now put the best weapon she owns in her hand first,
// like dig does with tools (toolSelect.js).
//
// Ranking is by damage per hit at the bot's fixed 600ms swing cadence. Swords
// recover in 625ms, so they deal full damage at that cadence; axes recover in
// 1000-1250ms and deal a fraction of their listed damage, so any sword beats
// any axe and an axe beats bare hands.

const SWORD_DAMAGE = {
  wooden_sword: 4, golden_sword: 4, stone_sword: 5,
  iron_sword: 6, diamond_sword: 7, netherite_sword: 8,
}
const AXE_DAMAGE = {
  wooden_axe: 7, golden_axe: 7, stone_axe: 9,
  iron_axe: 9, diamond_axe: 9, netherite_axe: 10,
}
const EQUIP_TIMEOUT_MS = 1500

/** Score of an item as a melee weapon; 0 for anything that is not one. */
export function weaponScore(name) {
  if (!name) return 0
  if (SWORD_DAMAGE[name]) return 100 + SWORD_DAMAGE[name]
  if (name === 'trident') return 100 + 9
  if (name === 'mace') return 100 + 6
  if (AXE_DAMAGE[name]) return 10 + AXE_DAMAGE[name]
  return 0
}

/** The best weapon in the inventory, or null when there is none. */
export function chooseWeapon(bot) {
  let best = null
  let bestScore = 0
  let items = []
  try { items = bot?.inventory?.items?.() ?? [] } catch { items = [] }
  for (const it of items) {
    const s = weaponScore(it?.name)
    if (s > bestScore) { bestScore = s; best = it }
  }
  return best
}

/**
 * Equip the best weapon the bot owns when it beats what is in hand.
 * Best-effort: a failed or slow equip never blocks the fight.
 * Returns the name equipped, or null when nothing changed.
 */
export async function equipBestWeapon(bot) {
  const best = chooseWeapon(bot)
  if (!best) return null
  if (weaponScore(best.name) <= weaponScore(bot?.heldItem?.name)) return null
  if (typeof bot?.equip !== 'function') return null
  const op = Promise.resolve().then(() => bot.equip(best, 'hand')).then(() => true).catch(() => false)
  let timer
  const tmo = new Promise((r) => { timer = setTimeout(() => r(false), EQUIP_TIMEOUT_MS) })
  const ok = await Promise.race([op, tmo])
  clearTimeout(timer)
  return ok ? best.name : null
}

/**
 * Put the best weapon back in hand during a fight, without blocking the swing
 * loop. Single-flight per bot; skipped while eating (an equip would cancel the
 * bite). 261011: the weapon was equipped once, before the first swing, and
 * anything that changed the hand after that (auto-eat's food, a block placed
 * mid-fight) stayed there for the rest of the fight.
 * @returns {boolean} true when an equip was started
 */
export function keepWeaponInHand(bot) {
  if (!bot || bot._seiWeaponEquipping) return false
  if (bot.autoEat?.isEating) return false
  const best = chooseWeapon(bot)
  if (!best || weaponScore(best.name) <= weaponScore(bot.heldItem?.name)) return false
  bot._seiWeaponEquipping = true
  equipBestWeapon(bot).catch(() => {}).finally(() => { bot._seiWeaponEquipping = false })
  return true
}

// 261030 (quality pass 31): "she lost her weapon when she died and has not
// got one back". In the combat_night eval a first death dropped her sword,
// and the fight texts, the automatic defend and the swing-back kept her
// fighting with 1-damage fists until she died again (13 of 18 deaths in the
// two worst runs). Only that case changes behavior: a player who never had a
// weapon (the early game, wooden pickaxe only) keeps the dev fight texts and
// the automatic defend, which pulls aggro off a low-health player with a
// punch. deathTracker sets the mark when the drop held a weapon; it clears
// when she owns a weapon again or after LOST_WEAPON_MS (the drops despawn
// after 5 minutes, and a night is about 7).
export const LOST_WEAPON_MS = 10 * 60_000

/** The best weapon in a death's lost list ([{item, n}]), or null. */
export function bestLostWeapon(lost) {
  let best = null
  let bestScore = 0
  for (const l of Array.isArray(lost) ? lost : []) {
    const s = weaponScore(l?.item)
    if (s > bestScore) { bestScore = s; best = l.item }
  }
  return best
}

// Dropped items despawn 5 minutes after they land (vanilla).
export const DROP_DESPAWN_MS = 5 * 60_000

const finitePos = (p) => (p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)
  ? { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) }
  : null)

/**
 * Mark the bot when a death dropped a weapon, with where it dropped (`pos`,
 * the death spot). A death while still marked (she died again before getting
 * one back) restarts the window and keeps the first drop's spot and time:
 * the weapon is still lying there. Returns the weapon or null.
 */
export function noteLostWeapon(bot, lost, now = Date.now(), pos = null) {
  if (!bot) return null
  const weapon = bestLostWeapon(lost)
  if (weapon) bot._seiLostWeapon = { weapon, at: now, droppedAt: now, pos: finitePos(pos) }
  else if (lostWeaponUnarmed(bot, now)) bot._seiLostWeapon = { ...bot._seiLostWeapon, at: now }
  return weapon
}

/**
 * 261031 (quality pass 33): where the lost weapon lies, while she is in the
 * lost-weapon state. { weapon, pos (or null), dist (blocks from her now, or
 * null), minutesLeft (0 once it has despawned) }, or null outside the state.
 */
export function lostWeaponDrop(bot, now = Date.now()) {
  if (!lostWeaponUnarmed(bot, now)) return null
  const m = bot._seiLostWeapon
  const left = (m.droppedAt ?? m.at) + DROP_DESPAWN_MS - now
  const minutesLeft = left > 0 ? Math.max(1, Math.ceil(left / 60_000)) : 0
  let dist = null
  const me = bot.entity?.position
  if (m.pos && me && Number.isFinite(me.x) && Number.isFinite(me.y) && Number.isFinite(me.z)) {
    dist = Math.round(Math.hypot(me.x - m.pos.x, me.y - m.pos.y, me.z - m.pos.z))
  }
  return { weapon: m.weapon, pos: m.pos ?? null, dist, minutesLeft }
}

/**
 * 261031 (quality pass 33): the snapshot's `weapon:` line, only in the
 * lost-weapon state (every other snapshot is unchanged). The combat_night
 * eval after pass 31: she was told to get away and say she had no weapon, so
 * she walked away from her sword lying a few blocks off, said "no sword" in
 * almost every line and died 7 and 15 times in two runs. Every turn now sees
 * where it lies and how to get it back.
 */
export function lostWeaponLine(bot, now = Date.now()) {
  const d = lostWeaponDrop(bot, now)
  if (!d) return null
  if (d.minutesLeft === 0) return `weapon: none. The ${d.weapon} you dropped when you died has despawned; craft a new sword when you can.`
  const where = d.pos
    ? ` @${d.pos.x},${d.pos.y},${d.pos.z}${d.dist != null ? ` (${d.dist} blocks from you)` : ''}`
    : ''
  const mins = d.minutesLeft === 1 ? 'about 1 more minute' : `about ${d.minutesLeft} more minutes`
  return `weapon: none. Your ${d.weapon} is on the ground where you died${where} for ${mins}. pickup with item "${d.weapon}" and maxDistance 32 walks onto it; if it is farther than that, goTo the spot first.`
}

/** True while she lost a weapon on death and owns none again. */
export function lostWeaponUnarmed(bot, now = Date.now()) {
  const mark = bot?._seiLostWeapon
  if (!mark) return false
  if (!(now - mark.at < LOST_WEAPON_MS) || chooseWeapon(bot) != null) {
    bot._seiLostWeapon = null
    return false
  }
  return true
}
