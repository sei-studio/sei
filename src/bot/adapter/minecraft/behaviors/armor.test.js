// 261111 (user feedback ae9a758e): "Sui won't put on or use what I give her"
// and "she doesn't know what copper armor is" (Minecraft 26.3).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import mcDataLib from 'minecraft-data'
import prismarineRegistry from 'prismarine-registry'
import prismarineBlock from 'prismarine-block'
import {
  armorSlotFor, armorScore, armorUpgrades, wearBestArmor, startAutoArmor, takeOffWorn, wornArmor,
} from './armor.js'
import { equipAction } from './equip.js'
import { dropItemAction } from './drop.js'
import { weaponScore, chooseWeapon } from './weaponSelect.js'
import { fixToolMaterials } from '../registryFixes.js'
import { createSnapshotComposer, wornLineFor } from '../observers/snapshot.js'
import { worldPrimer, COPPER_GEAR_FACT, WORLD_PRIMER } from '../../../brain/promptLibrary.js'

const SLOT = { head: 5, torso: 6, legs: 7, feet: 8, 'off-hand': 45 }

/** A bot with mineflayer's slot layout: 5-8 armor, 9-44 bag, 45 off hand. */
function fakeBot(bag = []) {
  const inventory = new EventEmitter()
  inventory.slots = new Array(46).fill(null)
  bag.forEach((it, i) => { inventory.slots[9 + i] = { count: 1, ...it, slot: 9 + i } })
  inventory.items = () => inventory.slots.slice(9, 45).filter(Boolean)
  const bot = new EventEmitter()
  Object.assign(bot, {
    inventory,
    getEquipmentDestSlot: (d) => SLOT[d],
    equip: vi.fn(async (item, dest) => {
      const to = SLOT[dest]
      const from = inventory.slots.indexOf(item)
      const prev = inventory.slots[to]
      inventory.slots[to] = item
      inventory.slots[from] = prev
      inventory.emit('updateSlot', to)
    }),
    unequip: vi.fn(async (dest) => {
      const to = SLOT[dest]
      const it = inventory.slots[to]
      const free = inventory.slots.findIndex((s, i) => i >= 9 && i < 45 && !s)
      inventory.slots[free] = it
      inventory.slots[to] = null
      inventory.emit('updateSlot', free)
    }),
  })
  return bot
}

const give = (bot, item) => {
  const free = bot.inventory.slots.findIndex((s, i) => i >= 9 && i < 45 && !s)
  bot.inventory.slots[free] = { count: 1, ...item, slot: free }
  bot.inventory.emit('updateSlot', free)
}
const worn = (bot) => wornArmor(bot).map((w) => w.item.name)

afterEach(() => { vi.useRealTimers() })

describe('armor ranking', () => {
  it('knows every piece slot, copper included', () => {
    expect(armorSlotFor('copper_helmet')).toBe('head')
    expect(armorSlotFor('copper_chestplate')).toBe('torso')
    expect(armorSlotFor('copper_leggings')).toBe('legs')
    expect(armorSlotFor('copper_boots')).toBe('feet')
    expect(armorSlotFor('turtle_helmet')).toBe('head')
    expect(armorSlotFor('elytra')).toBeNull()
    expect(armorSlotFor('copper_sword')).toBeNull()
  })

  it('puts copper between leather and iron', () => {
    expect(armorScore('copper_chestplate')).toBeGreaterThan(armorScore('leather_chestplate'))
    expect(armorScore('copper_chestplate')).toBeLessThan(armorScore('iron_chestplate'))
    expect(armorScore('netherite_helmet')).toBeGreaterThan(armorScore('diamond_helmet'))
    expect(armorScore('modded_helmet')).toBe(0)
  })

  it('picks only strict upgrades and leaves unknown worn items on', () => {
    const bot = fakeBot([{ name: 'copper_helmet' }, { name: 'copper_chestplate' }, { name: 'iron_boots' }])
    bot.inventory.slots[5] = { name: 'iron_helmet' } // same points as copper: keep
    bot.inventory.slots[6] = { name: 'elytra' } // not armor: never swapped
    expect(armorUpgrades(bot).map((u) => [u.slot, u.item.name])).toEqual([['feet', 'iron_boots']])
  })

  it('skips a piece with the curse of binding', () => {
    const bot = fakeBot([{ name: 'diamond_helmet', enchants: [{ name: 'binding_curse', lvl: 1 }] }])
    expect(armorUpgrades(bot)).toEqual([])
  })
})

