// 261012: quality pass 4a, protect_player target selection.
//  - a hostile asked for by name resolves to the one nearest the OWNER, also
//    past the old 16-block name bound, while the owner is under threat
//  - a mob already at her feet still wins over one that is not on them yet
//  - after a kill with swings left, attackEntity goes on to the next hostile
//    near the owner
//  - in an owner defense, a second hostile next to her gets one hit
//  - the reflex does not strafe around another mob during a committed attack

import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { attackEntityAction } from '../adapter/minecraft/behaviors/attack.js'
import { resolveEntity, pickHostileForOwner, ownerEntityOf } from '../adapter/minecraft/observers/targeting.js'

const vec = (x, y, z) => ({
  x, y, z,
  distanceTo(p) { return Math.hypot(p.x - this.x, p.y - this.y, p.z - this.z) },
  offset(dx, dy, dz) { return vec(this.x + dx, this.y + dy, this.z + dz) },
})

// Her at x=0, the owner Alex at `ownerX`, mobs along the x axis.
function world(mobs = [], { ownerX = 4, owner = true } = {}) {
  const bot = new EventEmitter()
  bot.entity = { id: 1, position: vec(0, 64, 0) }
  bot.entities = { 1: bot.entity }
  bot._seiOwnerNames = owner ? ['alex'] : []
  const alex = { id: 2, username: 'Alex', type: 'player', position: vec(ownerX, 64, 0) }
  bot.entities[2] = alex
  bot.players = { Alex: { entity: alex } }
  for (const m of mobs) bot.entities[m.id] = { type: 'hostile', height: 1.95, ...m, position: vec(m.x, 64, m.z ?? 0) }
  bot.nearestEntity = (match) => Object.values(bot.entities)
    .filter((e) => e !== bot.entity && match(e))
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0] ?? null
  return bot
}

describe('owner-aware hostile pick', () => {
  it('finds the owner from the recorded names', () => {
    expect(ownerEntityOf(world())?.username).toBe('Alex')
    expect(ownerEntityOf(world([], { owner: false }))).toBeNull()
  })

  it('a by-name attack goes for the zombie nearest the owner, not nearest her', () => {
    // Owner 20 blocks out; zombie 21 is 6 from her, zombie 22 is on the owner.
    const bot = world([{ id: 21, name: 'zombie', x: -6 }, { id: 22, name: 'zombie', x: 22 }], { ownerX: 20 })
    expect(resolveEntity({ entity: 'zombie' }, bot)?.id).toBe(22)
  })

  it('reaches past the old 16-block name bound when the mob is near the owner', () => {
    // protect_player at the order: her and the owner together, zombies 21-25 out.
    const bot = world([{ id: 21, name: 'zombie', x: -25, z: -3 }, { id: 22, name: 'zombie', x: -26, z: 3 }], { ownerX: -4 })
    expect(resolveEntity({ target: 'zombie' }, bot)?.id).toBe(21)
  })

  it('a zombie at her feet beats one that is not on the owner yet', () => {
    const bot = world([{ id: 21, name: 'zombie', x: 2 }, { id: 22, name: 'zombie', x: 30 }], { ownerX: 18 })
    expect(pickHostileForOwner(bot)?.id).toBe(21)
  })

  it('...but not one that is on the owner', () => {
    const bot = world([{ id: 21, name: 'zombie', x: 2 }, { id: 22, name: 'zombie', x: 21 }], { ownerX: 18 })
    expect(pickHostileForOwner(bot)?.id).toBe(22)
  })

  it('keeps the old nearest-to-her rule when the owner is unknown', () => {
    const bot = world([{ id: 21, name: 'zombie', x: -6 }, { id: 22, name: 'zombie', x: 12 }], { owner: false })
    expect(resolveEntity({ entity: 'zombie' }, bot)?.id).toBe(21)
  })

  it('does not apply to non-hostiles (a sheep is still the nearest one)', () => {
    const bot = world([{ id: 21, name: 'sheep', x: -3 }, { id: 22, name: 'sheep', x: 5 }], { ownerX: 6 })
    expect(resolveEntity({ entity: 'sheep' }, bot)?.id).toBe(21)
  })
})

