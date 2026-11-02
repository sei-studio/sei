// src/bot/adapter/minecraft/observers/workItems.js
//
// 261102 (quality pass 37): which items an action works toward, and how many
// of them she carries now. The brain keeps the player's asks open until a
// hand-over lands (pass 32, orchestrator openAsks); with these it knows WHAT
// each ask was about, so the arrival note and the delivery line can name the
// coal she fetched instead of "look back at what they asked you for". In the
// 11-02 scorecard that vague note had her hand over called-off logs while the
// coal stayed in her bag (errands-02), and a stop that ended a log run still
// left the logs owed (work_session-01).

import { resolveTerm } from '../loose-terms.js'
import { dropItemsFor } from '../behaviors/mineVein.js'
import { liveInventoryItems } from './liveInventory.js'

// A loose term ("wood") expands to every variant; past this many it says
// nothing useful about one ask.
const MAX_TERMS = 16

function dropsOf(bot, term) {
  const t = String(term ?? '').toLowerCase().trim()
  if (!t) return []
  const out = new Set()
  for (const block of resolveTerm(t).slice(0, MAX_TERMS)) {
    const drops = dropItemsFor(bot, block)
    if (drops.length) for (const d of drops) out.add(d)
    else out.add(block)
  }
  // gather("coal") names the item, not the block it comes from.
  out.add(t)
  return [...out]
}

// What a furnace input cooks into (smeltInput names only the input). An input
// left out here just names no item.
const SMELTS = {
  raw_iron: 'iron_ingot', raw_gold: 'gold_ingot', raw_copper: 'copper_ingot',
  iron_ore: 'iron_ingot', deepslate_iron_ore: 'iron_ingot',
  gold_ore: 'gold_ingot', deepslate_gold_ore: 'gold_ingot', nether_gold_ore: 'gold_ingot',
  copper_ore: 'copper_ingot', deepslate_copper_ore: 'copper_ingot',
  ancient_debris: 'netherite_scrap',
  sand: 'glass', red_sand: 'glass', cobblestone: 'stone', stone: 'smooth_stone',
  clay_ball: 'brick', netherrack: 'nether_brick', cactus: 'green_dye', kelp: 'dried_kelp',
  potato: 'baked_potato', wet_sponge: 'sponge', chorus_fruit: 'popped_chorus_fruit',
  beef: 'cooked_beef', porkchop: 'cooked_porkchop', chicken: 'cooked_chicken', mutton: 'cooked_mutton',
  rabbit: 'cooked_rabbit', cod: 'cooked_cod', salmon: 'cooked_salmon',
}
export function smeltProductOf(input) {
  const n = String(input ?? '').toLowerCase().trim()
  if (SMELTS[n]) return SMELTS[n]
  // Logs and wood (stripped or not) burn to charcoal; nether stems do not.
  if (/_(log|wood)$/.test(n)) return 'charcoal'
  return null
}

/**
 * Item names an action brings into her bag when it works: a gather, dig or
 * find target's drops, the item a craft, pickup or withdraw names, and what a
 * smeltInput cooks into.
 * [] for anything else (walking, following, building, a dig by coordinates).
 * @param {object} bot
 * @param {string} name
 * @param {Record<string, unknown>} [args]
 * @returns {string[]}
 */
export function workItemsFor(bot, name, args) {
  const a = args && typeof args === 'object' ? args : {}
  switch (name) {
    case 'gather':
    case 'find':
      return typeof a.name === 'string' ? dropsOf(bot, a.name) : []
    case 'dig':
      return typeof a.block === 'string' && a.to == null ? dropsOf(bot, a.block) : []
    case 'craft':
    case 'pickup':
    case 'withdrawItem':
      return typeof a.item === 'string' && a.item.trim() ? [a.item.toLowerCase().trim()] : []
    case 'smeltInput': {
      const out = smeltProductOf(a.item)
      return out ? [out] : []
    }
    default:
      return []
  }
}

/**
 * How many of each named item she carries now (names with none are left out).
 * @param {object} bot
 * @param {string[]} names
 * @returns {Record<string, number>}
 */
export function carriedCounts(bot, names) {
  const want = new Set((Array.isArray(names) ? names : []).map((n) => String(n)))
  const out = {}
  if (!want.size) return out
  for (const it of liveInventoryItems(bot)) {
    if (!it || !want.has(it.name)) continue
    out[it.name] = (out[it.name] ?? 0) + (Number(it.count) || 0)
  }
  return out
}
