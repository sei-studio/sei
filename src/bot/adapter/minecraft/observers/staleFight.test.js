// 261111 (quality pass 51): stale kill / threat state in free play.
//
// combat_night evals (11-06 to 11-10, 18 runs): she told the player
// "zombie's dead" / "drowned's down" about a second mob of the same kind while
// it was on one of them (her snapshot still said "killed zombie" and nothing
// told the two apart), the "already told the player about this fight" note
// carried over to a new mob after a kill, and 10 turns attacked a mob that
// died while the turn was being written ("i'm hitting it now" about a dead
// spider, then a swing at nothing).

import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { trackEntityDeaths, sameNameDeathAge, isGoneOrDead } from './entities.js'
import { sameNameEventNote, sameFight, staleFightTurn, staleAttackerText } from './staleAttacker.js'
import { composeSnapshot } from './snapshot.js'
import { setHandles } from './targeting.js'
import { goneResult } from '../behaviors/attack.js'

afterEach(() => { vi.useRealTimers() })

const mob = (id, name, x, z = 0) => ({ id, name, type: 'hostile', position: new Vec3(x, 64, z), height: 1.95, isValid: true })

function makeBot(entities = []) {
  const alex = { id: 2, username: 'Alex', type: 'player', position: new Vec3(-3, 64, 0), height: 1.8 }
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0, 64, 0), yaw: 0, pitch: 0, eyeHeight: 1.6 },
    username: 'Sui',
    entities: { 2: alex },
    players: { Alex: { username: 'Alex', entity: alex } },
    _seiOwnerNames: ['alex'],
    inventory: { items: () => [], slots: [] },
    findBlocks: () => [],
    findBlock: () => null,
    blockAt: (p) => ({ name: 'air', shapes: [], position: p }),
    health: 20,
    food: 20,
    game: { dimension: 'overworld' },
    time: { timeOfDay: 14000 },
  })
  bot.nearestEntity = (match) => {
    let best = null
    let bd = Infinity
    for (const e of Object.values(bot.entities)) {
      if (!e || !match(e)) continue
      const d = e.position.distanceTo(bot.entity.position)
      if (d < bd) { bd = d; best = e }
    }
    return best
  }
  for (const e of entities) bot.entities[e.id] = e
  trackEntityDeaths(bot)
  return bot
}

function kill(bot, e) {
  bot.emit('entityDead', e)
  delete bot.entities[e.id]
  bot.emit('entityGone', e)
}

describe('a second mob with the name of one that just died', () => {
  it('is tagged on its nearby-entities line', () => {
    vi.useFakeTimers()
    const first = mob(7, 'zombie', 2)
    const bot = makeBot([first])
    kill(bot, first)
    vi.advanceTimersByTime(12_000)
    const second = mob(8, 'zombie', 1)
    bot.entities[8] = second
    expect(sameNameDeathAge(bot, second)).toBe(12_000)
    const snap = composeSnapshot(bot, { pinUsername: 'Alex' })
    expect(snap).toMatch(/ zombie @1,64,0 \(1 from you, 4 from Alex; not the zombie that died 12s ago\)/)
    expect(snap.split('\n').find((l) => l.includes('not the zombie'))).not.toMatch(/—/)
  })

  it('is not tagged without a recent death of that kind, or after 60s', () => {
    vi.useFakeTimers()
    const spider = mob(5, 'spider', 3)
    const bot = makeBot([spider])
    kill(bot, spider)
    const z = mob(8, 'zombie', 1)
    bot.entities[8] = z
    expect(composeSnapshot(bot, { pinUsername: 'Alex' })).toMatch(/ zombie @1,64,0 \(1 from you, 4 from Alex\)\n/)
    const first = mob(7, 'zombie', 2)
    bot.entities[7] = first
    kill(bot, first)
    vi.advanceTimersByTime(61_000)
    expect(sameNameDeathAge(bot, z)).toBeNull()
  })

  it('a mob that only left (no death) does not tag the next one', () => {
    const first = mob(7, 'zombie', 2)
    const bot = makeBot([first])
    delete bot.entities[7]
    bot.emit('entityGone', first)
    const second = mob(8, 'zombie', 1)
    bot.entities[8] = second
    expect(sameNameDeathAge(bot, second)).toBeNull()
  })

  it('a hit or defend event about it says it is a different one', () => {
    vi.useFakeTimers()
    const first = mob(7, 'drowned', 2)
    const bot = makeBot([first])
    kill(bot, first)
    vi.advanceTimersByTime(17_000)
    const second = mob(9, 'drowned', 7)
    bot.entities[9] = second
    const data = { attacker: second, attackerLabel: 'drowned', attackerKind: 'defend', ownerLabel: 'Alex', engaged: true }
    expect(sameNameEventNote(bot, 'sei:attacked', data)).toBe(' This drowned is a different one from the drowned that died 17s ago.')
    // Survival heads-ups and player hits carry no such note.
    expect(sameNameEventNote(bot, 'sei:attacked', { ...data, survivalKind: 'drowning' })).toBe('')
    expect(sameNameEventNote(bot, 'sei:chat_received', data)).toBe('')
  })
})