function fightable(bot) {
  bot.health = 20
  bot.heldItem = { name: 'iron_sword' }
  bot.inventory = { items: () => [{ name: 'iron_sword' }] }
  bot.lookAt = vi.fn()
  bot.swingArm = vi.fn()
  bot.equip = vi.fn()
  bot.attack = vi.fn()
  bot.setControlState = vi.fn()
  bot.pathfinder = { goal: null, setGoal: vi.fn((g) => { bot.pathfinder.goal = g }), setMovements: vi.fn() }
  return bot
}

describe('attackEntity after a kill (owner defense)', () => {
  it('goes on to the next hostile near the owner while swings remain', async () => {
    const bot = fightable(world([{ id: 21, name: 'zombie', x: 2 }, { id: 22, name: 'zombie', x: 3, z: 1 }], { ownerX: 4 }))
    const hits = []
    bot.attack.mockImplementation((e) => {
      hits.push(e.id)
      // each zombie dies on its second hit
      if (hits.filter((x) => x === e.id).length === 2) { bot.emit('entityDead', { id: e.id }); delete bot.entities[e.id] }
    })
    const r = await attackEntityAction({ target: 'zombie', times: 8 }, bot, {})
    expect(r).toMatch(/killed zombie/)
    expect(r).toContain('Then went for the next zombie: killed zombie')
    expect(new Set(hits)).toEqual(new Set([21, 22]))
    expect(bot._seiOffensiveTarget ?? null).toBeNull()
  })

  it('stops after the kill when nothing else is near the owner', async () => {
    const bot = fightable(world([{ id: 21, name: 'zombie', x: 2 }, { id: 22, name: 'zombie', x: -40 }], { ownerX: 4 }))
    bot.attack.mockImplementation((e) => { bot.emit('entityDead', { id: e.id }); delete bot.entities[e.id] })
    const r = await attackEntityAction({ target: 'zombie', times: 8 }, bot, {})
    expect(r).toBe('killed zombie (1 hits). Nothing hurt you in this fight: you are at 20/20 health.')
    expect(bot.attack).toHaveBeenCalledTimes(1)
  })

  it('does not chain a hunt (a sheep kill is just a kill)', async () => {
    const bot = fightable(world([{ id: 21, name: 'sheep', x: 2 }, { id: 22, name: 'zombie', x: 3 }], { ownerX: 4 }))
    bot.attack.mockImplementation((e) => { bot.emit('entityDead', { id: e.id }); delete bot.entities[e.id] })
    const r = await attackEntityAction({ entity: 'sheep', times: 5 }, bot, {})
    expect(r).toBe('killed sheep (1 hits). Nothing hurt you in this fight: you are at 20/20 health.')
  })

  it('gives a second hostile next to her one hit during the fight', async () => {
    const bot = fightable(world([{ id: 21, name: 'zombie', x: 2 }, { id: 22, name: 'zombie', x: 1, z: 2 }], { ownerX: 6 }))
    const hits = []
    bot.attack.mockImplementation((e) => {
      hits.push(e.id)
      if (e.id === 21 && hits.filter((x) => x === 21).length === 3) { bot.emit('entityDead', { id: 21 }); delete bot.entities[21] }
    })
    const r = await attackEntityAction({ target: 'zombie', times: 3 }, bot, {})
    // 21, then one tag on 22, then 21 twice more (the kill).
    expect(hits).toEqual([21, 22, 21, 21])
    expect(r).toContain('killed zombie (3 hits)')
    expect(r).toContain('You also hit another hostile once on the way')
  })

  it('never goes on to an enderman or a creeper near the owner after a kill', async () => {
    const bot = fightable(world([
      { id: 21, name: 'zombie', x: 2 }, { id: 22, name: 'enderman', x: 3, z: 1 }, { id: 23, name: 'creeper', x: 5 },
    ], { ownerX: 4 }))
    bot.attack.mockImplementation((e) => { if (e.id === 21) { bot.emit('entityDead', { id: 21 }); delete bot.entities[21] } })
    const r = await attackEntityAction({ target: 'zombie', times: 8 }, bot, {})
    expect(r).toBe('killed zombie (1 hits). Nothing hurt you in this fight: you are at 20/20 health.')
    expect(bot.attack.mock.calls.map(([e]) => e.id)).toEqual([21])
  })

  it('never tags an enderman next to her during the fight', async () => {
    const bot = fightable(world([{ id: 21, name: 'zombie', x: 2 }, { id: 22, name: 'enderman', x: 1, z: 2 }], { ownerX: 6 }))
    const hits = []
    bot.attack.mockImplementation((e) => {
      hits.push(e.id)
      if (e.id === 21 && hits.length === 3) { bot.emit('entityDead', { id: 21 }); delete bot.entities[21] }
    })
    const r = await attackEntityAction({ target: 'zombie', times: 3 }, bot, {})
    expect(hits).toEqual([21, 21, 21])
    expect(r).not.toContain('You also hit')
  })

  it('an abort after the first kill does not start on the next hostile', async () => {
    const bot = fightable(world([{ id: 21, name: 'zombie', x: 2 }, { id: 22, name: 'zombie', x: 3, z: 1 }], { ownerX: 4 }))
    const ac = new AbortController()
    bot.attack.mockImplementation((e) => { bot.emit('entityDead', { id: e.id }); delete bot.entities[e.id]; ac.abort() })
    const r = await attackEntityAction({ target: 'zombie', times: 8 }, bot, { signal: ac.signal })
    expect(bot.attack).toHaveBeenCalledTimes(1)
    expect(r).not.toContain('Then went for the next')
  })
})

