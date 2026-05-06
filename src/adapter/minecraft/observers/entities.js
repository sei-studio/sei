// src/observers/entities.js — pure function of bot state
/**
 * Find nearby entities, closest-first, excluding self.
 * @param {import('mineflayer').Bot} bot
 * @param {{ radius?:number, count?:number }} [opts]
 * @returns {{ entries: Array<{ entity:any, distance:number }>, more:number }}
 */
export function nearbyEntities(bot, opts = {}) {
  const radius = opts.radius ?? 24
  const count = opts.count ?? 6
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
  const entries = all.slice(0, count)
  const more = Math.max(0, all.length - entries.length)
  return { entries, more }
}
