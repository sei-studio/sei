import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createDontStarveAdapter } from './index.js'
import { createObservationState, createHandleRegistry } from './protocol.js'
import { createFakeMod } from '../../../../scripts/fake-dst-mod.mjs'

function adapterWith({ hasCaps, proactiveness }) {
  const state = createObservationState()
  const mod = createFakeMod({ botPort: 1, token: 'x' })
  const frame = mod.frame(true)
  frame.ents = frame.ents.filter((e) => e.p !== 'spider')
  state.apply(frame)
  const link = {
    events: new EventEmitter(), state, handles: createHandleRegistry(), botName: 'Sui', body: { fight: true },
    playerName: () => 'Steve', playerUserid: () => 'KU_steve', send: vi.fn(async () => 'built firepit'),
    say: vi.fn(), setPaused: vi.fn(), paused: false, hasCaps, guid: 9001, modVersion: hasCaps ? '0.3.0' : null,
  }
  const persona = proactiveness == null ? undefined : { name: 'Sui', expanded: '', proactiveness }
  const adapter = createDontStarveAdapter({ link, config: { adapter: { dontstarve: { prefab: 'wilson' } }, persona } })
  const handlers = { onAttacked: vi.fn(), onIdleNudge: vi.fn() }
  adapter.attach(handlers)
  return { adapter, link, handlers, state }
}

describe('DST adapter: mod 0.3.0 wiring', () => {
  it('turns a new alert into a wake, and gates prompts, tools and progression on the helper version', async () => {
    const { adapter, link, handlers, state } = adapterWith({ hasCaps: true })
    state.self.freezing = true
    link.events.emit('obs', {})
    expect(handlers.onAttacked).toHaveBeenCalledWith(expect.objectContaining({ attackerKind: 'reflex', survivalKind: 'alert', alert: 'freezing', attackerLabel: 'the cold' }))
    expect(adapter.listActions()).toContain('give')
    expect(adapter.surfaceBaseline()).toMatch(/drop, give\)/)
    expect(adapter.capabilityParagraph()).toMatch(/survival habits/)
    expect(adapter.eventAddendum('sei:attacked', { attackerKind: 'defend', attackerLabel: 'spider' })).toMatch(/your body is fighting it/)
    // A build result latches the structure for the frontier.
    await adapter.executeAction('build', { recipe: 'firepit' })
    expect(adapter.getProgression().raw.has('camp')).toBe(true) // firepit built + a chest in view
    link.events.emit('survival', { what: 'light', did: 'prepared' })
    expect(adapter.createSnapshotComposer().next({})).toContain('your_habits (done on your own lately): made a torch for tonight')
    adapter.detach()
  })

  it('gives a passive character no nudge turns, a reactive one a nudge', () => {
    const passive = adapterWith({ hasCaps: true, proactiveness: 0 })
    passive.state.self.sanity = 10
    passive.link.events.emit('obs', {})
    expect(passive.handlers.onIdleNudge).not.toHaveBeenCalled()
    expect(passive.adapter.createSnapshotComposer().next({})).toMatch(/heads_up: .*sanity is low/)
    passive.adapter.detach()
    const reactive = adapterWith({ hasCaps: true, proactiveness: 1 })
    reactive.state.self.sanity = 10
    reactive.link.events.emit('obs', {})
    expect(reactive.handlers.onIdleNudge).toHaveBeenCalledWith(expect.objectContaining({ reason: 'alert', alert: 'low_sanity' }))
    reactive.adapter.detach()
  })

  it('describes chop for the helper it is talking to', () => {
    expect(adapterWith({ hasCaps: true }).adapter.getActionDescription('chop')).toMatch(/your body equips for you/)
    expect(adapterWith({ hasCaps: false }).adapter.getActionDescription('chop')).toMatch(/Equip an axe first/)
  })

  it('an older helper gets no alerts, no habits line and the 0.2 prompts', () => {
    const { adapter, link, handlers, state } = adapterWith({ hasCaps: false })
    state.self.freezing = true
    link.events.emit('obs', {})
    expect(handlers.onAttacked).not.toHaveBeenCalled()
    expect(adapter.listActions()).not.toContain('give')
    expect(adapter.capabilityParagraph()).toMatch(/Reflexes run in your body/)
    link.events.emit('survival', { what: 'light', did: 'prepared' })
    expect(adapter.createSnapshotComposer().next({})).not.toContain('your_habits')
    adapter.detach()
  })
})
