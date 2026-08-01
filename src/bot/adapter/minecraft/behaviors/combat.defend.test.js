// 260730 — defending the owner.
//
// Live report: "sui is not attracting mob aggro, mobs are all on me". Reading
// two sessions of snapshots, the mobs were as often nearer to HER than to the
// player (48 sightings to 6 in the 23-minute log), so proximity was not the
// problem. The problem was that `entityHurt` returned immediately unless the
// BOT was the one hurt: the player being swarmed produced no event, no
// reaction and no help, and the companion learned about it only if they said
// something out loud.
//
// The fix is a swing rather than a reposition, because vanilla targeting is
// what decides this: a mob that gets hit runs HurtByTargetGoal and switches to
// whoever hit it. So one landed swing MOVES the aggro and nothing else the bot
// can do does.
//
// Pins: who counts as the owner, which attackers are worth engaging, the
// safety carve-outs, and that the bot's OWN hits still take the old path.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { startCombat } from './combat.js'

vi.mock('./follow.js', () => ({
  startFollow: vi.fn(),
  stopFollow: vi.fn(),
}))

function makeBot() {
  const bot = new EventEmitter()
  bot.entity = {
    id: 1,
    position: { x: 0, y: 64, z: 0, distanceTo: (p) => Math.hypot(p.x, p.y - 64, p.z) },
    velocity: { x: 0, y: 0, z: 0 },
  }
  bot.owner = { id: 9, username: 'SSk1tz', type: 'player', position: { x: 2, y: 64, z: 0 } }
  bot.entities = { 1: bot.entity, 9: bot.owner }
  bot.pathfinder = { setGoal: vi.fn(), stop: vi.fn() }
  bot.look = vi.fn()
  bot.attack = vi.fn()
  bot.swingArm = vi.fn()
  return bot
}

function mob(bot, name, id, at = { x: 3, y: 64, z: 0 }) {
  const e = { id, name, position: at, yaw: 0 }
  bot.entities[id] = e
  return e
}

const cfg = (extra = {}) => ({
  player_username: 'SSk1tz',
  player_display_name: 'Shawn',
  adapter: { kind: 'minecraft', minecraft: { attack_react_throttle_ms: 0, ...extra } },
})

function capture(bot) {
  const out = []
  bot.on('sei:owner_attacked', (p) => out.push(p))
  return out
}

afterEach(() => { vi.useRealTimers() })

describe('a hostile hitting the owner wakes the bot', () => {
  it('fires sei:owner_attacked and starts swinging at the mob', () => {
    const bot = makeBot()
    const seen = capture(bot)
    startCombat(bot, cfg())
    const zombie = mob(bot, 'zombie', 21)

    bot.emit('entityHurt', bot.owner, zombie)

    expect(seen).toHaveLength(1)
    expect(seen[0].attackerKind).toBe('defend')
    expect(seen[0].attackerLabel).toBe('zombie')
    expect(seen[0].ownerLabel).toBe('Shawn')
    expect(seen[0].engaged).toBe(true)
    // The deliberate-target flag is claimed so reflex.js stops kiting the mob
    // we are walking into (same contract attack.js uses).
    expect(bot._seiOffensiveTarget).toBe(21)
  })

  it('actually lands swings on the mob, and closes the gap when it is out of reach', () => {
    vi.useFakeTimers()
    const bot = makeBot()
    startCombat(bot, cfg())
    const zombie = mob(bot, 'zombie', 21, { x: 8, y: 64, z: 0 }) // 8 blocks: out of reach

    bot.emit('entityHurt', bot.owner, zombie)
    vi.advanceTimersByTime(300)

    expect(bot.attack).toHaveBeenCalledWith(zombie)
    // Out of swing range, so a pursuit goal was installed — without it the
    // "defence" is the bot waving at a zombie six blocks away.
    expect(bot.pathfinder.setGoal).toHaveBeenCalled()
  })

  it('does not walk into a creeper to defend, but still reports it', () => {
    const bot = makeBot()
    const seen = capture(bot)
    startCombat(bot, cfg())
    const creeper = mob(bot, 'creeper', 22)

    bot.emit('entityHurt', bot.owner, creeper)

    expect(seen).toHaveLength(1)
    expect(seen[0].engaged).toBe(false) // closing on a creeper is how you set it off
    expect(bot._seiOffensiveTarget).toBeUndefined()
  })

  it('ignores a mob too far away to be our fight', () => {
    const bot = makeBot()
    const seen = capture(bot)
    startCombat(bot, cfg({ defend_radius_blocks: 8 }))
    mob(bot, 'zombie', 23, { x: 40, y: 64, z: 0 })

    bot.emit('entityHurt', bot.owner, bot.entities[23])
    expect(seen).toEqual([])
  })

  it('stays out of a fight between the owner and another player', () => {
    const bot = makeBot()
    const seen = capture(bot)
    startCombat(bot, cfg())
    bot.entities[31] = { id: 31, username: 'Griefer', type: 'player', position: { x: 3, y: 64, z: 0 } }

    bot.emit('entityHurt', bot.owner, bot.entities[31])
    expect(seen).toEqual([])
  })

  it('a paused (AFK) bot comes to nobody\'s rescue', () => {
    const bot = makeBot()
    const seen = capture(bot)
    startCombat(bot, cfg())
    bot._seiPaused = true
    mob(bot, 'zombie', 24)

    bot.emit('entityHurt', bot.owner, bot.entities[24])
    expect(seen).toEqual([])
  })

  it('a safety reflex owning the body wins: report, do not engage', () => {
    const bot = makeBot()
    const seen = capture(bot)
    startCombat(bot, cfg())
    bot._seiReflexActive = true // mid creeper-flee
    mob(bot, 'zombie', 25)

    bot.emit('entityHurt', bot.owner, bot.entities[25])
    expect(seen).toHaveLength(1)
    expect(seen[0].engaged).toBe(false)
  })

  it('another player being hit is not our business — only the owner', () => {
    const bot = makeBot()
    const seen = capture(bot)
    startCombat(bot, cfg())
    const bystander = { id: 40, username: 'Someone', type: 'player', position: { x: 2, y: 64, z: 0 } }
    mob(bot, 'zombie', 26)

    bot.emit('entityHurt', bystander, bot.entities[26])
    expect(seen).toEqual([])
  })

  it('the bot\'s own hits still take the retaliation path, not this one', () => {
    const bot = makeBot()
    const defended = capture(bot)
    const attacked = []
    bot.on('sei:attacked', (p) => attacked.push(p))
    startCombat(bot, cfg())
    mob(bot, 'zombie', 27)

    bot.emit('entityHurt', bot.entity, bot.entities[27])

    expect(defended).toEqual([])
    expect(attacked).toHaveLength(1)
    expect(attacked[0].attackerKind).toBe('hostile_mob')
  })
})
