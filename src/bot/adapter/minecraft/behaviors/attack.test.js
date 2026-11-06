// weakWeaponNote (260708) — when a mob survives the batch and the bot is not
// holding a real weapon, the result string must say so and point at the right
// fix: equip the weapon already in the inventory if one exists, otherwise
// craft one (Lyra fought a zombie and a skeleton with a stick while the player
// died twice; nothing ever told the model the stick was the problem).

import { describe, it, expect, vi } from 'vitest'
import { Vec3 } from 'vec3'
import { weakWeaponNote, attackEntityAction, goneResult, CRITICAL_HP, continueAttack, fightHealthNote, attackRunState, attackInFlightSuffix, withAttackRunState } from './attack.js'
import { DEFEND_ADDENDUM } from '../../../brain/promptLibrary.js'

function makeBot({ held = null, items = [] } = {}) {
  return {
    heldItem: held ? { name: held } : null,
    inventory: { items: () => items.map(name => ({ name })) },
  }
}

describe('weakWeaponNote', () => {
  it('is silent when a real weapon is held', () => {
    expect(weakWeaponNote(makeBot({ held: 'wooden_sword' }))).toBe('')
    expect(weakWeaponNote(makeBot({ held: 'iron_axe' }))).toBe('')
  })

  it('a pickaxe is NOT a weapon (the _axe match must not catch it)', () => {
    const n = weakWeaponNote(makeBot({ held: 'wooden_pickaxe' }))
    expect(n).toContain('wooden_pickaxe')
    expect(n).toContain('slow')
  })

  it('points at the inventory weapon when one exists but is not equipped', () => {
    const n = weakWeaponNote(makeBot({ held: 'stick', items: ['oak_planks', 'stone_sword'] }))
    expect(n).toContain("fighting with stick")
    expect(n).toContain('equip your stone_sword')
  })

  it('suggests crafting when no weapon exists anywhere', () => {
    const n = weakWeaponNote(makeBot({ held: 'stick', items: ['oak_planks'] }))
    expect(n).toContain('craft a weapon')
  })

  it('handles empty hands and a missing inventory', () => {
    const n = weakWeaponNote({ heldItem: null })
    expect(n).toContain('bare hands')
    expect(n).toContain('craft a weapon')
  })
})

// 261011 quality pass 2: critical health and the weapon staying in hand.
function fightBot({ health = 20, held = 'stone_sword', items = ['stone_sword', 'bread'] } = {}) {
  const zombie = { id: 7, name: 'zombie', type: 'hostile', position: new Vec3(1, 64, 0), height: 1.95 }
  const bot = {
    health,
    entity: { position: new Vec3(0, 64, 0) },
    entities: { 7: zombie },
    heldItem: held ? { name: held } : null,
    inventory: { items: () => items.map((name) => ({ name })) },
    lookAt: vi.fn(),
    swingArm: vi.fn(),
    attack: vi.fn(),
    equip: vi.fn(async (item) => { bot.heldItem = { name: item.name } }),
  }
  return bot
}

describe('attackEntity at critical health (261011)', () => {
  it('does not start a mob fight at critical health, and says what to do instead', async () => {
    const bot = fightBot({ health: CRITICAL_HP - 2 })
    const r = await attackEntityAction({ entity_id: 7, times: 3 }, bot, {})
    expect(r).toMatch(/^did not attack zombie: you are at 4 health/)
    expect(r).toMatch(/Get away first/)
    expect(bot.attack).not.toHaveBeenCalled()
  })

  it('stops trading hits once the fight brings her to critical health', async () => {
    const bot = fightBot()
    bot.attack.mockImplementation(() => { bot.health = 5 })
    const r = await attackEntityAction({ entity_id: 7, times: 3 }, bot, {})
    expect(bot.attack).toHaveBeenCalledTimes(1)
    expect(r).toMatch(/^1\/3 hits on zombie, then stopped: you are down to 5 health/)
  })

  it('puts the weapon back before the next swing when the hand changed mid-fight', async () => {
    const bot = fightBot()
    bot.attack.mockImplementationOnce(() => { bot.heldItem = { name: 'bread' } })
    await attackEntityAction({ entity_id: 7, times: 2 }, bot, {})
    expect(bot.attack).toHaveBeenCalledTimes(2)
    expect(bot.equip).toHaveBeenCalledTimes(1)
    expect(bot.equip.mock.calls[0][0].name).toBe('stone_sword')
  })
})