describe('reflex melee strafe during a committed attack', () => {
  it('does not strafe around a different mob', async () => {
    const { startReflex } = await import('../adapter/minecraft/behaviors/reflex.js')
    const bot = world([{ id: 21, name: 'zombie', x: 3 }], { ownerX: 10 })
    // No pitch: the field-of-view gate fails open, so the zombie counts as seen.
    bot.entity.yaw = Math.PI / 2
    bot.entity.velocity = vec(0, 0, 0)
    bot.health = 20
    bot.setControlState = vi.fn()
    bot.lookAt = vi.fn()
    bot.clearControlStates = vi.fn()
    bot._seiOffensiveTarget = 99 // committed to some other mob
    const dispose = startReflex(bot, {})
    bot.emit('physicsTick')
    expect(bot.setControlState.mock.calls.filter(([, on]) => on === true)).toHaveLength(0)
    bot._seiOffensiveTarget = null
    bot.emit('physicsTick')
    expect(bot.setControlState.mock.calls.filter(([, on]) => on === true).length).toBeGreaterThan(0)
    dispose?.()
  })
})

// â”€â”€ Issue 2 + 3: tool tiers, recipe counts, progress and inventory wording â”€â”€
import { SPINE, recipeNote, pickaxeLine, furnaceLine } from '../adapter/minecraft/observers/progression.js'
import { getInFlightLineForSnapshot } from './inflight.js'
import { CAPABILITY_PARAGRAPH } from './promptLibrary.js'

describe('what a pickaxe mines', () => {
  it('says plainly that a wooden pickaxe mines stone', () => {
    expect(CAPABILITY_PARAGRAPH).toContain('A wooden pickaxe mines stone (it drops cobblestone)')
    expect(CAPABILITY_PARAGRAPH).not.toContain('you cannot skip a rung')
  })

  it('the stone pickaxe step says the wooden pickaxe mines the stone', () => {
    const node = SPINE.find((n) => n.id === 'stone_pickaxe')
    expect(node.next_action).toMatch(/^mine stone with the wooden pickaxe/)
  })
})

describe('recipe on the next: line', () => {
  const stone = SPINE.find((n) => n.id === 'stone_pickaxe')

  it('gives the counts and what she holds', () => {
    const r = recipeNote(stone, { wooden_pickaxe: 1, cobblestone: 2, oak_planks: 2 })
    expect(r).toContain('Recipe: 3 cobblestone + 2 sticks at a crafting table.')
    expect(r).toContain('You have 2 cobblestone, 0 sticks, 2 planks, 0 logs')
  })

  it('drops the log note once the sticks are there', () => {
    expect(recipeNote(stone, { cobblestone: 5, stick: 4 })).toBe('Recipe: 3 cobblestone + 2 sticks at a crafting table. You have 5 cobblestone, 4 sticks.')
  })

  it('counts any kind of planks', () => {
    const table = SPINE.find((n) => n.id === 'crafting_table')
    expect(recipeNote(table, { oak_planks: 2, birch_planks: 2 })).toBe('Recipe: 4 planks. You have 4 planks.')
  })

  // 261018 (pass 17): the total in logs and the shortfall (work_session-02).
  it('says how many logs the missing planks and sticks take', () => {
    const pick = SPINE.find((n) => n.id === 'wood_pickaxe')
    expect(recipeNote(pick, { oak_log: 7 })).toContain('The planks and sticks for it take 2 logs, and you have 7.')
    expect(recipeNote(pick, { oak_log: 1 })).toContain('The planks and sticks for it take 2 logs, and you have 1.')
    expect(recipeNote(pick, { oak_planks: 3 })).toContain('The sticks for it take 1 log')
    expect(recipeNote(pick, { oak_planks: 3, stick: 2 })).not.toContain(' for it take ')
    // 2 planks make the 4 sticks, so no logs are needed
    expect(recipeNote(stone, { cobblestone: 2, oak_planks: 2 })).not.toContain(' for it take ')
  })

  // The pass 17 eval: "what is missing ... so you need 1 more first" on the
  // stone pickaxe sent her for logs when asked to mine stone. The note names
  // the sticks and gives the totals only, with nothing about what comes first.
  it('gives stick totals without telling her what to do first', () => {
    const note = recipeNote(stone, { wooden_pickaxe: 1 })
    expect(note).toContain('The sticks for it take 1 log, and you have 0.')
    expect(note).not.toMatch(/\b(first|need)\b/)
  })

  it('is empty for a node without a recipe', () => {
    expect(recipeNote(SPINE.find((n) => n.id === 'diamonds'), {})).toBe('')
  })
})

