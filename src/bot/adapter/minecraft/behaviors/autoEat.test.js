import { describe, it, expect, vi } from 'vitest'
import { shouldAutoEat, inCombat, noteCombat, STARVING_FOOD, IN_COMBAT_MS, FIGHT_EAT_HEALTH } from './autoEat.js'
import { keepWeaponInHand } from './weaponSelect.js'

describe('shouldAutoEat (261011)', () => {
  it('never tries on a full food bar, whatever the health (the server refuses)', () => {
    expect(shouldAutoEat({ food: 20, health: 4 })).toBe(false)
  })

  it('eats when hungry or hurt with room to eat', () => {
    expect(shouldAutoEat({ food: 16, health: 20 })).toBe(true)
    expect(shouldAutoEat({ food: 19, health: 10 })).toBe(true)
    expect(shouldAutoEat({ food: 18, health: 20 })).toBe(false)
  })

  it('holds off mid-fight unless starving or badly hurt', () => {
    expect(shouldAutoEat({ food: 10, health: 12 }, { fighting: true })).toBe(false)
    expect(shouldAutoEat({ food: STARVING_FOOD, health: 18 }, { fighting: true })).toBe(true)
    // pass-2 combat_night death: 17/20 food, losing a skeleton fight
    expect(shouldAutoEat({ food: 17, health: FIGHT_EAT_HEALTH }, { fighting: true })).toBe(true)
    expect(shouldAutoEat({ food: 20, health: 4 }, { fighting: true })).toBe(false)
  })

  it('backs off after a failed attempt and never double-starts', () => {
    expect(shouldAutoEat({ food: 10, health: 20 }, { backoffUntil: 2000, now: 1000 })).toBe(false)
    expect(shouldAutoEat({ food: 10, health: 20 }, { backoffUntil: 2000, now: 3000 })).toBe(true)
    expect(shouldAutoEat({ food: 10, health: 20 }, { eating: true })).toBe(false)
  })
})

describe('inCombat (261011)', () => {
  it('is a deliberate target or a recent hit', () => {
    const bot = {}
    expect(inCombat(bot, 10_000)).toBe(false)
    noteCombat(bot, 10_000)
    expect(inCombat(bot, 10_000 + IN_COMBAT_MS - 1)).toBe(true)
    expect(inCombat(bot, 10_000 + IN_COMBAT_MS + 1)).toBe(false)
    expect(inCombat({ _seiOffensiveTarget: 3 })).toBe(true)
  })
})

describe('keepWeaponInHand (261011)', () => {
  function bot(held) {
    const b = {
      heldItem: held ? { name: held } : null,
      inventory: { items: () => [{ name: 'stone_sword' }, { name: 'bread' }] },
      equip: vi.fn(async (it) => { b.heldItem = { name: it.name } }),
    }
    return b
  }

  it('swaps food back out for the sword', async () => {
    const b = bot('bread')
    expect(keepWeaponInHand(b)).toBe(true)
    expect(keepWeaponInHand(b)).toBe(false) // single flight
    await vi.waitFor(() => expect(b.heldItem.name).toBe('stone_sword'))
  })

  it('leaves the hand alone while eating or when the weapon is already held', () => {
    const eating = bot('bread'); eating.autoEat = { isEating: true }
    expect(keepWeaponInHand(eating)).toBe(false)
    expect(keepWeaponInHand(bot('stone_sword'))).toBe(false)
  })
})




