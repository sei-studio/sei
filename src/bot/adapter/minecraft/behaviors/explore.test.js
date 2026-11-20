// 261108 (quality pass 47): explore heading, column goal, walk-on and detours.
// Free play: "forward" walked her back to base behind the player (gaze turned
// her), a 3D goal inside a hill had no path, an 8s leg ran out a third of the
// way, and a blocked first leg gave up.

import { describe, it, expect, vi } from 'vitest'
import { Vec3 } from 'vec3'

vi.mock('./visualize.js', () => ({
  orientationToYawOffset: (args) => {
    const DEG = { forward: 0, forwards: 0, right: 90, backwards: 180, backward: 180, back: 180, left: 270 }
    let deg = null
    if (typeof args?.angle === 'number') deg = args.angle
    else if (typeof args?.orientation === 'string' && args.orientation in DEG) deg = DEG[args.orientation]
    if (deg == null) return null
    return -(((deg % 360) + 360) % 360) * Math.PI / 180
  },
  faceYaw: vi.fn(async () => {}),
  captureFrame: vi.fn(async () => null),
}))

const { exploreAction, resolveHeading, avoidTrail, compassWord, legBudgetMs, yawOf } = await import('./explore.js')

const NORTH = yawOf(0, -1)
const SOUTH = yawOf(0, 1)
const EAST = yawOf(1, 0)

function makeBot({ yaw = 0, pos = new Vec3(0, 64, 0) } = {}) {
  return { entity: { position: pos.clone(), yaw } }
}

/** Walk double: moves the bot toward the goal by `step` per call. */
function walker(bot, { step = 100, result } = {}) {
  return vi.fn(async (b, x, y, z, range, ms, signal, opts) => {
    const p = bot.entity.position
    const dx = x - p.x, dz = z - p.z
    const d = Math.hypot(dx, dz)
    const s = Math.min(step, d)
    if (d > 0) bot.entity.position = new Vec3(p.x + dx / d * s, p.y, p.z + dz / d * s)
    if (typeof result === 'function') return result({ x, z, opts })
    return d - s <= range ? 'reached' : 'timeout'
  })
}

describe('compass helpers', () => {
  it('names 8-way directions in the yaw convention (north = -z)', () => {
    expect(compassWord(0, -5)).toBe('north')
    expect(compassWord(5, 0)).toBe('east')
    expect(compassWord(0, 5)).toBe('south')
    expect(compassWord(-5, 0)).toBe('west')
    expect(compassWord(4, -4)).toBe('northeast')
  })

  it('scales the leg budget with the distance', () => {
    expect(legBudgetMs(8)).toBe(6000)
    expect(legBudgetMs(16)).toBe(7300)
    expect(legBudgetMs(32)).toBe(12000)
    expect(legBudgetMs(48)).toBe(12000)
  })
})

describe('resolveHeading', () => {
  const pos = { x: 0, y: 64, z: 0 }

  it('takes compass directions as world headings, whatever the facing', () => {
    const bot = makeBot({ yaw: SOUTH })
    expect(resolveHeading({ orientation: 'north' }, bot, pos).yaw).toBeCloseTo(NORTH)
    expect(resolveHeading({ orientation: 'east' }, bot, pos).yaw).toBeCloseTo(EAST)
  })

  it('forward continues the last explore while she is near where it ended', () => {
    const bot = makeBot({ yaw: SOUTH }) // the gaze turned her to the player behind
    bot._seiExplore = { yaw: NORTH, end: { x: 2, z: 1 }, at: Date.now(), trail: [] }
    const h = resolveHeading({ orientation: 'forward' }, bot, pos)
    expect(h.from).toBe('continue')
    expect(h.yaw).toBeCloseTo(NORTH)
  })

  it('does not continue an old or far-away explore', () => {
    const bot = makeBot({ yaw: SOUTH })
    bot._seiExplore = { yaw: NORTH, end: { x: 40, z: 0 }, at: Date.now(), trail: [] }
    expect(resolveHeading({}, bot, pos).from).toBe('body')
    bot._seiExplore = { yaw: NORTH, end: { x: 0, z: 0 }, at: Date.now() - 10 * 60_000, trail: [] }
    expect(resolveHeading({}, bot, pos).from).toBe('body')
  })

  it('reads relative directions against the facing the snapshot showed', () => {
    const bot = makeBot({ yaw: SOUTH })
    bot._seiShownFacing = { yaw: EAST, at: Date.now() }
    // facing east, left is north
    const h = resolveHeading({ orientation: 'left' }, bot, pos)
    expect(h.from).toBe('shown')
    expect(Math.cos(h.yaw - NORTH)).toBeCloseTo(1)
  })

  it('left is never read against the last explore heading', () => {
    const bot = makeBot({ yaw: SOUTH })
    bot._seiExplore = { yaw: NORTH, end: { x: 0, z: 0 }, at: Date.now(), trail: [] }
    expect(resolveHeading({ orientation: 'left' }, bot, pos).from).toBe('body')
  })
})

