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

// 261128 (quality pass 68): what an untagged pickup can still be. Vanilla
// Block.popResource spawns a broken block's drop at the block's center, up to
// 0.25 off on each axis and 0.125 lower (y fraction 0.125 to 0.625), and the
// spawn packet goes out right away. The block_update that turns the block to
// air goes out at the end of that tick, after it. A player's toss spawns at
// their eyes and flies about 0.3 a tick, so it never spawns far from them.
const BREAK_XZ = 0.3
const BREAK_Y_MIN = 0.1
const BREAK_Y_MAX = 0.65
const BREAK_BEFORE_MS = 500
const BREAK_AFTER_MS = 2000
const BREAK_KEEP_MS = 10_000
const BREAK_MAX = 64
/** Nobody else this close (horizontally) to where it spawned: not a toss. */
export const GROUND_PLAYER_RADIUS = 3

function isAirName(n) { return n === 'air' || n === 'cave_air' || n === 'void_air' }
const cellKey = (x, y, z) => `${x},${y},${z}`

/**
 * The mob whose drop an item that spawned at `pos` at time `at` is, or null.
 * 261128 (pass 68): read when she picks it up, not when it spawns. Vanilla
 * LivingEntity.die() drops the loot before it sends the death event (entity
 * status 3), so at the item's spawn the death is not known yet. In the 11-28
 * compare her own zombie kill's rotten flesh came out untagged.
 * @returns {{ kind: 'mob', name: string } | null}
 */
export function mobSourceAt(bot, pos, at = Date.now()) {
  if (!pos || ![pos.x, pos.y, pos.z].every(Number.isFinite)) return null
  let best = null
  const losses = bot?._seiRecentLosses
  if (losses && typeof losses.values === 'function') {
    for (const d of losses.values()) {
      if (!d?.died || !d.pos || !d.name) continue
      const age = at - d.at
      if (age < -500 || age > DROP_SPAWN_MS) continue
      const r = dist(d.pos, pos)
      if (r <= DROP_SPAWN_RADIUS && (!best || r < best.r)) best = { r, name: d.name }
    }
  }
  return best ? { kind: 'mob', name: best.name } : null
}

/**
 * The player who tossed an item that spawned at `pos`, from where they stand
 * now (call it at the spawn), or null. Never her own toss.
 * @returns {{ kind: 'player', name: string } | null}
 */
