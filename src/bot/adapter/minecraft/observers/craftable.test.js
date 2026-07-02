// Craftable enumeration + count + table-gating + cache.
//
// Uses REAL minecraft-data / prismarine-recipe via a mineflayer-shaped bot stub
// (recipesFor delegates to prismarine-recipe, the same way mineflayer does), so
// the recipe math is exercised against ground-truth data rather than fakes.

import { describe, it, expect, beforeEach } from 'vitest'
import { createRequire } from 'module'
import {
  getCraftableEntries,
  detectCraftingTable,
  maxRepetitions,
  __resetCraftableCache,
  CRAFT_TABLE_REACH,
} from './craftable.js'

const require = createRequire(import.meta.url)
const VERSION = '1.21.1'
const mcData = require('minecraft-data')(VERSION)
const Recipe = require('prismarine-recipe')(VERSION).Recipe

const id = (name) => mcData.itemsByName[name].id
const blockId = (name) => mcData.blocksByName[name].id

// A bot stub whose recipesFor mirrors mineflayer's: it returns prismarine-recipe
// Recipe instances filtered by current inventory + table availability.
function makeBot({ items = [], table = null } = {}) {
  const stacks = items.map((it) => ({ name: it.name, type: id(it.name), count: it.count }))
  const invCount = new Map()
  for (const s of stacks) invCount.set(s.type, (invCount.get(s.type) ?? 0) + s.count)
  return {
    version: VERSION,
    entity: { position: { x: 0, y: 64, z: 0 } },
    inventory: { items: () => stacks },
    findBlock: ({ matching, maxDistance }) =>
      table && maxDistance >= table.dist && matching === blockId('crafting_table') ? table.block : null,
    recipesFor: (itemId, meta, minResultCount, craftingTable) =>
      Recipe.find(itemId, meta).filter((r) => {
        if (r.requiresTable && !craftingTable) return false
        // enough materials for at least minResultCount?
        const reps = maxRepetitions(r, invCount)
        return reps * (r.result?.count ?? 1) >= (minResultCount ?? 1)
      }),
  }
}

const tableBlock = { name: 'crafting_table' }

beforeEach(() => __resetCraftableCache())

describe('maxRepetitions', () => {
  it('divides inventory by consumed ingredient counts', () => {
    const planks = Recipe.find(id('oak_planks'), null)[0] // 1 log -> 4 planks
    const inv = new Map([[id('oak_log'), 3]])
    expect(maxRepetitions(planks, inv)).toBe(3) // 3 logs -> 3 reps -> 12 planks
  })
  it('is 0 when an ingredient is missing', () => {
    const planks = Recipe.find(id('oak_planks'), null)[0]
    expect(maxRepetitions(planks, new Map())).toBe(0)
  })
})

describe('detectCraftingTable', () => {
  it('returns the block when one is within reach', () => {
    const bot = makeBot({ table: { block: tableBlock, dist: CRAFT_TABLE_REACH } })
    expect(detectCraftingTable(bot)).toBe(tableBlock)
  })
  it('returns null when none is near', () => {
    expect(detectCraftingTable(makeBot())).toBeNull()
  })
  it('never throws on a barebones stub', () => {
    expect(detectCraftingTable({})).toBeNull()
  })
})

describe('getCraftableEntries', () => {
  it('lists 2×2 recipes craftable from inventory with correct counts', () => {
    const bot = makeBot({ items: [{ name: 'oak_log', count: 2 }] })
    const { entries, nearTable } = getCraftableEntries(bot)
    expect(nearTable).toBe(false)
    const planks = entries.find((e) => e.name === 'oak_planks')
    expect(planks).toBeTruthy()
    expect(planks.count).toBe(8) // 2 logs × 4 planks
    // crafting_table is a 2×2 recipe (4 planks) — but we only hold logs, not
    // planks yet, so it should NOT appear from a bare-log inventory.
    expect(entries.some((e) => e.name === 'crafting_table')).toBe(false)
  })

  it('unlocks 3×3 recipes only when a table is in reach', () => {
    const items = [{ name: 'oak_planks', count: 8 }]
    const without = getCraftableEntries(makeBot({ items }))
    expect(without.entries.some((e) => e.name === 'chest')).toBe(false)

    __resetCraftableCache()
    const withTable = getCraftableEntries(
      makeBot({ items, table: { block: tableBlock, dist: CRAFT_TABLE_REACH } }),
    )
    expect(withTable.nearTable).toBe(true)
    expect(withTable.entries.some((e) => e.name === 'chest')).toBe(true) // 8 planks, 3×3
  })

  it('returns empty (never throws) for a bot lacking recipesFor', () => {
    expect(getCraftableEntries({ version: VERSION }).entries).toEqual([])
  })

  it('caches until the inventory signature changes', () => {
    let calls = 0
    const base = makeBot({ items: [{ name: 'oak_log', count: 1 }] })
    const bot = { ...base, recipesFor: (...a) => { calls++; return base.recipesFor(...a) } }
    getCraftableEntries(bot)
    const after = calls
    getCraftableEntries(bot) // identical inventory + table state → served from cache
    expect(calls).toBe(after)
  })
})
