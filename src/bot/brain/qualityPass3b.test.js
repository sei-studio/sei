// 261012: quality pass 3b. Pins the protect_player and scripted-conversation
// fixes that live outside the combat watch (combat.threat.test.js):
//  - defend-turn wording per event variant (threat, engaged with others, hp)
//  - "no zombie within 16 blocks" now says where the nearest one is
//  - a mob in its death animation is not listed or targeted as alive
//  - hostile lines carry distance from her and from the player
//  - the conversation transcript keeps both sides over the same stretch
//  - a dug count is labelled as blocks broken, not items held

import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { DEFEND_ADDENDUM } from './promptLibrary.js'
import { createConvoMemory, lastTurns } from './convoMemory.js'
import { getInFlightLineForSnapshot } from './inflight.js'
import { fartherNote, attackEntityAction } from '../adapter/minecraft/behaviors/attack.js'
import { trackEntityDeaths, isDeadEntity, nearbyEntities } from '../adapter/minecraft/observers/entities.js'
import { setHandles, resolveEntity, handleForEntity } from '../adapter/minecraft/observers/targeting.js'
import { hostileDistances } from '../adapter/minecraft/observers/snapshot.js'

const vec = (x, y, z) => ({
  x, y, z,
  distanceTo(p) { return Math.hypot(p.x - this.x, p.y - this.y, p.z - this.z) },
})

function world(mobs = []) {
  const bot = new EventEmitter()
  bot.entity = { id: 1, position: vec(0, 64, 0) }
  bot.entities = { 1: bot.entity }
  for (const m of mobs) bot.entities[m.id] = { ...m, position: vec(m.x, 64, m.z ?? 0) }
  // mineflayer's nearestEntity: closest entity (not self) matching the filter.
  bot.nearestEntity = (match) => Object.values(bot.entities)
    .filter((e) => e !== bot.entity && match(e))
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0] ?? null
  return bot
}

afterEach(() => { setHandles([]); vi.useRealTimers() })

describe('DEFEND_ADDENDUM variants', () => {
  it('threat: tells her to attackEntity the closing mob, with both distances and hp', () => {
    const t = DEFEND_ADDENDUM('zombie', { threat: true, ownerLabel: 'Alex', distance: 22, ownerDistance: 9, ownerHp: 10, count: 1 })
    expect(t).toContain('A zombie is closing in on Alex')
    expect(t).toContain('9 blocks from them and 22 blocks from you')
    expect(t).toContain('They are at 10 hp.')
    expect(t).toContain('Call attackEntity on it now')
    expect(t).toContain('follow and goTo never swing')
  })

  it('threat with several mobs says how many', () => {
    const t = DEFEND_ADDENDUM('zombie', { threat: true, ownerLabel: 'Alex', distance: 22, ownerDistance: 9, count: 2 })
    expect(t).toContain('2 hostiles are closing in on Alex')
    expect(t).not.toContain('hp.')
  })

  it('engaged with another mob on the owner asks for a second attackEntity', () => {
    const t = DEFEND_ADDENDUM('zombie', { engaged: true, ownerLabel: 'Alex', distance: 3, othersOnOwner: 1, ownerHp: 6 })
    expect(t).toContain('ALREADY swinging')
    expect(t).toContain('There is 1 more hostile mob on them')
    expect(t).toContain('They are at 6 hp.')
  })

  it('engaged alone at good health keeps the old wording', () => {
    const t = DEFEND_ADDENDUM('zombie', { engaged: true, ownerLabel: 'Alex', distance: 3, othersOnOwner: 0, ownerHp: 18 })
    expect(t).not.toContain('more hostile')
    expect(t).not.toContain('hp.')
  })

  it('has no em-dashes in the new text', () => {
    const t = DEFEND_ADDENDUM('zombie', { threat: true, ownerLabel: 'Alex', distance: 22, ownerDistance: 9, ownerHp: 4, count: 2 })
    expect(t).not.toContain('â€”')
  })
})

describe('attackEntity name lookup past 16 blocks', () => {
  it('points at the nearest one by handle', async () => {
    const bot = world([{ id: 21, name: 'zombie', x: 25 }, { id: 22, name: 'zombie', x: 30 }])
    setHandles([['#3', { kind: 'entity', entityId: 21, expiresAt: Date.now() + 10_000 }]])
    expect(handleForEntity(21)).toBe('#3')
    const r = await attackEntityAction({ entity: 'zombie' }, bot, {})
    expect(r).toBe('no zombie within 16 blocks to attack. The nearest zombie is 25 blocks away at 25,64,0. To go after it, call attackEntity with target "#3"; it runs there on its own.')
  })

  it('falls back to goTo when the mob has no live handle', () => {
    const bot = world([{ id: 21, name: 'zombie', x: 25 }])
    expect(fartherNote('zombie', bot)).toContain('goTo near it first')
  })

  it('says nothing extra when none is within 48 blocks', () => {
    const bot = world([{ id: 21, name: 'zombie', x: 60 }])
    expect(fartherNote('zombie', bot)).toBe('')
  })
})

