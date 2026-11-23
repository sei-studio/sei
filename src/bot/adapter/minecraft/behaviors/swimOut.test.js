// 261123 (quality pass 62): out of deep water before a walk. gather_craft-02
// (2026-11-23 scorecard) spent the last three minutes in a river: every goTo
// to the bank failed from the bed, where the pathfinder has no move up.
import { describe, it, expect, vi } from 'vitest'
import { Vec3 } from 'vec3'
import { inDeepWater, waterDepth, targetInWater, findShore, swimToShore, deepWaterLine } from './swimOut.js'

/**
 * A river: water fills x in [0, 9], all z, from the bed (y=56) up to y=61.
 * Sand bank at x >= 10 up to y=61 (stand at y=62), and on the far side
 * x <= -1 a high bank up to y=64 (stand at y=65, three over the water: no
 * climbing out there). Stone everywhere below y=56.
 */
function river({ pos = new Vec3(4.5, 56, 0.5), lowBankWest = false } = {}) {
  const extra = new Map()
  const name = (x, y, z) => {
    const k = `${x},${y},${z}`
    if (extra.has(k)) return extra.get(k)
    if (y < 56) return 'stone'
    if (x >= 0 && x <= 9) return y <= 61 ? 'water' : 'air'
    if (x >= 10) return y <= 61 ? 'sand' : 'air'
    const top = lowBankWest ? 61 : 64
    return y <= top ? 'sand' : 'air'
  }
  const bot = {
    entity: { position: pos, yaw: 0, isInWater: true, onGround: false },
    controls: {},
    blockAt(p) {
      const n = name(p.x, p.y, p.z)
      return { name: n, position: new Vec3(p.x, p.y, p.z), boundingBox: n === 'water' || n === 'air' ? 'empty' : 'block' }
    },
    look: vi.fn((yaw) => { bot.entity.yaw = yaw }),
    setControlState: vi.fn((c, v) => { bot.controls[c] = v }),
    pathfinder: { setGoal: vi.fn() },
  }
  return { bot, extra, name }
}

/**
 * Crude swim physics for one poll: jump rises toward the top of the water,
 * forward moves along the yaw, and a bank one block over the water line is
 * climbed when she presses into it from the top.
 */
function physicsSleep(bot, name) {
  return async () => {
    const p = bot.entity.position
    const inWater = (x, y, z) => name(Math.floor(x), Math.floor(y), Math.floor(z)) === 'water'
    if (bot.controls.jump && inWater(p.x, p.y, p.z)) p.y = Math.min(p.y + 0.4, 61.4)
    if (bot.controls.forward) {
      const yaw = bot.entity.yaw
      const nx = p.x - Math.sin(yaw) * 0.25, nz = p.z - Math.cos(yaw) * 0.25
      const feet = name(Math.floor(nx), Math.floor(p.y), Math.floor(nz))
      if (feet === 'water' || feet === 'air') { p.x = nx; p.z = nz }
      else {
        // Bank: climb if the cell above it is open and she is at the top.
        const up = name(Math.floor(nx), Math.floor(p.y) + 1, Math.floor(nz))
        if (up === 'air' && p.y >= 61) { p.x = nx; p.z = nz; p.y = Math.floor(p.y) + 1 }
      }
    }
    const fy = Math.floor(p.y)
    bot.entity.isInWater = inWater(p.x, p.y, p.z)
    bot.entity.onGround = !bot.entity.isInWater && name(Math.floor(p.x), fy - 1, Math.floor(p.z)) !== 'air' && name(Math.floor(p.x), fy - 1, Math.floor(p.z)) !== 'water'
  }
}

