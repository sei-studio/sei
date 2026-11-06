// 261012: the owner-threat watch.
//
// Quality eval protect_player: a 10 hp player and two zombies 21 blocks out.
// The order turn often called follow (which never swings), the loop ended,
// and nothing woke the brain again until a zombie had already hit the player.
// The watch wakes the brain while a hostile is still closing on a hurt owner
// (or when two or more are closing), as a `defend` event flagged `threat`.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { startCombat } from './combat.js'

vi.mock('./follow.js', () => ({
  startFollow: vi.fn(),
  stopFollow: vi.fn(),
  pauseFollow: vi.fn(),
}))

const vec = (x, y, z) => ({
  x, y, z,
  distanceTo(p) { return Math.hypot(p.x - this.x, p.y - this.y, p.z - this.z) },
})

function makeBot({ ownerHp = 10 } = {}) {
  const bot = new EventEmitter()
  bot.entity = { id: 1, position: vec(0, 64, 0), velocity: { x: 0, y: 0, z: 0 } }
  bot.registry = { entitiesByName: { player: { metadataKeys: ['flags', 'health'] } } }
  bot.owner = { id: 9, username: 'SSk1tz', type: 'player', position: vec(4, 64, 0), metadata: [0, ownerHp] }
  bot.players = { SSk1tz: { entity: bot.owner } }
  bot.entities = { 1: bot.entity, 9: bot.owner }
  bot.pathfinder = { setGoal: vi.fn(), stop: vi.fn() }
  bot.look = vi.fn()
  bot.attack = vi.fn()
  bot.swingArm = vi.fn()
  return bot
}

function mob(bot, name, id, x) {
  const e = { id, name, position: vec(x, 64, 0), yaw: 0 }
  bot.entities[id] = e
  return e
}

const cfg = (extra = {}) => ({
  player_username: 'SSk1tz',
  player_display_name: 'Alex',
  adapter: { kind: 'minecraft', minecraft: { attack_react_throttle_ms: 0, ...extra } },
})

function capture(bot) {
  const out = []
  bot.on('sei:owner_attacked', (p) => out.push(p))
  return out
}

// Move each mob `step` blocks toward the owner (who stands at x=4) and run a tick.
function closeIn(mobs, step = 1) {
  for (const m of mobs) m.position = vec(m.position.x - step, 64, 0)
  vi.advanceTimersByTime(500)
}

afterEach(() => { vi.useRealTimers() })

