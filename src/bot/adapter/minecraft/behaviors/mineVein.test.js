// gatherAction (260708) â€” multi-component gather. Pins the Lyra post-mortem
// fix: name-mode keeps re-anchoring on fresh trees until the REQUESTED count
// is attempted (old behavior stopped after ONE connected component and
// reported `gathered 1/1`, which read as full success). Also pins: honest
// K/W result denominators, the exhaustion note, coord-mode staying
// single-component, abort mid-batch, and the no-re-anchor guarantee for a
// component whose digs all failed (no infinite loop).

import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'module'
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

describe('gatherAction â€” multi-component (260708)', () => {
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
    // One lonely log â€” the exact `gathered 1/1` false-success shape from the
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
      if (x === 2 && y >= 66) return `out of range (5.1m, need â‰¤4.5) for oak_log @${x},${y},${z}`
      blocks.delete(`${x},${y},${z}`)
      return 'dug oak_log'
    })
    const r = await gatherAction({ name: 'oak_log', count: 8 }, bot, {}, { goTo, digAction })
    expect(r).toBe('gathered 5/8 oak_log (no more oak_log reachable nearby)')
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
      if (y === 65 && !flaked) { flaked = true; return 'out of range (4.6m, need â‰¤4.5) for oak_log' }
      blocks.delete(`${x},${y},${z}`)
      return 'dug oak_log'
    })
    const r = await gatherAction({ name: 'oak_log', count: 3 }, bot, {}, { goTo: vi.fn(async () => 'reached'), digAction })
    // y65 flaked once but the run reset on the next success; only y65 is lost.
    // 261011: the gather then looks for more and finds none, so it says so.
    expect(r).toBe('gathered 2/3 oak_log (no more oak_log reachable nearby)')
    expect(digAction).toHaveBeenCalledTimes(3)
  })

  it('keeps going past blocks it could not dig until the requested count is DUG (261011)', async () => {
    // Three 3-log trees whose top log is out of reach. Asking for 6 used to
    // stop after two trees (6 attempted, 4 dug); it must reach the third.
    const { bot, blocks } = makeWorld([
      [2, 64, 0, 'oak_log'], [2, 65, 0, 'oak_log'], [2, 66, 0, 'oak_log'],
      [10, 64, 0, 'oak_log'], [10, 65, 0, 'oak_log'], [10, 66, 0, 'oak_log'],
      [20, 64, 0, 'oak_log'], [20, 65, 0, 'oak_log'], [20, 66, 0, 'oak_log'],
    ])
    const digAction = vi.fn(async ({ x, y, z }) => {
      if (y === 66) return `out of range (5.0m, need â‰¤4.5) for oak_log @${x},${y},${z}`
      blocks.delete(`${x},${y},${z}`)
      return 'dug oak_log'
    })
    const r = await gatherAction({ name: 'oak_log', count: 6 }, bot, {}, { goTo: vi.fn(async () => 'reached'), digAction })
    expect(r).toBe('gathered 6/6 oak_log')
  })

  it('finds a fresh tree behind more than 8 logs it already gave up on (261011)', async () => {
    // Nine unreachable logs close by, one good tree further out. findBlocks
    // used to ask for only the 8 nearest, all of them already visited, and
    // reported "no more reachable" with the good tree in range.
    const near = []
    for (let i = 0; i < 9; i++) near.push([1 + (i % 3), 70 + Math.floor(i / 3), 1, 'oak_log'])
    const { bot, blocks } = makeWorld([...near, [30, 64, 0, 'oak_log'], [30, 65, 0, 'oak_log']])
    const digAction = vi.fn(async ({ x, y, z }) => {
      if (y >= 70) return 'timeout'
      blocks.delete(`${x},${y},${z}`)
      return 'dug oak_log'
    })
    const r = await gatherAction({ name: 'oak_log', count: 11 }, bot, {}, { goTo: vi.fn(async () => 'reached'), digAction })
    expect(r).toBe('gathered 2/11 oak_log (no more oak_log reachable nearby)')
    expect(blocks.has('30,64,0')).toBe(false)
  })

  it('retries a block once when the dig answered busy (261011)', async () => {
    const { bot, blocks } = makeWorld([[2, 64, 0, 'oak_log'], [2, 65, 0, 'oak_log']])
    let busyOnce = true
    const digAction = vi.fn(async ({ x, y, z }) => {
      if (y === 65 && busyOnce) { busyOnce = false; return 'busy digging oak_log @2,65,0' }
      blocks.delete(`${x},${y},${z}`)
      return 'dug oak_log'
    })
    const r = await gatherAction({ name: 'oak_log', count: 2 }, bot, {}, { goTo: vi.fn(async () => 'reached'), digAction, sleep: async () => {} })
    expect(r).toBe('gathered 2/2 oak_log')
  })

  it('walks toward dig reach of an out-of-reach block, not feet-within-3 (261011)', async () => {
    const { bot, blocks } = makeWorld([[2, 64, 12, 'oak_log']])
    const goTo = vi.fn(async () => 'reached')
    const digAction = vi.fn(async ({ x, y, z }) => { blocks.delete(`${x},${y},${z}`); return 'dug oak_log' })
    await gatherAction({ name: 'oak_log', count: 1 }, bot, {}, { goTo, digAction, sleep: async () => {} })
    const approach = goTo.mock.calls.find((c) => c[1] === 2 && c[3] === 12)
    expect(approach?.[7]?.reach).toBeGreaterThan(3.5)
  })

  it('returns "no <term> in loaded chunks" when nothing matches', async () => {
    const { bot } = makeWorld([])
    const deps = makeDeps(new Map())
    const r = await gatherAction({ name: 'oak_log', count: 4 }, bot, {}, deps)
    expect(r).toBe('no oak_log in loaded chunks')
  })
})

