// Furnace 3-slot smelting (MCRAFT-01) — open + load input/fuel + take output.
// Mirrors the container/craft test mock style. Session is module-scoped, so a
// beforeEach closeFurnaceSession() resets the single-flight state between cases.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createRequire } from 'module'
import {
  openFurnaceAction,
  smeltInputAction,
  addFuelAction,
  takeSmeltedAction,
  closeFurnaceSession,
} from './furnace.js'

const require = createRequire(import.meta.url)
const VERSION = '1.21.1'
const mcData = require('minecraft-data')(VERSION)
const id = (name) => mcData.itemsByName[name].id

function makeFurnace({ output = null } = {}) {
  return {
    putInput: vi.fn(async () => {}),
    putFuel: vi.fn(async () => {}),
    takeOutput: vi.fn(async () => output),
    inputItem: () => null,
    fuelItem: () => null,
    outputItem: () => output,
    close: vi.fn(async () => {}),
  }
}

const FURNACE_BLOCK = { name: 'furnace', position: { x: 10, y: 64, z: 10 } }

function makeBot({ items = [], block = FURNACE_BLOCK, furnace = makeFurnace() } = {}) {
  const stacks = items.map((it) => ({ name: it.name, type: id(it.name), count: it.count }))
  return {
    version: VERSION,
    entity: { position: { x: 10, y: 64, z: 11, distanceTo: () => 1 } },
    inventory: { items: () => stacks },
    blockAt: () => block,
    findBlock: () => block,
    openFurnace: vi.fn(async () => furnace),
  }
}

beforeEach(async () => {
  await closeFurnaceSession()
})

describe('openFurnaceAction', () => {
  it('returns "no target" when no furnace block resolves', async () => {
    const bot = makeBot({ block: null })
    const res = await openFurnaceAction({ block: 'furnace' }, bot, {})
    expect(res).toBe('no target')
  })

  it('returns "out of reach" style string when the furnace is too far', async () => {
    const bot = makeBot()
    bot.entity.position.distanceTo = () => 9
    const res = await openFurnaceAction({ block: 'furnace' }, bot, {})
    expect(res).toMatch(/out of reach/i)
  })

  it('opens a reachable furnace and stores the session', async () => {
    const furnace = makeFurnace()
    const bot = makeBot({ furnace })
    const res = await openFurnaceAction({ block: 'furnace' }, bot, {})
    expect(res).toBe('opened furnace')
    expect(bot.openFurnace).toHaveBeenCalledTimes(1)
  })

  it('returns "aborted" when the signal is already aborted', async () => {
    const c = new AbortController()
    c.abort()
    const bot = makeBot()
    expect(await openFurnaceAction({ block: 'furnace' }, bot, { signal: c.signal })).toBe('aborted')
  })
})

describe('smeltInputAction', () => {
  it('returns "no furnace open" when no session is active', async () => {
    const bot = makeBot({ items: [{ name: 'raw_iron', count: 4 }] })
    const res = await smeltInputAction({ item: 'raw_iron', count: 1 }, bot, {})
    expect(res).toBe('no furnace open')
  })

  it('returns "no <item> to smelt" when the item is not in inventory', async () => {
    const furnace = makeFurnace()
    await openFurnaceAction({ block: 'furnace' }, makeBot({ furnace }), {})
    const bot = makeBot({ items: [], furnace })
    const res = await smeltInputAction({ item: 'raw_iron', count: 1 }, bot, {})
    expect(res).toBe('no raw_iron to smelt')
  })

  it('loads input and reports the count smelting', async () => {
    const furnace = makeFurnace()
    await openFurnaceAction({ block: 'furnace' }, makeBot({ furnace }), {})
    const bot = makeBot({ items: [{ name: 'raw_iron', count: 4 }], furnace })
    const res = await smeltInputAction({ item: 'raw_iron', count: 2 }, bot, {})
    expect(res).toBe('smelting 2 raw_iron')
    expect(furnace.putInput).toHaveBeenCalledTimes(1)
    expect(furnace.putInput.mock.calls[0][0]).toBe(id('raw_iron'))
  })
})

describe('addFuelAction', () => {
  it('loads fuel and reports it', async () => {
    const furnace = makeFurnace()
    await openFurnaceAction({ block: 'furnace' }, makeBot({ furnace }), {})
    const bot = makeBot({ items: [{ name: 'coal', count: 8 }], furnace })
    const res = await addFuelAction({ item: 'coal', count: 1 }, bot, {})
    expect(res).toBe('added 1 coal fuel')
    expect(furnace.putFuel).toHaveBeenCalledTimes(1)
  })

  it('returns "no <item> to fuel" when the fuel item is absent', async () => {
    const furnace = makeFurnace()
    await openFurnaceAction({ block: 'furnace' }, makeBot({ furnace }), {})
    const bot = makeBot({ items: [], furnace })
    const res = await addFuelAction({ item: 'coal', count: 1 }, bot, {})
    expect(res).toBe('no coal to fuel')
  })
})

describe('takeSmeltedAction', () => {
  it('returns "nothing smelted yet" when the output slot is empty', async () => {
    const furnace = makeFurnace({ output: null })
    await openFurnaceAction({ block: 'furnace' }, makeBot({ furnace }), {})
    const res = await takeSmeltedAction({}, makeBot({ furnace }), {})
    expect(res).toBe('nothing smelted yet')
  })

  it('returns "took N <item>" when the output is ready', async () => {
    const furnace = makeFurnace({ output: { name: 'iron_ingot', count: 3, type: id('iron_ingot') } })
    await openFurnaceAction({ block: 'furnace' }, makeBot({ furnace }), {})
    const res = await takeSmeltedAction({}, makeBot({ furnace }), {})
    expect(res).toBe('took 3 iron_ingot')
    expect(furnace.takeOutput).toHaveBeenCalledTimes(1)
  })

  it('returns "no furnace open" when no session is active', async () => {
    const res = await takeSmeltedAction({}, makeBot(), {})
    expect(res).toBe('no furnace open')
  })
})

describe('closeFurnaceSession', () => {
  it('closes the open furnace and clears the session', async () => {
    const furnace = makeFurnace()
    await openFurnaceAction({ block: 'furnace' }, makeBot({ furnace }), {})
    await closeFurnaceSession()
    expect(furnace.close).toHaveBeenCalledTimes(1)
    // After close, slot ops report no open furnace.
    expect(await takeSmeltedAction({}, makeBot(), {})).toBe('no furnace open')
  })
})
