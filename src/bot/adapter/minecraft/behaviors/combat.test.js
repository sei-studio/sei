// src/bot/adapter/minecraft/behaviors/combat.test.js
//
// 2026-06-19 combat-livelock regression. The entityHurt handler has always
// referenced bot._seiAttackThrottle to coalesce a burst of hits into ONE
// sei:attacked emission, but nothing ever assigned the throttle — so it was
// dead code and every hit emitted (the `else` fallback). Under sustained
// attack that fired sei:attacked every ~250-500ms; each one preempt-aborted
// the in-flight LLM reaction and reseeded the loop faster than Haiku could
// answer, so the bot completed zero reactions and stood frozen + silent while
// taking damage (playlogs bbf5b66f …2026-06-19T01-56 / …T02-19: loops 18-25 /
// 4-12 were nearly all sei:attacked → iterations=0).
//
// startCombat now instantiates the throttle. We drive a player attacker
// because combat.js skips the auto-attack/pathfinder machinery for players
// (REQUIREMENTS: no auto-PvP) — it ONLY emits the throttled sei:attacked, so
// the throttle is exercised in isolation with no mineflayer-pathfinder deps.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { startCombat } from './combat.js'

function makeBot() {
  const bot = new EventEmitter()
  bot.entity = { id: 1, position: { x: 0, y: 0, z: 0 } }
  // A player attacker, kept "live" so resolveAttacker returns it by id.
  const attacker = { id: 2, username: 'Griefer', type: 'player', position: { x: 1, y: 0, z: 0 } }
  bot.entities = { 1: bot.entity, 2: attacker }
  bot._attacker = attacker
  return bot
}

function capture(bot) {
  const events = []
  bot.on('sei:attacked', (p) => events.push(p))
  return events
}

const cfg = (ms) => ({ adapter: { kind: 'minecraft', minecraft: { attack_react_throttle_ms: ms } } })

afterEach(() => {
  vi.useRealTimers()
})

describe('combat.js sei:attacked throttle (livelock fix)', () => {
  it('collapses a burst of hits into ONE sei:attacked within the window', () => {
    vi.useFakeTimers()
    const bot = makeBot()
    const events = capture(bot)
    startCombat(bot, cfg(3500))
    expect(bot._seiAttackThrottle).toBeTruthy() // the throttle is actually wired now

    // A real beating: 8 hits over ~2s — comfortably inside the 3.5s window.
    for (let i = 0; i < 8; i++) {
      bot.emit('entityHurt', bot.entity, bot._attacker)
      vi.advanceTimersByTime(250)
    }
    expect(events).toHaveLength(1) // pre-fix this was 8 — the preempt storm
    expect(events[0].attackerKind).toBe('player')
  })

  it('re-fires once the throttle window elapses (still reacts to ongoing danger)', () => {
    vi.useFakeTimers()
    const bot = makeBot()
    const events = capture(bot)
    startCombat(bot, cfg(3500))

    bot.emit('entityHurt', bot.entity, bot._attacker) // fires immediately (leading edge)
    vi.advanceTimersByTime(4000)                       // window expires
    bot.emit('entityHurt', bot.entity, bot._attacker) // fires again
    expect(events).toHaveLength(2)
  })

  it('window=0 disables the throttle (escape hatch): every hit emits', () => {
    const bot = makeBot()
    const events = capture(bot)
    startCombat(bot, cfg(0))
    expect(bot._seiAttackThrottle).toBeUndefined()

    for (let i = 0; i < 4; i++) bot.emit('entityHurt', bot.entity, bot._attacker)
    expect(events).toHaveLength(4)
  })
})
