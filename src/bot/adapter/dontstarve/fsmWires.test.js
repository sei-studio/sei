import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { wireLinkEvents } from './fsmWires.js'

function setup({ hasCaps = false, darkNeedsBrain, state } = {}) {
  const link = new EventEmitter()
  const handlers = { onAttacked: vi.fn(), onIdleNudge: vi.fn(), onChat: vi.fn() }
  const dispose = wireLinkEvents(link, handlers, { botName: 'Sui', companions: () => [], hasCaps: () => hasCaps, darkNeedsBrain, state: state ? () => state : undefined })
  return { link, handlers, dispose }
}

describe('DST fsm wires: survival routing', () => {
  it('an older helper wakes the brain on every survival event and on enterdark', () => {
    const { link, handlers } = setup()
    link.emit('survival', { what: 'ate', item: 'berries' })
    link.emit('survival', { what: 'retreat', threat: 'hound' })
    link.emit('enterdark', { phase: 'night' })
    expect(handlers.onAttacked.mock.calls.map((c) => c[0].survivalKind)).toEqual(['ate', 'critical_retreat', 'dark'])
  })

  it('with mod 0.3.0 habits stay quiet; retreat, defend and a hopeless dark wake', () => {
    let noLight = false
    const { link, handlers } = setup({ hasCaps: true, darkNeedsBrain: () => noLight })
    for (const ev of [
      { what: 'ate', item: 'berries' }, { what: 'light', did: 'prepared' }, { what: 'fuel', item: 'log' },
      { what: 'equip', items: ['spear'] }, { what: 'heal', item: 'healingsalve' },
    ]) link.emit('survival', ev)
    link.emit('enterdark', { phase: 'night' })
    link.emit('survival', { what: 'dark', phase: 'night' }) // the habit has what it needs
    expect(handlers.onAttacked).not.toHaveBeenCalled()

    noLight = true
    link.emit('survival', { what: 'dark', phase: 'night' })
    link.emit('survival', { what: 'retreat', threat: 'hound' })
    link.emit('survival', { what: 'defend', threat: 'spider', player: 'Steve' })
    const calls = handlers.onAttacked.mock.calls.map((c) => c[0])
    expect(calls.map((c) => [c.attackerKind, c.survivalKind])).toEqual([
      ['reflex', 'dark'], ['reflex', 'critical_retreat'], ['defend', 'defend'],
    ])
    expect(calls[2]).toMatchObject({ attackerLabel: 'spider', player: 'Steve' })
  })

  it('helper 0.4.0: wormhole, kite and assist stay quiet; running from a boss wakes the brain', () => {
    const { link, handlers } = setup({ hasCaps: true })
    link.emit('survival', { what: 'wormhole', player: 'Steve' })
    link.emit('survival', { what: 'kite', threat: 'hound' })
    link.emit('survival', { what: 'assist', work: 'chop', player: 'Steve' })
    expect(handlers.onAttacked).not.toHaveBeenCalled()
    link.emit('survival', { what: 'boss', threat: 'bearger', guid: 9 })
    expect(handlers.onAttacked).toHaveBeenCalledTimes(1)
    expect(handlers.onAttacked.mock.calls[0][0]).toMatchObject({ attackerKind: 'reflex', survivalKind: 'boss', attackerLabel: 'bearger' })
  })

  it('dispose unhooks everything', () => {
    const { link, handlers, dispose } = setup({ hasCaps: true })
    dispose()
    link.emit('survival', { what: 'retreat' })
    expect(handlers.onAttacked).not.toHaveBeenCalled()
  })
})

describe('DST fsm wires: death and respawn (261104)', () => {
  function deathSetup() {
    const link = new EventEmitter()
    const handlers = { onDying: vi.fn(), onDeath: vi.fn() }
    const dispose = wireLinkEvents(link, handlers, { botName: 'Sui', companions: () => [], hasCaps: () => true })
    return { link, handlers, dispose }
  }

  it("the mod's death only marks her dying; the death turn waits for the runtime's bodydied", () => {
    const { link, handlers } = deathSetup()
    link.emit('death', { x: 1, z: 2, cause: 'darkness' })
    expect(handlers.onDying).toHaveBeenCalledTimes(1)
    expect(handlers.onDeath).not.toHaveBeenCalled()

    link.emit('bodydied', {
      pos: { x: 1, y: 0, z: 2 }, diedAt: 123, deathText: 'killed by Charlie in the darkness',
      detail: { outcome: 'respawned', cause: 'Charlie in the darkness', respawns: 1, respawnsLeft: 2, player: 'Steve' },
    })
    expect(handlers.onDeath).toHaveBeenCalledWith({
      pos: { x: 1, y: 0, z: 2 }, diedAt: 123, deathText: 'killed by Charlie in the darkness',
      detail: { outcome: 'respawned', cause: 'Charlie in the darkness', respawns: 1, respawnsLeft: 2, player: 'Steve' },
    })
  })

  it('a bodydied with no position or cause still gives a death turn', () => {
    const { link, handlers, dispose } = deathSetup()
    link.emit('bodydied', { pos: null, deathText: null })
    expect(handlers.onDeath).toHaveBeenCalledWith({ pos: null })
    dispose()
    link.emit('death', {})
    link.emit('bodydied', {})
    expect(handlers.onDying).not.toHaveBeenCalled()
    expect(handlers.onDeath).toHaveBeenCalledTimes(1)
  })
})

describe('DST fsm wires: a hit by the darkness', () => {
  const state = {
    self: { inLight: false, inv: [{ prefab: 'cutgrass', qty: 2 }, { prefab: 'twigs', qty: 1 }], equip: {} },
    world: { phase: 'night' },
  }

  it('is still a real hit, labelled the darkness, with what a torch needs', () => {
    const { link, handlers } = setup({ hasCaps: true, state })
    link.emit('attacked', { attacker: null, label: 'darkness', stimuli: 'darkness', healthpct: 0.3, damage: 100 })
    expect(handlers.onAttacked.mock.calls[0][0]).toMatchObject({
      attackerKind: 'mob', attackerLabel: 'the darkness', darkness: true, healthPct: 0.3,
      torchNeed: { grass: 0, twigs: 1, haveGrass: 2, haveTwigs: 1 },
    })
  })

  it('an older helper\'s "something" in the dark reads the same; a hound does not', () => {
    const { link, handlers } = setup({ hasCaps: true, state })
    link.emit('attacked', { label: 'something', healthpct: 0.3 })
    link.emit('attacked', { attacker: 77, label: 'hound', healthpct: 0.2 })
    const [a, b] = handlers.onAttacked.mock.calls.map((c) => c[0])
    expect(a).toMatchObject({ attackerLabel: 'the darkness', darkness: true })
    expect(b.attackerLabel).toBe('hound')
    expect(b.darkness).toBeUndefined()
  })
})
