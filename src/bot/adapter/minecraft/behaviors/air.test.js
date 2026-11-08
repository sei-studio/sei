// 261108 (quality pass 47): dig and gather swim up for air instead of
// mining on until she drowns (gather_craft-02-B: drowned on a river bed with
// the gather still running, lost every tool).

import { describe, it, expect, vi } from 'vitest'
import { Vec3 } from 'vec3'
import { lowOnAir, surfaceForAir, airLine, isUnderwaterBlock, AIR_LOW } from './air.js'
import { digAction, AIR_STOP_PREFIX } from './dig.js'
import { gatherAction, MAX_AIR_BREAKS } from './mineVein.js'

/** A bot in a voxel world; `water` cells are water, `blocks` solid. */
function makeBot({ water = [], blocks = [], oxy = 20, pos = new Vec3(0.5, 60, 0.5) } = {}) {
  const w = new Set(water.map((p) => p.join(',')))
  const solid = new Map(blocks.map(([x, y, z, n]) => [`${x},${y},${z}`, n]))
  const bot = {
    version: '1.21.1',
    oxygenLevel: oxy,
    entity: { position: pos, yaw: 0, isInWater: false },
    controls: {},
    blockAt(p) {
      const k = `${p.x},${p.y},${p.z}`
      if (solid.has(k)) return { name: solid.get(k), position: new Vec3(p.x, p.y, p.z) }
      return { name: w.has(k) ? 'water' : 'air', position: new Vec3(p.x, p.y, p.z) }
    },
    setControlState: vi.fn((c, v) => { bot.controls[c] = v }),
    stopDigging: vi.fn(),
    pathfinder: { setGoal: vi.fn() },
  }
  return { bot, water: w, solid }
}

describe('air helpers', () => {
  it('is low on air only with the head under water and air at or under AIR_LOW', () => {
    const { bot } = makeBot({ water: [[0, 61, 0]], oxy: AIR_LOW })
    expect(lowOnAir(bot)).toBe(true)
    bot.oxygenLevel = 19
    expect(lowOnAir(bot)).toBe(false)
    const dry = makeBot({ oxy: 5 }).bot
    expect(lowOnAir(dry)).toBe(false)
  })

  it('is low on air while the drowning reflex is up', () => {
    const { bot } = makeBot()
    bot._seiDrowning = true
    expect(lowOnAir(bot)).toBe(true)
  })

  it('knows a block with water on top is under water', () => {
    const { bot } = makeBot({ water: [[3, 61, 3]] })
    expect(isUnderwaterBlock(bot, { x: 3, y: 60, z: 3 })).toBe(true)
    expect(isUnderwaterBlock(bot, { x: 4, y: 60, z: 3 })).toBe(false)
  })

  it('shows air only when it is not full or the head is under water', () => {
    const { bot, water } = makeBot({ water: [[0, 61, 0]], oxy: 9 })
    expect(airLine(bot)).toBe('air: 9/20, head under water')
    bot._seiDrowning = true
    expect(airLine(bot)).toBe('air: 9/20, head under water, swimming up for air now')
    water.clear()
    bot._seiDrowning = false
    bot.oxygenLevel = 20
    expect(airLine(bot)).toBe(null)
  })

  it('surfacing stops the dig and the walk, swims up, and waits for the air', async () => {
    const { bot, water } = makeBot({ water: [[0, 61, 0]], oxy: 8 })
    const p = surfaceForAir(bot, undefined, 3000)
    await new Promise((r) => setTimeout(r, 150))
    expect(bot.stopDigging).toHaveBeenCalled()
    expect(bot.pathfinder.setGoal).toHaveBeenCalledWith(null)
    expect(bot.controls.jump).toBe(true)
    water.clear() // head is out
    bot.oxygenLevel = 19
    expect(await p).toBe('ok')
    expect(bot.controls.jump).toBe(false)
    expect(bot._seiAirBreak).toBe(false)
  })

  it('leaves the swim to the drowning reflex when it is up', async () => {
    const { bot, water } = makeBot({ water: [[0, 61, 0]], oxy: 8 })
    bot._seiDrowning = true
    const p = surfaceForAir(bot, undefined, 3000)
    await new Promise((r) => setTimeout(r, 150))
    expect(bot.setControlState).not.toHaveBeenCalled()
    water.clear(); bot.oxygenLevel = 20; bot._seiDrowning = false
    expect(await p).toBe('ok')
  })
})

describe('digAction with low air', () => {
  it('swims up before swinging and says the block is still there', async () => {
    const { bot, water } = makeBot({ water: [[0, 61, 0]], blocks: [[1, 59, 0, 'stone']], oxy: 6 })
    bot.dig = vi.fn()
    setTimeout(() => { water.clear(); bot.oxygenLevel = 20 }, 200)
    const r = await digAction({ x: 1, y: 59, z: 0 }, bot, {})
    expect(r.startsWith(AIR_STOP_PREFIX)).toBe(true)
    expect(r).toContain('stone @1,59,0 was not dug')
    expect(bot.dig).not.toHaveBeenCalled()
  })
})

describe('gatherAction with low air', () => {
  function stoneBed() {
    // A row of stone on a river bed (water above each) and dry stone on the bank.
    const blocks = [], water = []
    for (let x = 1; x <= 4; x++) { blocks.push([x, 59, 0, 'stone']); water.push([x, 60, 0]) }
    blocks.push([10, 62, 0, 'stone'])
    return { blocks, water }
  }
  function finder(bot, solid) {
    bot.findBlocks = ({ count }) => {
      const hits = []
      for (const [k, n] of solid) { if (n !== 'stone') continue; const [x, y, z] = k.split(',').map(Number); hits.push(new Vec3(x, y, z)) }
      hits.sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
      return hits.slice(0, count)
    }
  }

  it('picks the dry stone before the river bed', async () => {
    const { blocks, water } = stoneBed()
    const { bot, solid } = makeBot({ blocks, water })
    finder(bot, solid)
    const dug = []
    const digAction = vi.fn(async ({ x, y, z }) => { solid.delete(`${x},${y},${z}`); dug.push(x); return 'dug stone' })
    await gatherAction({ name: 'stone', count: 1 }, bot, {}, { goTo: vi.fn(async () => 'reached'), digAction })
    expect(dug).toEqual([10])
  })

  it('stops after swimming up MAX_AIR_BREAKS times and says why', async () => {
    const { blocks, water } = stoneBed()
    blocks.pop() // no dry stone
    const { bot, solid } = makeBot({ blocks, water })
    finder(bot, solid)
    const digAction = vi.fn(async () => `${AIR_STOP_PREFIX}: you were running out of air`)
    const r = await gatherAction({ name: 'stone', count: 4 }, bot, {}, { goTo: vi.fn(async () => 'reached'), digAction })
    expect(digAction).toHaveBeenCalledTimes(MAX_AIR_BREAKS)
    expect(r).toMatch(/ran low on air under water 2 times and swam up each time/)
  })
})
