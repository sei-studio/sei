import { describe, it, expect } from 'vitest'
import mcDataLib from 'minecraft-data'
import {
  SPINE,
  computeProgression,
  matchGoalToNode,
  readProgressionState,
  getProgression,
  nextMilestone,
  loadSpine,
} from './progression.js'

const ids = (nodes) => nodes.map(n => n.id)

// Synthesize the state change of "achieving" a node, so a test can walk the
// spine the way the bot would. Mirrors the predicate kinds in progression.js.
function achieve(state, node) {
  const g = node.goal
  const next = { ...state, items: { ...state.items }, flags: { ...state.flags } }
  if (g.have) next.items[g.have] = (next.items[g.have] ?? 0) + (g.count ?? 1)
  else if (g.haveSuffix) next.items[`oak${g.haveSuffix}`] = (next.items[`oak${g.haveSuffix}`] ?? 0) + (g.count ?? 1)
  else if (g.pickaxe) next.pickaxeTier = Math.max(next.pickaxeTier ?? 0, g.pickaxe)
  else if (g.dim) next.dim = g.dim
  else if (g.flag) next.flags[g.flag] = true
  return next
}

describe('progression spine — connectivity', () => {
  it('reaches defeat(ender_dragon) by greedily taking the frontier from an empty start', () => {
    let state = { items: {}, pickaxeTier: 0, dim: 'overworld', flags: {} }
    const taken = []
    for (let step = 0; step < 100; step++) {
      const { frontier, complete } = computeProgression(state)
      if (complete) break
      expect(frontier.length).toBeGreaterThan(0) // never a dead end before the dragon
      const node = frontier[0]
      taken.push(node.id)
      state = achieve(state, node)
    }
    expect(computeProgression(state).complete).toBe(true)
    // the win path was walked end to end
    expect(taken).toContain('iron_pickaxe')
    expect(taken).toContain('nether')
    expect(taken).toContain('ender_eyes')
    expect(taken[taken.length - 1]).toBe('dragon') // the boss is the final rung
  })

  it('every node lists prerequisites that exist in the spine', () => {
    const known = new Set(SPINE.map(n => n.id))
    for (const n of SPINE) for (const p of n.needs) expect(known.has(p)).toBe(true)
  })
})

describe('frontier correctness', () => {
  it('empty inventory → frontier is exactly gather wood', () => {
    const { frontier, currentMilestone } = computeProgression({ items: {}, pickaxeTier: 0, dim: 'overworld' })
    expect(ids(frontier)).toEqual(['logs'])
    expect(currentMilestone.id).toBe('logs')
  })

  it('with logs + crafting table → wooden pickaxe is reachable, stone is not yet', () => {
    const { frontier } = computeProgression({ items: { oak_log: 4, crafting_table: 1 }, pickaxeTier: 0, dim: 'overworld' })
    expect(ids(frontier)).toContain('wood_pickaxe')
    expect(ids(frontier)).not.toContain('stone_pickaxe')
  })

  it('after the Nether the frontier branches (blaze rods AND ender pearls in parallel)', () => {
    // iron+furnace+diamond gear all done, standing in the nether.
    const state = {
      items: { iron_pickaxe: 1, diamond_pickaxe: 1, furnace: 1, flint_and_steel: 1 },
      pickaxeTier: 4,
      dim: 'the_nether',
      flags: { entered_nether: true },
    }
    const { frontier } = computeProgression(state)
    expect(ids(frontier)).toEqual(expect.arrayContaining(['blaze_rods', 'ender_pearls']))
    expect(ids(frontier)).not.toContain('ender_eyes') // needs both branches first
  })
})