// 261011 quality pass 2: a mob leaving the entity table is not a kill.
describe('attackEntity reports death only on the death event (261011)', () => {
  function withEvents(bot) {
    const handlers = {}
    bot.on = vi.fn((ev, fn) => { (handlers[ev] ??= []).push(fn) })
    bot.removeListener = vi.fn((ev, fn) => { handlers[ev] = (handlers[ev] ?? []).filter((h) => h !== fn) })
    bot.emit = (ev, arg) => (handlers[ev] ?? []).forEach((h) => h(arg))
    bot.handlers = handlers
    return bot
  }

  it('says killed when the server reported the death', async () => {
    const bot = withEvents(fightBot())
    bot.attack.mockImplementation(() => { bot.emit('entityDead', { id: 7 }); delete bot.entities[7] })
    const r = await attackEntityAction({ entity_id: 7, times: 3 }, bot, {})
    expect(r).toBe('killed zombie (1 hits). Nothing hurt you in this fight: you are at 20/20 health.')
    expect(bot.handlers.entityDead).toHaveLength(0) // listener removed
  })

  it('says lost sight, not killed, when the mob just left the entity table', async () => {
    const bot = withEvents(fightBot())
    bot.attack.mockImplementation(() => { delete bot.entities[7] })
    const r = await attackEntityAction({ entity_id: 7, times: 3 }, bot, {})
    expect(r).toMatch(/^1 hits on zombie, then lost sight of zombie: .*NOT confirmed dead/)
    expect(r).not.toMatch(/killed/)
  })

  it('stops swinging once the death event arrives, while the corpse is still listed', async () => {
    const bot = withEvents(fightBot())
    bot.attack.mockImplementation(() => { bot.emit('entityDead', { id: 7 }) }) // entity stays in the table
    const r = await attackEntityAction({ entity_id: 7, times: 3 }, bot, {})
    expect(bot.attack).toHaveBeenCalledTimes(1)
    expect(r).toBe('killed zombie (1 hits). Nothing hurt you in this fight: you are at 20/20 health.')
  })

  it('counts a kill on the last swing', async () => {
    const bot = withEvents(fightBot())
    bot.attack.mockImplementation(() => { setTimeout(() => { bot.emit('entityDead', { id: 7 }) }, 50) })
    const r = await attackEntityAction({ entity_id: 7, times: 1 }, bot, {})
    expect(r).toBe('killed zombie (1 hits). Nothing hurt you in this fight: you are at 20/20 health.')
  })

  it('names the mob when none is in range', async () => {
    const bot = withEvents(fightBot())
    bot.entities = {}
    bot.nearestEntity = () => null
    expect(await attackEntityAction({ entity: 'zombie' }, bot, {})).toBe('no zombie within 16 blocks to attack')
  })

  it('goneResult wording', () => {
    expect(goneResult('skeleton', 0, true)).toBe('skeleton died before you hit it')
    expect(goneResult('skeleton', 0, false)).toMatch(/^lost sight of skeleton/)
  })
})

