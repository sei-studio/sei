// 261012 (quality pass 5): action results wait for the server's answer.
//  - the snapshot inventory reads the open window's slots (furnace session)
//  - craft counts what actually arrived, retries once when the server undid
//    it, and says so when it never went through
//  - placeBlock checks the cell after the server has answered
//  - furnace slot ops check that the item moved

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createRequire } from 'module'
import { craftAction } from './craft.js'
import { placeBlockAction } from './place.js'
import { openFurnaceAction, addFuelAction, takeSmeltedAction, closeFurnaceSession } from './furnace.js'
import { liveInventoryItems, waitInventoryQuiet } from '../observers/liveInventory.js'
import { inventory } from '../observers/inventory.js'
import { maxRepetitions, __resetCraftableCache } from '../observers/craftable.js'

vi.mock('./pathfind.js', () => ({ goTo: vi.fn(async () => 'reached') }))

const require = createRequire(import.meta.url)
const VERSION = '1.21.1'
const mcData = require('minecraft-data')(VERSION)
const Recipe = require('prismarine-recipe')(VERSION).Recipe
const id = (name) => mcData.itemsByName[name].id

// An inventory that emits updateSlot like prismarine-windows does.
function liveInv(counts) {
  const inv = new EventEmitter()
  inv.counts = new Map(Object.entries(counts).map(([n, c]) => [id(n), c]))
  inv.items = () => [...inv.counts].filter(([, c]) => c > 0).map(([type, count]) => ({ type, count, name: mcData.items[type].name }))
  inv.add = (name, d) => { inv.counts.set(id(name), (inv.counts.get(id(name)) ?? 0) + d); inv.emit('updateSlot', 0) }
  return inv
}

function craftBot(counts, craft) {
  const inv = liveInv(counts)
  const bot = {
    version: VERSION,
    entity: { position: { x: 0, y: 64, z: 0 } },
    inventory: inv,
    findBlock: () => null,
    recipesFor: (itemId, meta, min, table) => Recipe.find(itemId, meta)
      .filter((r) => (!r.requiresTable || table) && maxRepetitions(r, inv.counts) * (r.result?.count ?? 1) >= (min ?? 1)),
    recipesAll: (itemId, meta, table) => Recipe.find(itemId, meta).filter((r) => !r.requiresTable || table),
  }
  bot.craft = vi.fn((recipe, reps) => craft(bot, recipe, reps))
  return bot
}

// The client's prediction: the recipe's delta applied at once.
const apply = (bot, recipe, reps, sign = 1) => {
  for (const d of recipe.delta ?? []) bot.inventory.counts.set(d.id, (bot.inventory.counts.get(d.id) ?? 0) + sign * d.count * reps)
  bot.inventory.emit('updateSlot', 0)
}

beforeEach(() => __resetCraftableCache())

describe('liveInventory', () => {
  it('reads the open window, not the stale bot.inventory', () => {
    const bot = {
      inventory: { items: () => [{ name: 'raw_iron', count: 3 }] },
      currentWindow: { items: () => [{ name: 'iron_ingot', count: 3 }] },
    }
    expect(liveInventoryItems(bot)).toEqual([{ name: 'iron_ingot', count: 3 }])
    expect(inventory(bot)).toEqual({ iron_ingot: 3 })
    bot.currentWindow = null
    expect(inventory(bot)).toEqual({ raw_iron: 3 })
  })

  it('waitInventoryQuiet waits out a burst of slot updates', async () => {
    const inv = liveInv({ oak_log: 1 })
    const t0 = Date.now()
    const p = waitInventoryQuiet({ inventory: inv }, { quietMs: 60, maxMs: 1000 })
    for (const ms of [20, 40, 60]) setTimeout(() => inv.emit('updateSlot', 1), ms)
    expect(await p).toBe('quiet')
    expect(Date.now() - t0).toBeGreaterThanOrEqual(110)
  })

  it('is a no-op for a bot without a live inventory', async () => {
    expect(await waitInventoryQuiet({ inventory: { items: () => [] } })).toBe('n/a')
  })
})

describe('craft waits for the server', () => {
  it('a craft the server undoes is retried once and then reported as made', async () => {
    let calls = 0
    const bot = craftBot({ oak_planks: 8 }, async (b, recipe, reps) => {
      calls += 1
      apply(b, recipe, reps)
      // the first one is rolled back 80 ms later
      if (calls === 1) setTimeout(() => apply(b, recipe, reps, -1), 80)
    })
    const res = await craftAction({ item: 'crafting_table' }, bot, {})
    expect(bot.craft).toHaveBeenCalledTimes(2)
    expect(res).toMatch(/^crafted 1 crafting_table; it is in your inventory/)
    expect(bot.inventory.counts.get(id('crafting_table'))).toBe(1)
  })

  it('says the craft did not go through when the server undoes both tries', async () => {
    const bot = craftBot({ oak_planks: 8 }, async (b, recipe, reps) => {
      apply(b, recipe, reps)
      setTimeout(() => apply(b, recipe, reps, -1), 50)
    })
    const res = await craftAction({ item: 'crafting_table' }, bot, {})
    expect(res).toMatch(/^the craft of crafting_table did not go through: the server put the materials back twice, and you have 0 crafting_table/)
  })

  it('a craft that sticks is reported once, with no retry', async () => {
    const bot = craftBot({ oak_log: 1 }, async (b, recipe, reps) => apply(b, recipe, reps))
    const res = await craftAction({ item: 'oak_planks', count: 4 }, bot, {})
    expect(res).toBe('crafted 4 oak_planks')
    expect(bot.craft).toHaveBeenCalledTimes(1)
  })
})

