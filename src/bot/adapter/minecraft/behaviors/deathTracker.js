// src/bot/adapter/minecraft/behaviors/deathTracker.js
//
// 261019 (quality pass 19): what the brain hears when she dies.
//
// connect.js used to emit `sei:death` the moment health hit 0, carrying only
// the death position. Two things went wrong in the combat_night eval:
//
//  1. Timing. The death turn could start before the respawn (its snapshot
//     read hp 0, the old spot and sometimes the old inventory), and a turn the
//     dying body was still writing finished after the death: "4 hp, eating"
//     plus consumeItem(bread) for bread lying on the ground, "i'm at 7 hp, two
//     skeletons on me" a second after she died.
//  2. Content. The turn was told everything she carried dropped, but not what
//     that was, so she later tried to eat bread she no longer had, and fought
//     bare-handed without registering that her sword was on the ground.
//
// Now the death is reported in two steps:
//   sei:dying  at once (health 0), so the brain drops the stale turn;
//   sei:death  after the respawn has settled, with what she lost (what she
//              carried minus what she still has, so keepInventory reads as
//              nothing lost), where she died, and the game's own death
//              message when chat.js saw one.

/** Item name -> count over the main inventory. */
export function inventoryTally(bot) {
  const out = new Map()
  let items = []
  try { items = bot?.inventory?.items?.() ?? [] } catch { items = [] }
  for (const it of items) {
    if (!it?.name) continue
    out.set(it.name, (out.get(it.name) ?? 0) + (Number.isFinite(it.count) ? it.count : 1))
  }
  return out
}

/** [{item, n}] for everything `before` has more of than `after`, largest stacks first. */
export function lostItems(before, after) {
  const out = []
  if (!before) return out
  for (const [item, n] of before) {
    const d = n - (after?.get(item) ?? 0)
    if (d > 0) out.push({ item, n: d })
  }
  return out.sort((a, b) => b.n - a.n)
}

import { noteLostWeapon } from './weaponSelect.js'

const OWN_DEATH_TEXT_MS = 10_000

/**
 * Wire the death reporting on a mineflayer bot.
 *
 * @param {object} bot
 * @param {{ logger?: object, respawnDelayMs?: number, settleMs?: number,
 *           fallbackMs?: number, onDeath?: () => void }} [opts]
 *   respawnDelayMs: wait before bot.respawn() (the old 500ms).
 *   settleMs: after the respawn spawn, wait this long so health and the
 *     inventory sync land before the turn reads them.
 *   fallbackMs: report the death anyway if no respawn spawn arrives.
 * @returns {() => void} dispose
 */
export function trackDeaths(bot, opts = {}) {
  const logger = opts.logger ?? console
  const respawnDelayMs = opts.respawnDelayMs ?? 500
  const settleMs = opts.settleMs ?? 600
  const fallbackMs = opts.fallbackMs ?? 6000

  // What she carried the last time she was alive and the inventory was read.
  // The health event fires on every hit, so this is current as of the blow
  // that killed her; the live inventory is used instead when the server has
  // not cleared it yet.
  let carried = new Map()
  const onHealth = () => {
    if (!(bot.health > 0)) return
    carried = inventoryTally(bot)
  }

  let pending = null // { pos, carried, diedAt, timers[] }

  function report() {
    const p = pending
    if (!p) return
    pending = null
    for (const t of p.timers) clearTimeout(t)
    try { bot.off?.('spawn', p.onSpawn) } catch {}
    const now = inventoryTally(bot)
    const lost = lostItems(p.carried, now)
    // 261030 (pass 31): remember a dropped weapon (weaponSelect lostWeaponUnarmed).
    try { noteLostWeapon(bot, lost) } catch {}
    const ownText = bot._seiOwnDeathText
    const deathText = ownText && Date.now() - ownText.at <= OWN_DEATH_TEXT_MS ? ownText.text : null
    const payload = {
      pos: p.pos,
      diedAt: p.diedAt,
      lost,
      // Carrying something and losing none of it means the world keeps
      // inventories (keepInventory), not that nothing was there.
      keptAll: p.carried.size > 0 && lost.length === 0,
      ...(deathText ? { deathText } : {}),
    }
    try { bot.emit('sei:death', payload) } catch (err) {
      logger.warn?.(`[sei/death] sei:death emit threw: ${err && err.message}`)
    }
  }

  const onDeath = () => {
    try { opts.onDeath?.() } catch {}
    // Snapshot the death position BEFORE bot.respawn() teleports the entity
    // back to world spawn: that is where everything she carried dropped.
    // A partially-loaded entity (NaN coords) degrades to null.
    let pos = null
    try {
      const q = bot.entity?.position
      if (q && Number.isFinite(q.x) && Number.isFinite(q.y) && Number.isFinite(q.z)) {
        pos = { x: Math.round(q.x), y: Math.round(q.y), z: Math.round(q.z) }
      }
    } catch { /* pos stays null */ }
    const live = inventoryTally(bot)
    const had = live.size > 0 ? live : carried
    if (pending) { for (const t of pending.timers) clearTimeout(t); try { bot.off?.('spawn', pending.onSpawn) } catch {} }
    const p = { pos, carried: had, diedAt: Date.now(), timers: [], onSpawn: null }
    p.onSpawn = () => {
      if (pending !== p) return
      p.timers.push(setTimeout(report, settleMs))
    }
    pending = p
    carried = new Map()
    try { bot.emit('sei:dying', { pos }) } catch (err) {
      logger.warn?.(`[sei/death] sei:dying emit threw: ${err && err.message}`)
    }
    bot.once?.('spawn', p.onSpawn)
    p.timers.push(setTimeout(report, fallbackMs))
    p.timers.push(setTimeout(() => { try { bot.respawn?.() } catch {} }, respawnDelayMs))
  }

  bot.on('health', onHealth)
  bot.on('death', onDeath)
  return function dispose() {
    try { bot.off?.('health', onHealth) } catch {}
    try { bot.off?.('death', onDeath) } catch {}
    if (pending) {
      for (const t of pending.timers) clearTimeout(t)
      try { bot.off?.('spawn', pending.onSpawn) } catch {}
      pending = null
    }
  }
}
