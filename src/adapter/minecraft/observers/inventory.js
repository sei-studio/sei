// src/observers/inventory.js — pure functions of bot state
/**
 * @param {import('mineflayer').Bot} bot
 * @returns {{ name:string, durability:{current:number,max:number}|null } | null}
 */
export function heldItem(bot) {
  const it = bot.heldItem
  if (!it) return null
  // mineflayer Item has maxDurability; durabilityUsed gives wear; current = max - used
  const max = typeof it.maxDurability === 'number' ? it.maxDurability : null
  const used = typeof it.durabilityUsed === 'number' ? it.durabilityUsed : 0
  const durability = max != null && max > 0 ? { current: max - used, max } : null
  return { name: it.name, durability }
}

/**
 * Stack-summarized inventory: { itemName: totalCount }.
 * @param {import('mineflayer').Bot} bot
 * @returns {Record<string, number>}
 */
export function inventory(bot) {
  const out = {}
  const items = typeof bot.inventory?.items === 'function' ? bot.inventory.items() : []
  for (const it of items) {
    if (!it || !it.name) continue
    out[it.name] = (out[it.name] ?? 0) + (it.count ?? 0)
  }
  return out
}