describe('gatherAction â€” end-of-gather drop sweep (260709)', () => {
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
    const sweepOpts = []
    const goTo = vi.fn(async (b, x, y, z, range, ms, sig, opts) => {
      // Record only the sweep walks (range 1; mining walks use 3) and collect
      // the drop on arrival. Under a tree they may not dig.
      if (range === 1) {
        sweepOpts.push(opts)
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
    expect(sweepOpts).toEqual([{ canDig: false, canPlace: false }, { canDig: false, canPlace: false }]) // no digging under a tree, never placing
  })

  it('lets the sweep dig into the hole a stone drop fell in (261011)', async () => {
    const { bot, blocks } = makeWorld([[2, 63, 0, 'stone']])
    withDrops(bot, [[101, 2, 62, 0]])
    const goTo = vi.fn(async () => 'reached')
    const digAction = vi.fn(async ({ x, y, z }) => { blocks.delete(`${x},${y},${z}`); return 'dug stone' })
    await gatherAction({ x: 2, y: 63, z: 0, count: 1 }, bot, {}, { goTo, digAction, sleep: noSleep })
    const sweeps = goTo.mock.calls.filter(c => c[4] === 1)
    expect(sweeps).toHaveLength(1)
    expect(sweeps[0][7]).toEqual({ canPlace: false })
  })

  it('skips canopy drops (more than 2 above the bot) and never climbs', async () => {
    const { bot, blocks } = makeWorld([[2, 64, 0, 'oak_log']])
    withDrops(bot, [[101, 3, 69, 1]]) // resting on leaves, 5 above the bot
    const goTo = vi.fn(async () => 'reached')
    const digAction = vi.fn(async ({ x, y, z }) => { blocks.delete(`${x},${y},${z}`); return 'dug oak_log' })
    await gatherAction({ name: 'oak_log', count: 1 }, bot, {}, { goTo, digAction, sleep: noSleep })
    // No sweep walk was issued for the canopy drop.
    expect(goTo.mock.calls.filter(c => c[4] === 1)).toHaveLength(0)
  })

  it('attempts an uncollectable drop only once (no retry stall)', async () => {
    const { bot, blocks } = makeWorld([[2, 64, 0, 'oak_log']])
    withDrops(bot, [[101, 5, 64, 2]]) // never collected: walk times out
    const goTo = vi.fn(async (b, x, y, z, range) => (range === 1 ? 'timeout' : 'reached'))
    const digAction = vi.fn(async ({ x, y, z }) => { blocks.delete(`${x},${y},${z}`); return 'dug oak_log' })
    const r = await gatherAction({ name: 'oak_log', count: 1 }, bot, {}, { goTo, digAction, sleep: noSleep })
    expect(r).toBe('gathered 1/1 oak_log')
    expect(goTo.mock.calls.filter(c => c[4] === 1)).toHaveLength(1)
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

describe('gatherAction â€” says when the drops never reached the inventory (261011)', () => {
  const noSleep = async () => {}
  it('never counts a block whose drop did not reach the inventory (261012)', async () => {
    const { bot, blocks } = makeWorld([[2, 64, 0, 'oak_log']])
    bot.inventory = { items: () => [{ name: 'oak_log', count: 2 }] }
    const digAction = vi.fn(async ({ x, y, z }) => { blocks.delete(`${x},${y},${z}`); return 'dug oak_log' })
    const r = await gatherAction({ name: 'oak_log', count: 1 }, bot, {}, { goTo: async () => 'reached', digAction, sleep: noSleep })
    expect(r).toBe('gathered 0/1 oak_log (no more oak_log reachable nearby) (broke 1 oak_log, but none reached your inventory)')
  })

  it('adds nothing when the drop was collected', async () => {
    const { bot, blocks } = makeWorld([[2, 64, 0, 'oak_log']])
    const inv = [{ name: 'oak_log', count: 2 }]
    bot.inventory = { items: () => inv }
    const digAction = vi.fn(async ({ x, y, z }) => { blocks.delete(`${x},${y},${z}`); inv[0].count++; return 'dug oak_log' })
    const r = await gatherAction({ name: 'oak_log', count: 1 }, bot, {}, { goTo: async () => 'reached', digAction, sleep: noSleep })
    expect(r).toBe('gathered 1/1 oak_log')
  })
})

describe('gatherAction â€” loose term that is also a block ID (261011)', () => {
  const mcData = createRequire(import.meta.url)('minecraft-data')('1.21.1')
  function makeMatchingWorld(blockList) {
    const blocks = new Map()
    for (const [x, y, z, name] of blockList) blocks.set(`${x},${y},${z}`, name)
    const bot = {
      version: '1.21.1',
      entity: { position: new Vec3(0, 64, 0) },
      blockAt(p) {
        const name = blocks.get(`${p.x},${p.y},${p.z}`)
        return name ? { name, position: p } : { name: 'air', position: p }
      },
      findBlocks({ matching, count }) {
        const hits = []
        for (const [k, name] of blocks) {
          const id = mcData.blocksByName[name]?.id
          if (!(Array.isArray(matching) ? matching.includes(id) : matching({ name }))) continue
          const [x, y, z] = k.split(',').map(Number)
          hits.push(new Vec3(x, y, z))
        }
        hits.sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
        return hits.slice(0, count ?? 1)
      },
    }
    const deps = {
      goTo: vi.fn(async () => 'reached'),
      digAction: vi.fn(async ({ x, y, z }) => {
        const k = `${x},${y},${z}`
        const name = blocks.get(k)
        if (!name) return 'no block'
        blocks.delete(k)
        return `dug ${name} at ${k}`
      }),
      sleep: async () => {},
    }
    return { bot, blocks, deps }
  }

  it('gather("stone") mines stone even when diorite is closer', async () => {
    const { bot, deps } = makeMatchingWorld([
      [1, 64, 0, 'diorite'],
      [6, 64, 0, 'stone'], [6, 65, 0, 'stone'],
    ])
    const r = await gatherAction({ name: 'stone', count: 2 }, bot, {}, deps)
    expect(r).toBe('gathered 2/2 stone')
  })

  it('falls back to the variants when no plain stone is in range', async () => {
    const { bot, deps } = makeMatchingWorld([[1, 64, 0, 'andesite']])
    const r = await gatherAction({ name: 'stone', count: 1 }, bot, {}, deps)
    expect(r).toBe('gathered 1/1 andesite')
  })
})

describe('gatherAction â€” cobblestone comes from stone (261011)', () => {
  it('mines stone, not placed cobblestone, and says so', async () => {
    const mcData = createRequire(import.meta.url)('minecraft-data')('1.21.1')
    const blocks = new Map([['1,64,0', 'cobblestone'], ['5,64,0', 'stone']])
    const bot = {
      version: '1.21.1',
      entity: { position: new Vec3(0, 64, 0) },
      blockAt(p) { const name = blocks.get(`${p.x},${p.y},${p.z}`); return { name: name ?? 'air', position: p } },
      findBlocks({ matching }) {
        const hits = []
        for (const [k, name] of blocks) {
          if (!matching.includes(mcData.blocksByName[name].id)) continue
          const [x, y, z] = k.split(',').map(Number)
          hits.push(new Vec3(x, y, z))
        }
        return hits
      },
    }
    const deps = {
      goTo: vi.fn(async () => 'reached'),
      digAction: vi.fn(async ({ x, y, z }) => { const k = `${x},${y},${z}`; const n = blocks.get(k); blocks.delete(k); return `dug ${n}` }),
      sleep: async () => {},
    }
    const r = await gatherAction({ name: 'cobblestone', count: 1 }, bot, {}, deps)
    expect(r).toBe('gathered 1/1 stone (stone drops cobblestone)')
    expect(blocks.has('1,64,0')).toBe(true)
  })
})

// 261012 â€” quality eval mine_stone: "gathered 10/10 stone" with 7 to 9
// cobblestone delivered. The count now comes from the inventory, the batch
// mines on to make up lost drops, and the sweep tries a drop's own cell.
describe('gatherAction â€” counts what reaches the inventory (261012)', () => {
  const mcData = createRequire(import.meta.url)('minecraft-data')('1.21.1')
  // A row of stone along +x; the bot carries an inventory the dig stub feeds.
  function stoneWorld(n, { far = false } = {}) {
    const blocks = new Map()
    for (let i = 0; i < n; i++) blocks.set(`${i + 1},63,0`, 'stone')
    const inv = []
    const bot = {
      version: '1.21.1',
      entity: { position: new Vec3(0.5, 64, 0.5), eyeHeight: 1.62 },
      entities: {},
      inventory: { items: () => inv },
      blockAt(p) { const name = blocks.get(`${p.x},${p.y},${p.z}`); return { name: name ?? 'air', position: p } },
      findBlocks({ matching, count }) {
        const hits = []
        for (const [k, name] of blocks) {
          if (!matching.includes(mcData.blocksByName[name].id)) continue
          const [x, y, z] = k.split(',').map(Number)
          hits.push(new Vec3(x, y, z))
        }
        hits.sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
        return hits.slice(0, count ?? 1)
      },
    }
    if (far) bot.entity.position = new Vec3(-20.5, 64, 0.5)
    const give = (name, k = 1) => {
      const it = inv.find(i => i.name === name)
      if (it) it.count += k
      else inv.push({ name, count: k })
    }
    return { bot, blocks, inv, give }
  }
  const noSleep = async () => {}

  it('mines past a lost drop until the requested count is in the inventory', async () => {
    const { bot, blocks, give } = stoneWorld(6)
    let n = 0
    const digAction = vi.fn(async ({ x, y, z }) => {
      blocks.delete(`${x},${y},${z}`)
      if (++n !== 2) give('cobblestone') // the second drop is lost
      return 'dug stone'
    })
    const r = await gatherAction({ name: 'stone', count: 3 }, bot, {}, { goTo: vi.fn(async () => 'reached'), digAction, sleep: noSleep })
    expect(r).toBe('gathered 3/3 cobblestone (mined from stone)')
    expect(digAction).toHaveBeenCalledTimes(4)
  })

  it('progress ticks carry the drop items and the count held at the start (261014)', async () => {
    const { bot, blocks, give } = stoneWorld(4)
    give('cobblestone', 5)
    const digAction = vi.fn(async ({ x, y, z }) => { blocks.delete(`${x},${y},${z}`); give('cobblestone'); return 'dug stone' })
    const ticks = []
    await gatherAction({ name: 'stone', count: 2 }, bot, { onProgress: (p) => ticks.push({ ...p }) }, { goTo: vi.fn(async () => 'reached'), digAction, sleep: noSleep })
    expect(ticks[0]).toEqual({ dug: 0, total: 2, items: ['cobblestone'], before: 5 })
    expect(ticks.at(-1)).toEqual({ dug: 2, total: 2, items: ['cobblestone'], before: 5 })
  })

  it('stops after a bounded number of extra digs and reports only what arrived', async () => {
    const { bot, blocks } = stoneWorld(20)
    const digAction = vi.fn(async ({ x, y, z }) => { blocks.delete(`${x},${y},${z}`); return 'dug stone' })
    const r = await gatherAction({ name: 'stone', count: 4 }, bot, {}, { goTo: vi.fn(async () => 'reached'), digAction, sleep: noSleep })
    // 4 requested + 4 extra digs at most; nothing ever arrived.
    expect(digAction).toHaveBeenCalledTimes(8)
    expect(r).toBe('gathered 0/4 cobblestone (mined from stone) (broke 8 stone, but none reached your inventory)')
  })

  it('digs only the requested count when the drops arrive late, in the sweep', async () => {
    const { bot, blocks, give } = stoneWorld(12)
    let nextId = 100
    const digAction = vi.fn(async ({ x, y, z }) => {
      blocks.delete(`${x},${y},${z}`)
      const id = nextId++
      bot.entities[id] = { id, name: 'item', position: new Vec3(x + 0.5, y, z + 0.5), isValid: true }
      return 'dug stone'
    })
    // Nothing reaches the inventory until the sweep walks over each drop.
    const goTo = vi.fn(async (b, x, y, z) => {
      for (const [id, e] of Object.entries(bot.entities)) {
        if (Math.floor(e.position.x) === x && Math.floor(e.position.z) === z) { delete bot.entities[id]; give('cobblestone') }
      }
      return 'reached'
    })
    const r = await gatherAction({ name: 'stone', count: 4 }, bot, {}, { goTo, digAction, sleep: noSleep })
    expect(digAction).toHaveBeenCalledTimes(4)
    expect(r).toBe('gathered 4/4 cobblestone (mined from stone)')
  })

  it('counts the drop, not the block, for a block that drops several items', async () => {
    const { bot, blocks, give } = stoneWorld(0)
    blocks.set('1,63,0', 'redstone_ore'); blocks.set('2,63,0', 'redstone_ore'); blocks.set('3,63,0', 'redstone_ore')
    const digAction = vi.fn(async ({ x, y, z }) => { blocks.delete(`${x},${y},${z}`); give('redstone', 4); return 'dug redstone_ore' })
    const r = await gatherAction({ name: 'redstone_ore', count: 5 }, bot, {}, { goTo: vi.fn(async () => 'reached'), digAction, sleep: noSleep })
    expect(digAction).toHaveBeenCalledTimes(2)
    expect(r).toBe('gathered 8/5 redstone (mined from redstone_ore)')
  })

  it('stops at the first block that cannot drop anything with the tools on hand', async () => {
    const { bot, blocks } = stoneWorld(6)
    const digAction = vi.fn(async ({ x, y, z }) => {
      blocks.delete(`${x},${y},${z}`)
      return 'dug stone (no drop â€” you have no tool that can harvest stone; craft the right pickaxe first)'
    })
    const goTo = vi.fn(async () => 'reached')
    const r = await gatherAction({ name: 'stone', count: 5 }, bot, {}, { goTo, digAction, sleep: noSleep })
    expect(digAction).toHaveBeenCalledTimes(1)
    expect(r).toMatch(/^gathered 0\/5 cobblestone \(mined from stone\) \(stopped: stone drops nothing unless you hold the right tool/)
  })

  it('retries a block once when the dig was cancelled under it', async () => {
    const { bot, blocks, give } = stoneWorld(1)
    let first = true
    const digAction = vi.fn(async ({ x, y, z }) => {
      if (first) { first = false; return 'dig failed: Digging aborted' }
      blocks.delete(`${x},${y},${z}`); give('cobblestone'); return 'dug stone'
    })
    const r = await gatherAction({ name: 'stone', count: 1 }, bot, {}, { goTo: vi.fn(async () => 'reached'), digAction, sleep: noSleep })
    expect(digAction).toHaveBeenCalledTimes(2)
    expect(r).toBe('gathered 1/1 cobblestone (mined from stone)')
  })

  it('walks to a block without scaffolding with the item being gathered', async () => {
    const { bot, blocks, give } = stoneWorld(1, { far: true })
    const goTo = vi.fn(async () => 'reached')
    const digAction = vi.fn(async ({ x, y, z }) => { blocks.delete(`${x},${y},${z}`); give('cobblestone'); return 'dug stone' })
    await gatherAction({ name: 'stone', count: 1 }, bot, {}, { goTo, digAction, sleep: noSleep })
    const approach = goTo.mock.calls.find(c => c[4] === 3)
    expect(approach[7]).toEqual({ reach: 4.2, keepItems: ['cobblestone'] })
  })

  it('tries a drop a second time, ending in its own cell, when the first walk did not collect it', async () => {
    const { bot, blocks, give } = stoneWorld(1)
    const drop = { id: 7, name: 'item', position: new Vec3(3.4, 63, 0.6), isValid: true }
    bot.entities = { 7: drop }
    const walks = []
    const goTo = vi.fn(async (b, x, y, z, range) => {
      walks.push([x, y, z, range])
      // Only standing in the drop's own cell picks it up (it lies in a hole).
      if (range === 0) { delete bot.entities[7]; give('cobblestone') }
      return 'reached'
    })
    const digAction = vi.fn(async ({ x, y, z }) => { blocks.delete(`${x},${y},${z}`); return 'dug stone' })
    const r = await gatherAction({ name: 'stone', count: 1 }, bot, {}, { goTo, digAction, sleep: noSleep })
    expect(walks).toEqual([[3, 63, 0, 1], [3, 63, 0, 0]])
    expect(r).toBe('gathered 1/1 cobblestone (mined from stone)')
  })
})




