// 261019 (pass 18): an attack event whose mob died or left view before the
// turn is written gets plain "it is gone" text, not "attack it now".

import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { trackEntityDeaths, msSinceDeath, recentLossByName } from './entities.js'
import { staleAttackerText } from './staleAttacker.js'
import { justDiedNote, attackEntityAction } from '../behaviors/attack.js'

function makeBot() {
  const bot = new EventEmitter()
  bot.entity = { position: new Vec3(0, 64, 0) }
  bot.entities = {}
  trackEntityDeaths(bot)
  return bot
}
const zombie = (id = 7, x = 2) => ({ id, name: 'zombie', type: 'hostile', position: new Vec3(x, 64, 0), isValid: true })

afterEach(() => { vi.useRealTimers() })

describe('recent deaths (entities.js)', () => {
  it('keeps a death after the corpse is gone, and forgets it after 60s', () => {
    vi.useFakeTimers()
    const bot = makeBot()
    const z = zombie()
    bot.emit('entityDead', z)
    bot.emit('entityGone', z)
    expect(bot._seiDeadEntityIds.has(7)).toBe(false)
    vi.advanceTimersByTime(2000)
    expect(msSinceDeath(bot, 7)).toBe(2000)
    expect(recentLossByName(bot, 'Zombie')).toEqual({ id: 7, age: 2000, died: true })
    expect(recentLossByName(bot, 'skeleton')).toBeNull()
    vi.advanceTimersByTime(9000)
    expect(recentLossByName(bot, 'zombie')).toBeNull() // past the 10s name window
    vi.advanceTimersByTime(20000)
    expect(msSinceDeath(bot, 7)).toBe(31000) // 261111 (pass 51): kept 60s
    vi.advanceTimersByTime(30000)
    expect(msSinceDeath(bot, 7)).toBeNull()
  })

  it('a mob that left without dying is kept as gone, not dead', () => {
    const bot = makeBot()
    const c = { id: 9, name: 'creeper', type: 'hostile', position: new Vec3(3, 64, 0) }
    bot.emit('entityGone', c)
    expect(msSinceDeath(bot, 9)).toBeNull()
    expect(recentLossByName(bot, 'creeper')).toMatchObject({ id: 9, died: false })
    bot.emit('entityGone', { id: 10, name: 'item', type: 'object', position: new Vec3(1, 64, 0) })
    expect(recentLossByName(bot, 'item')).toBeNull()
    // minecraft-data 1.21 types: items are 'other', arrows 'projectile'.
    bot.emit('entityGone', { id: 11, name: 'item', type: 'other', position: new Vec3(1, 64, 0) })
    bot.emit('entityGone', { id: 12, name: 'arrow', type: 'projectile', position: new Vec3(1, 64, 0) })
    expect(recentLossByName(bot, 'item')).toBeNull()
    expect(recentLossByName(bot, 'arrow')).toBeNull()
    expect(bot._seiRecentLosses.size).toBe(1)
  })

  it('a death far from her does not count for the name lookup', () => {
    const bot = makeBot()
    bot.emit('entityDead', zombie(8, 40))
    expect(recentLossByName(bot, 'zombie')).toBeNull()
  })
})

