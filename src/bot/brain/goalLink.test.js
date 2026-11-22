// src/bot/brain/goalLink.test.js: linking goals to the progression spine, and
// the orchestrator's JS auto-clear built on it (261012).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'
import { z } from 'zod'
import { finishClause, nodesNamedIn, linkGoalToSpine, linkFinished } from './goalLink.js'
import { computeProgression } from '../adapter/minecraft/observers/progression.js'
import { computeProgression as computeDst } from '../adapter/dontstarve/observers/progression.js'
import { createOrchestrator, _setTickIntervalForTests } from './orchestrator.js'
import { PLAYER_TASK_TAG } from './promptLibrary.js'

describe('finishClause', () => {
  it('returns the text after the finish cue', () => {
    expect(finishClause('Get from wood to iron with Alex. Finish when I hold an iron pickaxe.')).toBe('I hold an iron pickaxe.')
    expect(finishClause('Science machine with Ouen. Finish: science machine built')).toBe('science machine built')
    expect(finishClause('Get tools. Done when I have a pickaxe and a torch')).toBe('I have a pickaxe and a torch')
    expect(finishClause('mine until we have 3 iron')).toBe('we have 3 iron')
  })
  it('is null when the goal has no finish clause', () => {
    expect(finishClause('Build a hut with Alex by the river')).toBeNull()
  })
})

describe('nodesNamedIn', () => {
  const spine = computeProgression({}).spine
  it('matches whole words only', () => {
    expect(nodesNamedIn('make a wooden pickaxe', spine).map((n) => n.id)).toEqual(['wood_pickaxe'])
    expect(nodesNamedIn('chop wood', spine).map((n) => n.id)).toEqual(['logs'])
  })
})

describe('linkGoalToSpine', () => {
  it('links a long goal to its finish condition, not its first rung', () => {
    const prog = computeProgression({})
    const link = linkGoalToSpine('Get from wood to a crafting table to iron with Alex. Finish when I hold an iron pickaxe', prog)
    expect(link.ids).toEqual(['iron_pickaxe'])
    expect(link.primary.id).toBe('iron_pickaxe')
  })

  it('does not link a goal whose finish clause names no spine node', () => {
    const prog = computeProgression({})
    expect(linkGoalToSpine('Build a 5x5 hut: chop logs, make a crafting table, then walls. Finish when the walls and roof are done', prog)).toBeNull()
  })

  it('without a finish clause, needs every named node', () => {
    const prog = computeProgression({ items: { oak_log: 3 } })
    const link = linkGoalToSpine('chop wood, make a crafting table and a wooden pickaxe', prog)
    expect(link.ids).toEqual(['crafting_table', 'wood_pickaxe'])
  })

  it('drops nodes already done, and does not link a goal that is already met', () => {
    const prog = computeProgression({ items: { oak_log: 3, crafting_table: 1 } })
    expect(linkGoalToSpine('Finish when we have a crafting table', prog)).toBeNull()
  })

  it('matches plurals and item ids, so a conjunction keeps every node (261012 review)', () => {
    const prog = computeProgression({})
    expect(linkGoalToSpine('Get diamonds with Alex. Finish when we have an iron pickaxe and 3 diamonds', prog).ids)
      .toEqual(['iron_pickaxe', 'diamonds'])
    expect(linkGoalToSpine('Finish when we have 12 ender pearls and blaze rods', prog).ids).toEqual(['blaze_rods', 'ender_pearls'])
    expect(linkGoalToSpine('Finish when I hold an iron_pickaxe', prog).ids).toEqual(['iron_pickaxe'])
    expect(linkGoalToSpine('Finish when we have an eye of ender', prog).ids).toEqual(['ender_eyes'])
    expect(nodesNamedIn('make a wooden pickaxe', computeProgression({}).spine).map((n) => n.id)).toEqual(['wood_pickaxe'])
  })

  it('does not link a goal that asks for more than the node counts', () => {
    const prog = computeProgression({})
    expect(linkGoalToSpine('Gather wood for Alex. Finish when we have 64 wood', prog)).toBeNull()
    expect(linkGoalToSpine('Finish when we have 3 diamonds', prog).ids).toEqual(['diamonds'])
  })

  it('the finish clause ends with its sentence (live eval 261012)', () => {
    const goal = "Get a wooden pickaxe, then stone tools and iron with Alex. Finish when I hold an iron ingot made with Alex's help. Start: gather wood."
    expect(finishClause(goal)).toBe("I hold an iron ingot made with Alex's help.")
    expect(linkGoalToSpine(goal, computeProgression({}))).toBeNull()
    expect(linkGoalToSpine('Get iron tools. Finish when I hold an iron pickaxe. Invite Alex in along the way.', computeProgression({})).ids)
      .toEqual(['iron_pickaxe'])
  })

  it('an explicit finish cue wins over an earlier "until"', () => {
    expect(finishClause('Follow Alex until he logs off. Finish when we have a furnace')).toBe('we have a furnace')
    expect(finishClause('mine until we have 3 iron')).toBe('we have 3 iron')
  })

  it('needs every node of a conjunction (DST)', () => {
    const link = linkGoalToSpine('Gear up with Ouen. Finish when we have a pickaxe and a torch', computeDst({ items: {} }))
    expect(link.ids.sort()).toEqual(['light', 'tools'])
    expect(linkFinished(link, { done: new Set(['tools']) })).toBe(false)
    expect(linkFinished(link, { done: new Set(['tools', 'light']) })).toBe(true)
  })
})

