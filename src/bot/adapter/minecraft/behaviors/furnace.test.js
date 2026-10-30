// Furnace 3-slot smelting (MCRAFT-01) — open + load input/fuel + take output.
// Mirrors the container/craft test mock style. Session is module-scoped, so a
// beforeEach closeFurnaceSession() resets the single-flight state between cases.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createRequire } from 'module'
import { EventEmitter } from 'events'
import {
  openFurnaceAction,
  smeltInputAction,
  addFuelAction,
  takeSmeltedAction,
  closeFurnaceSession,
  isSmeltResult,
} from './furnace.js'

const require = createRequire(import.meta.url)
const VERSION = '1.21.1'
const mcData = require('minecraft-data')(VERSION)
const id = (name) => mcData.itemsByName[name].id

function makeFurnace({ output = null, input = null, fuel = null, windowItems = null } = {}) {
  // An EventEmitter like mineflayer's window, so tests can emit 'close'.
  const f = Object.assign(new EventEmitter(), {
    slots: { input, fuel, output },
    putInput: vi.fn(async () => {}),
    putFuel: vi.fn(async () => {}),
    takeOutput: vi.fn(async () => { const o = f.slots.output; f.slots.output = null; return o }),
    takeInput: vi.fn(async () => { const it = f.slots.input; f.slots.input = null; return it }),
    inputItem: () => f.slots.input,
    fuelItem: () => f.slots.fuel,
    outputItem: () => f.slots.output,
    close: vi.fn(async () => {}),
  })
  if (windowItems) f.items = () => windowItems
  return f
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
    expect(res).toBe('opened furnace: input empty, fuel empty, output empty (not burning)')
    expect(bot.openFurnace).toHaveBeenCalledTimes(1)
  })

  it('returns "aborted" when the signal is already aborted', async () => {
    const c = new AbortController()
    c.abort()
    const bot = makeBot()
    expect(await openFurnaceAction({ block: 'furnace' }, bot, { signal: c.signal })).toBe('aborted')
  })

  it('keeps a successfully opened window open past the open timeout', async () => {
    vi.useFakeTimers()
    try {
      const furnace = makeFurnace()
      const c = new AbortController()
      await openFurnaceAction({ block: 'furnace' }, makeBot({ furnace }), { signal: c.signal })
      await vi.advanceTimersByTimeAsync(60_000)
      // The action's own signal aborting later must not close it either.
      c.abort()
      await vi.advanceTimersByTimeAsync(0)
      expect(furnace.close).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('closes a window that opens only after the timeout answered', async () => {
    vi.useFakeTimers()
    try {
      const furnace = makeFurnace()
      const bot = makeBot({ furnace })
      let release
      bot.openFurnace = vi.fn(() => new Promise((r) => { release = () => r(furnace) }))
      const p = openFurnaceAction({ block: 'furnace', timeout_ms: 1000 }, bot, {})
      await vi.advanceTimersByTimeAsync(1000)
      expect(await p).toBe('timeout')
      release()
      await vi.advanceTimersByTimeAsync(0)
      expect(furnace.close).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
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

  // 261011: iron ingots loaded as input read "smelting 6 iron_ingot".
  it('refuses an item that is already a smelting result and loads nothing', async () => {
    const furnace = makeFurnace()
    furnace.putInput = vi.fn(async () => {})
    await openFurnaceAction({ block: 'furnace' }, makeBot({ furnace }), {})
    const bot = makeBot({ items: [{ name: 'iron_ingot', count: 6 }], furnace })
    const res = await smeltInputAction({ item: 'iron_ingot', count: 6 }, bot, {})
    expect(res).toMatch(/^iron_ingot does not smelt into anything; nothing was loaded/)
    expect(furnace.putInput).not.toHaveBeenCalled()
  })

  it('isSmeltResult covers results and leaves real inputs alone', () => {
    for (const n of ['iron_ingot', 'gold_nugget', 'cooked_beef', 'coal', 'glass', 'oak_planks', 'smooth_stone']) expect(isSmeltResult(n)).toBe(true)
    for (const n of ['raw_iron', 'iron_ore', 'beef', 'sand', 'cobblestone', 'stone', 'oak_log', 'iron_sword', 'clay_ball']) expect(isSmeltResult(n)).toBe(false)
  })

  it('loads input and reports the count smelting', async () => {
    const furnace = makeFurnace()
    await openFurnaceAction({ block: 'furnace' }, makeBot({ furnace }), {})
    const bot = makeBot({ items: [{ name: 'raw_iron', count: 4 }], furnace })
    const res = await smeltInputAction({ item: 'raw_iron', count: 2 }, bot, {})
    expect(res).toBe('smelting 2 raw_iron; it needs fuel to start')
    expect(furnace.putInput).toHaveBeenCalledTimes(1)
    expect(furnace.putInput.mock.calls[0][0]).toBe(id('raw_iron'))
  })

  // 261011: quality eval 2026-10-11 — iron_ingot sitting in the input slot made
  // every later smeltInput(raw_iron) fail with a bare "destination full".
  it('takes a different item out of the input slot before loading', async () => {
    const furnace = makeFurnace({ input: { name: 'iron_ingot', count: 2 }, fuel: { name: 'coal', count: 1 } })
    await openFurnaceAction({ block: 'furnace' }, makeBot({ furnace }), {})
    const bot = makeBot({ items: [{ name: 'raw_iron', count: 3 }], furnace })
    const res = await smeltInputAction({ item: 'raw_iron', count: 3 }, bot, {})
    expect(furnace.takeInput).toHaveBeenCalledTimes(1)
    expect(res).toBe('took 2 iron_ingot back out of the input slot, then smelting 3 raw_iron')
  })

  // 261011: "crafted 4 oak_planks" then "no oak_planks to fuel" — the open
  // window holds the player's slots and bot.inventory lagged it.
  it('finds the item in the open furnace window when bot.inventory lags', async () => {
    const furnace = makeFurnace({ fuel: { name: 'coal', count: 1 }, windowItems: [{ name: 'raw_iron', type: id('raw_iron'), count: 2 }] })
    await openFurnaceAction({ block: 'furnace' }, makeBot({ furnace }), {})
    const bot = makeBot({ items: [], furnace })
    const res = await smeltInputAction({ item: 'raw_iron', count: 1 }, bot, {})
    expect(res).toBe('smelting 1 raw_iron')
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

  // 261011: oak_log onto a fuel slot holding oak_planks failed as "destination
  // full" three times in one session; the furnace was already fueled.
  it('reports the fuel already in the slot instead of failing on a different fuel', async () => {
    const furnace = makeFurnace({ fuel: { name: 'oak_planks', count: 3 } })
    await openFurnaceAction({ block: 'furnace' }, makeBot({ furnace }), {})
    const bot = makeBot({ items: [{ name: 'oak_log', count: 4 }], furnace })
    const res = await addFuelAction({ item: 'oak_log', count: 1 }, bot, {})
    expect(res).toBe('fuel slot already has 3 oak_planks, which burns first, so no oak_log was added')
    expect(furnace.putFuel).not.toHaveBeenCalled()
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
    expect(res).toBe('nothing smelted yet: input empty, fuel empty, output empty (not burning)')
  })

  // 261011: takeSmelted called 1-2s after loading came back "nothing smelted
  // yet" 12 of 16 times. While it is cooking, wait for the first item.
  it('waits for the first item while the furnace is cooking', async () => {
    vi.useFakeTimers()
    try {
      const furnace = makeFurnace({ input: { name: 'raw_iron', count: 3 }, fuel: { name: 'coal', count: 1 } })
      furnace.fuel = 0.9
      await openFurnaceAction({ block: 'furnace' }, makeBot({ furnace }), {})
      const p = takeSmeltedAction({}, makeBot({ furnace }), {})
      await vi.advanceTimersByTimeAsync(4000)
      furnace.slots.output = { name: 'iron_ingot', count: 1 }
      furnace.slots.input = { name: 'raw_iron', count: 2 }
      await vi.advanceTimersByTimeAsync(500)
      // 261026: it keeps collecting while the rest cooks.
      furnace.slots.output = { name: 'iron_ingot', count: 2 }
      furnace.slots.input = null
      await vi.advanceTimersByTimeAsync(500)
      expect(await p).toBe('took 3 iron_ingot')
      expect(furnace.takeOutput).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  // 261026 (quality pass 28): smelt_iron failed 2/5 when one ingot came out,
  // the rest was "still cooking", and the next turn walked off.
  it('stops collecting at the batch deadline and says what is still cooking', async () => {
    vi.useFakeTimers()
    try {
      const furnace = makeFurnace({ output: { name: 'iron_ingot', count: 1 }, input: { name: 'raw_iron', count: 5 }, fuel: { name: 'coal', count: 1 } })
      furnace.fuel = 0.9
      await openFurnaceAction({ block: 'furnace' }, makeBot({ furnace }), {})
      const p = takeSmeltedAction({}, makeBot({ furnace }), { takeSmelted_batch_ms: 20_000 })
      await vi.advanceTimersByTimeAsync(10_000)
      furnace.slots.output = { name: 'iron_ingot', count: 1 }
      furnace.slots.input = { name: 'raw_iron', count: 4 }
      await vi.advanceTimersByTimeAsync(11_000)
      expect(await p).toBe('took 2 iron_ingot (4 raw_iron still cooking)')
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports what it took when stopped mid-batch', async () => {
    vi.useFakeTimers()
    try {
      const furnace = makeFurnace({ output: { name: 'iron_ingot', count: 1 }, input: { name: 'raw_iron', count: 2 }, fuel: { name: 'coal', count: 1 } })
      furnace.fuel = 0.9
      await openFurnaceAction({ block: 'furnace' }, makeBot({ furnace }), {})
      const ac = new AbortController()
      const p = takeSmeltedAction({}, makeBot({ furnace }), { signal: ac.signal })
      await vi.advanceTimersByTimeAsync(2000)
      ac.abort()
      await vi.advanceTimersByTimeAsync(10)
      expect(await p).toBe('took 1 iron_ingot before stopping (2 raw_iron still cooking)')
      expect(furnace.close).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  // 261026 (pass 28 review): the tail is read from the final state, so fuel
  // running out mid-batch is not reported as "still cooking".
  it('says the rest is not cooking when the fuel runs out mid-batch', async () => {
    vi.useFakeTimers()
    try {
      const furnace = makeFurnace({ output: { name: 'iron_ingot', count: 1 }, input: { name: 'raw_iron', count: 3 } })
      furnace.fuel = 0.9
      await openFurnaceAction({ block: 'furnace' }, makeBot({ furnace }), {})
      const p = takeSmeltedAction({}, makeBot({ furnace }), {})
      await vi.advanceTimersByTimeAsync(1000)
      furnace.fuel = 0
      await vi.advanceTimersByTimeAsync(1000)
      expect(await p).toBe('took 1 iron_ingot; 3 raw_iron is left in the input but the furnace is not cooking (no fuel)')
    } finally {
      vi.useRealTimers()
    }
  })

  // A broken or out-of-reach furnace closes its window and its slots freeze,
  // so "cooking" would read true until the deadline.
  it('stops at once when the furnace window closes mid-batch', async () => {
    vi.useFakeTimers()
    try {
      const furnace = makeFurnace({ output: { name: 'iron_ingot', count: 1 }, input: { name: 'raw_iron', count: 3 }, fuel: { name: 'coal', count: 1 } })
      furnace.fuel = 0.9
      await openFurnaceAction({ block: 'furnace' }, makeBot({ furnace }), {})
      const p = takeSmeltedAction({}, makeBot({ furnace }), {})
      await vi.advanceTimersByTimeAsync(1000)
      furnace.emit('close')
      await vi.advanceTimersByTimeAsync(600)
      expect(await p).toBe('took 1 iron_ingot, then the furnace closed (broken or out of reach), so nothing more was collected')
      expect(furnace.listenerCount('close')).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('says the furnace closed when it closes before the first item', async () => {
    vi.useFakeTimers()
    try {
      const furnace = makeFurnace({ input: { name: 'raw_iron', count: 3 }, fuel: { name: 'coal', count: 1 } })
      furnace.fuel = 0.9
      await openFurnaceAction({ block: 'furnace' }, makeBot({ furnace }), {})
      const p = takeSmeltedAction({}, makeBot({ furnace }), {})
      await vi.advanceTimersByTimeAsync(1000)
      furnace.emit('close')
      await vi.advanceTimersByTimeAsync(600)
      expect(await p).toBe('the furnace closed (broken or out of reach) before anything was smelted')
    } finally {
      vi.useRealTimers()
    }
  })

  it('answers a stop at once while a take is still pending', async () => {
    vi.useFakeTimers()
    try {
      const furnace = makeFurnace({ output: { name: 'iron_ingot', count: 1 }, input: { name: 'raw_iron', count: 2 }, fuel: { name: 'coal', count: 1 } })
      furnace.fuel = 0.9
      const firstTake = furnace.takeOutput
      furnace.takeOutput = vi.fn(() => (furnace.takeOutput.mock.calls.length === 1 ? firstTake() : new Promise(() => {})))
      await openFurnaceAction({ block: 'furnace' }, makeBot({ furnace }), {})
      const ac = new AbortController()
      const p = takeSmeltedAction({}, makeBot({ furnace }), { signal: ac.signal })
      await vi.advanceTimersByTimeAsync(1000)
      furnace.slots.output = { name: 'iron_ingot', count: 1 }
      await vi.advanceTimersByTimeAsync(600)
      expect(furnace.takeOutput).toHaveBeenCalledTimes(2)
      ac.abort()
      await vi.advanceTimersByTimeAsync(10)
      expect(await p).toBe('took 1 iron_ingot before stopping (2 raw_iron still cooking)')
      expect(furnace.close).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('says an item is still in the output slot when a take mid-batch times out', async () => {
    vi.useFakeTimers()
    try {
      const furnace = makeFurnace({ output: { name: 'iron_ingot', count: 1 }, input: { name: 'raw_iron', count: 2 }, fuel: { name: 'coal', count: 1 } })
      furnace.fuel = 0.9
      const firstTake = furnace.takeOutput
      furnace.takeOutput = vi.fn(() => (furnace.takeOutput.mock.calls.length === 1 ? firstTake() : new Promise(() => {})))
      await openFurnaceAction({ block: 'furnace' }, makeBot({ furnace }), {})
      const p = takeSmeltedAction({ timeout_ms: 2000 }, makeBot({ furnace }), {})
      await vi.advanceTimersByTimeAsync(1000)
      furnace.slots.output = { name: 'iron_ingot', count: 1 }
      await vi.advanceTimersByTimeAsync(3000)
      expect(await p).toBe('took 1 iron_ingot; 1 iron_ingot is still in the output slot, taking it did not go through (2 raw_iron still cooking)')
    } finally {
      vi.useRealTimers()
    }
  })

  it('counts the wait for the first item against the one call budget', async () => {
    vi.useFakeTimers()
    try {
      const furnace = makeFurnace({ input: { name: 'raw_iron', count: 3 }, fuel: { name: 'coal', count: 1 } })
      furnace.fuel = 0.9
      await openFurnaceAction({ block: 'furnace' }, makeBot({ furnace }), {})
      let done = false
      const p = takeSmeltedAction({}, makeBot({ furnace }), { takeSmelted_batch_ms: 6000 }).then((r) => { done = true; return r })
      await vi.advanceTimersByTimeAsync(5000)
      furnace.slots.output = { name: 'iron_ingot', count: 1 }
      furnace.slots.input = { name: 'raw_iron', count: 2 }
      await vi.advanceTimersByTimeAsync(1600)
      expect(done).toBe(true)
      expect(await p).toBe('took 1 iron_ingot (2 raw_iron still cooking)')
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives up after the wait and reports the furnace state', async () => {
    vi.useFakeTimers()
    try {
      const furnace = makeFurnace({ input: { name: 'raw_iron', count: 1 }, fuel: { name: 'coal', count: 1 } })
      await openFurnaceAction({ block: 'furnace' }, makeBot({ furnace }), {})
      const p = takeSmeltedAction({}, makeBot({ furnace }), {})
      await vi.advanceTimersByTimeAsync(12_000)
      expect(await p).toBe('nothing smelted yet: input 1 raw_iron, fuel 1 coal, output empty (not burning)')
    } finally {
      vi.useRealTimers()
    }
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

// 261012 (pass 4a): the snapshot shows what was left cooking after the window
// closes (observers/progression.js furnaceLine reads bot._seiFurnaceCooking).
describe('what is left cooking', () => {
  it('records the input after loading and after a partial take, and clears it when emptied', async () => {
    const furnace = makeFurnace()
    const bot = makeBot({ items: [{ name: 'raw_iron', count: 3 }], furnace })
    await openFurnaceAction({ block: 'furnace' }, bot, {})
    expect(bot._seiFurnaceCooking).toBeNull()

    furnace.putInput = vi.fn(async () => { furnace.slots.input = { name: 'raw_iron', count: 3 } })
    await smeltInputAction({ item: 'raw_iron', count: 3 }, bot, {})
    expect(bot._seiFurnaceCooking).toMatchObject({ pos: [10, 64, 10], input: '3 raw_iron' })

    furnace.slots.output = { name: 'iron_ingot', count: 1 }
    furnace.slots.input = { name: 'raw_iron', count: 2 }
    furnace.takeOutput = vi.fn(async () => { const o = furnace.slots.output; furnace.slots.output = null; return o })
    // No fuel in this mock, so the rest is not cooking and the result says so.
    expect(await takeSmeltedAction({}, bot, {})).toBe('took 1 iron_ingot; 2 raw_iron is left in the input but the furnace is not cooking (no fuel)')
    expect(bot._seiFurnaceCooking).toMatchObject({ input: '2 raw_iron', output: null })

    furnace.slots.output = { name: 'iron_ingot', count: 2 }
    furnace.slots.input = null
    expect(await takeSmeltedAction({}, bot, {})).toBe('took 2 iron_ingot')
    expect(bot._seiFurnaceCooking).toBeNull()
  })
})
