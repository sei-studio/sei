import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { composeSnapshot, createSnapshotComposer } from './observers/snapshot.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const obs = () => JSON.parse(readFileSync(path.join(HERE, 'fixtures', 'obs-farm.json'), 'utf8'))

describe('stardew snapshot composer', () => {
  it('renders the recorded farm observation as the snapshot text the brain expects', () => {
    const text = composeSnapshot(obs(), { pinUsername: 'Ouen', worldTag: '#1 Sunny Farm', lastActionResult: 'water: watered 12 crops' })
    expect(text).toContain('world: #1 Sunny Farm')
    expect(text).toContain('location: Farm (farm)  pos: 62,18')
    expect(text).toContain('spring 3, year 1 (Wed)  time: 1:30 PM  weather: sunny')
    expect(text).toContain('energy: 210/270  health: 100/100  gold: 500g')
    expect(text).toContain('holding: Axe  watering can: 18/40')
    expect(text).toContain('inventory (9/36 slots): Axe, Hoe, Watering Can, Pickaxe, Scythe, Bamboo Pole, Rusty Sword, Parsnip Seeds x15, Leek x2')
    expect(text).toContain('around you (8 tiles): crops 24 (12 dry, 1 ready), empty soil 6, twigs 3, weeds 9, stones 5, water @71,30')
    expect(text).toContain('crops: Parsnip @60,20 2/5; Parsnip @61,20 dry 2/5; Cauliflower @59,21 READY')
    expect(text).toContain('trees: #4 oak @70,12')
    expect(text).toContain('machines: #8 Furnace READY @65,14')
    expect(text).toContain('#1 Ouen (player, host) @63,18 (1 tiles)')
    expect(text).toContain('#2 Green Slime (monster 24/24 hp) @50,10 (15 tiles)')
    expect(text).toContain('#9 Marnie @55,22')
    expect(text).toContain('ways out: #3 to BusStop @79,17')
    expect(text).toContain('follow_target: Ouen')
    expect(text).toContain('owner Ouen: @63,18 (1 tiles away)')
    expect(text).toContain('last_action_result: water: watered 12 crops')
    // Budget: the fixture is a busy farm and still well under ~1.2k tokens.
    expect(text.length).toBeLessThan(2400)
  })

  it('says the owner is on another map instead of inventing coordinates', () => {
    const o = obs()
    o.player = { ...o.player, location: 'Town', sameLocation: false, dist: -1 }
    const text = composeSnapshot(o, { pinUsername: 'Ouen' })
    expect(text).toContain('owner Ouen: in Town (a different map; call follow or come to reach them)')
  })

  it('handles a missing observation and labels companions', () => {
    expect(composeSnapshot(null)).toMatch(/snapshot unavailable/)
    const o = obs()
    o.entities.push({ handle: '#12', kind: 'companion', name: 'Marv', x: 61, y: 18, dist: 1 })
    expect(composeSnapshot(o, { companions: ['Marv'] })).toContain('#12 Marv (companion)')
  })

  it('calls out inventory changes and health loss between ticks', () => {
    let current = obs()
    const composer = createSnapshotComposer({ getObs: () => current })
    const first = composer.next({})
    expect(first).not.toContain('INVENTORY JUST CHANGED')
    current = obs()
    current.inventory.push({ slot: 9, id: '(O)388', name: 'Wood', count: 8, kind: 'resource' })
    current.inventory[8].count = 1
    current.health = 80
    const second = composer.next({})
    expect(second).toContain('*** INVENTORY JUST CHANGED ***: +8 Wood, -1 Leek')
    expect(second).toContain('recent_events: health -20')
    composer.reset()
    expect(composer.next({})).not.toContain('INVENTORY JUST CHANGED')
  })
})