// â”€â”€â”€ orchestrator: the auto-clear only fires on the goal's finish condition â”€â”€

// Goal lines in a HEARTBEAT file (`- [ISO] text`).
async function readGoals(file) {
  let raw = ''
  try { raw = fs.readFileSync(file, 'utf8') } catch { return [] }
  return raw.split('\n').map((l) => /^- \[[^\]]*\] (.*)$/.exec(l)?.[1]).filter(Boolean).map((text) => ({ text }))
}

const tmpFiles = []
afterEach(() => {
  for (const f of tmpFiles.splice(0)) { try { fs.rmSync(f, { force: true }) } catch { /* ignore */ } }
})

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
      return r
    },
  }
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sei-goallink-'))
  tmpFiles.push(dir)
  const state = { items: {}, pickaxeTier: 0 }
  const adapter = {
    listActions: () => ['gather'],
    getActionSchema: () => z.object({}),
    getActionDescription: (n) => `do ${n}`,
    capabilityParagraph: () => 'caps',
    worldPrimer: () => 'world',
    actionRules: () => 'rules',
    eventAddendum: () => '',
    createSnapshotComposer: () => ({ next: () => 'SNAPSHOT' }),
    chat() {},
    closeAnySessions: async () => {},
    executeAction: () => Promise.resolve('done'),
    getProgression: () => computeProgression(state),
  }
  const hb = path.join(dir, 'HEARTBEAT.md')
  const config = {
    player_username: 'Steve',
    preferred_name: 'Steve',
    persona: { name: 'Sei', expanded: 'You are a companion.', proactiveness: 2 },
    anthropic: { model: 'claude-haiku-4-5', timeout_ms: 20_000, max_retries: 1 },
    llm: { provider: 'anthropic', rate_limit_per_min: 30, debounce_ms: 0, max_hops: 5 },
    memory: { memory_md_path: path.join(dir, 'MEMORY.md'), heartbeat_md_path: hb, iteration_cap: 30 },
    web: { enabled: false },
  }
  return { state, adapter, config, hb }
}

const sayOnly = (id) => ({ text: '', toolUses: [{ id, name: 'say', input: { text: 'ok' } }] })
const lastUserText = (provider) => JSON.stringify(provider.calls[provider.calls.length - 1].messages)
const chat = (text) => ({ text, username: 'Steve', playerSpoke: true, ts: Date.now() })

