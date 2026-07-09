// weakWeaponNote (260708) — when a mob survives the batch and the bot is not
// holding a real weapon, the result string must say so and point at the right
// fix: equip the weapon already in the inventory if one exists, otherwise
// craft one (Lyra fought a zombie and a skeleton with a stick while the player
// died twice; nothing ever told the model the stick was the problem).

import { describe, it, expect } from 'vitest'
import { weakWeaponNote } from './attack.js'

function makeBot({ held = null, items = [] } = {}) {
  return {
    heldItem: held ? { name: held } : null,
    inventory: { items: () => items.map(name => ({ name })) },
  }
}

describe('weakWeaponNote', () => {
  it('is silent when a real weapon is held', () => {
    expect(weakWeaponNote(makeBot({ held: 'wooden_sword' }))).toBe('')
    expect(weakWeaponNote(makeBot({ held: 'iron_axe' }))).toBe('')
  })

  it('a pickaxe is NOT a weapon (the _axe match must not catch it)', () => {
    const n = weakWeaponNote(makeBot({ held: 'wooden_pickaxe' }))
    expect(n).toContain('wooden_pickaxe')
    expect(n).toContain('slow')
  })

  it('points at the inventory weapon when one exists but is not equipped', () => {
    const n = weakWeaponNote(makeBot({ held: 'stick', items: ['oak_planks', 'stone_sword'] }))
    expect(n).toContain("fighting with stick")
    expect(n).toContain('equip your stone_sword')
  })

  it('suggests crafting when no weapon exists anywhere', () => {
    const n = weakWeaponNote(makeBot({ held: 'stick', items: ['oak_planks'] }))
    expect(n).toContain('craft a weapon')
  })

  it('handles empty hands and a missing inventory', () => {
    const n = weakWeaponNote({ heldItem: null })
    expect(n).toContain('bare hands')
    expect(n).toContain('craft a weapon')
  })
})
