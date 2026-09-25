import { describe, it, expect } from 'vitest'
import { computeProgression, createProgressionLatches, getProgression, SPINE } from './progression.js'
import { createObservationState } from '../protocol.js'
import { createFakeMod } from '../../../../../scripts/fake-dst-mod.mjs'

const ids = (nodes) => nodes.map((n) => n.id)

describe('DST progression frontier', () => {
  it('starts with tools, light and food, and every node has a key and a label', () => {
    for (const n of SPINE) expect(n.key && n.label, n.id).toBeTruthy()
    expect(ids(computeProgression({}).frontier)).toEqual(['tools', 'light', 'food'])
  })

  it('opens science once tools are done, and camp once light is', () => {
    const p = computeProgression({ items: { axe: 1, pickaxe: 1, torch: 1, log: 2, cutgrass: 3 } })
    expect([...p.done].sort()).toEqual(['light', 'tools'])
    expect(ids(p.frontier)).toEqual(['food', 'science', 'camp'])
  })

  it('closes predecessors of a done node (monotonic)', () => {
    const p = computeProgression({ built: new Set(['cookpot']) })
    for (const id of ['crockpot', 'science', 'camp', 'tools', 'light']) expect(p.done.has(id), id).toBe(true)
  })

  it('holds winter prep back until autumn is nearly over', () => {
    const base = { items: { spear: 1, armorwood: 1 }, built: new Set(['cookpot']) }
    expect(ids(computeProgression({ ...base, season: 'autumn', seasonDays: 15 }).frontier)).not.toContain('winter')
    expect(ids(computeProgression({ ...base, season: 'autumn', seasonDays: 6 }).frontier)).toContain('winter')
    expect(ids(computeProgression({ ...base, season: 'winter', seasonDays: 14 }).frontier)).toContain('winter')
  })

  it('latches structures from results and from sight, and reads the bag', () => {
    const st = createObservationState()
    const mod = createFakeMod({ botPort: 1, token: 'x' })
    st.apply(mod.frame(true)) // the fake scene has a researchlab and a treasurechest in view
    const latches = createProgressionLatches()
    latches.result('build', 'built firepit at (3, 4)')
    latches.result('build', 'missing ingredients for cookpot')
    const p = getProgression(st, latches)
    expect([...latches.built].sort()).toEqual(['firepit', 'researchlab', 'treasurechest'])
    expect(p.done.has('science')).toBe(true)
    // camp needs light first, so the closure only marks it done if light is.
    expect(p.raw.has('camp')).toBe(true)
    expect(p.done.has('light')).toBe(true)
  })
})
