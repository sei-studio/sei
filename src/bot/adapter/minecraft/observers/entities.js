// src/observers/entities.js — pure function of bot state

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
 * @param {import('mineflayer').Bot} bot
 * @param {{ radius?:number, count?:number, pin?:string|null }} [opts]
 * @returns {{ entries: Array<{ entity:any, distance:number }>, more:number }}
 */
export function nearbyEntities(bot, opts = {}) {
  const radius = opts.radius ?? 24
  const count = opts.count ?? 6
  const pin = opts.pin ?? null
  const me = bot.entity
  if (!me) return { entries: [], more: 0 }
  const all = []
  for (const e of Object.values(bot.entities ?? {})) {
    if (!e || e === me) continue
    if (!e.position) continue
    const d = e.position.distanceTo(me.position)
    if (d > radius) continue
    all.push({ entity: e, distance: d })
  }
  all.sort((a, b) => a.distance - b.distance)
  let entries = all.slice(0, count)
  let more = Math.max(0, all.length - entries.length)
  // Player-priority pin: if the pinned username is within radius but got
  // sliced off by the count cap, force-include it by displacing the farthest
  // currently-visible non-pinned entry. `more` is unchanged — the same
  // number of entities is hidden, just a different one. Naive "concat +
  // re-sort + re-slice" would just drop the pin again (it's at rank > count
  // by definition); we explicitly evict by max distance among non-pins.
  if (pin && entries.length === count) {
    const inEntries = entries.some(({ entity }) => entity.username === pin)
    if (!inEntries) {
      const pinEntry = all.find(({ entity }) => entity.username === pin)
      if (pinEntry) {
        // Find the farthest non-pin entry to evict.
        let evictIdx = -1
        let evictDist = -Infinity
        for (let i = 0; i < entries.length; i++) {
          if (entries[i].entity.username === pin) continue
          if (entries[i].distance > evictDist) {
            evictDist = entries[i].distance
            evictIdx = i
          }
        }
        if (evictIdx >= 0) entries.splice(evictIdx, 1)
        entries.push(pinEntry)
        entries.sort((a, b) => a.distance - b.distance)
      }
    }
  }
  return { entries, more }
}