describe('owner-threat watch', () => {
  it('wakes the brain when a hostile closes on a hurt owner, before any hit', () => {
    vi.useFakeTimers()
    const bot = makeBot({ ownerHp: 10 })
    const seen = capture(bot)
    startCombat(bot, cfg())
    const z = mob(bot, 'zombie', 21, 14)
    vi.advanceTimersByTime(500) // first sighting: no baseline yet
    expect(seen).toHaveLength(0)
    closeIn([z])
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      attackerKind: 'defend', threat: true, engaged: false,
      attackerLabel: 'zombie', ownerLabel: 'Alex', ownerHp: 10, count: 1,
      ownerDistance: 9, distance: 13,
    })
    // It only reports; it does not start a fight on its own.
    expect(bot._seiOffensiveTarget).toBeUndefined()
  })

  it('stays quiet for one mob while the owner is healthy', () => {
    vi.useFakeTimers()
    const bot = makeBot({ ownerHp: 20 })
    const seen = capture(bot)
    startCombat(bot, cfg())
    const z = mob(bot, 'zombie', 21, 14)
    vi.advanceTimersByTime(500)
    closeIn([z]); closeIn([z])
    expect(seen).toHaveLength(0)
  })

  it('fires for two closing mobs even at full health', () => {
    vi.useFakeTimers()
    const bot = makeBot({ ownerHp: 20 })
    const seen = capture(bot)
    startCombat(bot, cfg())
    const a = mob(bot, 'zombie', 21, 14)
    const b = mob(bot, 'husk', 22, 15)
    vi.advanceTimersByTime(500)
    closeIn([a, b])
    expect(seen).toHaveLength(1)
    expect(seen[0].count).toBe(2)
    expect(seen[0].attackerLabel).toBe('zombie') // nearest to the owner
  })

  it('ignores a mob that is not getting closer', () => {
    vi.useFakeTimers()
    const bot = makeBot({ ownerHp: 6 })
    const seen = capture(bot)
    startCombat(bot, cfg())
    mob(bot, 'zombie', 21, 12)
    vi.advanceTimersByTime(2000)
    expect(seen).toHaveLength(0)
  })

  it('announces the same mob once per 15s', () => {
    vi.useFakeTimers()
    const bot = makeBot({ ownerHp: 6 })
    const seen = capture(bot)
    startCombat(bot, cfg())
    const z = mob(bot, 'zombie', 21, 15)
    vi.advanceTimersByTime(500)
    closeIn([z], 0.5); closeIn([z], 0.5); closeIn([z], 0.5)
    expect(seen).toHaveLength(1)
  })

  it('is skipped while a fight of our own is running', () => {
    vi.useFakeTimers()
    const bot = makeBot({ ownerHp: 6 })
    const seen = capture(bot)
    startCombat(bot, cfg())
    bot._seiOffensiveTarget = 99
    const z = mob(bot, 'zombie', 21, 14)
    vi.advanceTimersByTime(500)
    closeIn([z])
    expect(seen).toHaveLength(0)
  })

  it('does not count a mob that died', () => {
    vi.useFakeTimers()
    const bot = makeBot({ ownerHp: 6 })
    const seen = capture(bot)
    startCombat(bot, cfg())
    const z = mob(bot, 'zombie', 21, 14)
    vi.advanceTimersByTime(500)
    bot.emit('entityDead', z)
    closeIn([z])
    expect(seen).toHaveLength(0)
  })

  it('ignores endermen and mobs melee cannot safely answer', () => {
    vi.useFakeTimers()
    const bot = makeBot({ ownerHp: 6 })
    const seen = capture(bot)
    startCombat(bot, cfg())
    const a = mob(bot, 'enderman', 21, 14)
    const b = mob(bot, 'creeper', 22, 15)
    vi.advanceTimersByTime(500)
    closeIn([a, b]); closeIn([a, b])
    expect(seen).toHaveLength(0)
  })

  it('is off with defend_owner false', () => {
    vi.useFakeTimers()
    const bot = makeBot({ ownerHp: 6 })
    const seen = capture(bot)
    startCombat(bot, cfg({ defend_owner: false }))
    const z = mob(bot, 'zombie', 21, 14)
    vi.advanceTimersByTime(500)
    closeIn([z])
    expect(seen).toHaveLength(0)
  })
})

describe('defend event counts other mobs on the owner', () => {
  it('reports othersOnOwner and ownerHp when the owner is hit', () => {
    const bot = makeBot({ ownerHp: 8 })
    const seen = capture(bot)
    startCombat(bot, cfg())
    const a = mob(bot, 'zombie', 21, 5)
    mob(bot, 'zombie', 22, 6)
    bot.emit('entityHurt', bot.owner, a)
    expect(seen).toHaveLength(1)
    expect(seen[0].othersOnOwner).toBe(1)
    expect(seen[0].ownerHp).toBe(8)
  })
})

describe('an attackEntity action already owns the fight', () => {
  it('same mob: reported as handled by the action, the body is left alone', () => {
    const bot = makeBot({ ownerHp: 8 })
    const seen = capture(bot)
    startCombat(bot, cfg())
    const z = mob(bot, 'zombie', 21, 9)
    bot._seiOffensiveTarget = 21
    bot.emit('entityHurt', bot.owner, z)
    expect(seen).toHaveLength(1)
    expect(seen[0].engaged).toBe(true)
    expect(seen[0].actionOnIt).toBe(true)
    expect(bot.pathfinder.setGoal).not.toHaveBeenCalled()
    expect(bot._seiOffensiveTarget).toBe(21)
  })

  it('another mob: held for the turn to decide', () => {
    const bot = makeBot({ ownerHp: 8 })
    const seen = capture(bot)
    startCombat(bot, cfg())
    const z = mob(bot, 'zombie', 21, 9)
    bot._seiOffensiveTarget = 77
    bot.emit('entityHurt', bot.owner, z)
    expect(seen[0].engaged).toBe(false)
    expect(seen[0].actionOnIt).toBeFalsy()
    expect(bot._seiOffensiveTarget).toBe(77)
  })
})
