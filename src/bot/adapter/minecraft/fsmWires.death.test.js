// src/bot/adapter/minecraft/fsmWires.death.test.js
//
// 260703 (death→brain): the bot used to only log + respawn on death — no event
// ever reached the brain, so the next turn showed full hp / empty inventory with
// no explanation and the model confabulated ("dropped the sword, not my fault").
// These tests lock the new wire: connect.js emits `sei:death` (position snapped
// BEFORE respawn); fsmWires translates it to handlers.onDeath; the adapter's
// eventAddendum frames it for the prompt.

import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { wireBotEvents } from './fsmWires.js'
import { eventAddendum } from './prompts.js'

describe('sei:death wiring (fsmWires → handlers.onDeath)', () => {
  it('translates a bot sei:death emit into handlers.onDeath with the pos payload', () => {
    const bot = new EventEmitter()
    const onDeath = vi.fn()
    const dispose = wireBotEvents(bot, { onDeath })
    bot.emit('sei:death', { pos: { x: -46, y: 71, z: -35 } })
    expect(onDeath).toHaveBeenCalledTimes(1)
    expect(onDeath).toHaveBeenCalledWith({ pos: { x: -46, y: 71, z: -35 } })
    dispose()
  })

  it('passes a null pos through (death position was unreadable)', () => {
    const bot = new EventEmitter()
    const onDeath = vi.fn()
    const dispose = wireBotEvents(bot, { onDeath })
    bot.emit('sei:death', { pos: null })
    expect(onDeath).toHaveBeenCalledWith({ pos: null })
    dispose()
  })

  it('dispose() removes the sei:death listener', () => {
    const bot = new EventEmitter()
    const onDeath = vi.fn()
    const dispose = wireBotEvents(bot, { onDeath })
    dispose()
    bot.emit('sei:death', { pos: { x: 1, y: 2, z: 3 } })
    expect(onDeath).not.toHaveBeenCalled()
  })

  it('a throwing handler does not crash the emitter (listener errors swallowed)', () => {
    const bot = new EventEmitter()
    const dispose = wireBotEvents(bot, { onDeath: () => { throw new Error('boom') } })
    expect(() => bot.emit('sei:death', { pos: null })).not.toThrow()
    dispose()
  })
})

describe('sei:death prompt framing (eventAddendum)', () => {
  it('includes the death framing + coords when the death position is known', () => {
    const t = eventAddendum('sei:death', { pos: { x: -46, y: 71, z: -35 } })
    expect(t).toContain('You DIED')
    expect(t).toContain('-46,71,-35')
    expect(t).toContain('despawns')
    expect(t).toMatch(/recover your items/i)
  })

  it('omits coords when the death position is missing', () => {
    const t = eventAddendum('sei:death', { pos: null })
    expect(t).toContain('You DIED')
    // No "~<coords>" parenthetical when pos is unknown.
    expect(t).not.toMatch(/~-?\d/)
  })

  it('delegates non-death events to the base addendum (idle still works)', () => {
    const t = eventAddendum('sei:idle', { quietMs: 5000 })
    expect(t).toContain('IDLE TICK')
  })
})
