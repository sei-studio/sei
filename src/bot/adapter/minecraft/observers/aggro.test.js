// 260731 — the aggro tally.
//
// "sui is not attracting mob aggro, mobs are all on me". The defend swing
// (combat.defend.test.js) answers the mobs that are ON the player; this is the
// other half — the companion could not SEE the imbalance, because the snapshot
// listed entities with coords and nothing about who they were chasing.
//
// The attribution is an inference from body yaw (no target field exists on the
// wire), so what these pin is the inference: a mob facing someone counts for
// them, a mob facing nothing counts for nobody, and distance alone never
// attributes anything.

import { describe, it, expect } from 'vitest'
import { tallyAggro, aggroLine, AGGRO_RADIUS } from './aggro.js'

const SELF = { x: 0, y: 64, z: 0 }
const OWNER = { x: 10, y: 64, z: 0 }

// mineflayer yaw: forward is (-sin yaw, -cos yaw). Face a mob at `from` toward
// `to` the same way the observer reads it.
function yawToward(from, to) {
  return Math.atan2(-(to.x - from.x), -(to.z - from.z))
}

function mob(name, at, facing) {
  return { name, position: at, yaw: facing ? yawToward(at, facing) : undefined }
}

describe('tallyAggro', () => {
  it('attributes each mob to whoever it is facing', () => {
    const t = tallyAggro({
      mobs: [
        mob('zombie', { x: 12, y: 64, z: 0 }, OWNER),
        mob('zombie', { x: 13, y: 64, z: 2 }, OWNER),
        mob('skeleton', { x: 2, y: 64, z: 0 }, SELF),
      ],
      selfPos: SELF,
      ownerPos: OWNER,
    })
    expect(t).toEqual({ onSelf: { skeleton: 1 }, onOwner: { zombie: 2 }, unclear: 0, total: 3 })
  })

  // The whole reason the line exists: proximity is NOT aggro. A mob standing
  // next to the bot while walking at the player belongs to the player.
  it('does not credit the bot for a mob that is merely near it', () => {
    const t = tallyAggro({
      mobs: [mob('zombie', { x: 1, y: 64, z: 0 }, OWNER)],
      selfPos: SELF,
      ownerPos: OWNER,
    })
    expect(t.onSelf).toEqual({})
    expect(t.onOwner).toEqual({ zombie: 1 })
  })

  it('counts a mob facing neither of us as unclear rather than guessing', () => {
    const t = tallyAggro({
      mobs: [mob('zombie', { x: 4, y: 64, z: 4 }, { x: 4, y: 64, z: 40 })],
      selfPos: SELF,
      ownerPos: OWNER,
    })
    expect(t).toMatchObject({ onSelf: {}, onOwner: {}, unclear: 1, total: 1 })
  })

  it('a mob with no yaw yet is unclear, never attributed', () => {
    const t = tallyAggro({
      mobs: [{ name: 'zombie', position: { x: 2, y: 64, z: 0 } }],
      selfPos: SELF,
      ownerPos: OWNER,
    })
    expect(t.unclear).toBe(1)
  })

  it('ignores passive mobs, players and anything out of radius', () => {
    const t = tallyAggro({
      mobs: [
        mob('sheep', { x: 2, y: 64, z: 0 }, SELF),
        { name: undefined, username: 'SSk1tz', position: OWNER },
        mob('zombie', { x: AGGRO_RADIUS + 12, y: 64, z: 0 }, SELF),
      ],
      selfPos: SELF,
      ownerPos: OWNER,
    })
    expect(t.total).toBe(0)
  })

  // Standing shoulder to shoulder puts both of us inside one 60-degree cone,
  // and a mob lined up with both of us has an identical angle to each. Whoever
  // it reaches first is the one it hits.
  it('breaks a two-in-the-cone tie by who it reaches first', () => {
    const self = { x: 0, y: 64, z: 0 }
    const owner = { x: 1, y: 64, z: 0 }
    const t = tallyAggro({
      mobs: [mob('zombie', { x: 0, y: 64, z: 6 }, self)],
      selfPos: self,
      ownerPos: owner,
    })
    expect(t.onSelf).toEqual({ zombie: 1 })
    expect(t.onOwner).toEqual({})
  })

  it('survives NaN positions without throwing or counting', () => {
    expect(() => tallyAggro({
      mobs: [mob('zombie', { x: NaN, y: 64, z: 0 }, SELF)],
      selfPos: SELF,
      ownerPos: { x: NaN, y: NaN, z: NaN },
    })).not.toThrow()
    expect(tallyAggro({ mobs: null, selfPos: SELF, ownerPos: OWNER }).total).toBe(0)
  })
})

describe('aggroLine', () => {
  it('says nothing when no hostile is in the fight', () => {
    expect(aggroLine({ tally: { onSelf: {}, onOwner: {}, unclear: 0, total: 0 }, ownerLabel: 'Ouen' })).toBeNull()
  })

  // Counts only. It is a data line, not a coaching line — the "hit one to pull
  // it off them" half already lives in the capability prompt.
  it('is a bare tally by mob name, both sides', () => {
    const line = aggroLine({
      tally: { onSelf: {}, onOwner: { zombie: 2, creeper: 1 }, unclear: 1, total: 4 },
      ownerLabel: 'Ouen',
    })
    expect(line).toBe('aggro: none on you, zombie 2x creeper 1x on Ouen')
  })

  it('reports the bot side the same way', () => {
    const line = aggroLine({
      tally: { onSelf: { skeleton: 1 }, onOwner: {}, unclear: 0, total: 1 },
      ownerLabel: 'Ouen',
    })
    expect(line).toBe('aggro: skeleton 1x on you, none on Ouen')
  })
})
