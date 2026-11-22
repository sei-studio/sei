// 261011: attackEntity and the automatic swing-back hold the best weapon owned.
import { describe, it, expect, vi } from 'vitest'
import { weaponScore, chooseWeapon, equipBestWeapon } from './weaponSelect.js'

const bot = (names, held = null) => ({
  inventory: { items: () => names.map((name) => ({ name, count: 1 })) },
  heldItem: held ? { name: held } : null,
  equip: vi.fn(async () => {}),
})

describe('weapon selection', () => {
  it('any sword beats any axe, and an axe beats a tool or bare hands', () => {
    expect(weaponScore('wooden_sword')).toBeGreaterThan(weaponScore('netherite_axe'))
    expect(weaponScore('stone_axe')).toBeGreaterThan(weaponScore('stone_pickaxe'))
    expect(weaponScore('stone_pickaxe')).toBe(0)
    expect(weaponScore(null)).toBe(0)
  })

  it('picks the strongest sword in the inventory', () => {
    expect(chooseWeapon(bot(['oak_planks', 'stone_sword', 'iron_sword', 'iron_axe'])).name).toBe('iron_sword')
    expect(chooseWeapon(bot(['oak_planks', 'stick']))).toBeNull()
  })

  it('equips the sword when holding planks', async () => {
    const b = bot(['oak_planks', 'stone_sword'], 'oak_planks')
    expect(await equipBestWeapon(b)).toBe('stone_sword')
    expect(b.equip).toHaveBeenCalledWith(expect.objectContaining({ name: 'stone_sword' }), 'hand')
  })

  it('leaves an equal or better weapon in hand', async () => {
    const b = bot(['stone_sword', 'iron_sword'], 'iron_sword')
    expect(await equipBestWeapon(b)).toBeNull()
    expect(b.equip).not.toHaveBeenCalled()
  })

  it('a failing equip does not throw', async () => {
    const b = bot(['stone_sword'])
    b.equip = vi.fn(async () => { throw new Error('busy') })
    expect(await equipBestWeapon(b)).toBeNull()
  })
})




