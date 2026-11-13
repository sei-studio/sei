import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { composeSnapshot, createSnapshotComposer, arr } from './observers/snapshot.js'

// A real observation captured from the headless harness
// (FCT_DUMP_AFTER=deposit_take, scripts/factorio-headless-harness.mjs).
const base = JSON.parse(readFileSync(new URL('./fixtures/obs-base.json', import.meta.url), 'utf8'))

const busy = {
  ...base,
  fighting: true,
  health: 62,
  job: { verb: 'gather', id: 'x', progress: 'mining iron-ore, 6 of 20' },
  crafting: 2,
  owner: { name: 'Tester', surface: 'nauvis', at: [0, 0], dist: 9, dir: 'west', vehicle: 'car', health: 80, holding: 'transport-belt', pointing: { name: 'stone-furnace', h: 48, at: [4, 0] } },
  enemies: { units: [['small-biter', 3]], nests: 1, nearest: 'small-biter', dist: 14, dir: 'north', near_owner: true },
  base: {
    buildings: [['stone-furnace', 4], ['burner-mining-drill', 2]], kinds: 3,
    problems: [{ h: 48, name: 'stone-furnace', at: [4, 0], status: 'out of fuel' }],
    chests: [{ h: 49, name: 'wooden-chest', at: [15.5, 21.5], has: '6 copper-plate' }],
    ghosts: 5,
  },
  research: { name: 'automation', pct: 40, queue: 2 },
}

describe('composeSnapshot', () => {
  it('words a real observation in a few hundred characters', () => {
    const s = composeSnapshot(base)
    expect(s).toMatch(/^you: Sui at 18,19 on nauvis, health 100%/)
    expect(s).toContain('player Tester: 42 tiles northwest')
    expect(s).toContain('inventory (72 free slots): 39 iron-plate, 30 stone')
    expect(s).toContain('weapon: pistol (10 firearm-magazine)')
    expect(s).toContain('iron-ore 385k (nearest 2 tiles east)')
    expect(s).toContain('chests: #49 wooden-chest (16,22): 6 copper-plate')
    expect(s).toContain('research: none selected')
    // Lua writes an empty list as {}: no "problems:" line, no crash.
    expect(s).not.toContain('problems:')
    expect(s.length).toBeLessThan(700)
  })

  it('puts danger, problems and the job on their own lines', () => {
    const s = composeSnapshot(busy, { lastActionResult: 'gathered 8 wood' })
    expect(s).toContain('health 62%')
    expect(s).toContain(', fighting')
    expect(s).toContain('  progress: mining iron-ore, 6 of 20')
    expect(s).toContain('crafting queue: 2 recipes in progress')
    expect(s).toContain('player Tester: 9 tiles west, in a car, health 80%, holding transport-belt, pointing at #48 stone-furnace (4,0)')
    expect(s).toContain('ENEMIES: 3 small-biter, 1 nest or worms; nearest small-biter 14 tiles north (close to the player!)')
    expect(s).toContain('problems: #48 stone-furnace (4,0) out of fuel')
    expect(s).toContain('ghosts to build nearby: 5 (buildGhosts)')
    expect(s).toContain('research: automation 40% (1 more queued)')
    expect(s.split('\n').at(-1)).toBe('last_action_result: gathered 8 wood')
    expect(s.length).toBeLessThan(1200)
  })

  it('handles dead, gone, missing player and no observation', () => {
    expect(composeSnapshot(null)).toMatch(/waiting for the first observation/)
    expect(composeSnapshot({ dead: true, respawn_s: 7 })).toContain('you are DEAD; back next to the player in 7s')
    expect(composeSnapshot({ gone: true })).toContain('not in the world')
    expect(composeSnapshot({ ...base, owner: { missing: true } })).toContain('player: not in the world')
    expect(composeSnapshot({ ...base, owner: { name: 'Tester', surface: 'vulcanus' } })).toContain('on vulcanus (not where you are)')
  })

  it('reads Lua empty tables as empty lists', () => {
    expect(arr({})).toEqual([])
    expect(arr([1])).toEqual([1])
    const s = composeSnapshot({ ...base, inv: { items: {}, free: 80, kinds: 0, guns: {} } })
    expect(s).toContain('inventory (80 free slots): empty')
    expect(s).toContain('weapon: none (you cannot fight)')
  })
})

describe('createSnapshotComposer', () => {
  it('calls out inventory changes and health loss since the last look', () => {
    let obs = base
    const c = createSnapshotComposer({ getObs: () => obs })
    c.next()
    obs = { ...base, health: 70, inv: { ...base.inv, items: [['iron-plate', 29], ['stone', 30], ['coal', 20], ['iron-ore', 20], ['wood', 9], ['copper-plate', 6], ['burner-mining-drill', 2], ['stone-furnace', 1], ['iron-gear-wheel', 5]] } }
    const s = c.next()
    expect(s).toContain('inventory changed since last look: +5 iron-gear-wheel, -10 iron-plate')
    expect(s).toContain('recent_events: health -30%')
    expect(c.next()).not.toContain('inventory changed')
  })
})