describe('avoidTrail', () => {
  it('turns a forward that would land back on walked ground', () => {
    const bot = makeBot()
    bot._seiExplore = { yaw: NORTH, end: { x: 0, z: 0 }, at: Date.now(), trail: [{ x: 0, z: 20, at: Date.now() }] }
    const t = avoidTrail(SOUTH, { x: 0, z: 0 }, 20, bot)
    expect(t.turned).toBe(true)
    expect(Math.cos(t.yaw - SOUTH)).toBeLessThan(0.8)
  })

  it('keeps the heading when the way is fresh', () => {
    const bot = makeBot()
    bot._seiExplore = { yaw: NORTH, end: { x: 0, z: 0 }, at: Date.now(), trail: [{ x: 0, z: 20, at: Date.now() }] }
    expect(avoidTrail(NORTH, { x: 0, z: 0 }, 20, bot).turned).toBe(false)
  })
})

describe('exploreAction', () => {
  it('walks to the x,z column (any height) and says the compass way', async () => {
    const bot = makeBot({ yaw: SOUTH })
    const walk = walker(bot)
    const r = await exploreAction({ orientation: 'north', blocks: 20 }, bot, {}, { walk })
    expect(walk.mock.calls[0][7]).toEqual({ xz: true })
    expect(r).toMatch(/^explored 2\d blocks north, now at 0,64,-2\d/)
    expect(bot._seiExplore.yaw).toBeCloseTo(NORTH)
  })

  it('walks on while a timed-out leg was still closing in', async () => {
    const bot = makeBot({ yaw: NORTH })
    const walk = walker(bot, { step: 10 })
    const r = await exploreAction({ blocks: 40 }, bot, {}, { walk })
    expect(walk).toHaveBeenCalledTimes(4)
    expect(r).toMatch(/^explored 40 blocks north/)
  })

  it('a second forward keeps going the same way although the gaze turned her around', async () => {
    const bot = makeBot({ yaw: NORTH })
    const walk = walker(bot)
    await exploreAction({ orientation: 'forward', blocks: 20 }, bot, {}, { walk })
    bot.entity.yaw = SOUTH // looking back at the player following behind
    const r = await exploreAction({ orientation: 'forward', blocks: 20 }, bot, {}, { walk })
    expect(r).toMatch(/blocks north \(forward\)/)
    expect(bot.entity.position.z).toBeLessThan(-35)
  })

  it('tries the headings either side when straight on is blocked', async () => {
    const bot = makeBot({ yaw: NORTH })
    let n = 0
    const walk = vi.fn(async (b, x, y, z) => {
      n++
      if (n === 1) return 'cant_reach (closest=20.0m to target 0,64,-20)'
      const p = bot.entity.position
      const dx = x - p.x, dz = z - p.z
      bot.entity.position = new Vec3(x, p.y, z)
      return Math.hypot(dx, dz) >= 0 ? 'reached' : 'timeout'
    })
    const r = await exploreAction({ orientation: 'north', blocks: 20 }, bot, {}, { walk })
    expect(walk).toHaveBeenCalledTimes(2)
    expect(r).toMatch(/^explored 15 blocks northwest \(north was blocked\)/)
  })

  it('says what it tried when every way is blocked', async () => {
    const bot = makeBot({ yaw: NORTH })
    const walk = vi.fn(async () => 'cant_reach')
    const r = await exploreAction({ orientation: 'north', blocks: 20 }, bot, {}, { walk })
    expect(walk).toHaveBeenCalledTimes(5)
    expect(r).toMatch(/^couldn't move north \(cant_reach\); also tried northwest, northeast, west, east — blocked/)
  })

  it('stops on abort', async () => {
    const bot = makeBot()
    const ac = new AbortController()
    const walk = vi.fn(async () => { ac.abort(); return 'aborted' })
    expect(await exploreAction({}, bot, { signal: ac.signal }, { walk })).toBe('aborted')
  })
})
