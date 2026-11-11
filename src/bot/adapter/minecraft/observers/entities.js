// src/observers/entities.js — pure function of bot state

import { hasClearLineOfSight } from './lineOfSight.js'

/**
 * Resolve the concrete item name (and stack count) for a dropped-item entity.
 *
 * 260708: primary path is prismarine-entity's own `entity.getDroppedItem()`,
 * which knows the version-specific metadata index and parses the raw network
 * slot into an Item with `.name`/`.count`. The old hand-rolled metadata scan
 * below never fired on 1.21.x (the raw slot is `{itemId, itemCount}` with no
 * `.name`, so every dropped item rendered as an anonymous `item` — the bot
 * could not tell a cooked-beef gift from its own dirt drop). The scan is kept
 * only as a legacy fallback for entities without getDroppedItem.
 *
 * Returns `null` if the entity isn't a dropped item or the metadata hasn't
 * arrived yet — caller falls back to the generic 'item' label.
 *
 * @param {object} entity
 * @returns {{ name: string, count: number }|null}
 */
export function droppedItemName(entity) {
  if (!entity) return null
  const generic = entity.name === 'item' || entity.name === 'item_stack'
  if (!generic) return null
  try {
    const it = entity.getDroppedItem?.()
    if (it && typeof it.name === 'string' && it.name) {
      return { name: it.name, count: Number.isFinite(it.count) && it.count > 0 ? it.count : 1 }
    }
  } catch { /* metadata not arrived / unsupported version — fall through */ }
  const meta = entity.metadata
  if (!meta) return null
  const values = Array.isArray(meta) ? meta : Object.values(meta)
  for (const v of values) {
    if (!v || typeof v !== 'object') continue
    if (typeof v.name === 'string' && v.name && v.name !== 'item' && v.name !== 'item_stack') {
      return { name: v.name, count: Number.isFinite(v.count) && v.count > 0 ? v.count : 1 }
    }
  }
  return null
}

// 261012: a mob stays in bot.entities for its ~1s death animation after the
// server has said it died (entity_status 3, mineflayer 'entityDead'), until
// the destroy packet removes it. A snapshot taken right after a kill still
// listed the corpse as a live zombie, and the scripted-conversation eval had
// her announce "another one coming" and swing at nothing. The ids are kept
// on the bot so every observer (snapshot, aggro tally, name targeting, the
// owner-threat watch) agrees on what is still alive.
//
// 261019 (pass 18): deaths are also kept for RECENT_LOSS_MS after the corpse
// is gone (id, name, where, when), so a turn that was written while the mob
// was alive can be told it has died since (attackEntity's no-target result,
// the stale attack-event text). A mob that left the entity table without a
// death (a creeper that exploded, a despawn, out of range) is kept the same
// way with died:false.
// 261111 (pass 51): 60s (was 30s), so a mob that turns up after one with the
// same name died can be told apart from it (sameNameDeathAge) for as long as
// the kill is still the newest thing in her snapshot and her lines.
export const RECENT_LOSS_MS = 60_000
// Entity types that are never a mob she fought: dropped items, arrows, xp,
// boats and the like ('other' and 'projectile' in minecraft-data 1.21,
// 'object'/'orb'/'global' in older tables). Without this every item pickup
// and every arrow in a skeleton fight was kept as a "disappeared" entry.
const NOT_A_MOB = new Set(['object', 'orb', 'global', 'other', 'projectile', 'player'])

