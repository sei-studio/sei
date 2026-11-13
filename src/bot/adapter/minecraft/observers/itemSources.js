// 261113 (quality pass 54): where an item she picked up came from.
//
// combat_night free play (11-12 scorecard, dev 38d818a2): she killed a zombie,
// walked over its rotten flesh and said "thanks for the rotten flesh lol"
// (01 L8); "alex you just gave me rotten flesh lol" (02 L10); "thanks for
// the string" after her own spider kill (02 L42). Her snapshot showed the
// pickup under the loud inventory banner, whose reasons start with "the
// player handed you something", and the session record kept "2 rotten_flesh
// came into your inventory without an action of yours (handed to you or
// picked up)". Nothing said which.
//
// The game does say it. A mob's drops spawn where it died, on its death tick,
// and an item a player throws spawns at their eyes (eye height minus 0.3).
// So an item entity is tagged when it spawns, and a pickup of a tagged item
// (mineflayer's playerCollect with her as the collector) is kept with its
// source for the snapshot composer to read.

import { droppedItemName, trackEntityDeaths } from './entities.js'

/** Drops spawn on the death tick; the packets can arrive a little apart. */
export const DROP_SPAWN_MS = 2500
/** How far from where the mob died its drops can spawn. */
export const DROP_SPAWN_RADIUS = 2.5
/** A thrown item spawns this far below a standing player's eyes (1.62 - 0.3). */
const TOSS_HEIGHT = 1.32
const TOSS_HEIGHT_SNEAK = 0.97
/** Our copy of a moving player's position can lag a tick behind. */
const TOSS_RADIUS = 0.8
const TAG_TTL_MS = 5 * 60_000
const TAG_MAX = 256
export const PICKUP_KEEP_MS = 60_000
const PICKUP_MAX = 32

function isItem(e) {
  return !!e && (e.name === 'item' || e.name === 'item_stack' || e.displayName === 'Item')
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

/**
 * Where an item that spawned at `pos` came from, or null when the game gives
 * no sign (a broken block, a /give, her own toss).
 * @returns {{ kind: 'mob', name: string } | { kind: 'player', name: string } | null}
 */
export function itemSourceAt(bot, pos, now = Date.now()) {
  if (!pos || ![pos.x, pos.y, pos.z].every(Number.isFinite)) return null
  let best = null
  const losses = bot?._seiRecentLosses
  if (losses && typeof losses.values === 'function') {
    for (const d of losses.values()) {
      if (!d?.died || !d.pos || !d.name) continue
      const age = now - d.at
      if (age < -500 || age > DROP_SPAWN_MS) continue
      const r = dist(d.pos, pos)
      if (r <= DROP_SPAWN_RADIUS && (!best || r < best.r)) best = { r, name: d.name }
    }
  }
  if (best) return { kind: 'mob', name: best.name }
  const me = String(bot?.username ?? '').toLowerCase()
  for (const [name, p] of Object.entries(bot?.players ?? {})) {
    const ep = p?.entity?.position
    if (!ep || String(name).toLowerCase() === me) continue
    const flat = Math.hypot(ep.x - pos.x, ep.z - pos.z)
    if (flat > TOSS_RADIUS) continue
    const dy = pos.y - ep.y
    if (Math.abs(dy - TOSS_HEIGHT) <= 0.35 || Math.abs(dy - TOSS_HEIGHT_SNEAK) <= 0.2) return { kind: 'player', name }
  }
  return null
}

/** Start tagging item spawns and keeping her pickups of tagged items. */
export function trackItemSources(bot) {
  if (!bot || bot._seiItemSources || typeof bot.on !== 'function') return
  trackEntityDeaths(bot)
  const tags = new Map()
  const pickups = []
  bot._seiItemSources = { tags, pickups }
  try {
    bot.on('entitySpawn', (e) => {
      try {
        if (!isItem(e) || e.id == null) return
        const now = Date.now()
        const src = itemSourceAt(bot, e.position, now)
        if (!src) return
        tags.set(e.id, { ...src, at: now })
        if (tags.size > TAG_MAX) {
          for (const [id, t] of tags) if (now - t.at > TAG_TTL_MS || tags.size > TAG_MAX) tags.delete(id)
        }
      } catch { /* never let an observer throw into the event loop */ }
    })
    bot.on('playerCollect', (collector, collected) => {
      try {
        if (collector?.id == null || collector.id !== bot.entity?.id || collected?.id == null) return
        const tag = tags.get(collected.id)
        if (!tag) return
        tags.delete(collected.id)
        const item = droppedItemName(collected)?.name
        if (!item) return
        const now = Date.now()
        pickups.push({ item, kind: tag.kind, name: tag.name, at: now })
        while (pickups.length > PICKUP_MAX || (pickups.length && now - pickups[0].at > PICKUP_KEEP_MS)) pickups.shift()
      } catch { /* ignore */ }
    })
  } catch { /* a stub bot without events */ }
}

/**
 * The source of each item she picked up since `sinceMs`, by item name. An
 * item picked up from two different sources in the window has no single
 * source and is left out.
 * @returns {Map<string, { kind: 'mob'|'player', name: string }>}
 */
export function pickupSourcesSince(bot, sinceMs) {
  const out = new Map()
  const mixed = new Set()
  const list = bot?._seiItemSources?.pickups
  if (!Array.isArray(list)) return out
  for (const p of list) {
    if (sinceMs != null && p.at < sinceMs) continue
    const prev = out.get(p.item)
    if (prev && (prev.kind !== p.kind || prev.name !== p.name)) mixed.add(p.item)
    else out.set(p.item, { kind: p.kind, name: p.name })
  }
  for (const item of mixed) out.delete(item)
  return out
}