describe('monotonic-progress closure (the consumption gotcha)', () => {
  it('crafting diamonds into a diamond pickaxe does NOT re-open "mine diamonds"', () => {
    // 0 raw diamonds in inventory, but a diamond pickaxe (tier 4) exists.
    const { done } = computeProgression({ items: { diamond_pickaxe: 1 }, pickaxeTier: 4, dim: 'overworld' })
    expect(done.has('diamonds')).toBe(true)        // implied by the downstream pickaxe
    expect(done.has('iron_pickaxe')).toBe(true)    // …and everything before it
  })

  it('spending obsidian + eyes to reach the End leaves those milestones done', () => {
    // In the End, holding none of the consumed items.
    const { done, frontier } = computeProgression({ items: {}, pickaxeTier: 0, dim: 'the_end', flags: { entered_end: true } })
    expect(done.has('obsidian')).toBe(true)
    expect(done.has('ender_eyes')).toBe(true)
    expect(done.has('nether')).toBe(true)
    expect(ids(frontier)).toEqual(['dragon']) // only the boss remains
  })
})

describe('regression on loss (self-correcting gear, early game)', () => {
  it('losing the only stone pickaxe re-opens the stone-pickaxe milestone', () => {
    const withPick = computeProgression({ items: { oak_log: 1, crafting_table: 1 }, pickaxeTier: 2, dim: 'overworld' })
    expect(withPick.done.has('stone_pickaxe')).toBe(true)
    const lost = computeProgression({ items: { oak_log: 1, crafting_table: 1 }, pickaxeTier: 1, dim: 'overworld' })
    expect(lost.done.has('stone_pickaxe')).toBe(false)
    expect(ids(lost.frontier)).toContain('stone_pickaxe')
  })
})

describe('spine is consistent with real game data (minecraft-data 1.21.1)', () => {
  const d = mcDataLib('1.21.1')

  it('every item the spine names exists in the game', () => {
    // Items referenced by goal.have, plus the pickaxe-tier items the `pickaxe`
    // predicate stands for, plus the craft micro-steps the spine intentionally
    // leaves to the craft tool (planks, sticks) — all must be real ids.
    const named = SPINE.map(n => n.goal.have).filter(Boolean)
    const pickaxes = ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe']
    const micro = ['oak_log', 'oak_planks', 'stick']
    for (const name of [...named, ...pickaxes, ...micro]) {
      expect(d.itemsByName[name], `missing item: ${name}`).toBeTruthy()
    }
  })

  it('crafted milestones have a real recipe; gathered ones do not (the get/craft split)', () => {
    const hasRecipe = (name) => {
      const it = d.itemsByName[name]
      return !!(it && d.recipes[it.id] && d.recipes[it.id].length > 0)
    }
    // What the bot CRAFTS (incl. the planks/sticks micro-steps it does via the
    // craft tool rather than as spine nodes).
    for (const name of ['oak_planks', 'stick', 'crafting_table', 'wooden_pickaxe', 'stone_pickaxe', 'furnace', 'iron_pickaxe', 'diamond_pickaxe', 'flint_and_steel', 'ender_eye']) {
      expect(hasRecipe(name), `${name} should be craftable`).toBe(true)
    }
    // What the bot GATHERS / obtains with no crafting recipe at all — mined,
    // looted, or killed. (diamond is excluded: the spine MINES it, but the item
    // is also block-craftable from a diamond_block, so it does carry a recipe.)
    for (const name of ['oak_log', 'obsidian', 'blaze_rod', 'ender_pearl']) {
      expect(hasRecipe(name), `${name} should NOT be a crafting recipe`).toBe(false)
    }
  })
})