describe('orchestrator goal auto-clear (261012)', () => {
  it('keeps a wood-to-iron goal when its first rung finishes and clears it at the iron pickaxe', async () => {
    _setTickIntervalForTests(10_000_000)
    const { state, adapter, config, hb } = setup()
    const goal = 'Get from wood to iron with Steve. Finish when I hold an iron pickaxe'
    const provider = makeProvider([
      { text: '', toolUses: [{ id: 'g1', name: 'setGoal', input: { text: goal } }, { id: 's1', name: 'say', input: { text: 'deal' } }] },
      sayOnly('s2'),
      sayOnly('s3'),
    ])
    const orch = createOrchestrator({ adapter, config, reenqueue: () => {}, _anthropicOverride: provider })

    await orch.handleDispatch('sei:chat_received', chat('lets get to iron'))
    expect(await readGoals(hb)).toEqual([expect.objectContaining({ text: goal })])

    // First rungs done (logs, crafting table, wooden pickaxe): the goal stays.
    Object.assign(state, { items: { oak_log: 2, crafting_table: 1 }, pickaxeTier: 1 })
    await orch.handleDispatch('sei:idle', { reason: 'idle', quietMs: 30000 })
    expect((await readGoals(hb)).map((g) => g.text)).toEqual([goal])
    expect(lastUserText(provider)).not.toContain('PROGRESS: you just finished')

    // Iron pickaxe in hand: the goal is cleared and the next seed says so.
    state.pickaxeTier = 3
    await orch.handleDispatch('sei:idle', { reason: 'idle', quietMs: 30000 })
    expect(await readGoals(hb)).toEqual([])
    expect(lastUserText(provider)).toContain('PROGRESS: you just finished')
  })

  it('never auto-clears a player project whose finish condition is not a milestone', async () => {
    _setTickIntervalForTests(10_000_000)
    const { state, adapter, config, hb } = setup()
    const goal = 'Build a 5x5 hut with Steve: chop logs, make a crafting table, then walls and a roof. Finish when the walls and roof are done'
    const provider = makeProvider([
      { text: '', toolUses: [{ id: 'g1', name: 'setGoal', input: { text: goal } }, { id: 's1', name: 'say', input: { text: 'on it' } }] },
      sayOnly('s2'),
    ])
    const orch = createOrchestrator({ adapter, config, reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', chat('build us a hut'))
    Object.assign(state, { items: { oak_log: 6, crafting_table: 1 } })
    await orch.handleDispatch('sei:idle', { reason: 'idle', quietMs: 30000 })
    expect((await readGoals(hb)).map((g) => g.text)).toEqual([goal])
  })

  it('auto-clears a goal whose setGoal text spanned several lines', async () => {
    _setTickIntervalForTests(10_000_000)
    const { state, adapter, config, hb } = setup()
    const goal = 'Get a furnace with Steve.\nFinish when we have a furnace'
    const provider = makeProvider([
      { text: '', toolUses: [{ id: 'g1', name: 'setGoal', input: { text: goal } }, { id: 's1', name: 'say', input: { text: 'ok' } }] },
      sayOnly('s2'),
    ])
    const orch = createOrchestrator({ adapter, config, reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', chat('get a furnace'))
    expect((await readGoals(hb)).map((g) => g.text)).toEqual(['Get a furnace with Steve. Finish when we have a furnace'])
    Object.assign(state, { items: { furnace: 1 }, pickaxeTier: 2 })
    await orch.handleDispatch('sei:idle', { reason: 'idle', quietMs: 30000 })
    expect(await readGoals(hb)).toEqual([])
    expect(lastUserText(provider)).toContain('PROGRESS: you just finished')
  })

  it('setting a second linked goal does not delete the first', async () => {
    _setTickIntervalForTests(10_000_000)
    const { adapter, config, hb } = setup()
    const a = 'Science with Steve. Finish when we have a furnace'
    const b = 'Tools for Steve. Finish when I hold a stone pickaxe'
    const provider = makeProvider([
      { text: '', toolUses: [
        { id: 'g1', name: 'setGoal', input: { text: a } },
        { id: 'g2', name: 'setGoal', input: { text: b } },
        { id: 's1', name: 'say', input: { text: 'ok' } },
      ] },
    ])
    const orch = createOrchestrator({ adapter, config, reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', chat('two things'))
    expect((await readGoals(hb)).map((g) => g.text)).toEqual([a, b])
  })

  // 261013 (pass 6b): a task the player gives is stored tagged (renderHeartbeat
  // lists it ahead of the bot's own goals) and never auto-cleared by the spine
  // (its finish is usually the hand-over, which the spine cannot see).
  it('tags a for_player task and never auto-clears it from the spine', async () => {
    _setTickIntervalForTests(10_000_000)
    const { state, adapter, config, hb } = setup()
    const own = 'Get iron tools with Steve. Finish when I hold an iron pickaxe'
    const task = 'Bring Steve a furnace and come back to him. Finish when I have a furnace and gave it to Steve'
    const provider = makeProvider([
      { text: '', toolUses: [{ id: 'g1', name: 'setGoal', input: { text: own } }, { id: 's1', name: 'say', input: { text: 'deal' } }] },
      { text: '', toolUses: [{ id: 'g2', name: 'setGoal', input: { text: task, for_player: true } }, { id: 's2', name: 'say', input: { text: 'on it' } }] },
      sayOnly('s3'),
    ])
    const orch = createOrchestrator({ adapter, config, reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', chat('lets get iron'))
    await orch.handleDispatch('sei:chat_received', chat('can u make me a furnace and bring it here'))
    expect((await readGoals(hb)).map((g) => g.text)).toEqual([own, `${PLAYER_TASK_TAG} ${task}`])

    // The furnace node is done, but the task names the hand-over: it stays.
    Object.assign(state, { items: { furnace: 1, cobblestone: 8 }, pickaxeTier: 2 })
    await orch.handleDispatch('sei:idle', { reason: 'idle', quietMs: 30000 })
    expect((await readGoals(hb)).map((g) => g.text)).toEqual([own, `${PLAYER_TASK_TAG} ${task}`])
    expect(lastUserText(provider)).not.toContain('PROGRESS: you just finished')
  })

  it('takes for_player sent as the string "true" (local / OpenAI-compatible models)', async () => {
    _setTickIntervalForTests(10_000_000)
    const { adapter, config, hb } = setup()
    const task = 'Bring Steve 4 logs and come back. Finish when Steve has them'
    const provider = makeProvider([
      { text: '', toolUses: [{ id: 'g1', name: 'setGoal', input: { text: task, for_player: 'true' } }, { id: 's1', name: 'say', input: { text: 'ok' } }] },
    ])
    const orch = createOrchestrator({ adapter, config, reenqueue: () => {}, _anthropicOverride: provider })
    await orch.handleDispatch('sei:chat_received', chat('bring me 4 logs'))
    expect((await readGoals(hb)).map((g) => g.text)).toEqual([`${PLAYER_TASK_TAG} ${task}`])
  })

  it('setGoal tool schema offers for_player', () => {
    const { adapter, config } = setup()
    const provider = makeProvider([sayOnly('s1')])
    const orch = createOrchestrator({ adapter, config, reenqueue: () => {}, _anthropicOverride: provider })
    return orch.handleDispatch('sei:chat_received', chat('hi')).then(() => {
      const tool = provider.calls[0].tools.find((t) => t.name === 'setGoal')
      expect(tool.input_schema.properties.for_player.type).toBe('boolean')
      expect(tool.input_schema.required).toEqual(['text'])
    })
  })
})




