// gatherAction (260708) — multi-component gather. Pins the Lyra post-mortem
// fix: name-mode keeps re-anchoring on fresh trees until the REQUESTED count
// is attempted (old behavior stopped after ONE connected component and
// reported `gathered 1/1`, which read as full success). Also pins: honest
// K/W result denominators, the exhaustion note, coord-mode staying
// single-component, abort mid-batch, and the no-re-anchor guarantee for a
// component whose digs all failed (no infinite loop).

import { describe, it, expect, vi } from 'vitest'
import { Vec3 } from 'vec3'
import { gatherAction } from './mineVein.js'

// A tiny voxel world: `blocks` maps "x,y,z" -> block name. digAction stub
// removes the block (turns it to air) exactly like a real dig would, which is
// what makes findBlocks/blockAt see progress between rounds.
function makeWorld(blockList) {
  const blocks = new Map()
  for (const [x, y, z, name] of blockList) blocks.set(`${x},${y},${z}`, name)
  const bot = {
    version: '1.21.1',
    entity: { position: new Vec3(0, 64, 0) },
    blockAt(p) {
      const name = blocks.get(`${p.x},${p.y},${p.z}`)
      return name ? { name, position: p } : { name: 'air', position: p }
    },
    findBlocks({ count }) {
      const hits = []
      for (const [k, name] of blocks) {
        if (name !== 'oak_log') continue
        const [x, y, z] = k.split(',').map(Number)
        hits.push(new Vec3(x, y, z))
      }
      hits.sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
      return hits.slice(0, count ?? 1)
    },
  }
  return { bot, blocks }
}

function makeDeps(blocks, { failAll = false } = {}) {
  const goTo = vi.fn(async () => 'reached')
  const digAction = vi.fn(async ({ x, y, z }) => {
    if (failAll) return 'timeout'
    const k = `${x},${y},${z}`
    if (!blocks.has(k)) return 'no block'
    blocks.delete(k)
    return `dug oak_log at ${k}`
  })
  return { goTo, digAction }
}

// Two 3-log trees (vertical trunks), not connected to each other.
const TWO_TREES = [
  [2, 64, 0, 'oak_log'], [2, 65, 0, 'oak_log'], [2, 66, 0, 'oak_log'],
  [10, 64, 0, 'oak_log'], [10, 65, 0, 'oak_log'], [10, 66, 0, 'oak_log'],
]

