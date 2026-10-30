// craft(item, n) behavior — success, batch overshoot reporting, table-access
// guidance, not-enough-materials, unknown item, abort.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createRequire } from 'module'
import { craftAction, placeNote } from './craft.js'
import { goTo } from './pathfind.js'

vi.mock('./pathfind.js', () => ({ goTo: vi.fn(async () => 'reached') }))
import { maxRepetitions, __resetCraftableCache } from '../observers/craftable.js'

const require = createRequire(import.meta.url)
const VERSION = '1.21.1'
const mcData = require('minecraft-data')(VERSION)
const Recipe = require('prismarine-recipe')(VERSION).Recipe
const id = (name) => mcData.itemsByName[name].id
const blockId = (name) => mcData.blocksByName[name].id

function makeBot({ items = [], table = null, craft } = {}) {
  // A live inventory: the default craft applies the recipe's delta, so a
  // multi-step craft (parts first) sees what the earlier steps made.
  const invCount = new Map()
  for (const it of items) invCount.set(id(it.name), (invCount.get(id(it.name)) ?? 0) + it.count)
  const stacks = () => [...invCount].filter(([, n]) => n > 0)
    .map(([type, count]) => ({ name: mcData.items[type].name, type, count }))
  const applyCraft = vi.fn(async (recipe, reps) => {
    for (const d of recipe.delta ?? []) invCount.set(d.id, (invCount.get(d.id) ?? 0) + d.count * reps)
  })
  return {
    version: VERSION,
    entity: { position: { x: 0, y: 64, z: 0 } },
    inventory: { items: stacks },
    findBlock: ({ matching }) => (table && matching === blockId('crafting_table') ? table : null),
    recipesFor: (itemId, meta, minResultCount, craftingTable) =>
      Recipe.find(itemId, meta).filter((r) => {
        if (r.requiresTable && !craftingTable) return false
        return maxRepetitions(r, invCount) * (r.result?.count ?? 1) >= (minResultCount ?? 1)
      }),
    recipesAll: (itemId, meta, craftingTable) =>
      Recipe.find(itemId, meta).filter((r) => !r.requiresTable || craftingTable),
    craft: craft ?? applyCraft,
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
    expect(res).toBe('crafted 1 chest; it is in your inventory, not placed yet (placeBlock chest to put it down)')
    expect(craft).toHaveBeenCalledTimes(1)
  })

  it('reports not-enough-materials when inventory is short', async () => {
    const bot = makeBot({ items: [] })
    const res = await craftAction({ item: 'oak_planks', count: 1 }, bot, {})
    expect(res).toMatch(/not enough materials/i)
  })

  it('names the wood the bot already has when it is short on planks', async () => {
    // 2026-10-11 eval: holding 2 oak_planks, a crafting_table was refused
    // with "need 4x cherry_planks".
    const bot = makeBot({ items: [{ name: 'oak_planks', count: 2 }, { name: 'stick', count: 4 }] })
    const res = await craftAction({ item: 'crafting_table' }, bot, {})
    expect(res).toBe('not enough materials to craft crafting_table: need 2 more oak_planks (have 2)')
  })

  it('crafts the parts first when the bag has the raw wood (261011)', async () => {
    // 2 planks + 6 logs used to be refused with "you can craft it from what
    // you have"; now the planks are made on the way.
    const bot = makeBot({ items: [{ name: 'oak_planks', count: 2 }, { name: 'oak_log', count: 6 }] })
    const res = await craftAction({ item: 'crafting_table' }, bot, {})
    expect(res).toBe('crafted 1 crafting_table, made 4 oak_planks for it first; it is in your inventory, not placed yet (placeBlock crafting_table to put it down)')
    expect(bot.craft).toHaveBeenCalledTimes(2)
  })

  it('makes planks AND sticks for a pickaxe from logs alone (261011)', async () => {
    const bot = makeBot({ items: [{ name: 'oak_log', count: 2 }], table: { name: 'crafting_table' } })
    const res = await craftAction({ item: 'wooden_pickaxe' }, bot, {})
    expect(res).toMatch(/^crafted 1 wooden_pickaxe, made .*oak_planks.*stick.* for it first$/)
    const names = bot.inventory.items().map((i) => i.name)
    expect(names).toContain('wooden_pickaxe')
    expect(names).not.toContain('cherry_planks')
  })

  it('crafts nothing when the whole chain does not fit the bag (261011)', async () => {
    // One log = 4 planks; a pickaxe needs 3 planks + 2 sticks (1 plank more).
    const bot = makeBot({ items: [{ name: 'oak_log', count: 1 }], table: { name: 'crafting_table' } })
    const res = await craftAction({ item: 'wooden_pickaxe' }, bot, {})
    expect(res).toMatch(/^not enough materials to craft wooden_pickaxe: need 3 more oak_planks \(you can craft it from what you have\)/)
    expect(bot.craft).not.toHaveBeenCalled()
  })

  it('says to place the table it is carrying when none is in reach (261011)', async () => {
    const bot = makeBot({ items: [{ name: 'oak_planks', count: 8 }, { name: 'crafting_table', count: 1 }] })
    const res = await craftAction({ item: 'chest', count: 1 }, bot, {})
    expect(res).toMatch(/You have one in your inventory: place it/)
  })

  it('names the missing count for one ingredient of a multi-ingredient recipe', async () => {
    const bot = makeBot({ items: [{ name: 'oak_planks', count: 2 }, { name: 'stick', count: 2 }], table: { name: 'crafting_table' } })
    const res = await craftAction({ item: 'wooden_pickaxe' }, bot, {})
    expect(res).toBe('not enough materials to craft wooden_pickaxe: need 1 more oak_planks (have 2)')
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

  it('walks to a crafting table close by instead of refusing (261011)', async () => {
    const bot = makeBot({ items: [{ name: 'oak_planks', count: 8 }] })
    const far = { name: 'crafting_table', position: { x: 8, y: 64, z: 0 } }
    let walked = false
    bot.findBlock = ({ maxDistance }) => (walked || maxDistance >= 16 ? far : null)
    goTo.mockImplementationOnce(async () => { walked = true; return 'reached' })
    const res = await craftAction({ item: 'chest', count: 1 }, bot, {})
    expect(goTo).toHaveBeenCalledWith(bot, 8, 64, 0, 2, expect.any(Number), undefined, { reach: 3.5 })
    expect(res).toBe('crafted 1 chest; it is in your inventory, not placed yet (placeBlock chest to put it down)')
  })
})

