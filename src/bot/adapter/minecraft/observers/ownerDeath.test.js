// 261110 (quality pass 50): the owner's death on the snapshot owner line.
import { describe, it, expect } from 'vitest'
import { ownerStateClause, ownerHealthClause, deathSpotFromYou, OWNER_DEATH_NOTE_MS } from './snapshot.js'
import { recordOwnerDeath } from '../behaviors/chat.js'

const T0 = 1_000_000
const body = { id: 7 }
const death = { text: 'Alex was blown up by Creeper', at: T0, pos: { x: 183, y: 64, z: 9 }, entity: body }

describe('ownerStateClause', () => {
  it('is the plain health clause without a death', () => {
    expect(ownerStateClause(16, null, body, null, T0)).toBe(ownerHealthClause(16))
    expect(ownerStateClause(null, undefined, body, null, T0)).toBe('')
  })

  it('says dead while the dying body still shows stale health', () => {
    const t = ownerStateClause(16, death, body, null, T0 + 100)
    expect(t).toBe(': dead, died just now (Alex was blown up by Creeper) and has not respawned yet')
    expect(t).not.toContain('16/20')
  })

  it('says dead at 0 hp, with or without a death message', () => {
    expect(ownerStateClause(0, death, body, null, T0 + 60_000)).toContain('dead, died 60s ago')
    expect(ownerStateClause(0, null, body, null, T0)).toBe(', hp 0/20: dead, has not respawned yet')
  })

  it('after the respawn names the death and where their things dropped', () => {
    const t = ownerStateClause(20, death, { id: 7 }, { x: 180, y: 64, z: 5 }, T0 + 12_000)
    expect(t).toBe(', hp 20/20. They died 12s ago (Alex was blown up by Creeper) and respawned with an empty inventory, so they have no food or weapon unless you give them some. Anything they carried dropped where they died, 5 blocks southeast of you, unless someone has picked it up since')
  })

  it('trusts fresh health on the same body after a few seconds', () => {
    expect(ownerStateClause(20, death, body, null, T0 + 10_000)).toContain('respawned with an empty inventory')
  })

  it('drops the note once the window has passed', () => {
    expect(ownerStateClause(20, death, { id: 7 }, null, T0 + OWNER_DEATH_NOTE_MS + 1)).toBe(ownerHealthClause(20))
  })

  it('says minutes for an older death and copes without positions', () => {
    const t = ownerStateClause(18, { ...death, pos: null }, { id: 7 }, { x: 180, y: 64, z: 5 }, T0 + 150_000)
    expect(t).toContain('They died 3 min ago')
    expect(t).toContain('dropped where they died, unless someone')
  })
})

describe('deathSpotFromYou', () => {
  const me = { x: 0, y: 64, z: 0 }
  it('names distance and an 8-way compass direction (north = -z, east = +x)', () => {
    expect(deathSpotFromYou({ x: 0, y: 64, z: -9 }, me)).toBe('9 blocks north of you')
    expect(deathSpotFromYou({ x: 8, y: 64, z: 0 }, me)).toBe('8 blocks east of you')
    expect(deathSpotFromYou({ x: -5, y: 64, z: 5 }, me)).toBe('7 blocks southwest of you')
  })
  it('says right around you up close, above/below when straight up or down', () => {
    expect(deathSpotFromYou({ x: 1, y: 64, z: 1 }, me)).toBe('right around you')
    expect(deathSpotFromYou({ x: 0, y: 50, z: 1 }, me)).toBe('14 blocks below you')
  })
  it('is null without positions', () => {
    expect(deathSpotFromYou(null, me)).toBeNull()
    expect(deathSpotFromYou({ x: 1, y: 2, z: 3 }, null)).toBeNull()
  })
})

describe('recordOwnerDeath', () => {
  it('keeps the text, time, body and rounded position', () => {
    const ent = { position: { x: 183.4, y: 64, z: 8.7 } }
    const bot = { players: { Alex: { entity: ent } } }
    recordOwnerDeath(bot, { subject: 'Alex', text: 'Alex drowned' }, T0)
    expect(bot._seiOwnerDeath).toEqual({ text: 'Alex drowned', at: T0, pos: { x: 183, y: 64, z: 9 }, entity: ent })
  })

  it('records the death even when the player entity is not loaded', () => {
    const bot = { players: {} }
    recordOwnerDeath(bot, { subject: 'Alex', text: 'Alex fell from a high place' }, T0)
    expect(bot._seiOwnerDeath.pos).toBeNull()
    expect(bot._seiOwnerDeath.entity).toBeNull()
  })
  // keepInventory: the respawned body visibly holds or wears something.
  it('does not claim an empty inventory when the respawned player still has gear', () => {
    const death = { text: 'Alex was slain by Zombie', at: T0, pos: null, entity: body }
    const t = ownerStateClause(20, death, { id: 7, equipment: [{ name: 'iron_sword' }, null, null, null, null, null] }, null, T0 + 10_000)
    expect(t).toContain('keeps inventory')
    expect(t).not.toContain('empty inventory')
    expect(ownerStateClause(20, death, { id: 7, equipment: [null, null, null, null, null, null] }, null, T0 + 10_000)).toContain('empty inventory')
  })
})
