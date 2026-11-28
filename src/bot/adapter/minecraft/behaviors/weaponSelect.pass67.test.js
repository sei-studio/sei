// 261128 (quality pass 67): the weapon: line names the mobs standing by a
// dropped weapon and how often she has died by it.
import { describe, it, expect } from 'vitest'
import { noteLostWeapon, lostWeaponLine } from './weaponSelect.js'

const bot = (pos, entities = {}) => ({ entity: { position: pos }, entities, inventory: { items: () => [] } })
const mob = (id, name, x, z) => ({ id, name, position: { x, y: 64, z } })

describe('lostWeaponLine with mobs by the drop (pass 67)', () => {
  it('says which mobs stand by it and that walking in now is how she dies again', () => {
    const b = bot({ x: 0, y: 64, z: 0 }, { 1: mob(1, 'zombie', 12, 3), 2: mob(2, 'zombie', 14, 6), 3: mob(3, 'skeleton', 9, 5), 4: mob(4, 'zombie', 30, 5) })
    noteLostWeapon(b, [{ item: 'stone_sword', n: 1 }], 0, { x: 12, y: 64, z: 5 })
    const line = lostWeaponLine(b, 30_000)
    expect(line).toContain('@12,64,5 (13 blocks from you) for about 5 more minutes, and 2 zombies and a skeleton are within 6 blocks of it.')
    expect(line).toContain('walking in for it now is how you die again')
    expect(line).toContain('once nothing stands by it')
    expect(line).not.toContain('died 1 times')
  })
  it('counts deaths by the same spot', () => {
    const b = bot({ x: 0, y: 64, z: 0 }, { 1: mob(1, 'zombie', 11, 5) })
    noteLostWeapon(b, [{ item: 'stone_sword', n: 1 }], 0, { x: 12, y: 64, z: 5 })
    noteLostWeapon(b, [{ item: 'bread', n: 1 }], 40_000, { x: 13, y: 64, z: 6 })
    noteLostWeapon(b, [], 80_000, { x: 60, y: 64, z: 0 })
    const line = lostWeaponLine(b, 90_000)
    expect(line).toContain('a zombie is within 6 blocks of it. You have died 2 times by that spot in the last few minutes.')
  })
  it('is unchanged when the spot is clear', () => {
    const b = bot({ x: 0, y: 64, z: 0 }, { 1: mob(1, 'zombie', 30, 5), 2: mob(2, 'cow', 12, 5) })
    noteLostWeapon(b, [{ item: 'stone_sword', n: 1 }], 0, { x: 12, y: 64, z: 5 })
    expect(lostWeaponLine(b, 30_000)).toBe('weapon: none. Your stone_sword is on the ground where you died @12,64,5 (13 blocks from you) for about 5 more minutes. pickup with item "stone_sword" and maxDistance 32 walks onto it; if it is farther than that, goTo the spot first.')
  })
})