describe('gatherAction — multi-component (260708)', () => {
  it('continues across trees until the requested count', async () => {
    const { bot, blocks } = makeWorld(TWO_TREES)
    const deps = makeDeps(blocks)
    const r = await gatherAction({ name: 'oak_log', count: 6 }, bot, {}, deps)
    expect(r).toBe('gathered 6/6 oak_log')
    expect(deps.digAction).toHaveBeenCalledTimes(6)
    expect(blocks.size).toBe(0) // both trees fully harvested
  })

  it('reports honest shortfall with the exhaustion note when the world runs out', async () => {
    const { bot, blocks } = makeWorld(TWO_TREES)
    const deps = makeDeps(blocks)
    const r = await gatherAction({ name: 'oak_log', count: 16 }, bot, {}, deps)
    expect(r).toBe('gathered 6/16 oak_log (no more oak_log reachable nearby)')
  })

  it('denominator is the REQUESTED count, not the component size', async () => {
    // One lonely log — the exact `gathered 1/1` false-success shape from the
    // Lyra session must now read as 1/16 + exhaustion.
    const { bot, blocks } = makeWorld([[2, 64, 0, 'oak_log']])
    const deps = makeDeps(blocks)
    const r = await gatherAction({ name: 'oak_log', count: 16 }, bot, {}, deps)
    expect(r).toBe('gathered 1/16 oak_log (no more oak_log reachable nearby)')
  })

  it('aborts mid-batch with K/W bookkeeping', async () => {
    const { bot, blocks } = makeWorld(TWO_TREES)
    const ac = new AbortController()
    const goTo = vi.fn(async () => 'reached')
    let digs = 0
    const digAction = vi.fn(async ({ x, y, z }) => {
      digs++
      if (digs === 3) ac.abort()
      blocks.delete(`${x},${y},${z}`)
      return 'dug oak_log'
    })
    const r = await gatherAction({ name: 'oak_log', count: 6 }, bot, { signal: ac.signal }, { goTo, digAction })
    expect(r).toBe('aborted after 3/6 oak_log')
  })

  it('coord-mode stays on the explicit vein and notes its true size', async () => {
    const { bot, blocks } = makeWorld(TWO_TREES)
    const deps = makeDeps(blocks)
    const r = await gatherAction({ x: 2, y: 64, z: 0, count: 16 }, bot, {}, deps)
    expect(r).toBe('gathered 3/16 oak_log (that vein had only 3)')
    expect(blocks.size).toBe(3) // the second tree was never touched
  })

  it('a component whose digs all fail is never re-anchored (terminates)', async () => {
    const { bot, blocks } = makeWorld(TWO_TREES)
    const deps = makeDeps(blocks, { failAll: true })
    const r = await gatherAction({ name: 'oak_log', count: 16 }, bot, {}, deps)
    // Both components were attempted (6 swings), none succeeded, and the
    // visited set stops findBlocks' still-solid hits from looping forever.
    expect(r).toBe('gathered 0/16 oak_log (no more oak_log reachable nearby)')
    expect(deps.digAction).toHaveBeenCalledTimes(6)
  })

  it('streams progress against the requested total', async () => {
    const { bot, blocks } = makeWorld(TWO_TREES)
    const deps = makeDeps(blocks)
    const ticks = []
    await gatherAction({ name: 'oak_log', count: 6 }, bot, { onProgress: (p) => ticks.push({ ...p }) }, deps)
    expect(ticks[0]).toEqual({ dug: 0, total: 6 })
    expect(ticks.at(-1)).toEqual({ dug: 6, total: 6 })
    expect(ticks.every(t => t.total === 6)).toBe(true)
  })

  it('abandons a component after 2 consecutive out-of-range digs (unreachable canopy tail)', async () => {
    // One 5-log trunk + one 3-log tree. Logs y66/y67 of the trunk report out
    // of range (pathfinder can't stand close enough): after the 2nd, y68 must
    // be ABANDONED (no dig attempt, no 6s goTo burn) and the gather moves to
    // the next tree.
    const { bot, blocks } = makeWorld([
      [2, 64, 0, 'oak_log'], [2, 65, 0, 'oak_log'], [2, 66, 0, 'oak_log'], [2, 67, 0, 'oak_log'], [2, 68, 0, 'oak_log'],
      [10, 64, 0, 'oak_log'], [10, 65, 0, 'oak_log'], [10, 66, 0, 'oak_log'],
    ])
    const goTo = vi.fn(async () => 'reached')
    const digAction = vi.fn(async ({ x, y, z }) => {
      if (x === 2 && y >= 66) return `out of range (5.1m, need ≤4.5) for oak_log @${x},${y},${z}`
      blocks.delete(`${x},${y},${z}`)
      return 'dug oak_log'
    })
    const r = await gatherAction({ name: 'oak_log', count: 8 }, bot, {}, { goTo, digAction })
    expect(r).toBe('gathered 5/8 oak_log')
    // Trunk: y64, y65 dug; y66, y67 out of range; y68 never attempted.
    const trunkDigs = digAction.mock.calls.filter(([a]) => a.x === 2).map(([a]) => a.y).sort()
    expect(trunkDigs).toEqual([64, 65, 66, 67])
    // Second tree still fully harvested afterward.
    expect(digAction.mock.calls.filter(([a]) => a.x === 10)).toHaveLength(3)
  })

  it('a single out-of-range dig does not abandon the component (run must be consecutive)', async () => {
    const { bot, blocks } = makeWorld([
      [2, 64, 0, 'oak_log'], [2, 65, 0, 'oak_log'], [2, 66, 0, 'oak_log'],
    ])
    let flaked = false
    const digAction = vi.fn(async ({ x, y, z }) => {
      if (y === 65 && !flaked) { flaked = true; return 'out of range (4.6m, need ≤4.5) for oak_log' }
      blocks.delete(`${x},${y},${z}`)
      return 'dug oak_log'
    })
    const r = await gatherAction({ name: 'oak_log', count: 3 }, bot, {}, { goTo: vi.fn(async () => 'reached'), digAction })
    // y65 flaked once but the run reset on the next success; only y65 is lost.
    expect(r).toBe('gathered 2/3 oak_log')
    expect(digAction).toHaveBeenCalledTimes(3)
  })

  it('returns "no <term> in loaded chunks" when nothing matches', async () => {
    const { bot } = makeWorld([])
    const deps = makeDeps(new Map())
    const r = await gatherAction({ name: 'oak_log', count: 4 }, bot, {}, deps)
    expect(r).toBe('no oak_log in loaded chunks')
  })
})

