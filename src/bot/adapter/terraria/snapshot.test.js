// The Terraria snapshot text: one observation becomes a few short lines, and
// the stateful composer adds the bag and health callouts between turns.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { composeSnapshot, createSnapshotComposer, parseBagEntry, ownerOf } from './observers/snapshot.js'

const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/obs-surface.json', import.meta.url), 'utf8'))

describe('terraria snapshot', () => {
  it('parses bag entries', () => {
    expect(parseBagEntry('Wood x12')).toEqual(['Wood', 12])
    expect(parseBagEntry('Work Bench')).toEqual(['Work Bench', 1])
    expect(parseBagEntry('')).toBeNull()
  })

  it('renders the fixture as short lines with handles, owner and surroundings', () => {
    const text = composeSnapshot(fixture(), { lastActionResult: 'chopped 1/1: got Wood x9' })
    expect(text).toContain('you: @2092,208 (surface, forest)  health 100/100  defense 2  stance defensive')
    expect(text).toContain('weapon: Wooden Sword  armor: Wood Helmet')
    expect(text).toContain('bag: Copper Shortsword, Wood x45')
    expect(text).toContain('owner Ouen: @2088,208 (4 tiles away), health 200/200, holding Iron Pickaxe')
    expect(text).toContain('hostiles: #3 Blue Slime 25/25 @2106,208 (13 tiles)')
    expect(text).toContain('near you: trees @2095,207 @2099,207; crafting here: nothing (hand recipes only)')
    expect(text).toContain('progress: pre-hardmode, bosses defeated: none yet')
    expect(text).toContain('last_action_result: chopped 1/1: got Wood x9')
    // Paid for every turn: keep it small.
    expect(text.length).toBeLessThan(900)
  })

  it('handles no observation, an absent body, knock-out and a missing owner', () => {
    expect(composeSnapshot(null)).toMatch(/waiting for the first observation/)
    const absent = fixture(); absent.self.absent = true
    expect(composeSnapshot(absent)).toMatch(/not in the world/)
    const ko = fixture(); ko.self.knockedOut = 4; ko.players = []
    const t = composeSnapshot(ko, { pinUsername: 'Ouen' })
    expect(t).toContain('KNOCKED OUT, up again in 4s')
    expect(t).toContain('owner Ouen: not in the world')
  })

  it('picks the owner: followed player, then the pinned name, then the first', () => {
    const obs = { self: {}, players: [{ name: 'A' }, { name: 'B' }, { name: 'C' }] }
    expect(ownerOf(obs).name).toBe('A')
    expect(ownerOf(obs, 'c').name).toBe('C')
    expect(ownerOf({ ...obs, self: { following: 'B' } }, 'C').name).toBe('B')
  })

  it('calls out a bag change and lost health since the last turn', () => {
    let obs = fixture()
    const comp = createSnapshotComposer({ getObs: () => obs })
    expect(comp.next()).not.toContain('***')
    obs = fixture()
    obs.bag = ['Copper Shortsword', 'Wood x40', 'Gel x3', 'Copper Coin x102', 'Hasty Wooden Bow', 'Stone Block x9', 'Wooden Arrow x14', 'Copper Pickaxe', 'Copper Axe', 'Acorn x2']
    obs.self.hp = 70
    const t = comp.next()
    expect(t).toMatch(/\*\*\* BAG JUST CHANGED \*\*\*: \+3 Gel, -5 Wood/)
    expect(t).toContain('*** HEALTH DROPPED ***: -30 since last turn')
    expect(comp.next()).not.toContain('***')
  })
})