describe('progression.json externalization (D-04/D-07)', () => {
  it('loads the spine from progression.json — all 16 ids incl. iron_pickaxe', () => {
    const allIds = SPINE.map(n => n.id)
    expect(allIds).toContain('iron_pickaxe')
    expect(allIds).toContain('dragon')
    expect(SPINE.length).toBe(16)
  })

  it('iron-tier nodes (logs..iron_pickaxe) carry next_action + procedure', () => {
    const ironTier = ['logs', 'crafting_table', 'wood_pickaxe', 'stone_pickaxe', 'furnace', 'iron_pickaxe']
    for (const id of ironTier) {
      const node = SPINE.find(n => n.id === id)
      expect(node, `node ${id} exists`).toBeTruthy()
      expect(typeof node.next_action, `${id}.next_action`).toBe('string')
      expect(node.next_action.length, `${id}.next_action non-empty`).toBeGreaterThan(0)
      expect(typeof node.procedure, `${id}.procedure`).toBe('string')
      expect(node.procedure.length, `${id}.procedure non-empty`).toBeGreaterThan(0)
    }
  })

  it('loadSpine degrades to an empty spine on a missing/malformed file (never throws)', () => {
    expect(() => loadSpine(new URL('./does-not-exist-progression.json', import.meta.url))).not.toThrow()
    expect(loadSpine(new URL('./does-not-exist-progression.json', import.meta.url))).toEqual([])
  })
})

describe('nextMilestone walker (D-07)', () => {
  it('with no goal returns currentMilestone + its advancing action', () => {
    const nm = nextMilestone({ items: {}, pickaxeTier: 0, dim: 'overworld' })
    expect(nm.node.id).toBe('logs')
    expect(nm.action).toBe(SPINE.find(n => n.id === 'logs').next_action)
  })

  it('a goal that matches a frontier node wins over currentMilestone', () => {
    // After the Nether, frontier = [blaze_rods, ender_pearls]; currentMilestone is blaze_rods.
    const state = {
      items: { iron_pickaxe: 1, diamond_pickaxe: 1, furnace: 1, flint_and_steel: 1 },
      pickaxeTier: 4,
      dim: 'the_nether',
      flags: { entered_nether: true },
    }
    expect(nextMilestone(state).node.id).toBe('blaze_rods') // no goal → currentMilestone
    expect(nextMilestone(state, 'go get some ender pearls').node.id).toBe('ender_pearls') // goal wins
  })

  it('nextMilestone(state, "iron pickaxe") returns the iron_pickaxe node', () => {
    const state = { items: { stone_pickaxe: 1, furnace: 1 }, pickaxeTier: 2, dim: 'overworld' }
    const nm = nextMilestone(state, 'go get an iron pickaxe')
    expect(nm.node.id).toBe('iron_pickaxe')
    expect(typeof nm.action).toBe('string')
    expect(nm.action.length).toBeGreaterThan(0)
  })

  it('returns { node: null, action: null } when the game is complete', () => {
    const nm = nextMilestone({ items: {}, pickaxeTier: 0, dim: 'the_end', flags: { entered_end: true, killed_dragon: true } })
    expect(nm.node).toBe(null)
    expect(nm.action).toBe(null)
  })
})

describe('matchGoalToNode', () => {
  it('links a free-text goal to the right spine node, longest key wins', () => {
    expect(matchGoalToNode('go get a diamond pickaxe then mine obsidian').id).toBe('diamond_pickaxe')
    expect(matchGoalToNode('mine a stack of diamonds').id).toBe('diamonds')
    expect(matchGoalToNode('build a cozy cottage by the lake')).toBe(null) // off-graph personality goal
  })
})

describe('readProgressionState (live bot reader) — defensive', () => {
  it('reads inventory, best pickaxe tier and dimension off a bot-like object', () => {
    const bot = {
      version: '1.21.1',
      game: { dimension: 'the_nether' },
      inventory: { items: () => [
        { name: 'oak_log', count: 3 },
        { name: 'stone_pickaxe', count: 1 },
        { name: 'iron_pickaxe', count: 1 },
      ] },
    }
    const s = readProgressionState(bot, { entered_nether: true })
    expect(s.items.oak_log).toBe(3)
    expect(s.pickaxeTier).toBe(3) // iron beats stone
    expect(s.dim).toBe('the_nether')
    expect(s.flags.entered_nether).toBe(true)
  })

  it('degrades to an empty state on a stub bot (never throws)', () => {
    expect(() => getProgression({})).not.toThrow()
    const prog = getProgression({})
    expect(ids(prog.frontier)).toEqual(['logs']) // empty state → start of the spine
  })
})