describe('craft with a copy already in the bag (261025)', () => {
  // Eval: inventory oak_planks 3, oak_log 3, wooden_pickaxe 1, and craft
  // wooden_pickaxe answered "need 2 more stick" in 23ms. The plan counted the
  // pickaxe she already had, so it made no parts.
  const T = { name: 'crafting_table' }
  const bag = (o) => Object.entries(o).map(([name, count]) => ({ name, count }))

  it('makes the sticks it needs for a second pickaxe', async () => {
    const bot = makeBot({ items: bag({ oak_planks: 3, oak_log: 3, wooden_pickaxe: 1 }), table: T })
    const res = await craftAction({ item: 'wooden_pickaxe', count: 1 }, bot, {})
    expect(res).toBe('crafted 1 wooden_pickaxe, made 4 oak_planks, 4 stick for it first')
  })

  it('makes the planks it needs for a second pickaxe', async () => {
    const bot = makeBot({ items: bag({ stick: 4, oak_log: 9, oak_planks: 1, wooden_pickaxe: 1 }), table: T })
    const res = await craftAction({ item: 'wooden_pickaxe', count: 1 }, bot, {})
    expect(res).toBe('crafted 1 wooden_pickaxe, made 4 oak_planks for it first')
  })
})

describe('the table the walk reached (261025)', () => {
  it('uses a table within reach of her eyes when the feet test misses it', async () => {
    const bot = makeBot({ items: [{ name: 'oak_planks', count: 8 }] })
    const table = { name: 'crafting_table', position: { x: 3, y: 66, z: 0 } }
    // The feet-based detection (4m) never sees it; the walk radius does.
    bot.findBlock = ({ maxDistance }) => (maxDistance >= 16 ? table : null)
    bot.blockAt = (p) => (p.x === 3 && p.y === 66 && p.z === 0 ? table : null)
    bot.entity.position = { x: 0.5, y: 64, z: 0.5 }
    goTo.mockImplementationOnce(async () => 'reached')
    const res = await craftAction({ item: 'chest', count: 1 }, bot, {})
    expect(res).toMatch(/^crafted 1 chest/)
  })
})

describe('placeNote (261011)', () => {
  it('says a crafted station is still in the bag', () => {
    expect(placeNote('furnace')).toContain('not placed yet (placeBlock furnace')
    expect(placeNote('red_bed')).toContain('placeBlock red_bed')
    expect(placeNote('oak_planks')).toBe('')
    expect(placeNote('stone_pickaxe')).toBe('')
  })
})
