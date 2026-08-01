// toolSelect (260731) — auto-equip before a dig.
//
// The bug this exists to prevent from coming back: nothing on the dig path ever
// equipped anything, so the bot mined stone bare-handed. That is 7500ms against
// dig.js's old flat 8000ms timeout (three consecutive "timeout digging stone"
// in the live log) AND it drops nothing, so gather('cobblestone') reported 0/N
// forever. mineflayer's canDigBlock never looks at the held item, so nothing
// upstream catches it either.
//
// The cases below are the ones that were wrong or that a naive fix gets wrong:
// picking a pickaxe over bare hands, NOT "upgrading" into a junk item that
// merely ties on speed, leaving a good tool alone, preferring the tool that
// makes the block DROP over a marginally faster one that does not, and never
// unequipping.

import { describe, it, expect, vi } from 'vitest'
import { chooseDigTool, shouldSwap, canHarvestWith, equipBestTool } from './toolSelect.js'

// Item type ids. digTime/canHarvest below key off these.
const HAND = null
const WOOD_PICK = 1
const STONE_PICK = 2
const DIRT = 3
const SHOVEL = 4

const item = (type, name) => ({ type, name, enchants: [] })

// A stone-like block: pickaxes harvest it and mine it fast, everything else
// (including bare hands) breaks it slowly and gets no drop.
const stone = {
  name: 'stone',
  canHarvest: (t) => t === WOOD_PICK || t === STONE_PICK,
  digTime: (t) => (t === STONE_PICK ? 1150 : t === WOOD_PICK ? 1900 : 7500),
}

// A dirt-like block: harvestable by hand, a shovel is just faster.
const dirt = {
  name: 'dirt',
  canHarvest: () => true,
  digTime: (t) => (t === SHOVEL ? 150 : 750),
}

function makeBot(held, inventory) {
  return {
    heldItem: held,
    game: { gameMode: 'survival' },
    entity: { onGround: true, effects: {} },
    inventory: { items: () => inventory, slots: [] },
    getEquipmentDestSlot: () => 5,
    _getBlockAtEyeLevel: () => ({ name: 'air' }),
    equip: vi.fn().mockResolvedValue(undefined),
  }
}

describe('chooseDigTool', () => {
  it('picks the pickaxe over bare hands for stone', () => {
    const bot = makeBot(null, [item(WOOD_PICK, 'wooden_pickaxe'), item(DIRT, 'dirt')])
    const best = chooseDigTool(bot, stone)
    expect(best.item?.name).toBe('wooden_pickaxe')
    expect(best.harvest).toBe(true)
  })

  it('prefers the tool that makes the block DROP over a faster one that does not', () => {
    // A hypothetical fast-but-non-harvesting item must lose: gather counts
    // items, so a swing that yields nothing is not progress.
    const fastNoDrop = { ...item(9, 'shears'), type: 9 }
    const oreish = {
      name: 'iron_ore',
      canHarvest: (t) => t === STONE_PICK,
      digTime: (t) => (t === 9 ? 100 : t === STONE_PICK ? 1500 : 15000),
    }
    const bot = makeBot(null, [fastNoDrop, item(STONE_PICK, 'stone_pickaxe')])
    const best = chooseDigTool(bot, oreish)
    expect(best.item?.name).toBe('stone_pickaxe')
  })

  it('does not "upgrade" bare hands into a junk item that only ties on speed', () => {
    // Every non-tool digs at exactly hand speed, so an ms-only comparison would
    // equip whatever sits first in the inventory. Bare hand is a real candidate.
    const bot = makeBot(null, [item(DIRT, 'dirt')])
    const best = chooseDigTool(bot, dirt)
    expect(shouldSwap(best, best.current)).toBe(false)
  })

  it('leaves the right tool alone when it is already held', () => {
    const pick = item(STONE_PICK, 'stone_pickaxe')
    const bot = makeBot(pick, [pick])
    const best = chooseDigTool(bot, stone)
    expect(shouldSwap(best, best.current)).toBe(false)
  })

  it('swaps a held non-tool out for the pickaxe (the live failure: holding dirt)', () => {
    const bot = makeBot(item(DIRT, 'dirt'), [item(DIRT, 'dirt'), item(WOOD_PICK, 'wooden_pickaxe')])
    const best = chooseDigTool(bot, stone)
    expect(shouldSwap(best, best.current)).toBe(true)
    expect(best.item.name).toBe('wooden_pickaxe')
  })

  it('never unequips: bare hands winning is not a swap', () => {
    expect(shouldSwap({ item: null, ms: 100, harvest: true }, { item: item(DIRT, 'dirt'), ms: 200, harvest: true }))
      .toBe(false)
  })

  it('ignores a marginal speed gain', () => {
    const a = { item: item(SHOVEL, 'a'), ms: 96, harvest: true }
    const b = { item: item(DIRT, 'b'), ms: 100, harvest: true }
    expect(shouldSwap(a, b)).toBe(false)
  })
})

describe('canHarvestWith', () => {
  it('reports stone as unharvestable bare-handed — the silent 0/N gather', () => {
    expect(canHarvestWith(stone, null)).toBe(false)
    expect(canHarvestWith(stone, item(WOOD_PICK, 'wooden_pickaxe'))).toBe(true)
  })

  it('defaults to harvestable when the block cannot say (a stub or an odd version)', () => {
    expect(canHarvestWith({ name: 'weird' }, null)).toBe(true)
  })
})

describe('equipBestTool', () => {
  it('equips to the hand and reports the improved dig time', async () => {
    const pick = item(STONE_PICK, 'stone_pickaxe')
    const bot = makeBot(null, [pick])
    const r = await equipBestTool(bot, stone, {})
    expect(bot.equip).toHaveBeenCalledWith(pick, 'hand')
    expect(r.equipped).toBe('stone_pickaxe')
    expect(r.ms).toBe(1150)
    expect(r.harvest).toBe(true)
  })

  it('is a no-op when nothing better is available, and still reports the truth', async () => {
    const bot = makeBot(null, [])
    const r = await equipBestTool(bot, stone, {})
    expect(bot.equip).not.toHaveBeenCalled()
    expect(r.equipped).toBe(null)
    expect(r.harvest).toBe(false)      // drives dig.js's "no drop" note
    expect(r.ms).toBe(7500)            // drives the derived timeout
  })

  it('a failing equip never blocks the dig', async () => {
    const bot = makeBot(null, [item(STONE_PICK, 'stone_pickaxe')])
    bot.equip = vi.fn().mockRejectedValue(new Error('slot busy'))
    const r = await equipBestTool(bot, stone, {})
    expect(r.equipped).toBe(null)
    expect(r.ms).toBe(7500)
  })

  it('respects an aborted signal', async () => {
    const bot = makeBot(null, [item(STONE_PICK, 'stone_pickaxe')])
    const r = await equipBestTool(bot, stone, { signal: { aborted: true } })
    expect(bot.equip).not.toHaveBeenCalled()
    expect(r.equipped).toBe(null)
  })
})
