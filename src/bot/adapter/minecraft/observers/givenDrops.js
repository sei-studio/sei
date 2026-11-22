// 261017 (pass 14): items she tossed to the player with give().
//
// give() tosses at the player's feet, and in the scripted eval the player
// did not always walk over them. The next pickup (or a gather's drop sweep)
// then collected the same logs back, and she told the player their errand
// was done. So pickup and the sweep leave a toss alone for a few minutes, and
// the snapshot labels it as given.
//
// 261017 (pass 14b): a toss is tracked by the ids of the item entities that
// spawn at her during the toss, not by name and position. Matching on
// position also caught logs she chopped near the give spot, and an item
// whose stack did not decode was labelled as the given item.

import { droppedItemName } from './entities.js'

export const GIVEN_DROP_TTL_MS = 5 * 60_000
/** A tossed item spawns at her eyes; anything spawning farther off is not hers. */
export const TOSS_SPAWN_RADIUS = 3
/** The spawn packet can arrive a little after the toss itself resolves. */
export const TOSS_SETTLE_MS = 1500
const MAX_TOSSES = 8

function plain(p) {
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return null
  return { x: p.x, y: p.y, z: p.z }
}

function dist(a, b) {
  const dx = a.x - b.x
  const dy = a.y - b.y
  const dz = a.z - b.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

function isItem(e) {
  return !!e && (e.name === 'item' || e.name === 'item_stack' || e.displayName === 'Item')
}

function liveTosses(bot, now) {
  return (Array.isArray(bot._seiGivenDrops) ? bot._seiGivenDrops : []).filter((g) => now - g.ts < GIVEN_DROP_TTL_MS)
}

/**
 * Start watching for the item entities a toss spawns. Call before the toss;
 * then `commit(count)` once it dropped something, or `cancel()` if it did not.
 * @param {object} bot
 * @param {{ item: string, from?: {x:number,y:number,z:number}, to?: string }} toss
 */
export function beginGivenToss(bot, toss) {
  const origin = plain(toss?.from)
  if (!bot || !toss?.item || !origin || typeof bot.on !== 'function') {
    return { commit() {}, cancel() {} }
  }
  const rec = { item: String(toss.item), count: 0, to: toss.to ?? null, ids: new Set(), ts: Date.now() }
  const onSpawn = (e) => {
    if (!isItem(e) || e.id == null || !e.position) return
    if (dist(e.position, origin) > TOSS_SPAWN_RADIUS) return
    const name = droppedItemName(e)?.name
    if (name && name !== rec.item) return
    rec.ids.add(e.id)
  }
  bot.on('entitySpawn', onSpawn)
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    bot.removeListener?.('entitySpawn', onSpawn)
  }
  return {
    commit(count, settleMs = TOSS_SETTLE_MS) {
      const now = Date.now()
      rec.count = Number(count) || 1
      rec.ts = now
      bot._seiGivenDrops = [...liveTosses(bot, now), rec].slice(-MAX_TOSSES)
      const t = setTimeout(close, settleMs)
      t?.unref?.()
    },
    cancel: close,
  }
}

/**
 * The toss an item entity came from, or null when it is not one of hers.
 * @returns {{ item: string, count: number, to: string|null }|null}
 */
export function givenDropFor(bot, entity, now = Date.now()) {
  const list = Array.isArray(bot?._seiGivenDrops) ? bot._seiGivenDrops : null
  if (!list?.length || entity?.id == null) return null
  for (let i = list.length - 1; i >= 0; i--) {
    const g = list[i]
    if (now - g.ts >= GIVEN_DROP_TTL_MS) continue
    if (!g.ids?.has(entity.id)) continue
    // Ids are reused across sessions on some servers; a stack that now reads
    // as something else is not the toss.
    const name = droppedItemName(entity)?.name
    if (name && name !== g.item) return null
    return g
  }
  return null
}