export function trackEntityDeaths(bot) {
  if (!bot || bot._seiDeadEntityIds) return
  const ids = new Set()
  bot._seiDeadEntityIds = ids
  const recent = new Map()
  bot._seiRecentLosses = recent
  const note = (e, died) => {
    const now = Date.now()
    for (const [id, d] of recent) if (now - d.at > RECENT_LOSS_MS) recent.delete(id)
    const p = e.position
    recent.set(e.id, { name: e.name ?? null, at: now, died, pos: p ? { x: p.x, y: p.y, z: p.z } : null })
  }
  try {
    bot.on?.('entityDead', (e) => {
      if (e?.id == null) return
      ids.add(e.id)
      note(e, true)
    })
    bot.on?.('entityGone', (e) => {
      if (e?.id == null) return
      const dead = ids.delete(e.id) || recent.get(e.id)?.died === true
      if (!dead && !e.username && !NOT_A_MOB.has(e.type)) note(e, false)
    })
  } catch { /* a stub bot without events: nothing is ever marked dead */ }
}

/**
 * When the server reported this entity id dead within `withinMs`, the age of
 * that death in ms; otherwise null. Keeps working after the corpse is gone.
 */
export function msSinceDeath(bot, id, withinMs = RECENT_LOSS_MS) {
  const d = id == null ? null : bot?._seiRecentLosses?.get(id)
  if (!d?.died) return null
  const age = Date.now() - d.at
  return age <= withinMs ? age : null
}

/**
 * The most recent mob with this name that died or left the entity table
 * within `withinMs`, within `maxDist` blocks of her when both positions are
 * known. Returns { id, age, died } or null.
 */
export function recentLossByName(bot, name, { withinMs = 10_000, maxDist = 16, diedOnly = false } = {}) {
  const want = String(name ?? '').toLowerCase()
  const recent = bot?._seiRecentLosses
  if (!want || !recent) return null
  const me = bot?.entity?.position
  const now = Date.now()
  let best = null
  for (const [id, d] of recent) {
    if ((d.name ?? '').toLowerCase() !== want) continue
    if (diedOnly && !d.died) continue
    const age = now - d.at
    if (age > withinMs) continue
    if (me && d.pos) {
      const dist = Math.hypot(d.pos.x - me.x, d.pos.y - me.y, d.pos.z - me.z)
      if (!(dist <= maxDist)) continue
    }
    if (!best || age < best.age) best = { id, age, died: d.died }
  }
  return best
}

/**
 * 261111 (pass 51): how many ms ago ANOTHER mob with this entity's name died
 * near her, or null. In the combat_night evals she called a fresh zombie "the
 * zombie" she had just killed ("zombie's dead alex" with a live one 1 block
 * away, "drowned's down" while a second drowned hit the player): her snapshot
 * still said "killed zombie" and nothing told the two apart.
 */
export function sameNameDeathAge(bot, entity, { withinMs = RECENT_LOSS_MS, maxDist = 24 } = {}) {
  if (!entity || entity.username || entity.name == null) return null
  const d = recentLossByName(bot, entity.name, { withinMs, maxDist, diedOnly: true })
  if (!d || d.id === entity.id) return null
  return d.age
}

/**
 * 261111 (pass 51): true when this entity id has died or left the entity
 * table. Used to tell whether the fight she last spoke about is over.
 */
export function isGoneOrDead(bot, id) {
  if (id == null) return false
  if (bot?._seiDeadEntityIds?.has(id)) return true
  if (bot?._seiRecentLosses?.has(id)) return true
  return !bot?.entities?.[id]
}

/** True once the server has reported this entity dead (it may still be listed). */
export function isDeadEntity(bot, entity) {
  const ids = bot?._seiDeadEntityIds
  return !!ids && entity?.id != null && ids.has(entity.id)
}

