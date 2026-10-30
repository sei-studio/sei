// src/bot/adapter/minecraft/behaviors/deathTracker.test.js
//
// 261019 (quality pass 19): the death is reported in two steps. sei:dying at
// once (so the brain drops the turn the dying body was writing), sei:death
// after the respawn with what she lost.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { trackDeaths, inventoryTally, lostItems } from './deathTracker.js'

function makeBot(items) {
  const bot = new EventEmitter()
  bot.health = 20
  bot.entity = { position: { x: 10.4, y: 64, z: -3.6 } }
  bot._items = items
  bot.inventory = { items: () => bot._items }
  bot.respawn = vi.fn()
  return bot
}

afterEach(() => { vi.useRealTimers() })

describe('inventoryTally / lostItems', () => {
  it('sums stacks by name and diffs largest first', () => {
    const before = inventoryTally(makeBot([{ name: 'bread', count: 3 }, { name: 'bread', count: 2 }, { name: 'stone_sword', count: 1 }, { name: 'dirt', count: 20 }]))
    expect(before.get('bread')).toBe(5)
    const after = new Map([['dirt', 20]])
    expect(lostItems(before, after)).toEqual([{ item: 'bread', n: 5 }, { item: 'stone_sword', n: 1 }])
  })
})

describe('trackDeaths', () => {
  it('emits sei:dying at once and sei:death after the respawn settles, with the lost items', () => {
    vi.useFakeTimers()
    const bot = makeBot([{ name: 'bread', count: 5 }, { name: 'stone_sword', count: 1 }])
    const dying = vi.fn()
    const death = vi.fn()
    bot.on('sei:dying', dying)
    bot.on('sei:death', death)
    const onDeath = vi.fn()
    const dispose = trackDeaths(bot, { logger: {}, onDeath })
    bot.emit('health')
    // The server clears the inventory with the killing blow.
    bot.health = 0
    bot._items = []
    bot.emit('death')
    expect(onDeath).toHaveBeenCalledTimes(1)
    expect(dying).toHaveBeenCalledWith({ pos: { x: 10, y: 64, z: -4 } })
    expect(death).not.toHaveBeenCalled()
    vi.advanceTimersByTime(500)
    expect(bot.respawn).toHaveBeenCalledTimes(1)
    bot.health = 20
    bot.emit('spawn')
    vi.advanceTimersByTime(599)
    expect(death).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(death).toHaveBeenCalledTimes(1)
    const p = death.mock.calls[0][0]
    expect(p.pos).toEqual({ x: 10, y: 64, z: -4 })
    expect(p.lost).toEqual([{ item: 'bread', n: 5 }, { item: 'stone_sword', n: 1 }])
    expect(p.keptAll).toBe(false)
    // 261030 (pass 31): the dropped sword is remembered (weaponSelect lostWeaponUnarmed).
    expect(bot._seiLostWeapon).toMatchObject({ weapon: 'stone_sword' })
    expect(Number.isFinite(p.diedAt)).toBe(true)
    // The fallback timer does not report it a second time.
    vi.advanceTimersByTime(10_000)
    expect(death).toHaveBeenCalledTimes(1)
    dispose()
  })

  it('keepInventory reads as keptAll, with nothing lost', () => {
    vi.useFakeTimers()
    const bot = makeBot([{ name: 'bread', count: 5 }])
    const death = vi.fn()
    bot.on('sei:death', death)
    trackDeaths(bot, { logger: {} })
    bot.health = 0
    bot.emit('death')
    bot.health = 20
    bot.emit('spawn')
    vi.advanceTimersByTime(600)
    expect(death.mock.calls[0][0]).toMatchObject({ lost: [], keptAll: true })
    expect(bot._seiLostWeapon ?? null).toBe(null)
  })

  it('reports anyway when no respawn spawn arrives, and carries a fresh game death message', () => {
    vi.useFakeTimers()
    const bot = makeBot([])
    const death = vi.fn()
    bot.on('sei:death', death)
    trackDeaths(bot, { logger: {}, fallbackMs: 6000 })
    bot.health = 0
    bot._seiOwnDeathText = { text: 'Sui was slain by Zombie', at: Date.now() }
    bot.emit('death')
    vi.advanceTimersByTime(5999)
    expect(death).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(death.mock.calls[0][0]).toMatchObject({ lost: [], keptAll: false, deathText: 'Sui was slain by Zombie' })
  })

  it('a stale game death message is not reused', () => {
    vi.useFakeTimers()
    const bot = makeBot([])
    const death = vi.fn()
    bot.on('sei:death', death)
    trackDeaths(bot, { logger: {} })
    bot._seiOwnDeathText = { text: 'old', at: Date.now() - 60_000 }
    bot.health = 0
    bot.emit('death')
    bot.emit('spawn')
    vi.advanceTimersByTime(600)
    expect(death.mock.calls[0][0].deathText).toBeUndefined()
  })

  it('dispose stops the reporting', () => {
    vi.useFakeTimers()
    const bot = makeBot([])
    const death = vi.fn()
    bot.on('sei:death', death)
    const dispose = trackDeaths(bot, { logger: {} })
    dispose()
    bot.emit('death')
    vi.advanceTimersByTime(10_000)
    expect(death).not.toHaveBeenCalled()
  })
})