describe('placeBlock checks the cell', () => {
  function placeBot({ sticks, item = 'crafting_table', placed = item, consumes = true, oldCell = null }) {
    const inv = liveInv({ [item]: 1 })
    const cells = new Map()
    const key = (p) => `${p.x},${p.y},${p.z}`
    const ground = { name: 'barrier', position: { x: 5, y: 70, z: 0 } }
    const bot = {
      version: VERSION,
      entity: { position: { x: 4, y: 71, z: 0 } },
      inventory: inv,
      equip: vi.fn(async () => {}),
      blockAt: (p) => cells.get(key(p)) ?? (p.y <= 70 ? { name: 'stone', position: p } : { name: 'air', position: p }),
      placeBlock: vi.fn(async (ref, face) => {
        const dest = { x: ref.position.x + face.x, y: ref.position.y + face.y, z: ref.position.z + face.z }
        cells.set(key(dest), { name: placed, position: dest })
        if (consumes) inv.add(item, -1)
        if (!sticks) setTimeout(() => { if (oldCell) cells.set(key(dest), { name: oldCell, position: dest }); else cells.delete(key(dest)); if (consumes) inv.add(item, 1) }, 60)
      }),
    }
    if (oldCell) cells.set(key({ x: 5, y: 71, z: 0 }), { name: oldCell, position: { x: 5, y: 71, z: 0 } })
    return { bot, ground }
  }

  it('a placement the server keeps is reported as placed', async () => {
    const { bot, ground } = placeBot({ sticks: true })
    const res = await placeBlockAction({ block: 'crafting_table', against: { ...ground.position }, faceVector: { x: 0, y: 1, z: 0 } }, bot, {})
    expect(res).toMatch(/^placed crafting_table on/)
  })

  it('a placement the server undoes is reported as not done', async () => {
    const { bot, ground } = placeBot({ sticks: false })
    // resolveBlock reads blockAt for a position handle
    const res = await placeBlockAction({ block: 'crafting_table', against: { ...ground.position }, faceVector: { x: 0, y: 1, z: 0 } }, bot, {})
    expect(res).toMatch(/did not go through: the spot is still empty and the crafting_table is still in your inventory/)
  })

  it('a block named unlike its item that stuck is placed even when the count did not drop', async () => {
    const { bot, ground } = placeBot({ sticks: true, item: 'torch', placed: 'wall_torch', consumes: false })
    const res = await placeBlockAction({ block: 'torch', against: { ...ground.position }, faceVector: { x: 0, y: 1, z: 0 } }, bot, {})
    expect(res).toMatch(/^placed torch on/)
  })

  it('a placement into grass the server undoes is reported as not done', async () => {
    const { bot, ground } = placeBot({ sticks: false, oldCell: 'short_grass' })
    const res = await placeBlockAction({ block: 'crafting_table', against: { ...ground.position }, faceVector: { x: 0, y: 1, z: 0 } }, bot, {})
    expect(res).toMatch(/did not go through: the spot holds short_grass/)
  })
})

describe('furnace slot ops check the item moved', () => {
  beforeEach(async () => { await closeFurnaceSession() })

  function furnaceBot({ fuelSticks, takeSticks }) {
    const inv = liveInv({ coal: 2 })
    const slots = { input: { name: 'raw_iron', count: 3 }, fuel: null, output: { name: 'iron_ingot', count: 2 } }
    const furnace = {
      inputItem: () => slots.input,
      fuelItem: () => slots.fuel,
      outputItem: () => slots.output,
      putFuel: vi.fn(async () => {
        inv.add('coal', -1); slots.fuel = { name: 'coal', count: 1 }
        if (!fuelSticks) setTimeout(() => { inv.add('coal', 1); slots.fuel = null }, 50)
      }),
      takeOutput: vi.fn(async () => {
        const it = slots.output
        inv.add('iron_ingot', it.count); slots.output = null
        if (!takeSticks) setTimeout(() => { inv.add('iron_ingot', -it.count); slots.output = it }, 50)
        return it
      }),
      close: vi.fn(async () => {}),
    }
    const block = { name: 'furnace', position: { x: 1, y: 64, z: 0 } }
    const bot = {
      version: VERSION,
      entity: { position: { x: 0, y: 64, z: 0, distanceTo: () => 1 } },
      inventory: inv,
      blockAt: () => block,
      findBlock: () => block,
      openFurnace: vi.fn(async () => furnace),
    }
    return { bot }
  }

  it('addFuel and takeSmelted report what stuck', async () => {
    const { bot } = furnaceBot({ fuelSticks: true, takeSticks: true })
    expect(await openFurnaceAction({ block: 'furnace' }, bot, {})).toMatch(/^opened furnace/)
    expect(await addFuelAction({ item: 'coal', count: 1 }, bot, {})).toBe('added 1 coal fuel')
    expect(await takeSmeltedAction({}, bot, { takeSmelted_batch_ms: 0 })).toBe('took 2 iron_ingot (3 raw_iron still cooking)')
  })

  it('addFuel and takeSmelted say so when the server undid them', async () => {
    const { bot } = furnaceBot({ fuelSticks: false, takeSticks: false })
    await openFurnaceAction({ block: 'furnace' }, bot, {})
    expect(await addFuelAction({ item: 'coal', count: 1 }, bot, {})).toMatch(/^adding coal fuel did not go through/)
    expect(await takeSmeltedAction({}, bot, {})).toMatch(/^taking the iron_ingot did not go through; it is still in the furnace/)
  })
})