describe('staleAttackerText', () => {
  it('replaces a defend threat event whose mob has died', () => {
    const bot = makeBot()
    const z = zombie()
    bot.entities[7] = z
    const data = { attacker: z, attackerLabel: 'zombie', attackerKind: 'defend', threat: true, ownerLabel: 'Alex' }
    expect(staleAttackerText(bot, 'sei:attacked', data)).toBeNull()
    bot.emit('entityDead', z)
    const t = staleAttackerText(bot, 'sei:attacked', data)
    expect(t).toBe('A zombie went for Alex a moment ago, and it has died since then, so there is nothing to attack for it. Check nearby entities in your snapshot for anything still there before you act, and if you speak, talk about how things are now.')
    expect(t).not.toMatch(/—/)
  })

  it('says "you" for a hit on her, and "out of sight" when the mob left without dying', () => {
    const bot = makeBot()
    const z = zombie()
    z.isValid = false
    const t = staleAttackerText(bot, 'sei:attacked', { attacker: z, attackerLabel: 'zombie', attackerKind: 'mob' })
    expect(t).toBe('A zombie went for you a moment ago, and it is not there anymore (it despawned or moved out of range), so there is nothing to attack for it. Check nearby entities in your snapshot for anything still there before you act, and if you speak, talk about how things are now.')
  })

  it('a creeper heads-up after it blew up says it most likely exploded', () => {
    const bot = makeBot()
    const c = { id: 9, name: 'creeper', type: 'hostile', position: new Vec3(3, 64, 0), isValid: true }
    const data = { attacker: c, attackerLabel: 'creeper', attackerKind: 'reflex', noticed: true, count: 1 }
    expect(staleAttackerText(bot, 'sei:attacked', data)).toBeNull()
    bot.emit('entityGone', c)
    c.isValid = false
    expect(staleAttackerText(bot, 'sei:attacked', data)).toMatch(/^A creeper went for you a moment ago, and it is not there anymore \(it most likely exploded\)/)
  })

  it('still works after the corpse left the entity table', () => {
    const bot = makeBot()
    const z = zombie()
    bot.emit('entityDead', z)
    bot.emit('entityGone', z)
    z.isValid = false
    expect(staleAttackerText(bot, 'sei:attacked', { attacker: z, attackerLabel: 'zombie', attackerKind: 'mob' })).toMatch(/has died since then/)
  })

  it('leaves live mobs, players, survival takeovers and other events alone', () => {
    const bot = makeBot()
    const z = zombie()
    expect(staleAttackerText(bot, 'sei:attacked', { attacker: z, attackerKind: 'mob' })).toBeNull()
    const p = { id: 3, username: 'Alex', type: 'player', isValid: false }
    expect(staleAttackerText(bot, 'sei:attacked', { attacker: p, attackerKind: 'player' })).toBeNull()
    z.isValid = false
    expect(staleAttackerText(bot, 'sei:attacked', { attacker: z, attackerKind: 'reflex', survivalKind: 'critical_retreat' })).toBeNull()
    expect(staleAttackerText(bot, 'sei:idle', { attacker: z, attackerKind: 'mob' })).toBeNull()
    expect(staleAttackerText(bot, 'sei:attacked', { attacker: null, attackerKind: 'mob' })).toBeNull()
  })
})

describe('attackEntity no-target result names a mob that just died (261019)', () => {
  it('says the zombie near her died moments ago', async () => {
    const bot = makeBot()
    bot.emit('entityDead', zombie())
    bot.nearestEntity = () => null
    expect(justDiedNote('zombie', bot)).toBe(': the zombie that was near you died 1s ago, before this call, so that fight is already over')
    const r = await attackEntityAction({ entity: 'zombie' }, bot, {})
    expect(r).toBe('no zombie within 16 blocks to attack: the zombie that was near you died 1s ago, before this call, so that fight is already over')
  })

  it('says a creeper near her most likely exploded', async () => {
    const bot = makeBot()
    bot.emit('entityGone', { id: 9, name: 'creeper', type: 'hostile', position: new Vec3(3, 64, 0) })
    bot.nearestEntity = () => null
    expect(await attackEntityAction({ entity: 'creeper' }, bot, {})).toBe('no creeper within 16 blocks to attack: the creeper that was near you disappeared 1s ago, before this call (it most likely exploded), so there is nothing there to hit')
  })

  it('is unchanged when nothing of that name died', async () => {
    const bot = makeBot()
    bot.nearestEntity = () => null
    expect(await attackEntityAction({ entity: 'zombie' }, bot, {})).toBe('no zombie within 16 blocks to attack')
  })
})

// 261019 (pass 18): the snapshot names the attackEntity refusal threshold
// at low health, so she does not call it again right after a refusal.
import { composeSnapshot } from './snapshot.js'

describe('snapshot low-health line (261019)', () => {
  function snapBot(health) {
    return Object.assign(new EventEmitter(), {
      entity: { position: new Vec3(0, 64, 0), yaw: 0, pitch: 0 },
      username: 'Sei',
      entities: {},
      players: {},
      inventory: { items: () => [], slots: [] },
      findBlocks: () => [],
      findBlock: () => null,
      blockAt: (p) => ({ name: 'air', shapes: [], position: p }),
      health,
      food: 20,
      game: { dimension: 'overworld' },
      time: { timeOfDay: 1000 },
    })
  }

  it('appears at 6 hp or less and not above', () => {
    const low = composeSnapshot(snapBot(5), {})
    expect(low).toContain('low health: attackEntity will not start a mob fight at 6 hp or less.')
    expect(low.split('\n').find((l) => l.startsWith('low health:'))).not.toMatch(/—/)
    expect(composeSnapshot(snapBot(7), {})).not.toContain('low health:')
    expect(composeSnapshot(snapBot(0), {})).not.toContain('low health:')
  })
})
