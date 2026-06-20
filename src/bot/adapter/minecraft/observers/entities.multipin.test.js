// src/bot/adapter/minecraft/observers/entities.multipin.test.js
//
// 260618 (M2) — sibling companions must stay visible in the snapshot even when
// closer items/mobs would fill all the entity slots. nearbyEntities pins the
// human (pin) AND every sibling (pins), force-including them past the count cap.

import { describe, it, expect } from 'vitest'
import { nearbyEntities } from './entities.js'

// Minimal position with the distanceTo() the observer calls.
function pos(x, y, z) {
  return {
    x, y, z,
    distanceTo(o) {
      return Math.hypot(x - o.x, y - o.y, z - o.z)
    },
  }
}

function makeBot(entities) {
  const map = {}
  let id = 1
  for (const e of entities) map[id] = { id: id++, ...e }
  return { entity: { position: pos(0, 0, 0) }, entities: map }
}

describe('nearbyEntities multi-pin', () => {
  it('force-includes a far sibling past the count cap', () => {
    // 6 close items (would fill all slots) + the human + a far sibling bot.
    const ents = []
    for (let i = 0; i < 6; i++) ents.push({ name: 'item', position: pos(1, 0, i) })
    ents.push({ username: 'Ouen', position: pos(10, 0, 0) })
    ents.push({ username: 'Marv', position: pos(40, 0, 0) }) // far, beyond the cap

    const bot = makeBot(ents)
    const { entries } = nearbyEntities(bot, {
      radius: 64,
      count: 6,
      pin: 'Ouen',
      pins: ['Marv'],
    })

    const names = entries.map((e) => e.entity.username).filter(Boolean)
    expect(names).toContain('Ouen')
    expect(names).toContain('Marv')
  })

  it('does not evict one pinned name to fit another', () => {
    const ents = []
    for (let i = 0; i < 6; i++) ents.push({ name: 'item', position: pos(1, 0, i) })
    ents.push({ username: 'Ouen', position: pos(30, 0, 0) })
    ents.push({ username: 'Marv', position: pos(35, 0, 0) })
    ents.push({ username: 'Bo', position: pos(38, 0, 0) })

    const bot = makeBot(ents)
    const { entries } = nearbyEntities(bot, {
      radius: 64,
      count: 6,
      pin: 'Ouen',
      pins: ['Marv', 'Bo'],
    })
    const names = entries.map((e) => e.entity.username).filter(Boolean)
    expect(names).toContain('Ouen')
    expect(names).toContain('Marv')
    expect(names).toContain('Bo')
  })

  it('is unchanged for a solo bot (no pins)', () => {
    const ents = []
    for (let i = 0; i < 8; i++) ents.push({ name: 'item', position: pos(1, 0, i) })
    const bot = makeBot(ents)
    const { entries, more } = nearbyEntities(bot, { radius: 64, count: 6 })
    expect(entries).toHaveLength(6)
    expect(more).toBe(2)
  })
})
