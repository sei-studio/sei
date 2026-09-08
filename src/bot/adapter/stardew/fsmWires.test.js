import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { wireStardewEvents } from './fsmWires.js'

function fakeClient() {
  const e = new EventEmitter()
  return { on: (...a) => e.on(...a), off: (...a) => e.off(...a), emit: (...a) => e.emit(...a) }
}

function handlers() {
  return { onChat: vi.fn(), onAttacked: vi.fn(), onDeath: vi.fn(), onSpawn: vi.fn(), onPlayerJoined: vi.fn(), onPlayerLeft: vi.fn() }
}

describe('stardew fsm wires', () => {
  it('routes chat with addressed / playerSpoke / sibling suppression like chat.js', () => {
    const c = fakeClient()
    const h = handlers()
    const dispose = wireStardewEvents(c, h, { botName: 'Sui', companions: () => ['Marv'] })
    c.emit('chat', { from: 'Ouen', text: 'sui come here', sameLocation: true })
    expect(h.onChat).toHaveBeenLastCalledWith(expect.objectContaining({ username: 'Ouen', text: 'sui come here', playerSpoke: true, addressed: true, nearby: true, suppressInterrupt: false }))
    c.emit('chat', { from: 'Ouen', text: 'marv water the crops', sameLocation: true })
    expect(h.onChat).toHaveBeenLastCalledWith(expect.objectContaining({ addressed: false, suppressInterrupt: true }))
    c.emit('chat', { from: 'Marv', text: 'on it', sameLocation: false })
    expect(h.onChat).toHaveBeenLastCalledWith(expect.objectContaining({ username: 'Marv', playerSpoke: false, nearby: false, suppressInterrupt: true }))
    c.emit('chat', { from: 'Sui', text: 'hi' })
    expect(h.onChat).toHaveBeenCalledTimes(3)
    dispose()
    c.emit('chat', { from: 'Ouen', text: 'still there?' })
    expect(h.onChat).toHaveBeenCalledTimes(3)
  })

  it('maps damaged to a mob hit, a retreating hit to a reflex, and survival kinds', () => {
    const c = fakeClient()
    const h = handlers()
    wireStardewEvents(c, h, { botName: 'Sui' })
    c.emit('damaged', { attacker: 'Green Slime', damage: 6, health: 80, maxHealth: 100, retaliated: true, retreating: false })
    expect(h.onAttacked).toHaveBeenLastCalledWith(expect.objectContaining({ attackerKind: 'mob', attackerLabel: 'Green Slime', retaliated: true, health: 80 }))
    c.emit('damaged', { attacker: 'Bat', damage: 9, health: 20, maxHealth: 100, retreating: true })
    expect(h.onAttacked).toHaveBeenLastCalledWith(expect.objectContaining({ attackerKind: 'reflex', survivalKind: 'critical_retreat' }))
    c.emit('survival', { kind: 'ate', detail: 'ate Leek' })
    expect(h.onAttacked).toHaveBeenLastCalledWith(expect.objectContaining({ attackerKind: 'reflex', survivalKind: 'ate', detail: 'ate Leek' }))
    c.emit('survival', { kind: 'bedtime', time: 2550 })
    expect(h.onAttacked).toHaveBeenLastCalledWith(expect.objectContaining({ survivalKind: 'bedtime' }))
    c.emit('death', { cause: 'Bat', where: 'UndergroundMine12' })
    expect(h.onDeath).toHaveBeenCalledWith({ pos: null, cause: 'Bat', where: 'UndergroundMine12' })
  })

  it('fires onSpawn on spawned, joins players seen in observations once, and wakes on day events', () => {
    const c = fakeClient()
    const h = handlers()
    wireStardewEvents(c, h, { botName: 'Sui' })
    c.emit('spawned', { name: 'Sui' })
    expect(h.onSpawn).toHaveBeenCalledTimes(1)
    const obs = { entities: [{ kind: 'player', name: 'Ouen', farmerId: '9001' }], player: { name: 'Ouen', farmerId: '9001' } }
    c.emit('obs', { obs })
    c.emit('obs', { obs })
    expect(h.onPlayerJoined).toHaveBeenCalledTimes(1)
    expect(h.onPlayerJoined).toHaveBeenCalledWith({ username: 'Ouen', uuid: 'stardew:9001' })
    c.emit('day_started', { day: 4, season: 'spring', weather: 'rain' })
    expect(h.onChat).toHaveBeenLastCalledWith(expect.objectContaining({ username: 'sei', playerSpoke: false, addressed: true }))
    expect(h.onChat.mock.calls.at(-1)[0].text).toMatch(/new day: spring 4, rain/)
    c.emit('night_soon', { time: 2200 })
    expect(h.onChat.mock.calls.at(-1)[0].text).toMatch(/10 PM/)
  })
})
