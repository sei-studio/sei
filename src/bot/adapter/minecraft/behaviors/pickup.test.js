// src/bot/adapter/minecraft/behaviors/pickup.test.js
//
// 261011: pickup walks onto dropped items, closest first, and reports only
// what reached the inventory.

import { describe, it, expect } from 'vitest'
import { Vec3 } from 'vec3'
import { pickupAction } from './pickup.js'
import { noteLostWeapon } from './weaponSelect.js'

function dropEntity(id, name, x, y, z, count = 1) {
  return {
    id,
    name: 'item',
    position: new Vec3(x, y, z),
    isValid: true,
    getDroppedItem: () => ({ name, count }),
  }
}

function makeBot(drops, invStart = []) {
  const inv = invStart.map((i) => ({ ...i }))
  const bot = {
    entity: { id: 0, position: new Vec3(0, 64, 0) },
    entities: { 0: null },
    inventory: { items: () => inv },
  }
  for (const d of drops) bot.entities[d.id] = d
  // Walking onto a drop collects it: the fake goTo moves the bot there and
  // moves any drop in that cell into the inventory.
  const walked = []
  const goTo = async (_bot, x, y, z) => {
    walked.push([x, y, z])
    bot.entity.position = new Vec3(x + 0.5, y, z + 0.5)
    for (const d of drops) {
      if (!bot.entities[d.id] || d.unreachable) continue
      if (Math.floor(d.position.x) === x && Math.floor(d.position.z) === z) {
        const it = d.getDroppedItem()
        const have = inv.find((i) => i.name === it.name)
        if (have) have.count += it.count
        else inv.push({ name: it.name, count: it.count })
        delete bot.entities[d.id]
      }
    }
    return 'reached'
  }
  return { bot, goTo, walked }
}

const deps = (goTo) => ({ goTo, sleep: async () => {} })

describe('pickupAction', () => {
  it('collects every drop in range, closest first, and lists what it got', async () => {
    const far = dropEntity(1, 'stone_sword', 6, 64, 0)
    const near = dropEntity(2, 'string', 2, 64, 0, 2)
    const { bot, goTo, walked } = makeBot([far, near], [{ name: 'string', count: 1 }])
    const res = await pickupAction({}, bot, {}, deps(goTo))
    expect(walked[0]).toEqual([2, 64, 0])
    expect(walked[1]).toEqual([6, 64, 0])
    expect(res).toMatch(/^picked up /)
    expect(res).toContain('2 string')
    expect(res).toContain('1 stone_sword')
  })

  it('only goes for the named item when item is given', async () => {
    const { bot, goTo, walked } = makeBot([dropEntity(1, 'rotten_flesh', 1, 64, 0), dropEntity(2, 'stone_sword', 5, 64, 0)])
    const res = await pickupAction({ item: 'stone_sword' }, bot, {}, deps(goTo))
    expect(walked).toEqual([[5, 64, 0]])
    expect(res).toBe('picked up 1 stone_sword')
  })

  it('says nothing is in range when there are no drops', async () => {
    const { bot, goTo, walked } = makeBot([dropEntity(1, 'stick', 30, 64, 0)])
    const res = await pickupAction({}, bot, {}, deps(goTo))
    expect(walked).toEqual([])
    // 261019: and where the nearest one really is.
    expect(res).toBe('no dropped items on the ground within 16m; the nearest is 30m away at 30,64,0; goTo near it first, or pickup with a larger maxDistance (up to 32)')
  })

  it('reports honestly when it walked to a drop but nothing was collected', async () => {
    const d = dropEntity(1, 'stick', 3, 64, 0)
    d.unreachable = true
    const { bot, goTo } = makeBot([d])
    const res = await pickupAction({}, bot, {}, deps(goTo))
    expect(res).toMatch(/^could not pick up the dropped items/)
    expect(res).not.toMatch(/picked up \d/)
  })

  it('skips drops high above it', async () => {
    const { bot, goTo, walked } = makeBot([dropEntity(1, 'stick', 1, 70, 0)])
    const res = await pickupAction({}, bot, {}, deps(goTo))
    expect(walked).toEqual([])
    expect(res).toBe('no dropped items on the ground within 16m; the nearest is 6 blocks above you at 1,70,0; get up there first')
  })

  it('stops when aborted', async () => {
    const ac = new AbortController()
    const { bot, walked } = makeBot([dropEntity(1, 'stick', 1, 64, 0), dropEntity(2, 'stick', 4, 64, 0)])
    const goTo = async (_b, x, y, z) => { walked.push([x, y, z]); ac.abort(); return 'aborted' }
    const res = await pickupAction({}, bot, { signal: ac.signal }, deps(goTo))
    expect(walked).toHaveLength(1)
    expect(res).toBe('aborted')
  })

  it('may dig its way to a stone drop in a hole, but never toward wood (261011)', async () => {
    const { bot, walked } = makeBot([dropEntity(1, 'cobblestone', 1, 62, 0), dropEntity(2, 'oak_log', 4, 64, 0)])
    const opts = []
    const goTo = async (_b, x, y, z, _r, _ms, _sig, o) => { walked.push([x, y, z]); opts.push(o); return 'reached' }
    await pickupAction({}, bot, {}, deps(goTo))
    expect(opts).toEqual([{ canPlace: false, resume: true }, { canDig: false, canPlace: false, resume: true }])
  })
})

