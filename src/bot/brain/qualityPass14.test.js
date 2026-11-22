// 261017: quality pass 14, player orders beat her own project.
//  (261018, pass 15: the movement-order cut and the stop hold were phrase
//  matchers; they are gone. qualityPass15.test.js covers what replaced them.)
//  - every player line a reply deferred comes back in the completion turn
//  - the snapshot leaves out her own `next:` while the player is owed work
//  - items she gave the player are not picked back up
//  - a placed furnace / crafting table counts for the progression spine

import os from 'node:os'
import fs from 'node:fs'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { Vec3 } from 'vec3'
import { NUDGES } from './promptLibrary.js'
import { createOrchestrator, _setTickIntervalForTests } from './orchestrator.js'
import { beginGivenToss, givenDropFor } from '../adapter/minecraft/observers/givenDrops.js'
import { recordOwnStation } from '../adapter/minecraft/observers/ownStations.js'
import { composeSnapshot } from '../adapter/minecraft/observers/snapshot.js'
import { pickupAction } from '../adapter/minecraft/behaviors/pickup.js'
import { readProgressionState, nextMilestone } from '../adapter/minecraft/observers/progression.js'

// â”€â”€â”€ orchestrator harness â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function makeProvider(script) {
  let i = 0
  const calls = []
  return {
    calls,
    buildCachedSystem: (blocks) => blocks,
    setAuthToken() {},
    setBackend() {},
    async call(args) {
      calls.push(args)
      const r = script[Math.min(i, script.length - 1)]
      i += 1
      return typeof r === 'function' ? r(args) : r
    },
  }
}

// gather runs until settled or aborted; follow never settles (background);
// everything else is instant.
function makeAdapter(executed, running, aborted, snapshotOpts) {
  const ACTIONS = ['gather', 'dig', 'give', 'goTo', 'follow', 'unfollow', 'explore', 'look', 'attackEntity']
  return {
    listActions: () => ACTIONS,
    getActionSchema: () => z.object({ name: z.string().optional(), item: z.string().optional(), player: z.string().optional() }),
    getActionDescription: (n) => `do ${n}`,
    capabilityParagraph: () => 'caps',
    worldPrimer: () => 'world',
    actionRules: () => 'rules',
    eventAddendum: () => '',
    createSnapshotComposer: () => ({ next: (opts) => { snapshotOpts?.push(opts); return opts?.hideNext ? 'SNAPSHOT' : 'SNAPSHOT\nnext: make a furnace' } }),
    chat: vi.fn(),
    closeAnySessions: async () => {},
    executeAction: (name, _args, opts = {}) => {
      executed.push(name)
      if (name === 'follow') return new Promise(() => {})
      if (name !== 'gather' && name !== 'dig') return Promise.resolve(`${name} ok`)
      return new Promise((resolve) => {
        running[name] = resolve
        opts.signal?.addEventListener?.('abort', () => { aborted.push(name); resolve(`aborted ${name}`) }, { once: true })
      })
    },
  }
}

let seq = 0
const config = () => {
  const tag = `${process.pid}-${Date.now()}-${seq++}`
  return {
    player_username: 'Steve',
    preferred_name: 'Steve',
    persona: { name: 'Sei', expanded: 'You are a sharp little companion.' },
    anthropic: { model: 'claude-haiku-4-5', timeout_ms: 20_000, max_retries: 1 },
    llm: { provider: 'anthropic', rate_limit_per_min: 60, debounce_ms: 0, max_hops: 5 },
    memory: {
      memory_md_path: path.join(os.tmpdir(), `sei-p14-mem-${tag}.md`),
      heartbeat_md_path: path.join(os.tmpdir(), `sei-p14-hb-${tag}.md`),
      iteration_cap: 30,
    },
  }
}

const say = (id, text) => ({ id, name: 'say', input: { text } })
const act = (id, name, input = {}) => ({ id, name, input })
const turn = (...toolUses) => ({ text: '', toolUses })
const lastUserText = (call) => JSON.stringify((call.messages ?? []).slice(-1))
const line = (text) => ({ text, username: 'Steve', playerSpoke: true, ts: Date.now() })
const DRAINED = new Set(['sei:action_complete', 'sei:chat_received', 'sei:action_tick'])
const flush = () => new Promise((r) => setTimeout(r, 5))