export function tossSourceAt(bot, pos) {
  if (!pos || ![pos.x, pos.y, pos.z].every(Number.isFinite)) return null
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

/**
 * Where an item that spawned at `pos` came from, or null when the game gives
 * no sign (a broken block, a /give, her own toss).
 * @returns {{ kind: 'mob', name: string } | { kind: 'player', name: string } | null}
 */
export function itemSourceAt(bot, pos, now = Date.now()) {
  return mobSourceAt(bot, pos, now) ?? tossSourceAt(bot, pos)
}

/** Is another player (not her) within GROUND_PLAYER_RADIUS of `pos`, horizontally? */
function otherPlayerNear(bot, pos) {
  const me = String(bot?.username ?? '').toLowerCase()
  for (const [name, p] of Object.entries(bot?.players ?? {})) {
    const ep = p?.entity?.position
    if (!ep || String(name).toLowerCase() === me) continue
    if (Math.hypot(ep.x - pos.x, ep.z - pos.z) <= GROUND_PLAYER_RADIUS) return true
  }
  return false
}

/** Did an item at `pos` (spawned at `at`) drop from a block that broke right there? */
function brokenBlockDrop(breaks, pos, at) {
  const x = Math.floor(pos.x), y = Math.floor(pos.y), z = Math.floor(pos.z)
  const t = breaks.get(cellKey(x, y, z))
  if (t == null || t < at - BREAK_BEFORE_MS || t > at + BREAK_AFTER_MS) return false
  const fy = pos.y - y
  return Math.abs(pos.x - x - 0.5) <= BREAK_XZ && Math.abs(pos.z - z - 0.5) <= BREAK_XZ && fy >= BREAK_Y_MIN && fy <= BREAK_Y_MAX
}

/**
 * The source of an item she picked up, from what was kept at its spawn.
 * A mob's drop, a player's toss, or 'ground' only with a sign of it: a block
 * that broke right where it spawned, or nobody else near enough to have
 * thrown it. Anything else stays null (the inventory banner, whose reasons
 * include a hand-over): a toss we placed wrong must not lose its thanks.
 */
function resolveSource(bot, breaks, rec) {
  return mobSourceAt(bot, rec.pos, rec.at) ??
    rec.toss ??
    ((rec.lonely || brokenBlockDrop(breaks, rec.pos, rec.at)) ? { kind: 'ground', name: '' } : null)
}

/** Start tagging item spawns and keeping her pickups of tagged items. */
export function trackItemSources(bot) {
  if (!bot || bot._seiItemSources || typeof bot.on !== 'function') return
  trackEntityDeaths(bot)
  const tags = new Map()
  const pickups = []
  const breaks = new Map()
  bot._seiItemSources = { tags, pickups, breaks }
  try {
    bot.on('blockUpdate', (oldBlock, newBlock) => {
      try {
        const p = newBlock?.position
        if (!p || !oldBlock || isAirName(oldBlock.name) || !isAirName(newBlock.name)) return
        const now = Date.now()
        breaks.set(cellKey(p.x, p.y, p.z), now)
        if (breaks.size > BREAK_MAX) {
          for (const [k, t] of breaks) if (now - t > BREAK_KEEP_MS || breaks.size > BREAK_MAX) breaks.delete(k)
        }
      } catch { /* ignore */ }
    })
    bot.on('entitySpawn', (e) => {
      try {
        if (!isItem(e) || e.id == null) return
        const p = e.position
        if (!p || ![p.x, p.y, p.z].every(Number.isFinite)) return
        const now = Date.now()
        // 261128 (quality pass 68): kept for the pickup to resolve (see
        // resolveSource). Untagged, a dirt block broken on her follow hit the
        // loud inventory banner, whose reasons start with "the player handed
        // you something", and right after she gave the player 6 logs she
        // thanked them with "you're the one who gave me the logs" (11-28
        // scorecard work_session-02). The banner says something happened that
        // did not. A /give lands in the inventory without a pickup, so it
        // still reaches the banner.
        const pos = { x: p.x, y: p.y, z: p.z }
        tags.set(e.id, { pos, at: now, toss: tossSourceAt(bot, pos), lonely: !otherPlayerNear(bot, pos) })
        if (tags.size > TAG_MAX) {
          for (const [id, t] of tags) if (now - t.at > TAG_TTL_MS || tags.size > TAG_MAX) tags.delete(id)
        }
      } catch { /* never let an observer throw into the event loop */ }
    })
    bot.on('playerCollect', (collector, collected) => {
      try {
        if (collector?.id == null || collector.id !== bot.entity?.id || collected?.id == null) return
        const rec = tags.get(collected.id)
        if (!rec) return
        tags.delete(collected.id)
        const src = resolveSource(bot, breaks, rec)
        if (!src) return
        const item = droppedItemName(collected)?.name
        if (!item) return
        const now = Date.now()
        pickups.push({ item, kind: src.kind, name: src.name, at: now })
        while (pickups.length > PICKUP_MAX || (pickups.length && now - pickups[0].at > PICKUP_KEEP_MS)) pickups.shift()
      } catch { /* ignore */ }
    })
  } catch { /* a stub bot without events */ }
}

/**
 * The source of each item she picked up since `sinceMs`, by item name. An
 * item picked up from two different sources in the window has no single
 * source and is left out.
 * @returns {Map<string, { kind: 'mob'|'player'|'ground', name: string }>}
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
