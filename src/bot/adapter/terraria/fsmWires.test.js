// The Terraria wires: pushed mod events become the brain's handlers, with
// the token-saving rules (one turn per fight, no turn for a reflex heal,
// chat from companions as history only).
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { wireTerrariaEvents, FIGHT_WINDOW_MS } from './fsmWires.js'

function setup(opts = {}) {
  const client = new EventEmitter()
  const handlers = { onChat: vi.fn(), onAttacked: vi.fn(), onDeath: vi.fn(), onSpawn: vi.fn(), onPlayerJoined: vi.fn(), onPlayerLeft: vi.fn() }
  let t = 1_000_000
  const now = () => t
  const dispose = wireTerrariaEvents(client, handlers, { botName: 'Sui', companions: () => ['Lyra'], logger: { error: () => {} }, now, ...opts })
  return { client, handlers, dispose, advance: (ms) => { t += ms } }
}

describe('terraria fsm wires', () => {
  it('routes chat: drops her own lines, marks addressed, nearby and companion lines', () => {
    const { client, handlers } = setup()
    client.emit('chat', { from: 'Sui', text: 'hi' })
    expect(handlers.onChat).not.toHaveBeenCalled()
    client.emit('chat', { from: 'Ouen', text: 'sui, come here', dist: 10 })
    expect(handlers.onChat.mock.calls[0][0]).toMatchObject({ username: 'Ouen', addressed: true, nearby: true, playerSpoke: true, suppressInterrupt: false })
    client.emit('chat', { from: 'Ouen', text: 'lyra go mine', dist: 200 })
    expect(handlers.onChat.mock.calls[1][0]).toMatchObject({ addressed: false, nearby: false, suppressInterrupt: true })
    client.emit('chat', { from: 'Lyra', text: 'on it', kind: 'companion' })
    expect(handlers.onChat.mock.calls[2][0]).toMatchObject({ fromCompanion: true, playerSpoke: false, suppressInterrupt: true })
  })

  it('makes one turn per fight from damage, and a new one after the window or a new attacker', () => {
    const { client, handlers, advance } = setup()
    client.emit('damaged', { by: 'Zombie', amount: 10, hp: 90, maxHp: 100 })
    client.emit('damaged', { by: 'Zombie', amount: 10, hp: 80, maxHp: 100 })
    expect(handlers.onAttacked).toHaveBeenCalledTimes(1)
    expect(handlers.onAttacked.mock.calls[0][0]).toMatchObject({ attackerLabel: 'Zombie', attackerKind: 'mob', health: 90 })
    client.emit('damaged', { by: 'Demon Eye', amount: 5, hp: 75, maxHp: 100 })
    expect(handlers.onAttacked).toHaveBeenCalledTimes(2)
    advance(FIGHT_WINDOW_MS + 1)
    client.emit('damaged', { by: 'Demon Eye', amount: 5, hp: 70, maxHp: 100 })
    expect(handlers.onAttacked).toHaveBeenCalledTimes(3)
  })

  it('turns survival reflexes into reflex events, except a heal', () => {
    const { client, handlers } = setup()
    client.emit('survival', { kind: 'healed', hp: 80, maxHp: 100 })
    expect(handlers.onAttacked).not.toHaveBeenCalled()
    client.emit('survival', { kind: 'retreating', hp: 20, maxHp: 100 })
    expect(handlers.onAttacked.mock.calls[0][0]).toMatchObject({ attackerKind: 'reflex', survivalKind: 'critical_retreat' })
    client.emit('survival', { kind: 'low_health', hp: 25, maxHp: 100, potions: 0 })
    expect(handlers.onAttacked.mock.calls[1][0]).toMatchObject({ survivalKind: 'low_health', potions: 0 })
  })

  it('passes death and spawn, and turns world alerts into game-event lines', () => {
    const { client, handlers } = setup()
    client.emit('death', { by: 'Eye of Cthulhu' })
    expect(handlers.onDeath).toHaveBeenCalledWith({ pos: null, cause: 'Eye of Cthulhu', where: null })
    client.emit('spawned', {})
    expect(handlers.onSpawn).toHaveBeenCalled()
    client.emit('event', { kind: 'dawn', text: 'Morning.' })
    client.emit('event', { kind: 'player_joined', text: 'Ouen joined.' })
    expect(handlers.onChat).not.toHaveBeenCalled()
    client.emit('event', { kind: 'boss_spawn', text: 'The Eye of Cthulhu has awoken!' })
    const line = handlers.onChat.mock.calls[0][0]
    expect(line).toMatchObject({ gameEvent: true, playerSpoke: false, eventFact: 'the eye of cthulhu has awoken' })
    expect(line.text).toContain('The Eye of Cthulhu has awoken! This is a game event')
  })

  it('reports players joining and leaving from the observation, and stops on dispose', () => {
    const { client, handlers, dispose } = setup()
    client.emit('obs', { obs: { players: [{ name: 'Ouen' }] } })
    client.emit('obs', { obs: { players: [{ name: 'Ouen' }, { name: 'Kai' }] } })
    client.emit('obs', { obs: { players: [{ name: 'Kai' }] } })
    expect(handlers.onPlayerJoined.mock.calls.map((c) => c[0].username)).toEqual(['Ouen', 'Kai'])
    expect(handlers.onPlayerLeft).toHaveBeenCalledWith({ username: 'Ouen', uuid: 'terraria:Ouen' })
    dispose()
    client.emit('death', {})
    expect(handlers.onDeath).not.toHaveBeenCalled()
  })
})