function setup(script, cfg = config()) {
  _setTickIntervalForTests(10_000_000)
  const executed = []
  const running = {}
  const aborted = []
  const snapshotOpts = []
  const queue = []
  const provider = makeProvider(script)
  const orch = createOrchestrator({
    adapter: makeAdapter(executed, running, aborted, snapshotOpts), config: cfg,
    reenqueue: (event, data) => queue.push({ event, data }),
    _anthropicOverride: provider,
  })
  const drain = async () => {
    for (let guard = 0; queue.length && guard < 20; guard++) {
      const next = queue.shift()
      if (DRAINED.has(next.event)) await orch.handleDispatch(next.event, next.data)
    }
  }
  return { orch, provider, executed, running, aborted, snapshotOpts, queue, drain }
}

describe('deferred player lines come back together', () => {
  it('keeps an order that a later question would have replaced', async () => {
    const { orch, provider, running, snapshotOpts, drain } = setup([
      turn(say('s1', 'on it'), act('a1', 'gather', { name: 'stone' })),
      turn(say('s2', 'yep after this stone')),
      turn(say('s3', 'probably moss lol')),
      turn(say('s4', 'logs now'), act('a2', 'gather', { name: 'oak_log' })),
    ])
    await orch.handleDispatch('sei:chat_received', line('mine some stone'))
    await orch.handleDispatch('sei:chat_received', line('get me like 8 logs, i wanna build a dock'))
    await flush()
    await orch.handleDispatch('sei:chat_received', line('whats ur favorite block'))
    await flush()
    expect(orch.currentLoop?._replyDeferred).toEqual(['get me like 8 logs, i wanna build a dock', 'whats ur favorite block'])
    running.gather('gathered 8/8 stone')
    await flush()
    snapshotOpts.length = 0
    await drain()
    const text = lastUserText(provider.calls[3])
    expect(text).toContain('get me like 8 logs, i wanna build a dock')
    expect(text).toContain('whats ur favorite block')
    expect(text).toContain('before your own plan')
    // her own next milestone is left out of that turn's snapshot
    expect(snapshotOpts.some((o) => o?.hideNext === true)).toBe(true)
    expect(text).not.toContain('next: make a furnace')
  })

  it('one deferred line reads as before', () => {
    expect(NUDGES.deferredReplies(['go get more wood'])).toBe(NUDGES.deferredReply('go get more wood'))
    const two = NUDGES.deferredReplies(['a', 'b'])
    expect(two).toContain('"a"')
    expect(two).toContain('"b"')
    expect(two).not.toMatch(/â€”/)
  })
})

describe('a player task hides her own next milestone', () => {
  it('setGoal for the player sets hideNext until the task is cleared', async () => {
    const { orch, running, snapshotOpts, drain } = setup([
      turn(say('s1', 'on it'), { id: 'g1', name: 'setGoal', input: { text: 'get 8 logs for Steve', for_player: true } }, act('a1', 'gather', { name: 'oak_log' })),
      turn(say('s2', 'here you go'), act('v1', 'give', { item: 'oak_log' }), { id: 'c1', name: 'clearGoal', input: { text: 'get 8 logs' } }),
      turn(say('s3', 'there')),
    ])
    snapshotOpts.length = 0
    await orch.handleDispatch('sei:chat_received', line('get me 8 logs'))
    expect(orch.currentLoop?.inFlight?.name).toBe('gather')
    running.gather('gathered 8/8 oak_log')
    await flush()
    await drain()
    await flush()
    await drain()
    const flags = snapshotOpts.map((o) => o?.hideNext === true)
    // shown at the seed, hidden once the task is set, shown again after clearGoal
    expect(flags[0]).toBe(false)
    expect(flags).toContain(true)
    expect(flags.at(-1)).toBe(false)
  })
})

