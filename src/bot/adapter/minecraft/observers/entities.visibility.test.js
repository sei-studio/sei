// src/bot/adapter/minecraft/observers/entities.visibility.test.js
//
// 260618: nearbyEntities visibility filter (requireLineOfSight). The snapshot
// lists only entities the bot can actually SEE — within the radius and not
// occluded by terrain/fluids — so underground / behind-wall mobs (a skeleton in
// a cave below) drop out, while entities BEHIND the bot still count. Pinned
// users (the human + AI teammates) are exempt so their coords never vanish.

import { describe, it, expect } from 'vitest'
import { Vec3 } from 'vec3'
import { nearbyEntities } from './entities.js'

// Ground slab fills y 56..63 (solid); everything else is air. A surface ray
// (bot eye ~y65.6) stays clear; a ray down to an entity at y55 crosses the slab
// and is occluded — the "underground mob" the filter is meant to hide.
function makeBot(entities) {
  const map = {}
  let id = 1
  for (const e of entities) map[id] = { id: id++, ...e }
  return {
    entity: { position: new Vec3(0, 64, 0), eyeHeight: 1.6 },
    entities: map,
    blockAt: (v) => {
      const y = Math.floor(v.y)
      return y >= 56 && y <= 63
        ? { name: 'stone', shapes: [[0, 0, 0, 1, 1, 1]] }
        : { name: 'air', shapes: [] }
    },
  }
}
const at = (x, y, z) => new Vec3(x, y, z)

describe('nearbyEntities requireLineOfSight', () => {
  it('keeps visible mobs in front AND behind the bot, drops an underground one', () => {
    const bot = makeBot([
      { name: 'cow', position: at(6, 64, 0) },        // visible, in front
      { name: 'sheep', position: at(-6, 64, 0) },     // visible, BEHIND the bot
      { name: 'skeleton', position: at(2, 55, 0) },   // underground (below the slab)
    ])
    const names = nearbyEntities(bot, { radius: 64, count: 6, requireLineOfSight: true })
      .entries.map((e) => e.entity.name)
    expect(names).toContain('cow')
    expect(names).toContain('sheep')      // facing is NOT considered
    expect(names).not.toContain('skeleton')
  })

  it('is unchanged when the filter is off (default): the underground mob still shows', () => {
    const bot = makeBot([{ name: 'skeleton', position: at(2, 55, 0) }])
    const names = nearbyEntities(bot, { radius: 64, count: 6 })
      .entries.map((e) => e.entity.name)
    expect(names).toContain('skeleton')
  })

  it('never culls a pinned user, even when occluded underground', () => {
    const bot = makeBot([{ username: 'Ouen', position: at(2, 55, 0) }])
    const names = nearbyEntities(bot, { radius: 64, count: 6, pin: 'Ouen', requireLineOfSight: true })
      .entries.map((e) => e.entity.username)
    expect(names).toContain('Ouen')
  })
})
