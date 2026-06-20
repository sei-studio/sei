// src/observers/entities.js — pure function of bot state

import { hasClearLineOfSight } from './lineOfSight.js'

/**
 * Resolve the concrete item name for a dropped-item entity. Mineflayer parses
 * the item slot into `entity.metadata` keyed by metadata index; the value is
 * either a parsed Item instance (modern protocol with mcDataHasEntityMetadata)
 * or a raw slot object on older versions. We scan values for the first one
 * whose `.name` looks like a real MC id (anything other than the generic
 * 'item' / 'item_stack' label that's already on the entity itself).
 *
 * Returns `null` if the entity isn't a dropped item or the metadata hasn't
 * arrived yet — caller falls back to the generic 'item' label.
 *
 * @param {object} entity
 * @returns {string|null}
 */
export function droppedItemName(entity) {
  if (!entity) return null
  const generic = entity.name === 'item' || entity.name === 'item_stack'
  if (!generic) return null
  const meta = entity.metadata
  if (!meta) return null
  const values = Array.isArray(meta) ? meta : Object.values(meta)
  for (const v of values) {
    if (!v || typeof v !== 'object') continue
    if (typeof v.name === 'string' && v.name && v.name !== 'item' && v.name !== 'item_stack') {
      return v.name
    }
  }
  return null
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
 * @param {{ radius?:number, count?:number, pin?:string|null, pins?:string[] }} [opts]
 * @returns {{ entries: Array<{ entity:any, distance:number }>, more:number }}
 */
export function nearbyEntities(bot, opts = {}) {
  const radius = opts.radius ?? 24
  const count = opts.count ?? 6
  const requireLOS = opts.requireLineOfSight ?? false
  const pinSet = new Set()
  if (opts.pin) pinSet.add(opts.pin)
  for (const p of (opts.pins ?? [])) if (p) pinSet.add(p)
  const me = bot.entity
  if (!me) return { entries: [], more: 0 }
  const all = []
  for (const e of Object.values(bot.entities ?? {})) {
    if (!e || e === me) continue
    if (!e.position) continue
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
    if (requireLOS && !(e.username && pinSet.has(e.username)) &&
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
  if (pinSet.size > 0) {
    const isPinned = (e) => e && e.username && pinSet.has(e.username)
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
