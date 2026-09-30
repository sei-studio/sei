import { describe, it, expect, vi } from 'vitest'
import { computeAlerts, createAlertWatcher, lightMeans, nudgesAllowed, ALERT_TUNING } from './alerts.js'
import { createObservationState } from '../protocol.js'
import { createFakeMod } from '../../../../../scripts/fake-dst-mod.mjs'

function stateWith(edit = () => {}) {
  const st = createObservationState()
  const mod = createFakeMod({ botPort: 1, token: 'x' })
  const frame = mod.frame(true)
  edit(frame)
  st.apply(frame)
  return st
}

const keys = (st) => computeAlerts(st).map((a) => a.key)
// The fake scene has a spider about 17 m away; most cases want it gone.
const noSpider = (f) => { f.ents = f.ents.filter((e) => e.p !== 'spider') }

describe('DST alerts', () => {
  it('is quiet on a healthy day', () => {
    expect(computeAlerts(stateWith(noSpider))).toEqual([])
  })

  it('wakes for starving only when there is nothing to eat', () => {
    const starving = stateWith((f) => { noSpider(f); f.self.hunger = 10 })
    expect(keys(starving)).toEqual([]) // berries in the bag: the eat habit handles it
    const empty = stateWith((f) => { noSpider(f); f.self.hunger = 10; f.self.inv = f.self.inv.filter((i) => i.p !== 'berries') })
    const a = computeAlerts(empty).find((x) => x.key === 'starving')
    expect(a.level).toBe('wake')
    expect(a.text).toMatch(/starving \(hunger 7%\)/)
  })

  it('wakes for low health only when no hostile is close (retreat is the mod reflex)', () => {
    const close = (f) => { const sp = f.ents.find((e) => e.p === 'spider'); sp.x = 5; sp.z = 0 }
    expect(keys(stateWith((f) => { close(f); f.self.hp = 40 }))).not.toContain('low_health')
    expect(keys(stateWith((f) => { f.self.hp = 40 }))).toContain('low_health') // spider 17 m off
    expect(keys(stateWith((f) => { noSpider(f); f.self.hp = 40 }))).toContain('low_health')
  })

  it('wakes for freezing and overheating', () => {
    expect(keys(stateWith((f) => { noSpider(f); f.self.freezing = true }))).toEqual(['freezing'])
    expect(keys(stateWith((f) => { noSpider(f); f.self.overheating = true }))).toEqual(['overheating'])
  })

  it('nudges at dusk only when the light habit has nothing to work with', () => {
    const dusk = (edit) => stateWith((f) => { noSpider(f); f.world.phase = 'dusk'; edit(f) })
    // log x4 + twigs x2 but no grass: no torch, no campfire.
    expect(keys(dusk(() => {}))).toEqual(['dusk_no_light'])
    expect(keys(dusk((f) => { f.self.inv.push({ g: 3010, p: 'cutgrass', q: 3, f: ['fuel'] }) }))).toEqual([])
    expect(keys(dusk((f) => { f.self.inv.push({ g: 3011, p: 'torch', q: 1, f: ['equip'] }) }))).toEqual([])
    expect(keys(dusk((f) => { f.world.caves = true }))).toEqual([])
  })

  it('reads the light means: carried, makings, fire in sight', () => {
    const st = stateWith((f) => { f.self.inv.push({ g: 3010, p: 'cutgrass', q: 2, f: ['fuel'] }) })
    expect(lightMeans(st)).toMatchObject({ carried: false, makings: true, any: true })
    const fire = stateWith((f) => { f.ents.push({ g: 5000, p: 'campfire', x: 2, z: 0, f: ['fire', 'burning', 'structure'] }) })
    expect(lightMeans(fire)).toMatchObject({ makings: false, fireNear: true, any: true })
  })

  it('nudges for low sanity, a hungry player and the season turning', () => {
    const st = stateWith((f) => {
      noSpider(f)
      f.self.sanity = 40
      f.world.season = 'autumn'
      f.world.seasondays = 2
      const p = f.ents.find((e) => e.f.includes('player'))
      p.hu = 0.2
    })
    const got = computeAlerts(st)
    expect(got.map((a) => a.level)).toEqual(['nudge', 'nudge', 'nudge'])
    expect(got[0].key).toBe('low_sanity')
    expect(got[1].text).toBe('winter starts in 2 days')
    expect(got[2].key).toMatch(/^player_hungry_/)
    expect(got[2].text).toMatch(/Steve is hungry \(20%\)/)
  })

  it('notes a creature attacking the player without waking anyone', () => {
    const st = stateWith((f) => {
      const p = f.ents.find((e) => e.f.includes('player'))
      f.ents.find((e) => e.p === 'spider').t = p.g
    })
    const a = computeAlerts(st).find((x) => x.key.startsWith('player_attacked_'))
    expect(a).toMatchObject({ level: 'note', text: 'spider is attacking Steve' })
  })
})

describe('DST alert watcher', () => {
  it('fires on the rising edge, once per cooldown, and never for notes', () => {
    let t = 0
    const st = stateWith((f) => { noSpider(f); f.self.freezing = true })
    const onWake = vi.fn()
    const onNudge = vi.fn()
    const w = createAlertWatcher({ state: st, onWake, onNudge, now: () => t })
    expect(w.check().map((a) => a.key)).toEqual(['freezing'])
    t += 1000
    expect(w.check()).toEqual([]) // still active: no repeat
    st.self.freezing = false
    t += 1000
    w.check()
    st.self.freezing = true
    t += 1000
    expect(w.check()).toEqual([]) // cleared and back inside the cooldown
    st.self.freezing = false
    w.check()
    st.self.freezing = true
    t += ALERT_TUNING.cooldownMs.wake
    expect(w.check().map((a) => a.key)).toEqual(['freezing'])
    expect(onWake).toHaveBeenCalledTimes(2)
    expect(onNudge).not.toHaveBeenCalled()
  })

  it('holds nudges for a passive character but still wakes for survival', () => {
    const st = stateWith((f) => { noSpider(f); f.self.sanity = 20; f.self.freezing = true })
    const onWake = vi.fn()
    const onNudge = vi.fn()
    let allow = false
    const w = createAlertWatcher({ state: st, onWake, onNudge, allowNudges: () => allow, now: () => 0 })
    expect(w.check().map((a) => a.key)).toEqual(['freezing'])
    expect(onNudge).not.toHaveBeenCalled()
    expect(computeAlerts(st).map((a) => a.key)).toContain('low_sanity') // still in the snapshot
    expect(nudgesAllowed(0)).toBe(false)
    expect(nudgesAllowed(1)).toBe(true)
    expect(nudgesAllowed(2)).toBe(true)
    expect(nudgesAllowed(undefined)).toBe(true) // the config default is reactive
    allow = true
    w.reset()
    w.check()
    expect(onNudge).toHaveBeenCalledWith(expect.objectContaining({ key: 'low_sanity' }))
  })

  it('reset forgets the cooldowns (a new body after a death)', () => {
    const st = stateWith((f) => { noSpider(f); f.self.sanity = 20 })
    const onNudge = vi.fn()
    const w = createAlertWatcher({ state: st, onNudge, now: () => 0 })
    w.check()
    w.reset()
    w.check()
    expect(onNudge).toHaveBeenCalledTimes(2)
  })
})