// 261012: the chase re-installs its goal when another behavior replaced or
// cleared it (combat.js's defend exit called pathfinder.stop(), and the chase,
// which set its goal only once, stood still until its timeout).
describe('attackEntity pursuit keeps its goal (261012)', () => {
  it('re-installs the follow goal after something else cleared it', async () => {
    const bot = fightBot()
    bot.entities[7].position = new Vec3(10, 64, 0)
    const set = []
    bot.pathfinder = {
      goal: null,
      setGoal: vi.fn((g) => { bot.pathfinder.goal = g; if (g) set.push(g) }),
      setMovements: vi.fn(),
      stop: vi.fn(),
    }
    bot.setControlState = vi.fn()
    // First goal: wiped a moment later, as pathfinder.stop() would. Second
    // goal: the mob is then "reached".
    const p = attackEntityAction({ entity_id: 7, times: 1, timeout_ms: 3000 }, bot, {})
    await new Promise((r) => setTimeout(r, 150))
    expect(set).toHaveLength(1)
    bot.pathfinder.goal = null
    await new Promise((r) => setTimeout(r, 250))
    expect(set.length).toBeGreaterThanOrEqual(2)
    bot.entities[7].position = new Vec3(1, 64, 0)
    expect(await p).toMatch(/attacked zombie 1×|killed|zombie/)
  })
})

