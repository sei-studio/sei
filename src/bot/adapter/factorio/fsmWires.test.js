import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { wireFactorioEvents, mentions } from './fsmWires.js'

const quiet = { info() {}, warn() {}, error() {}, debug() {} }

function setup(companions = []) {
  const client = new EventEmitter()
  const h = {
    onChat: vi.fn(), onAttacked: vi.fn(), onDying: vi.fn(), onDeath: vi.fn(),
    onPlayerJoined: vi.fn(), onPlayerLeft: vi.fn(),
  }
  const onEvent = vi.fn()
  const dispose = wireFactorioEvents(client, h, { botName: 'Sui', companions: () => companions, logger: quiet, onEvent })
  const emit = (ev) => client.emit(ev.t, ev)
  return { client, h, emit, dispose, onEvent }
}

describe('wireFactorioEvents', () => {
  it('passes player chat through and marks when she is named', () => {
    const { h, emit } = setup()
    emit({ t: 'chat', from: 'Tester', text: 'sui come here' })
    expect(h.onChat).toHaveBeenCalledWith(expect.objectContaining({ username: 'Tester', text: 'sui come here', playerSpoke: true, addressed: true, suppressInterrupt: false }))
  })

  it('drops her own lines and keeps a sibling companion as history', () => {
    const { h, emit } = setup(['Lyra'])
    emit({ t: 'chat', from: 'Sui', text: 'echo' })
    expect(h.onChat).not.toHaveBeenCalled()
    emit({ t: 'chat', from: 'Lyra', text: 'on it', companion: true })
    expect(h.onChat).toHaveBeenCalledWith(expect.objectContaining({ fromCompanion: true, playerSpoke: false, suppressInterrupt: true }))
    emit({ t: 'chat', from: 'Tester', text: 'lyra grab coal' })
    expect(h.onChat).toHaveBeenLastCalledWith(expect.objectContaining({ playerSpoke: true, suppressInterrupt: true }))
  })

  it('maps a hit to a P0 mob attack and reflex events to P1', () => {
    const { h, emit } = setup()
    emit({ t: 'hit', attacker: 'small-biter', damage: 7, health: 80, fighting: true })
    expect(h.onAttacked).toHaveBeenLastCalledWith(expect.objectContaining({ attackerKind: 'mob', attackerLabel: 'small biter', health: 80, fighting: true }))
    emit({ t: 'fight', enemy: 'small-biter', count: 3, near_owner: true })
    expect(h.onAttacked).toHaveBeenLastCalledWith(expect.objectContaining({ attackerKind: 'reflex', survivalKind: 'fight', detail: '3 small biters attacking', nearOwner: true }))
    emit({ t: 'survival', kind: 'retreat', attacker: 'medium-biter', health: 30 })
    expect(h.onAttacked).toHaveBeenLastCalledWith(expect.objectContaining({ attackerKind: 'reflex', survivalKind: 'critical_retreat', health: 30 }))
    emit({ t: 'survival', kind: 'no_ammo', attacker: 'small-biter' })
    expect(h.onAttacked).toHaveBeenLastCalledWith(expect.objectContaining({ survivalKind: 'no_ammo' }))
  })

  it('raises dying then death with the details', () => {
    const { h, emit } = setup()
    emit({ t: 'death', cause: 'small-spitter', at: [3, 4], respawn_s: 10 })
    expect(h.onDying).toHaveBeenCalled()
    expect(h.onDeath).toHaveBeenCalledWith(expect.objectContaining({ detail: { cause: 'small spitter', at: [3, 4], respawnS: 10 } }))
  })

  it('turns world events into system lines that are not the player talking', () => {
    const { h, emit } = setup()
    emit({ t: 'research_finished', tech: 'logistics' })
    const call = h.onChat.mock.calls.at(-1)[0]
    expect(call).toMatchObject({ gameEvent: true, playerSpoke: false })
    expect(call.text).toContain('Research finished: logistics')
    expect(call.text).toContain('not the player talking')
  })

  it('reports players joining and leaving, counts every event, and disposes', () => {
    const { h, emit, dispose, onEvent, client } = setup()
    emit({ t: 'player_joined', name: 'Friend' })
    expect(h.onPlayerJoined).toHaveBeenCalledWith({ username: 'Friend', uuid: 'factorio:Friend' })
    emit({ t: 'player_left', name: 'Friend' })
    expect(h.onPlayerLeft).toHaveBeenCalled()
    expect(onEvent).toHaveBeenCalledTimes(2)
    dispose()
    expect(client.listenerCount('chat')).toBe(0)
  })
})

describe('mentions', () => {
  it('matches whole names only, accents folded', () => {
    expect(mentions('hey Sui!', 'Sui')).toBe(true)
    expect(mentions('suit up', 'Sui')).toBe(false)
    expect(mentions('zoë help', 'Zoe')).toBe(true)
  })
})
