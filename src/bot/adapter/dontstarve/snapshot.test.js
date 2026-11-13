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

  it('mod 0.3.0: season countdown, what the player is doing, who a creature attacks, habits and heads-up', () => {
    const st = createObservationState()
    const mod = createFakeMod({ botPort: 1, token: 'x' })
    const frame = mod.frame(true)
    frame.world.seasondays = 2
    const player = frame.ents.find((e) => e.f.includes('player'))
    Object.assign(player, { a: 'chop', at: 'evergreen', hold: 'axe', hu: 0.2, sa: 0.9 })
    frame.ents.find((e) => e.p === 'spider').t = player.g
    st.apply(frame)
    const composer = createSnapshotComposer({
      state: st, handles: createHandleRegistry(), dst: { prefab: 'wilson' }, getBodyState: () => ({ fight: true }),
      getSelfGuid: () => 9001, getHabits: () => ['made a torch for tonight', 'fed the campfire with log (x2)'],
    })
    const text = composer.next({ lastActionResult: null })
    expect(text).toContain('day 3 autumn (2 days left), day')
    expect(text).toMatch(/Steve #\d+ \([\d.]+m, chopping evergreen, holding axe, hunger 20%, sanity 90%\)/)
    expect(text).toMatch(/spider #\d+ \([\d.]+m, [^)]*attacking Steve/)
    expect(text).toContain('your_habits (done on your own lately): made a torch for tonight; fed the campfire with log (x2)')
    expect(text).toMatch(/heads_up: winter starts in 2 days; Steve is hungry \(20%\); spider is attacking Steve/)
  })

  it('an older helper sends none of the new fields and the lines stay out', () => {
    const { st } = fixtureState()
    const composer = createSnapshotComposer({ state: st, handles: createHandleRegistry(), dst: { prefab: 'wilson' }, getBodyState: () => ({ fight: true }) })
    const text = composer.next({ lastActionResult: null })
    expect(text).not.toContain('your_habits')
    expect(text).not.toContain('days left')
    expect(text).not.toMatch(/holding|attacking/)
  })
  it('says how far the follow target is once it is out of sight (helper 0.3.2), and that a command leaves it behind', () => {
    const st = createObservationState()
    const mod = createFakeMod({ botPort: 1, token: 'x' })
    const frame = mod.frame(true)
    frame.self.follow = 99999
    frame.self.followd = 82.4
    st.apply(frame)
    const handles = createHandleRegistry()
    const composer = createSnapshotComposer({ state: st, handles, getBodyState: () => ({ fight: true, followLabel: 'Steve' }) })
    expect(composer.next({})).toContain('follow: Steve (82m away, out of sight: while another command runs you stay behind) | fight back')
    // An older helper sends no distance: the target is simply not in sight.
    const st2 = createObservationState()
    const f2 = createFakeMod({ botPort: 1, token: 'x' }).frame(true)
    f2.self.follow = 99999
    st2.apply(f2)
    const c2 = createSnapshotComposer({ state: st2, handles: createHandleRegistry(), getBodyState: () => ({ fight: true, followLabel: 'Steve' }) })
    expect(c2.next({})).toContain('follow: Steve (over 24m away, out of sight')
    // Close by: no note.
    const st3 = createObservationState()
    const f3 = createFakeMod({ botPort: 1, token: 'x' }).frame(true)
    f3.self.followd = 3
    st3.apply(f3)
    const c3 = createSnapshotComposer({ state: st3, handles: createHandleRegistry(), getBodyState: () => ({ fight: true, followLabel: 'Steve' }) })
    expect(c3.next({})).not.toContain('out of sight')
  })

  it('helper 0.4.0: stumps and graves to dig, traps, a boss, a busy crock pot and jerky on the rack', () => {
    const st = createObservationState()
    const mod = createFakeMod({ botPort: 1, token: 'x' })
    const frame = mod.frame(true)
    frame.ents.push(
      { g: 5001, p: 'evergreen', x: 3, z: 3, f: ['dig', 'stump'] },
      { g: 5002, p: 'grass', x: 1, z: 1, f: ['dig'] },
      { g: 5003, p: 'trap', x: 2, z: -2, f: ['trap', 'sprung', 'pickup'] },
      { g: 5004, p: 'bearger', x: 14, z: 0, f: ['hostile', 'epic', 'combat'], h: 1 },
      { g: 5005, p: 'cookpot', x: -2, z: 2, f: ['stewer', 'container', 'cooking'] },
      { g: 5006, p: 'meatrack', x: -3, z: 2, f: ['container', 'rack', 'dried'] },
    )
    st.apply(frame)
    const composer = createSnapshotComposer({ state: st, handles: createHandleRegistry(), dst: { prefab: 'wilson' }, getBodyState: () => ({ fight: true }) })
    const text = composer.next({ lastActionResult: null })
    expect(text).toMatch(/diggable: evergreen #\d+ \([\d.]+m, stump\)\n/)
    expect(text).not.toMatch(/diggable:[^\n]*grass/)
    expect(text).toMatch(/traps: trap #\d+ \([\d.]+m, caught something\)/)
    expect(text).toMatch(/bearger #\d+ \([\d.]+m, 100% hp, BOSS/)
    expect(text).toMatch(/cookpot #\d+ \([\d.]+m, cooking\)/)
    expect(text).toMatch(/meatrack #\d+ \([\d.]+m, jerky ready\)/)
    // A 0.2.x/0.3.x helper without the dig verb gets no diggable line.
    const old = createSnapshotComposer({ state: st, handles: createHandleRegistry(), dst: { prefab: 'wilson' }, getBodyState: () => ({ fight: true }), hasDig: () => false })
    expect(old.next({ lastActionResult: null })).not.toContain('diggable')
  })
})