// 261019 (pass 18): a repeat attackEntity on the mob the running attack is
// fighting extends that attack instead of restarting it.
describe('continueAttack (261019)', () => {
  const running = { name: 'attackEntity', input: { entity: 'zombie', times: 2 } }
  const again = (input) => ({ name: 'attackEntity', input })
  // A name lookup like the live bot's: nearest matching entity.
  const withLookup = (bot) => {
    bot.nearestEntity = (match) => Object.values(bot.entities)
      .filter((e) => match(e))
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0] ?? null
    return bot
  }

  it('is null when no attack is running', () => {
    const bot = withLookup(fightBot())
    expect(continueAttack(bot, running, again({ entity: 'zombie' }))).toBeNull()
  })

  it('extends the swing budget of the running fight and says so', async () => {
    const bot = withLookup(fightBot())
    let reply
    // The repeat call lands between swings, as a model turn would.
    bot.attack.mockImplementationOnce(() => setTimeout(() => {
      reply = continueAttack(bot, running, again({ entity: 'zombie', times: 3 }))
    }, 50))
    const r = await attackEntityAction({ entity_id: 7, times: 2 }, bot, {})
    expect(reply).toMatch(/^your attackEntity is already on that zombie \(1 swing so far\), so it keeps going with up to 3 more/)
    // 1 swing before the repeat call + 3 more, not the original 2.
    expect(bot.attack).toHaveBeenCalledTimes(4)
    expect(r).toMatch(/attacked zombie 4×/)
    // Closed once the action returns.
    expect(continueAttack(bot, running, again({ entity: 'zombie' }))).toBeNull()
  })

  it('never shrinks the budget', async () => {
    const bot = withLookup(fightBot())
    bot.attack.mockImplementationOnce(() => setTimeout(() => {
      continueAttack(bot, running, again({ entity: 'zombie', times: 1 }))
    }, 50))
    await attackEntityAction({ entity_id: 7, times: 3 }, bot, {})
    expect(bot.attack).toHaveBeenCalledTimes(3)
  })

  it('does not take over a call on another mob, another id, or another action', async () => {
    const bot = withLookup(fightBot())
    const seen = []
    bot.attack.mockImplementationOnce(() => setTimeout(() => {
      seen.push(continueAttack(bot, running, again({ entity: 'skeleton' })))
      seen.push(continueAttack(bot, running, again({ entity_id: 99 })))
      seen.push(continueAttack(bot, running, again({})))
      seen.push(continueAttack(bot, { name: 'gather' }, again({ entity: 'zombie' })))
      seen.push(continueAttack(bot, running, { name: 'goTo', input: {} }))
      seen.push(continueAttack(bot, running, again({ entity_id: 7 })))
    }, 50))
    await attackEntityAction({ entity_id: 7, times: 2 }, bot, {})
    expect(seen.slice(0, 5)).toEqual([null, null, null, null, null])
    expect(seen[5]).toMatch(/already on that zombie/)
  })

  it('does not take over once the mob is dead', async () => {
    const bot = withLookup(fightBot())
    const handlers = {}
    bot.on = (ev, fn) => { (handlers[ev] ??= []).push(fn) }
    bot.removeListener = (ev, fn) => { handlers[ev] = (handlers[ev] ?? []).filter((h) => h !== fn) }
    let after
    bot.attack.mockImplementationOnce(() => {
      for (const h of handlers.entityDead ?? []) h({ id: 7 })
      after = continueAttack(bot, running, again({ entity: 'zombie' }))
    })
    await attackEntityAction({ entity_id: 7, times: 3 }, bot, {})
    expect(after).toBeNull()
  })

  it('repeat calls never carry one attack past three timeout windows', async () => {
    const bot = withLookup(fightBot())
    const replies = []
    // Every swing is followed by a repeat call asking for 10 more.
    bot.attack.mockImplementation(() => {
      replies.push(continueAttack(bot, running, again({ entity: 'zombie', times: 10 })))
    })
    const t0 = Date.now()
    const r = await attackEntityAction({ entity_id: 7, times: 2, timeout_ms: 700 }, bot, {})
    const ms = Date.now() - t0
    // Hard cap 3 x 700 ms; the last swing check lands one swing delay after it at most.
    expect(ms).toBeLessThan(3 * 700 + 700)
    expect(r).toMatch(/^timeout after \d+\/\d+ hits on zombie/)
    expect(bot.attack.mock.calls.length).toBeLessThanOrEqual(4)
    // Near the cap the repeat call is not folded in (it starts a fresh attack).
    expect(replies.at(-1)).toBeNull()
  }, 10_000)

  it('does not take over an attack that is being aborted', async () => {
    const bot = withLookup(fightBot())
    const ac = new AbortController()
    let after
    bot.attack.mockImplementationOnce(() => {
      ac.abort()
      after = continueAttack(bot, running, again({ entity: 'zombie' }))
    })
    const r = await attackEntityAction({ entity_id: 7, times: 3 }, bot, { signal: ac.signal })
    expect(after).toBeNull()
    expect(r).toMatch(/^aborted after 1\/\d+ hits on zombie/)
  })

  it('a name that now points at another mob (the one on the player) still switches', async () => {
    const bot = withLookup(fightBot())
    bot.entities[9] = { id: 9, name: 'zombie', type: 'hostile', position: new Vec3(10, 64, 0), height: 1.95 }
    bot._seiOwnerNames = ['alex']
    bot.players = { Alex: { entity: { username: 'Alex', position: new Vec3(11, 64, 0) } } }
    const seen = []
    bot.attack.mockImplementationOnce(() => setTimeout(() => {
      seen.push(continueAttack(bot, running, again({ entity: 'zombie' })))
      seen.push(continueAttack(bot, running, again({ entity_id: 7 })))
    }, 50))
    await attackEntityAction({ entity_id: 7, times: 2 }, bot, {})
    expect(seen[0]).toBeNull()
    expect(seen[1]).toMatch(/already on that zombie/)
  })
})