describe('in_flight progress wording', () => {
  // 261018 (pass 17): work_session-05, a craft planned on logs mid-give.
  // 261021 (pass 21): no longer "those are theirs now", which read as a
  // hand-over already done (qualityPass21.test.js).
  it('says items in a running give are meant for the player, not hers', () => {
    const line = getInFlightLineForSnapshot({ name: 'give', args: { item: 'oak_log', count: 6 }, startedAt: 0 }, 1800)
    expect(line).toBe('in_flight: give(oak_log) started=1.8s ago, handing 6 oak_log to the player. Nothing is handed over until the toss lands, so stopping it keeps them with you. They are meant for the player, so do not count them toward anything of yours')
    expect(getInFlightLineForSnapshot({ name: 'give', args: { item: 'coal', player: 'Alex' }, startedAt: 0 }, 0)).toContain('handing all your coal to Alex')
  })

  it('spells out a dig count instead of a fraction', () => {
    const line = getInFlightLineForSnapshot({ name: 'gather', args: { name: 'oak_log', count: 6 }, startedAt: 0, progress: { dug: 1, total: 6 } }, 1000)
    expect(line).toContain('broke 1 of the 6 blocks asked for so far')
    expect(line).not.toContain('1/6')
  })

  it('spells out a place count', () => {
    const line = getInFlightLineForSnapshot({ name: 'build', args: {}, startedAt: 0, progress: { placed: 3, total: 10 } }, 1000)
    expect(line).toContain('placed 3 of 10 so far')
  })
})

describe('pickaxe line under the inventory', () => {
  it('says what the best pickaxe she holds mines', () => {
    expect(pickaxeLine({ wooden_pickaxe: 1, dirt: 2 })).toBe('pickaxe: wooden_pickaxe mines stone (it drops cobblestone) and coal ore. Iron, copper and lapis ore need a stone pickaxe.')
    expect(pickaxeLine({ wooden_pickaxe: 1, iron_pickaxe: 1 })).toMatch(/^pickaxe: iron_pickaxe mines every ore\./)
  })

  it('says when she has none', () => {
    expect(pickaxeLine({ oak_log: 3 })).toBe('pickaxe: none, so stone and ore drop nothing when dug.')
  })
})

describe('furnace line for what is still cooking', () => {
  it('shows what was left in the furnace and how long ago', () => {
    const line = furnaceLine({ pos: [179, 71, 2], input: '2 raw_iron', t: 1000 }, 21000)
    expect(line).toBe('furnace @179,71,2: 2 raw_iron cooking when you checked 20s ago (each item takes about 10s to cook); takeSmelted at the furnace collects what is done')
    expect(furnaceLine({ pos: [1, 2, 3], input: null, output: '3 iron_ingot', t: 0 }, 5000))
      .toBe('furnace @1,2,3: 3 iron_ingot done and not taken when you checked 5s ago; takeSmelted at the furnace collects what is done')
  })

  it('shows nothing when the furnace was emptied or the record is old', () => {
    expect(furnaceLine(null)).toBeNull()
    expect(furnaceLine({ pos: [1, 2, 3], input: '1 raw_iron', t: 0 }, 601000)).toBeNull()
  })
})





