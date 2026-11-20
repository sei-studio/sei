import { describe, it, expect } from 'vitest'
import { isDarknessHit, torchShortfall } from './darkness.js'

const night = (self) => ({ self: { inLight: false, inv: [], equip: {}, ...self }, world: { phase: 'night' } })

describe('DST darkness: Charlie vs a monster', () => {
  it('helper 0.3.2+ says so with the stimuli', () => {
    expect(isDarknessHit({ attacker: null, stimuli: 'darkness' }, null)).toBe(true)
  })

  it('an older helper: no attacker while unlit at night or in a cave', () => {
    expect(isDarknessHit({ attacker: null, label: 'something' }, night())).toBe(true)
    expect(isDarknessHit({}, { self: { inLight: false }, world: { phase: 'day', caves: true } })).toBe(true)
  })

  it('anything with an attacker, other stimuli, light, or daytime is not the dark', () => {
    expect(isDarknessHit({ attacker: 1234, label: 'hound' }, night())).toBe(false)
    expect(isDarknessHit({ attacker: null, stimuli: 'electric' }, night())).toBe(false)
    expect(isDarknessHit({ attacker: null }, night({ inLight: true }))).toBe(false)
    expect(isDarknessHit({ attacker: null }, { self: { inLight: false }, world: { phase: 'dusk' } })).toBe(false)
    expect(isDarknessHit({ attacker: null }, undefined)).toBe(false)
  })

  it('torchShortfall counts what a torch still needs', () => {
    expect(torchShortfall(night({ inv: [{ prefab: 'cutgrass', qty: 2 }, { prefab: 'twigs', qty: 1 }] })))
      .toEqual({ grass: 0, twigs: 1, haveGrass: 2, haveTwigs: 1 })
    expect(torchShortfall(night())).toEqual({ grass: 2, twigs: 2, haveGrass: 0, haveTwigs: 0 })
    expect(torchShortfall({})).toBeNull()
  })
})