// 261022 (pass 24): a finished mob fight says what it cost her, so "got hit a
// little" at 20/20 health has the result itself against it.
describe('attackEntity says what the fight cost her (261022)', () => {
  function withEvents(bot) {
    const handlers = {}
    bot.on = vi.fn((ev, fn) => { (handlers[ev] ??= []).push(fn) })
    bot.removeListener = vi.fn((ev, fn) => { handlers[ev] = (handlers[ev] ?? []).filter((h) => h !== fn) })
    bot.emit = (ev, arg) => (handlers[ev] ?? []).forEach((h) => h(arg))
    bot.handlers = handlers
    return bot
  }

  it('fightHealthNote wording', () => {
    expect(fightHealthNote(0, 20)).toBe('Nothing hurt you in this fight: you are at 20/20 health.')
    expect(fightHealthNote(3, 17)).toBe('You took 3 damage in this fight and are at 17/20 health.')
    expect(fightHealthNote(1.5, 18.5)).toBe('You took 1.5 damage in this fight and are at 18.5/20 health.')
    expect(fightHealthNote(0, undefined)).toBe('')
    expect(fightHealthNote(0, 20, 20)).toBe('Nothing hurt you in this fight: you are at 20/20 health.')
    expect(fightHealthNote(0, 16, 16)).toBe('Nothing hurt you in this fight. You were already at 16/20 health when it started, and you are at 16/20 now.')
    expect(fightHealthNote(2, 14, 16)).toBe('You took 2 damage in this fight and are at 14/20 health.')
  })

  it('says she was already hurt when the fight began, instead of only "nothing hurt you" at 16/20', async () => {
    // The usual order: a zombie hits her (sei:attacked), then she calls attackEntity.
    const bot = withEvents(fightBot({ health: 16 }))
    bot.attack.mockImplementation(() => { bot.emit('entityDead', { id: 7 }); delete bot.entities[7] })
    const r = await attackEntityAction({ entity_id: 7, times: 3 }, bot, {})
    expect(r).toBe('killed zombie (1 hits). Nothing hurt you in this fight. You were already at 16/20 health when it started, and you are at 16/20 now.')
  })

  it('leaves the note off when she died during the action (the respawn is back at 20)', async () => {
    const bot = withEvents(fightBot({ health: 10 }))
    let n = 0
    bot.attack.mockImplementation(() => {
      n++
      if (n === 1) { bot.health = 0; bot.emit('health'); bot.health = 20; bot.emit('health'); bot.emit('entityDead', { id: 7 }); delete bot.entities[7] }
    })
    const r = await attackEntityAction({ entity_id: 7, times: 3 }, bot, {})
    expect(r).toBe('killed zombie (1 hits)')
    expect(r).not.toMatch(/in this fight/)
  })

  it('counts a hit even when she regenerated back to full before the end', async () => {
    const bot = withEvents(fightBot())
    let n = 0
    bot.attack.mockImplementation(() => {
      n++
      if (n === 1) { bot.health = 16; bot.emit('health') }
      if (n === 2) { bot.health = 20; bot.emit('health'); bot.emit('entityDead', { id: 7 }) }
    })
    const r = await attackEntityAction({ entity_id: 7, times: 3 }, bot, {})
    expect(r).toBe('killed zombie (2 hits). You took 4 damage in this fight and are at 20/20 health.')
    expect(bot.handlers.health).toHaveLength(0) // listener removed
  })

  it('leaves the note off the critical-health stop, which already names her health', async () => {
    const bot = withEvents(fightBot())
    bot.attack.mockImplementation(() => { bot.health = 5; bot.emit('health') })
    const r = await attackEntityAction({ entity_id: 7, times: 3 }, bot, {})
    expect(r).not.toMatch(/in this fight/)
  })

  it('leaves the note off a spar with a player', async () => {
    const bot = withEvents(fightBot())
    bot._seiPvp = true
    bot.entities[7] = { id: 7, type: 'player', username: 'Alex', position: new Vec3(1, 64, 0), height: 1.8 }
    const r = await attackEntityAction({ entity_id: 7, times: 1 }, bot, {})
    expect(r).not.toMatch(/in this fight/)
  })
})