// 261019 (quality pass 19): "no stone_sword within 4m" while the sword was
// already in her inventory sent her looking for it again.
describe('pickup when the item is already in the inventory (261019)', () => {
  it('says she already has it', async () => {
    const { bot, goTo } = makeBot([], [{ name: 'stone_sword', count: 1 }])
    const res = await pickupAction({ item: 'stone_sword', maxDistance: 4 }, bot, {}, deps(goTo))
    expect(res).toBe('no stone_sword on the ground within 4m; you already have 1 stone_sword in your inventory')
  })

  // 261031 (pass 33 review): after a death took her sword, the player's own
  // sword (and bread) lying closer is left alone.
  it('takes her own lost weapon, nearest her death spot, and stops there', async () => {
    const { bot, goTo, walked } = makeBot([
      dropEntity(1, 'stone_sword', 3, 64, 0), // the player's, closer to her
      dropEntity(2, 'bread', 3, 64, 0),
      dropEntity(3, 'stone_sword', 12, 64, 0), // hers
    ])
    noteLostWeapon(bot, [{ item: 'stone_sword', n: 1 }], Date.now(), { x: 12, y: 64, z: 0 })
    const res = await pickupAction({ item: 'stone_sword', maxDistance: 32 }, bot, {}, deps(goTo))
    expect(walked).toEqual([[12, 64, 0]])
    expect(res).toBe('picked up 1 stone_sword')
  })

  it('outside the lost-weapon state a named pickup still takes every match', async () => {
    const { bot, goTo, walked } = makeBot([dropEntity(1, 'stone_sword', 3, 64, 0), dropEntity(3, 'stone_sword', 12, 64, 0)])
    const res = await pickupAction({ item: 'stone_sword', maxDistance: 32 }, bot, {}, deps(goTo))
    expect(walked).toEqual([[3, 64, 0], [12, 64, 0]])
    expect(res).toBe('picked up 2 stone_sword')
  })

  it('gives a far drop enough time to walk to', async () => {
    const times = []
    const { bot, goTo } = makeBot([dropEntity(1, 'stick', 2, 64, 0), dropEntity(2, 'stick', 30, 64, 0)])
    const timed = async (b, x, y, z, r, ms, ...rest) => { times.push(ms); return goTo(b, x, y, z, r, ms, ...rest) }
    await pickupAction({ maxDistance: 32 }, bot, {}, deps(timed))
    expect(times[0]).toBe(4000)
    expect(times[1]).toBeGreaterThanOrEqual(1500 + 27 * 280)
  })
})