describe('deep water (261123)', () => {
  it('on the bed with the head under, or swimming over deep water, is deep; wading is not', () => {
    const { bot } = river()
    expect(inDeepWater(bot)).toBe(true)
    expect(waterDepth(bot)).toBe(6)
    bot.entity.position = new Vec3(4.5, 61.2, 0.5)
    expect(inDeepWater(bot)).toBe(true)
    // Feet just over the water line, bobbing.
    bot.entity.position = new Vec3(4.5, 62.05, 0.5)
    expect(inDeepWater(bot)).toBe(true)
    expect(waterDepth(bot)).toBe(6)
    bot.entity.isInWater = false
    expect(inDeepWater(bot)).toBe(false)
    // On the bank.
    bot.entity.position = new Vec3(12.5, 62, 0.5)
    expect(inDeepWater(bot)).toBe(false)
    expect(deepWaterLine(bot)).toBe(null)
  })

  it('a one-deep puddle is not deep water', () => {
    const { bot, extra } = river({ pos: new Vec3(20.5, 62, 0.5) })
    extra.set('20,62,0', 'water')
    bot.entity.isInWater = true
    expect(inDeepWater(bot)).toBe(false)
  })

  it('the snapshot line says how deep and what works', () => {
    const { bot } = river()
    expect(deepWaterLine(bot)).toBe('in deep water (6 deep): goTo a spot on land swims you to the shore first; you cannot pillar up out of water')
  })

  it('a target in the water is in water', () => {
    const { bot } = river()
    expect(targetInWater(bot, { x: 3, y: 57, z: 0 })).toBe(true)
    expect(targetInWater(bot, { x: 12, y: 62, z: 0 })).toBe(false)
  })
})

describe('findShore (261123)', () => {
  it('finds the low bank she can climb, not the high one', () => {
    const { bot } = river({ pos: new Vec3(1.5, 56, 0.5) })
    const s = findShore(bot)
    expect(s.landing).toMatchObject({ x: 10, y: 62 })
    expect(s.path.at(-1)).toEqual(s.landing)
  })

  it('with two low banks, takes the one toward the target', () => {
    const { bot } = river({ pos: new Vec3(3.5, 56, 0.5), lowBankWest: true })
    expect(findShore(bot).landing.x).toBe(-1)
    expect(findShore(bot, { x: 30, y: 62, z: 0 }).landing.x).toBe(10)
  })

  it('null when there is no bank in reach', () => {
    const { bot } = river({ pos: new Vec3(1.5, 56, 0.5) })
    expect(findShore(bot, null, { radius: 4 })).toBe(null)
  })
})

describe('swimToShore (261123)', () => {
  it('swims up and over to the bank and climbs out, then lets go of the controls', async () => {
    const { bot, name } = river({ pos: new Vec3(2.5, 56, 0.5) })
    const r = await swimToShore(bot, { x: 20, y: 62, z: 0 }, { sleep: physicsSleep(bot, name) })
    expect(r.status).toBe('ashore')
    expect(r.landing).toMatchObject({ x: 10, y: 62 })
    expect(bot.entity.position.x).toBeGreaterThanOrEqual(10)
    expect(Math.floor(bot.entity.position.y)).toBe(62)
    expect(bot.controls.forward).toBe(false)
    expect(bot.controls.jump).toBe(false)
  })

  it('does nothing on dry ground', async () => {
    const { bot } = river({ pos: new Vec3(12.5, 62, 0.5) })
    bot.entity.isInWater = false
    bot.entity.onGround = true
    expect((await swimToShore(bot)).status).toBe('not_needed')
    expect(bot.setControlState).not.toHaveBeenCalled()
  })

  it('says no_shore when nothing is in reach', async () => {
    const { bot, extra } = river({ pos: new Vec3(4.5, 56, 0.5) })
    // Wall both banks off with a high cliff.
    for (let z = -20; z <= 20; z++) for (let y = 56; y <= 64; y++) extra.set(`10,${y},${z}`, 'stone')
    expect((await swimToShore(bot)).status).toBe('no_shore')
  })

  it('gives up as stuck when she makes no headway, and stops on abort', async () => {
    const { bot } = river({ pos: new Vec3(2.5, 56, 0.5) })
    let t = 0
    const now = vi.spyOn(Date, 'now').mockImplementation(() => t)
    try {
      const r = await swimToShore(bot, null, { sleep: async () => { t += 500 } })
      expect(r.status).toBe('stuck')
      const ctl = new AbortController()
      ctl.abort()
      expect((await swimToShore(bot, null, { signal: ctl.signal, sleep: async () => { t += 50 } })).status).toBe('aborted')
    } finally { now.mockRestore() }
  })

  it('waits while the drowning reflex swims her up', async () => {
    const { bot, name } = river({ pos: new Vec3(2.5, 56, 0.5) })
    bot._seiDrowning = true
    const step = physicsSleep(bot, name)
    let polls = 0
    const r = await swimToShore(bot, null, {
      sleep: async () => {
        polls++
        if (polls === 5) {
          expect(bot.setControlState).not.toHaveBeenCalled()
          bot._seiDrowning = false
        }
        await step()
      },
    })
    expect(r.status).toBe('ashore')
  })
})