describe('wearing what she is given', () => {
  it('puts on the copper set a player hands her', async () => {
    vi.useFakeTimers()
    const bot = fakeBot()
    startAutoArmor(bot)
    await vi.advanceTimersByTimeAsync(600)
    for (const name of ['copper_helmet', 'copper_chestplate', 'copper_leggings', 'copper_boots']) give(bot, { name })
    await vi.advanceTimersByTimeAsync(600)
    expect(worn(bot)).toEqual(['copper_helmet', 'copper_chestplate', 'copper_leggings', 'copper_boots'])
    expect(bot.inventory.items()).toEqual([])
  })

  it('swaps in a better piece and keeps the old one in the bag', async () => {
    const bot = fakeBot([{ name: 'diamond_chestplate' }])
    bot.inventory.slots[6] = { name: 'copper_chestplate' }
    expect(await wearBestArmor(bot)).toEqual(['diamond_chestplate'])
    expect(worn(bot)).toEqual(['diamond_chestplate'])
    expect(bot.inventory.items().map((i) => i.name)).toEqual(['copper_chestplate'])
  })

  it('waits while paused or a chest is open, then puts it on', async () => {
    vi.useFakeTimers()
    const bot = fakeBot()
    bot._seiPaused = true
    startAutoArmor(bot)
    give(bot, { name: 'iron_helmet' })
    await vi.advanceTimersByTimeAsync(2000)
    expect(worn(bot)).toEqual([])
    bot._seiPaused = false
    bot.currentWindow = { id: 3 }
    await vi.advanceTimersByTimeAsync(2000)
    expect(worn(bot)).toEqual([])
    bot.currentWindow = null
    await vi.advanceTimersByTimeAsync(2000)
    expect(worn(bot)).toEqual(['iron_helmet'])
  })

  it('does not put a piece back on after she takes it off to hand it over', async () => {
    vi.useFakeTimers()
    const bot = fakeBot()
    bot.inventory.slots[8] = { name: 'copper_boots' }
    startAutoArmor(bot)
    await vi.advanceTimersByTimeAsync(600)
    expect(await takeOffWorn(bot, 'copper_boots', 1)).toBe(1)
    await vi.advanceTimersByTimeAsync(3000)
    expect(worn(bot)).toEqual([])
    expect(bot.inventory.items().map((i) => i.name)).toEqual(['copper_boots'])
  })

  it('a stopped watcher does nothing', async () => {
    vi.useFakeTimers()
    const bot = fakeBot()
    const stop = startAutoArmor(bot)
    stop()
    give(bot, { name: 'iron_helmet' })
    await vi.advanceTimersByTimeAsync(3000)
    expect(worn(bot)).toEqual([])
  })
})

describe('equip and drop with armor', () => {
  it('sends armor to its own slot whatever destination the model passed', async () => {
    const bot = fakeBot([{ name: 'copper_chestplate' }])
    expect(await equipAction({ item: 'copper_chestplate', destination: 'hand' }, bot, {})).toBe('put on copper_chestplate')
    expect(bot.equip).toHaveBeenCalledWith(expect.objectContaining({ name: 'copper_chestplate' }), 'torso')
  })

  it('says she already wears it instead of "no X in inventory"', async () => {
    const bot = fakeBot()
    bot.inventory.slots[5] = { name: 'copper_helmet' }
    expect(await equipAction({ item: 'copper_helmet', destination: 'head' }, bot, {})).toBe('already wearing copper_helmet')
    expect(await equipAction({ item: 'iron_sword', destination: 'hand' }, bot, {})).toBe('no iron_sword in inventory')
  })

  it('defaults a tool to the hand', async () => {
    const bot = fakeBot([{ name: 'copper_sword' }])
    expect(await equipAction({ item: 'copper_sword' }, bot, {})).toBe('equipped copper_sword to hand')
  })

  it('takes a worn piece off to drop it', async () => {
    const bot = fakeBot()
    bot.inventory.slots[7] = { name: 'copper_leggings', type: 1, count: 1 }
    bot.toss = vi.fn(async () => {})
    expect(await dropItemAction({ item: 'copper_leggings', count: 1 }, bot, {})).toBe('dropped 1 copper_leggings')
    expect(bot.unequip).toHaveBeenCalledWith('legs')
  })
})