// 261106 (quality pass 44): what a turn sees while attackEntity runs. In the
// combat_night eval the mob the attack was on stood in the river (hidden by
// the sight filter), and she told the player "zombies are down" and called
// goTo, which ended the fight.
describe('the running attack, as the turn sees it (261106)', () => {
  const running = { name: 'attackEntity', input: { entity: 'zombie', times: 8 } }
  const again = (input) => ({ name: 'attackEntity', input })
  // Two zombies: 7 in reach of her, 9 by the player. She and Alex stand close.
  const twoZombies = () => {
    const bot = fightBot()
    bot.entities[9] = { id: 9, name: 'zombie', type: 'hostile', position: new Vec3(3.5, 64, 1), height: 1.95 }
    bot._seiOwnerNames = ['alex']
    bot.players = { Alex: { entity: { username: 'Alex', position: new Vec3(3, 64, 0) } } }
    bot.nearestEntity = (match) => Object.values(bot.entities)
      .filter((e) => match(e))
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0] ?? null
    return bot
  }
  // Run the attack and call `probe` between the first two swings.
  async function midFight(bot, probe, times = 2) {
    let out
    bot.attack.mockImplementationOnce(() => setTimeout(() => { out = probe() }, 50))
    await attackEntityAction({ entity_id: 7, times }, bot, {})
    return out
  }

  it('is null with no attack running', () => {
    expect(attackRunState(fightBot())).toBeNull()
    expect(attackInFlightSuffix(null, fightBot(), 'Alex')).toBe('')
  })

  it('says where the fight goes on to next', async () => {
    const bot = twoZombies()
    const out = await midFight(bot, () => {
      const st = attackRunState(bot)
      return { st, text: attackInFlightSuffix(st, bot, 'Alex') }
    })
    expect(out.st.targetId).toBe(7)
    expect(out.st.next?.id).toBe(9)
    expect(out.text).toBe(', after this kill it goes on by itself to the zombie 1 block from Alex.')
    // Over once the action returns.
    expect(attackRunState(bot)).toBeNull()
  })

  it('counts the kills so far and drops the next-target sentence when there is none', async () => {
    const bot = fightBot()
    const out = await midFight(bot, () => {
      bot._seiAttackRun.ctx.tagged.add(5)
      bot._seiAttackRun.ctx.deadIds.add(5)
      return attackInFlightSuffix(attackRunState(bot), bot, 'Alex')
    })
    expect(out).toBe(', 1 killed so far.')
  })

  it('a repeat call by name for another mob of the same kind keeps the fight in reach going', async () => {
    const bot = twoZombies()
    const reply = await midFight(bot, () => continueAttack(bot, running, again({ entity: 'zombie', times: 1 })))
    expect(reply).toMatch(/^your attackEntity is already swinging at a zombie next to you \(1 swing so far\), so it keeps going with up to 1 more instead of switching, and after this kill it goes on by itself to the next one near Alex\./)
    expect(reply).toMatch(/call attackEntity with its # handle/)
  })

  it('a # handle, an id or another kind still switches', async () => {
    const bot = twoZombies()
    const seen = await midFight(bot, () => [
      continueAttack(bot, running, again({ entity_id: 9 })),
      continueAttack(bot, running, again({ entity: 'skeleton' })),
    ])
    expect(seen).toEqual([null, null])
  })

  it('the defend turn on the mob the attack is on reads as handled, and says it goes on to the next', async () => {
    const bot = twoZombies()
    const data = { attackerKind: 'defend', attacker: bot.entities[7], attackerLabel: 'zombie', ownerLabel: 'Alex', distance: 1, engaged: true, othersOnOwner: 1, ownerHp: 17 }
    const out = await midFight(bot, () => withAttackRunState(bot, 'sei:attacked', data))
    expect(out.actionOnIt).toBe(true)
    expect(out.runGoesOn).toBe(true)
    const text = DEFEND_ADDENDUM('zombie', out)
    expect(text).toMatch(/the mob your attackEntity is already going after/)
    expect(text).toMatch(/After this kill it goes on by itself to the next one near them\.$/)
    expect(text).not.toMatch(/nothing is swinging at/)
    // Another mob, a threat, or no attack: unchanged.
    const other = { ...data, attacker: bot.entities[9] }
    expect(withAttackRunState(bot, 'sei:attacked', other)).toBe(other)
    expect(withAttackRunState(bot, 'sei:attacked', data)).toBe(data)
  })
})