describe('sameFight: the fight her last fight line was about', () => {
  it('is over once that mob died, so a new mob is a new fight', () => {
    const first = mob(7, 'drowned', 2)
    const second = mob(9, 'drowned', 7)
    const bot = makeBot([first, second])
    expect(sameFight(bot, 7, { attacker: first })).toBe(true)
    // Two at once: the first is still around, so it is the same fight.
    expect(sameFight(bot, 7, { attacker: second })).toBe(true)
    kill(bot, first)
    expect(isGoneOrDead(bot, 7)).toBe(true)
    expect(sameFight(bot, 7, { attacker: second })).toBe(false)
    // Unknown ids keep the old answer.
    expect(sameFight(bot, null, { attacker: second })).toBe(true)
    expect(sameFight(bot, 7, {})).toBe(true)
  })
})

describe('staleFightTurn: an attack on a mob that died while the turn was written', () => {
  const attack = (input) => [{ id: 's', name: 'say', input: { text: "i'm hitting it now" } }, { id: 'a', name: 'attackEntity', input }]

  it('is stale when the named mob died after the snapshot and no other is in range', () => {
    vi.useFakeTimers()
    const spider = mob(5, 'spider', 2)
    const bot = makeBot([spider])
    const since = Date.now()
    vi.advanceTimersByTime(800)
    kill(bot, spider)
    vi.advanceTimersByTime(700)
    expect(staleFightTurn(bot, attack({ entity: 'spider', times: 10 }), since)).toEqual({
      reason: 'the spider you went for died 1s ago',
    })
    // `target` used as a name works the same way.
    expect(staleFightTurn(bot, attack({ target: 'spider' }), since)).not.toBeNull()
  })

  it('is not stale when the mob died before the snapshot was taken', () => {
    vi.useFakeTimers()
    const spider = mob(5, 'spider', 2)
    const bot = makeBot([spider])
    kill(bot, spider)
    vi.advanceTimersByTime(3000)
    expect(staleFightTurn(bot, attack({ entity: 'spider' }), Date.now() - 1000)).toBeNull()
  })

  it('is not stale while another mob of that name is in range', () => {
    vi.useFakeTimers()
    const z1 = mob(7, 'zombie', 2)
    const z2 = mob(8, 'zombie', 5)
    const bot = makeBot([z1, z2])
    const since = Date.now()
    kill(bot, z1)
    expect(staleFightTurn(bot, attack({ entity: 'zombie' }), since)).toBeNull()
  })

  it('a #handle to a mob that died during the call is stale; a turn with no attack never is', () => {
    vi.useFakeTimers()
    const z = mob(7, 'zombie', 2)
    const bot = makeBot([z])
    setHandles([['#11', { kind: 'entity', entityId: 7, expiresAt: Date.now() + 60_000 }]])
    const since = Date.now()
    vi.advanceTimersByTime(500)
    kill(bot, z)
    expect(staleFightTurn(bot, attack({ target: '#11' }), since)).toEqual({ reason: 'the zombie you went for died 1s ago' })
    expect(staleFightTurn(bot, [{ id: 's', name: 'say', input: { text: 'hi' } }], since)).toBeNull()
  })

  it('find() for a mob that died during the call is stale; a block name or a live mob of that name is not', () => {
    vi.useFakeTimers()
    const spider = mob(5, 'spider', 4)
    const far = mob(6, 'zombie', 40)
    const bot = makeBot([spider, far])
    const since = Date.now()
    vi.advanceTimersByTime(600)
    kill(bot, spider)
    const findTurn = (name) => [{ id: 's', name: 'say', input: { text: 'on it' } }, { id: 'f', name: 'find', input: { name } }]
    expect(staleFightTurn(bot, findTurn('spider'), since)).toEqual({ reason: 'the spider you went for died 1s ago' })
    expect(staleFightTurn(bot, findTurn('oak_log'), since)).toBeNull()
    expect(staleFightTurn(bot, findTurn('zombie'), since)).toBeNull()
    bot.entities[9] = mob(9, 'spider', 30)
    expect(staleFightTurn(bot, findTurn('spider'), since)).toBeNull()
  })

  it('a creeper that blew up during the call reads as gone, not dead', () => {
    vi.useFakeTimers()
    const c = mob(4, 'creeper', 3)
    const bot = makeBot([c])
    const since = Date.now()
    vi.advanceTimersByTime(1200)
    delete bot.entities[4]
    bot.emit('entityGone', c)
    expect(staleFightTurn(bot, attack({ entity: 'creeper' }), since)).toEqual({
      reason: 'the creeper you went for left 1s ago (it most likely exploded)',
    })
  })
})

describe('creeper results agree with the event text', () => {
  it('a creeper lost mid-fight most likely exploded', () => {
    expect(goneResult('creeper', 1, false)).toBe('1 hits on creeper, then lost sight of creeper: it most likely exploded, so it is gone')
    expect(goneResult('zombie', 1, false)).toMatch(/NOT confirmed dead/)
    expect(goneResult('creeper', 2, true)).toBe('killed creeper (2 hits)')
  })

  it('the stale-attacker text for a gone creeper still says it most likely exploded', () => {
    const c = mob(4, 'creeper', 3)
    const bot = makeBot([c])
    delete bot.entities[4]
    bot.emit('entityGone', c)
    c.isValid = false
    expect(staleAttackerText(bot, 'sei:attacked', { attacker: c, attackerLabel: 'creeper', attackerKind: 'mob' })).toMatch(/most likely exploded/)
  })
})