describe('copper weapons and tools', () => {
  it('a copper sword is a weapon', () => {
    expect(weaponScore('copper_sword')).toBeGreaterThan(weaponScore('wooden_sword'))
    expect(weaponScore('copper_sword')).toBeLessThan(weaponScore('iron_sword'))
    expect(weaponScore('copper_axe')).toBeGreaterThan(0)
    const bot = { inventory: { items: () => [{ name: 'dirt' }, { name: 'copper_sword' }] } }
    expect(chooseWeapon(bot)?.name).toBe('copper_sword')
  })

  const digMs = (reg, block, tool) => {
    const Block = prismarineBlock(reg)
    const b = Block.fromStateId(reg.blocksByName[block].defaultState, 0)
    return b.digTime(tool ? reg.itemsByName[tool].id : null, false, false, false, [], {})
  }

  it('fixes copper tool speeds (minecraft-data has them at hand speed)', () => {
    const reg = prismarineRegistry('1.21.11')
    expect(digMs(reg, 'stone', 'copper_pickaxe')).toBe(2300)
    const r = fixToolMaterials(reg, mcDataLib)
    expect(r.copper).toBeGreaterThan(0)
    expect(digMs(reg, 'stone', 'copper_pickaxe')).toBeLessThan(digMs(reg, 'stone', 'stone_pickaxe'))
    expect(digMs(reg, 'stone', 'copper_pickaxe')).toBeGreaterThan(digMs(reg, 'stone', 'iron_pickaxe'))
    // idempotent, and the shared JSON is untouched
    expect(fixToolMaterials(reg, mcDataLib)).toEqual({ remapped: 0, copper: 0 })
    expect(digMs(prismarineRegistry('1.21.11'), 'stone', 'copper_pickaxe')).toBe(2300)
  })

  it('renumbers the 26.3 tool table, which carries 26.2 item ids', () => {
    const reg = prismarineRegistry('26.3')
    // Before: no pickaxe is the right tool, all dig stone at hand-with-harvest speed.
    expect(digMs(reg, 'stone', 'wooden_pickaxe')).toBe(digMs(reg, 'stone', 'diamond_pickaxe'))
    const r = fixToolMaterials(reg, mcDataLib)
    expect(r.remapped).toBeGreaterThan(0)
    expect(digMs(reg, 'stone', 'wooden_pickaxe')).toBe(1150)
    expect(digMs(reg, 'stone', 'diamond_pickaxe')).toBe(300)
    expect(digMs(reg, 'oak_log', 'stone_axe')).toBeLessThan(digMs(reg, 'oak_log', null))
    // 26.2 itself is untouched by the 26.3 fix.
    expect(digMs(prismarineRegistry('26.2'), 'stone', 'wooden_pickaxe')).toBe(1150)
  })
})

describe('what she is told', () => {
  function snapBot(bag) {
    const bot = fakeBot(bag)
    Object.assign(bot, {
      version: '26.3', username: 'Sui', health: 20, food: 20, experience: { level: 0 },
      entity: { id: 1, position: new Vec3(0, 64, 0), yaw: 0, pitch: 0 },
      entities: {}, players: {}, time: { timeOfDay: 6000, day: 1 },
      blockAt: () => ({ name: 'air' }), findBlocks: () => [],
      game: { dimension: 'overworld' },
    })
    return bot
  }

  it('shows what she wears, and putting a piece on is not a loss', async () => {
    const bot = snapBot([])
    const c = createSnapshotComposer({ bot })
    c.next({})
    give(bot, { name: 'copper_chestplate' })
    await wearBestArmor(bot)
    const snap = c.next({})
    expect(snap).toContain('wearing: copper_chestplate')
    expect(snap).toContain('+1 copper_chestplate (put on)')
    // Equipping it by hand later changes nothing she owns.
    const again = c.next({})
    expect(again).not.toContain('INVENTORY JUST CHANGED')
    expect(wornLineFor(snapBot([]))).toBeNull()
  })

  it('names copper gear in the world primer only when the version has it', () => {
    expect(worldPrimer()).toBe(WORLD_PRIMER)
    expect(worldPrimer({ copperGear: true })).toContain(COPPER_GEAR_FACT)
    expect(COPPER_GEAR_FACT).not.toMatch(/[–—]/)
  })
})
