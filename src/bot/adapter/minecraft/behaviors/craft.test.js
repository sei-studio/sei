// craft(item, n) behavior — success, batch overshoot reporting, table-access
// guidance, not-enough-materials, unknown item, abort.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createRequire } from 'module'
import { craftAction } from './craft.js'
import { maxRepetitions, __resetCraftableCache } from '../observers/craftable.js'

const require = createRequire(import.meta.url)
const VERSION = '1.21.1'
const mcData = require('minecraft-data')(VERSION)
const Recipe = require('prismarine-recipe')(VERSION).Recipe
const id = (name) => mcData.itemsByName[name].id
const blockId = (name) => mcData.blocksByName[name].id

function makeBot({ items = [], table = null, craft } = {}) {
  const stacks = items.map((it) => ({ name: it.name, type: id(it.name), count: it.count }))
  const invCount = new Map()
  for (const s of stacks) invCount.set(s.type, (invCount.get(s.type) ?? 0) + s.count)
  return {
    version: VERSION,
    entity: { position: { x: 0, y: 64, z: 0 } },
    inventory: { items: () => stacks },
    findBlock: ({ matching }) => (table && matching === blockId('crafting_table') ? table : null),
    recipesFor: (itemId, meta, minResultCount, craftingTable) =>
      Recipe.find(itemId, meta).filter((r) => {
        if (r.requiresTable && !craftingTable) return false
        return maxRepetitions(r, invCount) * (r.result?.count ?? 1) >= (minResultCount ?? 1)
      }),
    craft: craft ?? vi.fn(async () => {}),
  }
}

beforeEach(() => __resetCraftableCache())

describe('craftAction', () => {
  it('crafts and reports the actual produced count (batch overshoot)', async () => {
    const craft = vi.fn(async () => {})
    const bot = makeBot({ items: [{ name: 'oak_log', count: 4 }], craft })
    // Ask for 2 planks; recipe makes 4 per log → 1 rep → 4 produced.
    const res = await craftAction({ item: 'oak_planks', count: 2 }, bot, {})
    expect(res).toBe('crafted 4 oak_planks (recipe makes 4 at a time)')
    expect(craft).toHaveBeenCalledTimes(1)
    expect(craft.mock.calls[0][1]).toBe(1) // reps = ceil(2/4) = 1
  })

  it('crafts multiple repetitions when more product is requested', async () => {
    const craft = vi.fn(async () => {})
    const bot = makeBot({ items: [{ name: 'oak_log', count: 4 }], craft })
    const res = await craftAction({ item: 'oak_planks', count: 9 }, bot, {})
    // ceil(9/4) = 3 reps → 12 produced, capped by 4 logs available.
    expect(res).toBe('crafted 12 oak_planks (recipe makes 4 at a time)')
    expect(craft.mock.calls[0][1]).toBe(3)
  })

  it('guides to a table for a 3×3 recipe when none is in reach', async () => {
    const bot = makeBot({ items: [{ name: 'oak_planks', count: 8 }] })
    const res = await craftAction({ item: 'chest', count: 1 }, bot, {})
    expect(res).toMatch(/needs a crafting table/i)
  })

  it('crafts a 3×3 recipe when a table is in reach', async () => {
    const craft = vi.fn(async () => {})
    const bot = makeBot({ items: [{ name: 'oak_planks', count: 8 }], table: { name: 'crafting_table' }, craft })
    const res = await craftAction({ item: 'chest', count: 1 }, bot, {})
    expect(res).toBe('crafted 1 chest')
    expect(craft).toHaveBeenCalledTimes(1)
  })

  it('reports not-enough-materials when inventory is short', async () => {
    const bot = makeBot({ items: [] })
    const res = await craftAction({ item: 'oak_planks', count: 1 }, bot, {})
    expect(res).toMatch(/not enough materials/i)
  })

  it('rejects an unknown item name', async () => {
    const bot = makeBot({ items: [{ name: 'oak_log', count: 1 }] })
    const res = await craftAction({ item: 'not_a_real_item', count: 1 }, bot, {})
    expect(res).toMatch(/no item named/i)
  })

  it('returns "aborted" when the signal is already aborted', async () => {
    const c = new AbortController()
    c.abort()
    const bot = makeBot({ items: [{ name: 'oak_log', count: 1 }] })
    expect(await craftAction({ item: 'oak_planks' }, bot, { signal: c.signal })).toBe('aborted')
  })
})
