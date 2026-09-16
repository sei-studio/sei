// The Stardew first-fortnight frontier (260910). Pure: a state in, the
// reachable list out; the latches read verb results and observations.
import { describe, it, expect } from 'vitest'
import { computeProgression, createProgressionFlags, getProgression, readProgressionState, SPINE } from './progression.js'

const inv = (rows) => rows.map(([name, count, kind]) => ({ name, count, kind }))

describe('stardew progression frontier', () => {
  it('a fresh farm on spring 1 offers the patch, wood, forage, town and fishing, not the mines', () => {
    const prog = getProgression({ inventory: [], farm: { crops: 0, soil: 0 }, daysPlayed: 1 }, createProgressionFlags())
    expect(prog.frontier.map((n) => n.id)).toEqual(['clear_patch', 'wood', 'forage', 'town', 'fish'])
    expect(prog.complete).toBe(false)
    expect(prog.currentMilestone?.id).toBe('clear_patch')
  })

  it('the mines unlock on spring 5 and copper waits behind level 5', () => {
    const latches = createProgressionFlags()
    let prog = getProgression({ inventory: [], daysPlayed: 5 }, latches)
    expect(prog.frontier.map((n) => n.id)).toContain('mines')
    expect(prog.frontier.map((n) => n.id)).not.toContain('copper')
    latches.observe({ location: 'UndergroundMine5' })
    prog = getProgression({ inventory: [], daysPlayed: 5 }, latches)
    expect(prog.done.has('mines')).toBe(true)
    expect(prog.frontier.map((n) => n.id)).toContain('copper')
  })

  it('farm counts move the crop rungs; a done harvest implies the earlier rungs (monotonic closure)', () => {
    const state = readProgressionState({ inventory: [], farm: { crops: 12, soil: 3 }, daysPlayed: 2 }, createProgressionFlags())
    let prog = computeProgression(state)
    expect(prog.done.has('clear_patch')).toBe(true)
    expect(prog.done.has('first_crops')).toBe(true)
    expect(prog.frontier.map((n) => n.id)).toContain('first_harvest')
    prog = computeProgression({ ...state, farm: { crops: 0, soil: 0 }, items: { Parsnip: 3 } })
    expect(prog.done.has('first_harvest')).toBe(true)
    expect(prog.done.has('first_crops')).toBe(true)
  })

  it('latches read the verb results: debris cleared, forage picked, a catch, a purchase, a visit to town', () => {
    const l = createProgressionFlags()
    l.result('gather', { kind: 'debris' }, 'cleared 5 pieces of debris')
    expect(l.flags.cleared).toBe(false)
    l.result('gather', { kind: 'debris' }, 'failed: cleared 4, then: stuck')
    expect(l.flags.cleared).toBe(true)
    l.result('gather', { kind: 'forage' }, 'picked 3 forage (Leek x2, Dandelion)')
    expect(l.flags.foraged).toBe(true)
    l.result('fish', {}, 'caught nothing in 2 casts')
    expect(l.flags.fished).toBe(false)
    l.result('fish', {}, 'caught Sunfish')
    expect(l.flags.fished).toBe(true)
    l.result('buy', { item: 'parsnip seeds' }, 'bought 5 Parsnip Seeds for 100g')
    expect(l.flags.bought).toBe(true)
    l.observe({ location: 'SeedShop' })
    expect(l.flags.visited_town).toBe(true)
    const prog = getProgression({ inventory: inv([['Wood', 50, 'resource']]), daysPlayed: 3 }, l)
    for (const id of ['clear_patch', 'wood', 'forage', 'town', 'seeds_bought', 'fish']) expect(prog.done.has(id), id).toBe(true)
  })

  it('every node has a label with a part for the player or a fact, a key, and a next action', () => {
    for (const n of SPINE) {
      expect(n.label.length, n.id).toBeGreaterThan(20)
      expect(n.key, n.id).toBeTruthy()
      expect(n.next_action, n.id).toBeTruthy()
      for (const need of n.needs) expect(SPINE.some((m) => m.id === need), `${n.id} needs ${need}`).toBe(true)
    }
  })
})
