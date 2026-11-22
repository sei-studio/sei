// 261120: quality pass 59. While a give() walked over to the player the
// in_flight line read "handing 1 coal to Alex", and asked "hows it going"
// from 22 blocks out she answered "coal's tossing your way now, check your feet"
// (pass 55 errands-01-A). pass59-probe at n=30: delivered claims 9/30 with
// the old line, 0/30 once the line says she is still walking over. The
// adapter decides walking (out of give.js toss range); the brain only words it.

import { describe, it, expect } from 'vitest'
import { Vec3 } from 'vec3'
import { getInFlightLineForSnapshot } from './inflight.js'
import { giveStillWalking, GIVE_TOSS_RANGE } from '../adapter/minecraft/observers/snapshot.js'
import { TOSS_RANGE } from '../adapter/minecraft/behaviors/give.js'
import { SPEAK_REMINDER } from './promptLibrary.js'

const give = { name: 'give', args: { item: 'coal', count: 1, player: 'Alex' }, startedAt: 0 }

describe('give in_flight line', () => {
  it('says she is still walking over while out of toss range', () => {
    const l = getInFlightLineForSnapshot(give, 5_000, { giveWalking: true })
    expect(l).toContain('still walking over to Alex to hand them 1 coal. Nothing is tossed until you get there')
    expect(l).not.toContain('handing')
    expect(l).toContain('so stopping it keeps them with you')
  })

  it('keeps the handing wording once close, or when walking is unknown', () => {
    for (const giveWalking of [false, null, undefined]) {
      const l = getInFlightLineForSnapshot(give, 5_000, { giveWalking })
      expect(l).toContain('handing 1 coal to Alex. Nothing is handed over until the toss lands')
      expect(l).not.toContain('walking')
    }
  })
})

describe('giveStillWalking', () => {
  const bot = (alexAt, extra = {}) => ({
    username: 'Sui',
    entity: { position: new Vec3(0, 64, 0) },
    players: {
      Sui: { username: 'Sui', entity: { position: new Vec3(0, 64, 0) } },
      Alex: { username: 'Alex', entity: alexAt ? { position: alexAt } : null },
      ...extra,
    },
  })

  it('matches give.js TOSS_RANGE', () => {
    expect(GIVE_TOSS_RANGE).toBe(TOSS_RANGE)
  })

  it('is true far from the named player and false within toss range', () => {
    expect(giveStillWalking(bot(new Vec3(24, 64, 0)), give, 'Alex', [])).toBe(true)
    expect(giveStillWalking(bot(new Vec3(3, 64, 0)), give, 'Alex', [])).toBe(false)
  })

  it('matches the named player case-insensitively', () => {
    const g = { ...give, args: { ...give.args, player: 'alex' } }
    expect(giveStillWalking(bot(new Vec3(24, 64, 0)), g, null, [])).toBe(true)
  })

  it('falls back to the owner when the give names no player', () => {
    const g = { ...give, args: { item: 'coal' } }
    expect(giveStillWalking(bot(new Vec3(30, 64, 0)), g, 'Alex', [])).toBe(true)
  })

  it('is null for other actions, an unseen player, or no entity', () => {
    expect(giveStillWalking(bot(new Vec3(24, 64, 0)), { name: 'gather', args: {} }, 'Alex', [])).toBe(null)
    expect(giveStillWalking(bot(null), give, 'Alex', [])).toBe(null)
    expect(giveStillWalking({ players: {} }, give, 'Alex', [])).toBe(null)
  })
})

describe('SPEAK_REMINDER', () => {
  it('has no em dash', () => {
    expect(SPEAK_REMINDER).not.toContain('â€”')
    expect(SPEAK_REMINDER).toContain('words in your text output never reach the player')
  })
})