describe('next: hide follows the goal list, not a timer', () => {
  it('a clearGoal that names the task with its tag shows next: again', async () => {
    const { orch, running, snapshotOpts, drain } = setup([
      turn(say('s1', 'on it'), { id: 'g1', name: 'setGoal', input: { text: 'get 8 logs for Steve', for_player: true } }, act('a1', 'gather', { name: 'oak_log' })),
      turn(say('s2', 'here you go'), act('v1', 'give', { item: 'oak_log' }), { id: 'c1', name: 'clearGoal', input: { text: '(player task) get 8 logs for Steve' } }),
      turn(say('s3', 'there')),
    ])
    snapshotOpts.length = 0
    await orch.handleDispatch('sei:chat_received', line('get me 8 logs'))
    running.gather('gathered 8/8 oak_log')
    await flush()
    await drain()
    await flush()
    await drain()
    const flags = snapshotOpts.map((o) => o?.hideNext === true)
    expect(flags).toContain(true)
    expect(flags.at(-1)).toBe(false)
  })

  it('a player task already in the goal file hides next: from the first turn', async () => {
    const cfg = config()
    fs.writeFileSync(cfg.memory.heartbeat_md_path, '# Heartbeat\n\n- [2026-10-17T00:00:00.000Z] (player task) bring Steve 3 coal\n')
    const { orch, snapshotOpts } = setup([turn(say('s1', 'on it'))], cfg)
    snapshotOpts.length = 0
    await orch.handleDispatch('sei:chat_received', line('hey'))
    expect(snapshotOpts[0]?.hideNext).toBe(true)
  })

  it('her own goals alone do not hide next:', async () => {
    const cfg = config()
    fs.writeFileSync(cfg.memory.heartbeat_md_path, '# Heartbeat\n\n- [2026-10-17T00:00:00.000Z] make a furnace\n')
    const { orch, snapshotOpts } = setup([turn(say('s1', 'hi'))], cfg)
    snapshotOpts.length = 0
    await orch.handleDispatch('sei:chat_received', line('hey'))
    expect(snapshotOpts[0]?.hideNext).toBe(false)
  })
})

// â”€â”€â”€ given drops â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function vec(x, y, z) {
  return { x, y, z, distanceTo(o) { return Math.hypot(this.x - o.x, this.y - o.y, this.z - o.z) } }
}
function itemEntity(id, name, pos) {
  return { id, name: 'item', position: pos, getDroppedItem: () => (name ? { name, count: 6 } : null) }
}
function emitterBot(extra = {}) {
  return Object.assign(new EventEmitter(), extra)
}

