import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { wireStardewEvents, activityFor, morningText, DAY_OBS_WAIT_MS, ACTIVITY_SETTLE_MS, ACTIVITY_MIN_GAP_MS, ACTIVITY_REPEAT_MS } from './fsmWires.js'

function fakeClient() {
  const e = new EventEmitter()
  return { on: (...a) => e.on(...a), off: (...a) => e.off(...a), emit: (...a) => e.emit(...a) }
}

function handlers() {
  return { onChat: vi.fn(), onAttacked: vi.fn(), onDeath: vi.fn(), onSpawn: vi.fn(), onPlayerJoined: vi.fn(), onPlayerLeft: vi.fn(), onIdleNudge: vi.fn() }
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
    // The notice waits for the new day's first observation.
    expect(h.onChat).not.toHaveBeenCalled()
    c.emit('obs', { obs: { ...obs, day: 4 } })
    expect(h.onChat).toHaveBeenLastCalledWith(expect.objectContaining({ username: 'sei', playerSpoke: false, addressed: true }))
    expect(h.onChat.mock.calls.at(-1)[0].text).toMatch(/new day: spring 4, rain/)
    c.emit('night_soon', { time: 2200 })
    expect(h.onChat.mock.calls.at(-1)[0].text).toMatch(/10 PM/)
  })

  it('names the morning chores from the new day\'s first observation', () => {
    const c = fakeClient()
    const h = handlers()
    wireStardewEvents(c, h, { botName: 'Sui' })
    c.emit('day_started', { day: 5, season: 'spring', weather: 'sunny' })
    // A late push from the old day does not count.
    c.emit('obs', { obs: { day: 4, farm: { crops: 3, dryCrops: 0, readyCrops: 0 } } })
    expect(h.onChat).not.toHaveBeenCalled()
    c.emit('obs', { obs: { day: 5, weather: 'sunny', farm: { crops: 15, dryCrops: 15, readyCrops: 2 } } })
    expect(h.onChat).toHaveBeenCalledTimes(1)
    const text = h.onChat.mock.calls[0][0].text
    expect(text).toMatch(/new day: spring 5, sunny/)
    expect(text).toMatch(/On the farm this morning: 15 crops need water, 2 are ready to harvest\./)
    expect(h.onChat.mock.calls[0][0].gameEvent).toBe(true)
    // Once only.
    c.emit('obs', { obs: { day: 5, farm: { crops: 15, dryCrops: 15 } } })
    expect(h.onChat).toHaveBeenCalledTimes(1)
  })

  it('sends the plain notice when no observation arrives in time, and cancels on dispose', () => {
    const c = fakeClient()
    const h = handlers()
    const timers = []
    const setTimer = vi.fn((fn, ms) => { timers.push({ fn, ms }); return timers.length })
    const clearTimer = vi.fn()
    const dispose = wireStardewEvents(c, h, { botName: 'Sui', setTimer, clearTimer })
    c.emit('day_started', { day: 6, season: 'spring', weather: 'rain' })
    expect(timers[0].ms).toBe(DAY_OBS_WAIT_MS)
    timers[0].fn()
    expect(h.onChat).toHaveBeenCalledTimes(1)
    expect(h.onChat.mock.calls[0][0].text).toMatch(/new day: spring 6, rain\. Your energy and health are full\. This is a game event/)
    c.emit('day_started', { day: 7, season: 'spring' })
    dispose()
    expect(clearTimer).toHaveBeenCalled()
    timers[1].fn()
    expect(h.onChat).toHaveBeenCalledTimes(1)
  })

  it('morning text: rain waters the crops, nothing to say on an empty farm', () => {
    expect(morningText({ weather: 'rain', farm: { crops: 10, dryCrops: 10, readyCrops: 0 } })).toBe(' The rain waters the crops today.')
    expect(morningText({ weather: 'storm', farm: { crops: 4, dryCrops: 4, readyCrops: 1 } })).toBe(' On the farm this morning: 1 is ready to harvest. The rain waters the crops today.')
    expect(morningText({ weather: 'sunny', farm: { crops: 1, dryCrops: 1 } })).toBe(' On the farm this morning: 1 crop needs water.')
    expect(morningText({ weather: 'sunny', farm: { crops: 0 } })).toBe('')
    expect(morningText({ weather: 'sunny' })).toBe('')
    expect(morningText(null)).toBe('')
    expect(morningText({ weather: 'sunny', farm: { crops: 3, dryCrops: 1 } })).not.toMatch(/\u2014/)
  })

  it('reads the player\'s activity from the tool in their hands', () => {
    expect(activityFor('Watering Can')).toBe('watering')
    expect(activityFor('Copper Watering Can')).toBe('watering')
    expect(activityFor('Hoe')).toBe('tilling')
    expect(activityFor('Axe')).toBe('chopping')
    expect(activityFor('Steel Axe')).toBe('chopping')
    expect(activityFor('Pickaxe')).toBe('mining')
    expect(activityFor('Training Rod')).toBe('fishing')
    expect(activityFor('Bamboo Pole')).toBe('fishing')
    expect(activityFor('Scythe')).toBe('cutting weeds')
    expect(activityFor('Parsnip Seeds')).toBe('planting')
    expect(activityFor('Strawberry Seeds')).toBe('planting')
    expect(activityFor('Rusty Sword')).toBeNull()
    expect(activityFor('Parsnip')).toBeNull()
    expect(activityFor(null)).toBeNull()
    expect(activityFor('')).toBeNull()
  })

  it('nudges once when the player keeps a tool out, rate-limited, never in a menu or mid-action', () => {
    const c = fakeClient()
    const h = handlers()
    let t = 0
    wireStardewEvents(c, h, { botName: 'Sui', now: () => t })
    const push = (host, extra = {}) => c.emit('obs', { obs: { host, player: { sameLocation: true }, ...extra } })
    push({ holding: 'Watering Can' })
    t = ACTIVITY_SETTLE_MS - 1
    push({ holding: 'Watering Can' })
    expect(h.onIdleNudge).not.toHaveBeenCalled()
    t = ACTIVITY_SETTLE_MS
    push({ holding: 'Watering Can' })
    expect(h.onIdleNudge).toHaveBeenCalledTimes(1)
    expect(h.onIdleNudge).toHaveBeenCalledWith({ reason: 'player_activity', activity: 'watering', item: 'Watering Can' })
    // Still holding it: no second nudge.
    t += 10_000
    push({ holding: 'Watering Can' })
    expect(h.onIdleNudge).toHaveBeenCalledTimes(1)
    // Switches to the hoe, but inside the global gap.
    push({ holding: 'Hoe' })
    t += ACTIVITY_SETTLE_MS
    push({ holding: 'Hoe' })
    expect(h.onIdleNudge).toHaveBeenCalledTimes(1)
    // Past the gap, still holding the hoe: nudges.
    t = ACTIVITY_MIN_GAP_MS + ACTIVITY_SETTLE_MS
    push({ holding: 'Hoe' })
    expect(h.onIdleNudge).toHaveBeenCalledTimes(2)
    expect(h.onIdleNudge.mock.calls[1][0].activity).toBe('tilling')
    // Back to the can: same activity within ACTIVITY_REPEAT_MS stays quiet.
    t += ACTIVITY_MIN_GAP_MS
    push({ holding: 'Watering Can' })
    t += ACTIVITY_SETTLE_MS
    push({ holding: 'Watering Can' })
    expect(h.onIdleNudge).toHaveBeenCalledTimes(2)
    t = ACTIVITY_REPEAT_MS + ACTIVITY_SETTLE_MS + 1
    push({ holding: 'Watering Can' })
    expect(h.onIdleNudge).toHaveBeenCalledTimes(3)
  })

  it('does not nudge while the player is in a menu or cutscene, away, or the body is busy', () => {
    const c = fakeClient()
    const h = handlers()
    let t = 0
    wireStardewEvents(c, h, { botName: 'Sui', now: () => t })
    const settle = (host, extra = {}) => {
      c.emit('obs', { obs: { host, player: { sameLocation: true }, ...extra } })
      t += ACTIVITY_SETTLE_MS
      c.emit('obs', { obs: { host, player: { sameLocation: true }, ...extra } })
      t += ACTIVITY_REPEAT_MS
    }
    settle({ holding: 'Axe', menu: 'ShopMenu' })
    settle({ holding: 'Axe', inEvent: true })
    settle({ holding: 'Axe' }, { player: { sameLocation: false } })
    settle({ holding: 'Axe' }, { inAction: 'gather' })
    settle({ holding: 'Rusty Sword' })
    settle({})
    expect(h.onIdleNudge).not.toHaveBeenCalled()
    // An old mod (no host.holding) never nudges either.
    settle(undefined)
    expect(h.onIdleNudge).not.toHaveBeenCalled()
  })

  it('nudges only in proactive mode, read live', () => {
    const c = fakeClient()
    const h = handlers()
    let t = 0
    let tier = 1
    wireStardewEvents(c, h, { botName: 'Sui', now: () => t, getProactiveness: () => tier })
    const push = () => c.emit('obs', { obs: { host: { holding: 'Hoe' }, player: { sameLocation: true } } })
    push()
    t += ACTIVITY_SETTLE_MS
    push()
    expect(h.onIdleNudge).not.toHaveBeenCalled()
    tier = 0
    t += ACTIVITY_SETTLE_MS
    push()
    expect(h.onIdleNudge).not.toHaveBeenCalled()
    tier = 2
    t += ACTIVITY_SETTLE_MS
    push()
    expect(h.onIdleNudge).toHaveBeenCalledTimes(1)
  })
})