/**
 * Find nearby entities, closest-first, excluding self.
 *
 * `pin`: a username (typically the human player) that is force-included in
 * the result whenever it is within `radius`, even if `count` closer entities
 * would otherwise filter it out. The pinned entry keeps its true distance
 * position in the sort, so it appears among the closest visually — it just
 * isn't subject to the count cap. Without this, the player can vanish from the
 * snapshot in busy areas (sheep / foxes / traders / llamas at <40 blocks),
 * leaving the model with no real coords to feed `goTo` or `follow`.
 *
 * `pins`: additional usernames force-included the same way (260618 — the other
 * AI companions in a multi-bot session). The human and a couple of teammates
 * is a small set, so they all stay visible with coords; items and mobs fill the
 * remaining slots. Without this, a sibling bot competes with sheep for the 6
 * entity slots and drops out, so the model can't see its teammate to coordinate.
 *
 * @param {import('mineflayer').Bot} bot
 * `pinIds`: entity ids force-included the same way (and exempt from the
 * line-of-sight filter), for the mob her running attackEntity is fighting.
 *
 * @param {{ radius?:number, count?:number, pin?:string|null, pins?:string[], pinIds?:number[], requireLineOfSight?:boolean }} [opts]
 * @returns {{ entries: Array<{ entity:any, distance:number }>, more:number }}
 */
export function nearbyEntities(bot, opts = {}) {
  const radius = opts.radius ?? 24
  const count = opts.count ?? 6
  const requireLOS = opts.requireLineOfSight ?? false
  const pinSet = new Set()
  if (opts.pin) pinSet.add(opts.pin)
  for (const p of (opts.pins ?? [])) if (p) pinSet.add(p)
  // 261106 (quality pass 44): entity ids pinned the same way as the usernames
  // (the mob her running attackEntity is on). See snapshot.js.
  const pinIds = new Set((opts.pinIds ?? []).filter((id) => id != null))
  const isPinned = (e) => !!e && ((e.username && pinSet.has(e.username)) || pinIds.has(e.id))
  const me = bot.entity
  if (!me) return { entries: [], more: 0 }
  const all = []
  for (const e of Object.values(bot.entities ?? {})) {
    if (!e || e === me) continue
    if (!e.position) continue
    if (isDeadEntity(bot, e)) continue
    const d = e.position.distanceTo(me.position)
    if (d > radius) continue
    // Visibility filter (260618): only keep entities the bot can actually SEE —
    // a clear line of sight within the radius, with terrain and fluids as
    // occluders. This drops mobs that are underground / behind walls / over a
    // hill (e.g. a skeleton in a cave below), so `nearby entities` reflects what
    // is visible rather than everything the server streams. Facing is NOT
    // considered, so entities BEHIND the bot still count. Pinned usernames (the
    // human + AI teammates) bypass it: the bot needs their coords for
    // goTo/follow even through cover, and the owner-whereabouts line handles an
    // out-of-view owner separately.
    if (requireLOS && !isPinned(e) &&
        !hasClearLineOfSight(bot, e, { maxRange: radius, stepsPerBlock: 2 })) continue
    all.push({ entity: e, distance: d })
  }
  all.sort((a, b) => a.distance - b.distance)
  let entries = all.slice(0, count)
  // Priority pins: any pinned username within radius but sliced off by the count
  // cap is force-included by displacing the farthest currently-visible NON-pinned
  // entry (so two pins never evict each other). Naive "concat + re-sort + re-slice"
  // would just drop the pin again (it's at rank > count by definition). If every
  // visible slot is already a pin, we let the set overflow slightly rather than
  // drop a teammate — the pin set is small (human + a teammate or two).
  if (pinSet.size > 0 || pinIds.size > 0) {
    for (const pinEntry of all) {
      if (!isPinned(pinEntry.entity)) continue
      if (entries.some((x) => x.entity === pinEntry.entity)) continue
      if (entries.length >= count) {
        let evictIdx = -1
        let evictDist = -Infinity
        for (let i = 0; i < entries.length; i++) {
          if (isPinned(entries[i].entity)) continue
          if (entries[i].distance > evictDist) {
            evictDist = entries[i].distance
            evictIdx = i
          }
        }
        if (evictIdx >= 0) entries.splice(evictIdx, 1)
      }
      entries.push(pinEntry)
    }
    entries.sort((a, b) => a.distance - b.distance)
  }
  const more = Math.max(0, all.length - entries.length)
  return { entries, more }
}
