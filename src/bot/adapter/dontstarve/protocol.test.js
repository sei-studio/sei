import { describe, it, expect } from 'vitest'
import { createObservationState, createHandleRegistry, normalizeName, CMD_HOLD_MS } from './protocol.js'

const selfRaw = { x: 10, z: -20, hp: 100, hpmax: 150, hunger: 50, hungermax: 150, sanity: 120, sanitymax: 200, temp: 20, moist: 0, inlight: true, inv: [{ g: 1, p: 'axe', q: 1, f: ['equip'] }], equip: { hands: { g: 1, p: 'axe', q: 1, f: ['equip'] } } }

describe('observation state', () => {
  it('stores entities absolute, applies deltas + gone, and asks for a full frame until it has one', () => {
    const st = createObservationState()
    expect(st.apply({ seq: 1, full: false, self: selfRaw, ents: [{ g: 7, p: 'evergreen', x: 4, z: 1, f: ['chop'] }], gone: [], world: { day: 2, phase: 'day', season: 'autumn' } })).toBe(true)
    expect(st.hasFull).toBe(false)
    expect(st.ents.get(7)).toMatchObject({ x: 14, z: -19, prefab: 'evergreen' })
    // The body walks 5 to the east; an entity the delta did not re-send keeps its place.
    st.apply({ seq: 2, full: true, self: { ...selfRaw, x: 15 }, ents: [{ g: 7, p: 'evergreen', x: -1, z: 1, f: ['chop'] }, { g: 8, p: 'sapling', x: 0, z: 2, f: ['pick'] }], gone: [], world: { day: 2, phase: 'dusk' } })
    expect(st.hasFull).toBe(true)
    expect(st.ents.get(7)).toMatchObject({ x: 14, z: -19 })
    st.apply({ seq: 3, full: false, self: { ...selfRaw, x: 20 }, ents: [], gone: [8], world: { day: 2, phase: 'dusk' } })
    expect(st.ents.has(8)).toBe(false)
    expect(st.distTo(st.ents.get(7))).toBeCloseTo(Math.sqrt(36 + 1), 3)
    expect(st.world.phase).toBe('dusk')
    expect(st.findInventory('Axe')?.guid).toBe(1)
    expect(st.apply(null)).toBe(false)
    expect(st.apply({ seq: 4, ents: [] })).toBe(false)
  })

  it('handles are stable per guid and parse with or without the hash', () => {
    const h = createHandleRegistry()
    expect(h.handleFor(42)).toBe('#1')
    expect(h.handleFor(43)).toBe('#2')
    expect(h.handleFor(42)).toBe('#1')
    expect(h.guidFor('#2')).toBe(43)
    expect(h.guidFor('2')).toBe(43)
    expect(h.guidFor('#9')).toBeNull()
    expect(h.isHandle('#3')).toBe(true)
    expect(h.isHandle('evergreen')).toBe(false)
  })

  it('normalizes loose names and pins the hold constant the mod is tuned for', () => {
    expect(normalizeName(' Science Machine ')).toBe('science_machine')
    expect(normalizeName('cut-grass')).toBe('cut_grass')
    expect(CMD_HOLD_MS).toBe(400)
  })
})