describe('items she gave the player', () => {
  it('are the entities that spawned at her during the toss, for a few minutes', () => {
    const bot = emitterBot()
    const toss = beginGivenToss(bot, { item: 'oak_log', from: vec(13, 64, 10), to: 'Steve' })
    bot.emit('entitySpawn', itemEntity(1, null, vec(13, 65.3, 10)))
    toss.commit(6, 0)
    const now = Date.now()
    const tossed = itemEntity(1, null, vec(10, 64, 10))
    expect(givenDropFor(bot, tossed, now + 1000)?.to).toBe('Steve')
    // the same stack decoded later still counts
    expect(givenDropFor(bot, itemEntity(1, 'oak_log', vec(10, 64, 10)), now + 1000)).not.toBeNull()
    // logs she chops right next to the give spot are hers to pick up
    expect(givenDropFor(bot, itemEntity(2, 'oak_log', vec(10.5, 64, 10)), now + 1000)).toBeNull()
    // an unknown stack beside the toss is not labelled as the toss
    expect(givenDropFor(bot, itemEntity(3, null, vec(10.5, 64, 10)), now + 1000)).toBeNull()
    // after the window it is loot again
    expect(givenDropFor(bot, tossed, now + 6 * 60_000)).toBeNull()
  })

  it('only counts item spawns at her, and none after a failed toss', async () => {
    const bot = emitterBot()
    const toss = beginGivenToss(bot, { item: 'oak_log', from: vec(0, 64, 0), to: 'Steve' })
    bot.emit('entitySpawn', itemEntity(7, null, vec(9, 64, 0))) // a drop far off
    bot.emit('entitySpawn', itemEntity(8, 'cobblestone', vec(0, 65, 0))) // another item
    bot.emit('entitySpawn', { id: 9, name: 'zombie', position: vec(0, 64, 0) })
    toss.commit(1, 0)
    await new Promise((r) => setTimeout(r, 5))
    bot.emit('entitySpawn', itemEntity(10, null, vec(0, 65, 0))) // after the window closed
    for (const id of [7, 8, 10]) expect(givenDropFor(bot, itemEntity(id, null, vec(0, 64, 0)))).toBeNull()
    expect(bot.listenerCount('entitySpawn')).toBe(0)

    const bot2 = emitterBot()
    const failed = beginGivenToss(bot2, { item: 'oak_log', from: vec(0, 64, 0) })
    failed.cancel()
    bot2.emit('entitySpawn', itemEntity(11, null, vec(0, 65, 0)))
    expect(givenDropFor(bot2, itemEntity(11, null, vec(0, 64, 0)))).toBeNull()
    expect(bot2.listenerCount('entitySpawn')).toBe(0)
  })

  it('pickup leaves them and says whose they are', async () => {
    const bot = emitterBot({
      entity: { position: vec(12, 64, 10) },
      entities: { 1: itemEntity(1, 'oak_log', vec(10.5, 64, 10)) },
      inventory: { items: () => [] },
    })
    const toss = beginGivenToss(bot, { item: 'oak_log', from: vec(12, 64, 10), to: 'Steve' })
    bot.emit('entitySpawn', itemEntity(1, null, vec(12, 65.3, 10)))
    toss.commit(6, 0)
    const goTo = vi.fn(async () => 'reached')
    const res = await pickupAction({ item: 'oak_log' }, bot, {}, { goTo, sleep: async () => {} })
    expect(goTo).not.toHaveBeenCalled()
    expect(res).toContain('you gave Steve')
  })

  it('the snapshot never labels a stack it cannot read as given', () => {
    const bot = emitterBot({
      entity: { position: new Vec3(12, 64, 10), yaw: 0, pitch: 0 },
      username: 'Sei',
      entities: {
        1: itemEntity(1, null, new Vec3(10.5, 64, 10)),
        2: itemEntity(2, 'oak_log', new Vec3(11, 64, 10)),
      },
      players: {},
      inventory: { items: () => [], slots: [] },
      findBlocks: () => [],
      findBlock: () => null,
      blockAt: (p) => ({ name: 'air', shapes: [], position: p }),
      health: 20,
      food: 20,
      game: { dimension: 'overworld' },
      time: { timeOfDay: 1000 },
    })
    const toss = beginGivenToss(bot, { item: 'oak_log', from: new Vec3(12, 64, 10), to: 'Steve' })
    bot.emit('entitySpawn', itemEntity(1, null, new Vec3(12, 65.3, 10)))
    bot.emit('entitySpawn', itemEntity(2, null, new Vec3(12, 65.3, 10)))
    toss.commit(6, 0)
    let text = ''
    try { text = composeSnapshot(bot, {}) } catch (e) { text = 'ERR ' + e.stack }
    expect(text).toContain('item(oak_log x6, you gave this to Steve)')
    expect(text).not.toMatch(/item\(oak_log, you gave/)
  })
})

// â”€â”€â”€ progression: a placed station counts â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('only her own furnace counts as had', () => {
  // A world with a crafting table and a furnace beside her (the player's,
  // say); only positions she recorded count.
  function bot() {
    const world = { '1,64,1': 'crafting_table', '2,64,1': 'furnace' }
    return {
      entity: { position: vec(0, 64, 0) },
      registry: { blocksByName: { crafting_table: { id: 1 }, furnace: { id: 2 } } },
      blockAt: (p) => ({ name: world[`${p.x},${p.y},${p.z}`] ?? 'air', position: p }),
      findBlock: () => ({ position: vec(2, 64, 1) }),
      inventory: { items: () => [{ name: 'stone_pickaxe', count: 1 }, { name: 'oak_log', count: 4 }, { name: 'cobblestone', count: 2 }] },
      game: { dimension: 'overworld' },
    }
  }
  it('a furnace that is not hers does not move the milestone', () => {
    const b = bot()
    recordOwnStation(b, 'crafting_table', vec(1, 64, 1))
    expect(nextMilestone(readProgressionState(b))?.node?.id).toBe('furnace')
  })
  it('one she placed or used does, while it is still there', () => {
    const b = bot()
    recordOwnStation(b, 'crafting_table', vec(1, 64, 1))
    expect(nextMilestone(readProgressionState(b))?.node?.id).toBe('furnace')
    recordOwnStation(b, 'furnace', vec(2, 64, 1))
    expect(nextMilestone(readProgressionState(b))?.node?.id).not.toBe('furnace')
    // a recorded spot that no longer holds a furnace does not count
    const c = bot()
    recordOwnStation(c, 'crafting_table', vec(1, 64, 1))
    recordOwnStation(c, 'furnace', vec(5, 64, 5))
    expect(nextMilestone(readProgressionState(c))?.node?.id).toBe('furnace')
  })
})