describe('gatherAction — end-of-gather drop sweep (260709)', () => {
  const noSleep = async () => {}

  function withDrops(bot, drops) {
    bot.entities = {}
    for (const [id, x, y, z] of drops) {
      bot.entities[id] = { id, name: 'item', position: new Vec3(x, y, z), isValid: true }
    }
  }

  it('walks to leftover drops near the bot after mining', async () => {
    const { bot, blocks } = makeWorld([[2, 64, 0, 'oak_log']])
    withDrops(bot, [[101, 5, 64, 2], [102, -3, 64, -4]])
    const walked = []
    const goTo = vi.fn(async (b, x, y, z, range) => {
      // Record only the sweep walks (range 0); collect the drop on arrival.
      if (range === 0) {
        walked.push(`${x},${y},${z}`)
        for (const e of Object.values(bot.entities)) {
          if (Math.floor(e.position.x) === x && Math.floor(e.position.z) === z) e.isValid = false
        }
      }
      return 'reached'
    })
    const digAction = vi.fn(async ({ x, y, z }) => { blocks.delete(`${x},${y},${z}`); return 'dug oak_log' })
    const r = await gatherAction({ name: 'oak_log', count: 1 }, bot, {}, { goTo, digAction, sleep: noSleep })
    expect(r).toBe('gathered 1/1 oak_log')
    expect(walked).toEqual(['-3,64,-4', '5,64,2']) // closest first (5.0m before 5.4m)
  })

  it('skips canopy drops (more than 2 above the bot) and never climbs', async () => {
    const { bot, blocks } = makeWorld([[2, 64, 0, 'oak_log']])
    withDrops(bot, [[101, 3, 69, 1]]) // resting on leaves, 5 above the bot
    const goTo = vi.fn(async () => 'reached')
    const digAction = vi.fn(async ({ x, y, z }) => { blocks.delete(`${x},${y},${z}`); return 'dug oak_log' })
    await gatherAction({ name: 'oak_log', count: 1 }, bot, {}, { goTo, digAction, sleep: noSleep })
    // No range-0 sweep walk was issued for the canopy drop.
    expect(goTo.mock.calls.filter(c => c[4] === 0)).toHaveLength(0)
  })

  it('attempts an uncollectable drop only once (no retry stall)', async () => {
    const { bot, blocks } = makeWorld([[2, 64, 0, 'oak_log']])
    withDrops(bot, [[101, 5, 64, 2]]) // never collected: walk times out
    const goTo = vi.fn(async (b, x, y, z, range) => (range === 0 ? 'timeout' : 'reached'))
    const digAction = vi.fn(async ({ x, y, z }) => { blocks.delete(`${x},${y},${z}`); return 'dug oak_log' })
    const r = await gatherAction({ name: 'oak_log', count: 1 }, bot, {}, { goTo, digAction, sleep: noSleep })
    expect(r).toBe('gathered 1/1 oak_log')
    expect(goTo.mock.calls.filter(c => c[4] === 0)).toHaveLength(1)
  })

  it('does not sweep when nothing was dug', async () => {
    const { bot, blocks } = makeWorld([[2, 64, 0, 'oak_log']])
    withDrops(bot, [[101, 5, 64, 2]])
    const goTo = vi.fn(async () => 'reached')
    const digAction = vi.fn(async () => 'timeout') // all digs fail
    await gatherAction({ name: 'oak_log', count: 1 }, bot, {}, { goTo, digAction, sleep: noSleep })
    expect(goTo.mock.calls.filter(c => c[4] === 0)).toHaveLength(0)
  })
})