describe('dead mobs are not alive in the snapshot or targeting', () => {
  it('drops a mob between entityDead and entityGone', () => {
    const bot = world([{ id: 21, name: 'zombie', x: 3 }, { id: 22, name: 'zombie', x: 6 }])
    trackEntityDeaths(bot)
    bot.emit('entityDead', bot.entities[21])
    expect(isDeadEntity(bot, bot.entities[21])).toBe(true)
    const ids = nearbyEntities(bot).entries.map((x) => x.entity.id)
    expect(ids).toEqual([22])
    expect(resolveEntity({ entity: 'zombie' }, bot)?.id).toBe(22)
    bot.emit('entityGone', bot.entities[21])
    expect(isDeadEntity(bot, bot.entities[21])).toBe(false)
  })
})

describe('hostileDistances', () => {
  it('gives distance from her and from the player for hostiles only', () => {
    const me = { position: vec(0, 64, 0) }
    const owner = { position: vec(4, 64, 0) }
    expect(hostileDistances({ name: 'zombie', position: vec(25, 64, 0) }, me, owner, 'Alex')).toBe(' (25 from you, 21 from Alex)')
    expect(hostileDistances({ name: 'cow', position: vec(5, 64, 0) }, me, owner, 'Alex')).toBe('')
  })
})

describe('conversation transcript window', () => {
  it('keeps the newest 24 turns, counting a run of her sentences as one turn', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const m = createConvoMemory().recentChat
    for (let i = 0; i < 15; i++) {
      m.pushPlayer('Alex', `p${i}`)
      vi.advanceTimersByTime(1000)
      m.pushSelf('Sui', `s${i}a`)
      m.pushSelf('Sui', `s${i}b`)
      vi.advanceTimersByTime(1000)
    }
    const lines = m.formatConversationBlock().split('\n').filter((l) => /\] (you|player)/.test(l))
    // 12 player lines and 12 two-sentence answers.
    expect(lines).toHaveLength(36)
    expect(lines[0]).toContain('player (Alex): p3')
    expect(lines[1]).toContain('you: s3a')
    expect(lines.at(-1)).toContain('s14b')
  })

  it('lastTurns never splits a run of her lines', () => {
    const P = (t) => ({ self: false, text: t })
    const S = (t) => ({ self: true, text: t })
    const merged = [P('a'), S('1'), S('2'), S('3'), P('b'), S('4')]
    expect(lastTurns(merged, 2).map((l) => l.text)).toEqual(['b', '4'])
    expect(lastTurns(merged, 3).map((l) => l.text)).toEqual(['1', '2', '3', 'b', '4'])
    expect(lastTurns(merged, 10)).toHaveLength(6)
  })
})

describe('in_flight dug label', () => {
  it('marks a dug count as blocks broken', () => {
    const line = getInFlightLineForSnapshot({ name: 'gather', args: { block: 'oak_log', count: 6 }, startedAt: 0, progress: { dug: 5, total: 6 } }, 2000)
    expect(line).toContain('broke 5 of the 6 blocks asked for so far (what you hold is on your inventory line)')
  })

  it('says placed counts as placed', () => {
    const line = getInFlightLineForSnapshot({ name: 'buildCuboid', args: {}, startedAt: 0, progress: { placed: 3, total: 9, currentY: 65 } }, 2000)
    expect(line).toContain('placed 3 of 9 so far, y=65')
  })
})

describe('DEFEND_ADDENDUM when the running attackEntity is on that mob', () => {
  it('tells her to let it run instead of calling attackEntity again', () => {
    const t = DEFEND_ADDENDUM('zombie', { engaged: true, actionOnIt: true, ownerLabel: 'Alex', distance: 9, othersOnOwner: 1, ownerHp: 7 })
    expect(t).toContain('the mob your attackEntity is already going after')
    expect(t).toContain('Let it run')
    expect(t).not.toContain('ALREADY swinging')
    expect(t).not.toContain('more hostile')
    expect(t).toContain('They are at 7 hp.')
  })
})




