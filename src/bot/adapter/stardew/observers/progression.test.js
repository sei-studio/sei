// The Stardew first-fortnight frontier (260910). Pure: a state in, the
// reachable list out; the latches read verb results and observations.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { computeProgression, createProgressionFlags, getProgression, readProgressionState, seasonIndex, SPINE } from './progression.js'
import { createProgressionStore, progressionFileFor } from './progressionStore.js'

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

describe('stardew progression past the first fortnight (261113)', () => {
  const allEarly = () => {
    const l = createProgressionFlags()
    for (const f of ['cleared', 'foraged', 'harvested', 'fished', 'bought', 'visited_town']) l.flags[f] = true
    return l
  }

  it('after the early rungs the list keeps going: beach, a bigger field, farming level, savings, deeper mines', () => {
    const l = allEarly()
    l.observe({ location: 'UndergroundMine5' })
    const prog = getProgression({ inventory: inv([['Wood', 50, 'resource']]), farm: { crops: 3 }, daysPlayed: 15, season: 'spring', year: 1, host: { money: 900, farmingLevel: 1 } }, l)
    const ids = prog.frontier.map((n) => n.id)
    for (const id of ['beach', 'bigger_field', 'farming_level', 'save_gold', 'mines_20', 'copper']) expect(ids, id).toContain(id)
    expect(ids).not.toContain('summer_crops') // not before spring 21
    expect(ids).not.toContain('fall_crops')
    expect(prog.complete).toBe(false)
  })

  it('the season rungs wait for their season, and a spring field does not count as the summer planting', () => {
    const l = allEarly()
    const spring = getProgression({ inventory: [], farm: { crops: 40 }, daysPlayed: 25, season: 'spring', year: 1 }, l)
    expect(spring.frontier.map((n) => n.id)).toContain('summer_crops')
    expect(spring.done.has('summer_crops')).toBe(false)
    const summer = getProgression({ inventory: [], farm: { crops: 16 }, daysPlayed: 33, season: 'summer', year: 1 }, l)
    expect(summer.done.has('summer_crops')).toBe(true)
    expect(summer.frontier.map((n) => n.id)).toContain('fall_crops')
    expect(seasonIndex('spring', 2)).toBe(4)
    expect(seasonIndex('fall', 1)).toBe(2)
  })

  it('a rung done once stays done: the harvested field and the spent gold do not re-open it', () => {
    const l = allEarly()
    let prog = getProgression({ inventory: [], farm: { crops: 31 }, daysPlayed: 12, season: 'spring', year: 1, host: { money: 5200 } }, l)
    expect(prog.done.has('bigger_field')).toBe(true)
    expect(prog.done.has('save_gold')).toBe(true)
    prog = getProgression({ inventory: [], farm: { crops: 0 }, daysPlayed: 14, season: 'spring', year: 1, host: { money: 100 } }, l)
    expect(prog.done.has('bigger_field')).toBe(true)
    expect(prog.done.has('save_gold')).toBe(true)
    expect(prog.frontier.map((n) => n.id)).not.toContain('bigger_field')
  })

  it('a load() into a machine, a visit to the beach and the mine depth are latched', () => {
    const l = allEarly()
    l.result('load', { item: 'Copper Ore' }, 'failed: the Furnace needs 1 Coal as fuel too')
    expect(l.flags.loaded_machine).toBe(false)
    l.result('load', { item: 'Copper Ore' }, 'put 5 Copper Ore (and 1 Coal) into the Furnace at (10, 12), making Copper Bar; ready in 30 minutes')
    expect(l.flags.loaded_machine).toBe(true)
    l.observe({ location: 'Beach' })
    l.observe({ location: 'UndergroundMine42' })
    const prog = getProgression({ inventory: [], daysPlayed: 20, season: 'spring', year: 1 }, l)
    for (const id of ['beach', 'copper_bars', 'mines', 'mines_20', 'mines_40', 'copper']) expect(prog.done.has(id), id).toBe(true)
    expect(prog.frontier.map((n) => n.id)).toEqual(expect.arrayContaining(['iron', 'mines_80']))
  })

  it('survives a re-summon: saved per farm, restored into a fresh latch set, other farms untouched', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sei-sdv-prog-'))
    try {
      const file = progressionFileFor({ memory: { memory_md_path: path.join(dir, 'MEMORY.md') } })
      expect(file).toBe(path.join(dir, 'stardew-progress.json'))
      const store = createProgressionStore(file)
      const first = createProgressionFlags({ onChange: () => store.save('farm-A', first.toJSON()) })
      first.flags.visited_town = true
      first.observe({ location: 'UndergroundMine25' })
      getProgression({ inventory: [], farm: { crops: 31 }, daysPlayed: 12, season: 'spring', year: 1 }, first)
      const saved = JSON.parse(readFileSync(file, 'utf8'))
      expect(saved['farm-A'].mineLevel).toBe(25)
      expect(saved['farm-A'].doneNodes).toContain('bigger_field')

      const next = createProgressionFlags()
      next.restore(store.load('farm-A'))
      const prog = getProgression({ inventory: [], farm: { crops: 0 }, daysPlayed: 13, season: 'spring', year: 1 }, next)
      for (const id of ['town', 'mines', 'mines_20', 'bigger_field']) expect(prog.done.has(id), id).toBe(true)
      expect(store.load('farm-B')).toBeNull()
      // A broken record is ignored, and an unknown node id is dropped.
      const odd = createProgressionFlags()
      odd.restore({ flags: { cleared: 'yes' }, doneNodes: ['not_a_node', 'beach'], mineLevel: -4 })
      expect(odd.flags.cleared).toBe(false)
      expect([...odd.doneNodes]).toEqual(['beach'])
      expect(odd.mineLevel).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('no memory path means no file', () => {
    expect(progressionFileFor({})).toBeNull()
    const store = createProgressionStore(null)
    expect(store.save('x', {})).toBe(false)
    expect(store.load('x')).toBeNull()
  })
})

