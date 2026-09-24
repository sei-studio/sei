import { describe, it, expect } from 'vitest'
import { createObservationState, createHandleRegistry } from './protocol.js'
import { createSnapshotComposer } from './observers/snapshot.js'
import { createFakeMod } from '../../../../scripts/fake-dst-mod.mjs'

function fixtureState() {
  const st = createObservationState()
  const mod = createFakeMod({ botPort: 1, token: 'x' })
  const frame = mod.frame(true)
  frame.self.hunger = 30
  frame.self.inlight = false
  st.apply(frame)
  st.world.phase = 'night'
  return { st, mod }
}

describe('DST snapshot composer', () => {
  it('renders the clock, vitals, inventory, buckets with #N handles, follow state and the last result under ~1k tokens', () => {
    const { st } = fixtureState()
    const handles = createHandleRegistry()
    const composer = createSnapshotComposer({ state: st, handles, dst: { prefab: 'wigfrid', label: 'Fake World' }, getBodyState: () => ({ fight: true, followLabel: 'Steve' }) })
    const text = composer.next({ lastActionResult: 'gathered 3 twigs', inFlight: null, pinUsername: 'Steve', worldTag: '#1 Fake World' })
    expect(text).toContain('world: #1 Fake World | day 3 autumn, night')
    expect(text).toContain('you: Wigfrid at (10, -20) | health 150/150 hunger 30/150 sanity 180/200')
    expect(text).toContain('IN THE DARK')
    expect(text).toContain('inventory (4): axe, log x4, berries x3, twigs x2')
    expect(text).toContain('equipped: hands=axe')
    expect(text).toContain('follow: Steve | fight back when hit: on')
    expect(text).toMatch(/players: Steve #\d+ \(/)
    expect(text).toMatch(/threats: spider #\d+ \([\d.]+m, 100% hp\)/)
    expect(text).toMatch(/choppable: evergreen #\d+/)
    expect(text).toMatch(/mineable: rock1 #\d+/)
    expect(text).toMatch(/pickable: (sapling|grass|berrybush) #\d+/)
    expect(text).toMatch(/on the ground: flint #\d+/)
    expect(text).toMatch(/chests: treasurechest #\d+/)
    expect(text).toMatch(/stations: researchlab #\d+/)
    expect(text).toContain('last_action_result: gathered 3 twigs')
    // Budget: the fixture is a busy scene; ~4 chars per token.
    expect(text.length).toBeLessThan(4000)
    // Handles are stable across turns.
    const again = composer.next({ lastActionResult: null, inFlight: { name: 'gather', progress: { have: 1 } } })
    const h1 = /spider (#\d+)/.exec(text)[1]
    expect(again).toContain(`spider ${h1}`)
    expect(again).toContain('in_flight: gather ({"have":1})')
    expect(again).toContain('last_action_result: none')
  })

  it('flags an inventory change loudly and a health drop quietly', () => {
    const { st, mod } = fixtureState()
    const composer = createSnapshotComposer({ state: st, handles: createHandleRegistry(), dst: { prefab: 'wilson' } })
    composer.next({})
    const f = mod.frame(false)
    f.self.inv = [...f.self.inv, { g: 3999, p: 'flint', q: 2, f: [] }]
    f.self.hp = 120
    st.apply(f)
    const text = composer.next({})
    expect(text).toContain('*** INVENTORY JUST CHANGED ***: +2 flint')
    expect(text).toContain('recent_events: health -30')
  })

  it('says so when no observation has arrived', () => {
    const st = createObservationState()
    const composer = createSnapshotComposer({ state: st, handles: createHandleRegistry(), dst: {} })
    expect(composer.next({})).toMatch(/snapshot unavailable/)
  })
})
