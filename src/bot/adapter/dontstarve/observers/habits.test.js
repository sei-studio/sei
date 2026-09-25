import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { habitPhrase, createHabitLog } from './habits.js'

describe('DST habit log', () => {
  it('phrases every survival habit the mod reports', () => {
    expect(habitPhrase({ what: 'light', did: 'prepared' })).toBe('made a torch for tonight')
    expect(habitPhrase({ what: 'light', did: 'equipped', item: 'torch' })).toBe('held your torch for light')
    expect(habitPhrase({ what: 'light', did: 'built', item: 'campfire' })).toBe('built a campfire for light')
    expect(habitPhrase({ what: 'light', did: 'stowed', item: 'torch' })).toBe('put your torch away')
    expect(habitPhrase({ what: 'fuel', item: 'log', fire: 'campfire' })).toBe('fed the campfire with log')
    expect(habitPhrase({ what: 'equip', items: ['spear', 'armorwood'] })).toBe('equipped spear, armorwood for the fight')
    expect(habitPhrase({ what: 'heal', item: 'healingsalve' })).toBe('used healingsalve to heal')
    expect(habitPhrase({ what: 'ate', item: 'berries' })).toBe('ate berries')
    expect(habitPhrase({ what: 'defend', threat: 'spider', player: 'Steve' })).toBe('went after the spider attacking Steve')
    expect(habitPhrase({ what: 'dark' })).toBeNull()
    expect(habitPhrase({ what: 'equip', items: [] })).toBeNull()
  })

  it('keeps a short recent window and folds repeats', () => {
    const ev = new EventEmitter()
    let t = 0
    const log = createHabitLog(ev, { now: () => t, windowMs: 1000 })
    ev.emit('survival', { what: 'fuel', item: 'log', fire: 'campfire' })
    ev.emit('survival', { what: 'fuel', item: 'log', fire: 'campfire' })
    ev.emit('survival', { what: 'dark' })
    ev.emit('survival', { what: 'ate', item: 'berries' })
    expect(log.recent()).toEqual(['fed the campfire with log (x2)', 'ate berries'])
    t = 2000
    expect(log.recent()).toEqual([])
    ev.emit('survival', { what: 'ate', item: 'carrot' })
    log.dispose()
    ev.emit('survival', { what: 'ate', item: 'meat' })
    expect(log.recent()).toEqual(['ate carrot'])
    log.clear()
    expect(log.recent()).toEqual([])
  })
})
