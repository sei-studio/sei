#!/usr/bin/env node
// Stardew goal A/B (T435, 261113): does the companion pick a fresh, sensible
// next goal on her own once the first fortnight is behind the farm?
//
// One idle tick per rep, agentic (proactiveness 2), no goal yet: the state a
// summon lands in. Everything is the REAL code of the checkout under test
// (--repo): the Stardew adapter over a stub client (mod 0.1.3), its
// progression frontier, the orchestrator's system blocks and tools, and
// composeSeedBlocks for the seed turn. Only the model call and the judge
// are here.
//
// Scenes:
//   resummon_spring16  a new session on a farm played since spring 1 (memory
//                      says what was done). The adapter's own progress store
//                      is pre-filled the way an earlier session leaves it; a
//                      checkout without the store starts from nothing.
//   resummon_summer3   the same on summer 3.
//   session_spring20   a long session on spring 20: the in-session latches
//                      are set on the checkout's own progression module.
//
// Judge (claude-haiku-5-5, one call per rep): from the scene's fact list, is
// what she committed to (setGoal, or the job she started) already done or out
// of season ("stale"), and is it a sensible next step ("fits")? pass = she
// committed to something, not stale, fits.
//
// Usage:
//   node scripts/quality-eval/stardew-goal-ab.mjs --repo <checkout> --arm dev --out <dir> [--reps 8] [--scenes a,b]
//   --dry prints each scene's frontier (no API calls); --snap adds the snapshot.
// Key: ~/.sei-dev/anthropic-test-key (never printed). Writes <out>/<arm>.jsonl.
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const argv = process.argv.slice(2)
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d }
const REPO = path.resolve(arg('repo', process.cwd()))
const ARM = arg('arm', 'arm')
const OUT = path.resolve(arg('out', path.join(os.homedir(), 'suisei', 'reports', 'quality', 'stardew-goal-ab')))
const REPS = Number(arg('reps', '8'))
const MODEL = 'claude-haiku-5-5'
const PRICE = { in: 0.10, out: 0.50, cw: 0.125, cr: 0.01 }
mkdirSync(OUT, { recursive: true })

const { default: Anthropic } = await import(path.join(REPO, 'node_modules', '@anthropic-ai', 'sdk', 'index.js')).catch(() => import('@anthropic-ai/sdk'))
const client = new Anthropic({ apiKey: readFileSync(path.join(os.homedir(), '.sei-dev', 'anthropic-test-key'), 'utf8').trim() })
const imp = (p) => import(path.join(REPO, p))
const { ConfigSchema } = await imp('src/bot/config.js')
const { composeSeedBlocks, createOrchestrator } = await imp('src/bot/brain/orchestrator.js')
const { createStardewAdapter } = await imp('src/bot/adapter/stardew/index.js')
const sdRuntime = await imp('src/bot/adapter/stardew/runtime.js')
const { composeSnapshot } = await imp('src/bot/adapter/stardew/observers/snapshot.js')
const progression = await imp('src/bot/adapter/stardew/observers/progression.js')
const sui = JSON.parse(readFileSync(path.join(os.homedir(), 'suisei', 'eval', 'characters', 'sui.json'), 'utf8'))
const noopLog = { debug() {}, info() {}, warn() {}, error() {}, child() { return noopLog } }
const SAVE_ID = '424242'

const MEMORY_SPRING = `## World 1
- Spring 2: cleared the debris by the house with Ouen and planted 15 parsnips.
- Spring 6: harvested the parsnips and shipped them; Ouen bought cauliflower and potato seeds at Pierre's.
- Spring 8: picked leeks and daffodils in the forest south of the farm.
- Spring 9: walked to town together, met Pierre and Gus at the saloon.
- Spring 11: fished at the beach, caught two sardines.
- Spring 14: went down the mines with Ouen to level 25. Mostly copper, some slimes.
- We have 50 wood in the chest by the house and Ouen crafted a furnace on spring 15.
`
const MEMORY_SUMMER = `${MEMORY_SPRING}- Spring 22: the cauliflowers came in, shipped 12.
- Summer 1: Ouen planted blueberries and melons, 40 crops in the ground.
`
const PRIOR = {
  flags: { cleared: true, foraged: true, harvested: true, fished: true, bought: true, visited_town: true },
  visited: { Town: true, Beach: true, Mine: true, Forest: true, Mountain: true, BusStop: true },
  doneNodes: ['clear_patch', 'first_crops', 'first_harvest', 'wood', 'forage', 'town', 'seeds_bought', 'fish', 'mines', 'copper', 'beach', 'mines_20'], mineLevel: 25, debrisCleared: 40, foragePicked: 8,
}
const DONE_FACTS = [
  'cleared debris and planted the first parsnips (spring 2)', 'harvested and shipped the parsnips (spring 6)',
  'foraged spring goods (spring 8)', 'visited town and Pierre\'s shop (spring 9)', 'caught fish at the beach (spring 11)',
  'reached mine level 25 (spring 14), so mine levels 5 and 20 are done', 'gathered 50 wood (it is in the chest by the house)', 'mined the copper and the player crafted a furnace on spring 15',
]

function baseObs(over) {
  const o = JSON.parse(readFileSync(path.join(REPO, 'src/bot/adapter/stardew/fixtures/obs-farm.json'), 'utf8'))
  return {
    ...o, location: 'Farm', locationKind: 'farm', time: 910, timeText: '9:10 AM', weather: 'sunny', saveId: SAVE_ID,
    host: { ...(o.host ?? {}), name: 'Ouen', money: 1400, seeds: 0, stamina: 240, maxStamina: 270, farmingLevel: 2, mailWaiting: 0, holding: 'Hoe', menu: null, inEvent: false },
    ...over,
  }
}

const SCENES = {
  resummon_spring16: {
    obs: baseObs({ season: 'spring', day: 16, dayOfWeek: 'Tue', daysPlayed: 16, farm: { crops: 30, dryCrops: 0, readyCrops: 0, deadCrops: 0, soil: 4, twigs: 20, weeds: 60, stones: 40, debris: 120, bigClumps: 12, grownTrees: 60, shippingBinItems: 0 } }),
    memory: MEMORY_SPRING, resummon: true, date: 'spring 16, year 1', money: 1400,
  },
  resummon_summer3: {
    obs: baseObs({ season: 'summer', day: 3, dayOfWeek: 'Wed', daysPlayed: 31, host: { name: 'Ouen', money: 3200, seeds: 0, stamina: 240, maxStamina: 270, farmingLevel: 3, mailWaiting: 0, holding: 'Watering Can' }, farm: { crops: 40, dryCrops: 0, readyCrops: 0, deadCrops: 0, soil: 6, twigs: 15, weeds: 40, stones: 30, debris: 85, bigClumps: 12, grownTrees: 58, shippingBinItems: 0 } }),
    memory: MEMORY_SUMMER, resummon: true, date: 'summer 3, year 1', money: 3200,
  },
  session_spring20: {
    obs: baseObs({ season: 'spring', day: 20, dayOfWeek: 'Sat', daysPlayed: 20, host: { name: 'Ouen', money: 2100, seeds: 0, stamina: 240, maxStamina: 270, farmingLevel: 2, mailWaiting: 0, holding: 'Hoe' }, farm: { crops: 30, dryCrops: 0, readyCrops: 0, deadCrops: 0, soil: 4, twigs: 20, weeds: 60, stones: 40, debris: 120, bigClumps: 12, grownTrees: 60, shippingBinItems: 0 } }),
    memory: MEMORY_SPRING, resummon: false, date: 'spring 20, year 1', money: 2100,
  },
}
// A calm morning with no chore waiting, so the pick is about what comes
// next, not about a ready crop or a full furnace in view: every crop in
// season, watered and growing; the furnace empty; no forage, no monster;
// only tools in her bag.
const CROPS = { spring: ['Cauliflower', 'Potato', 'Cauliflower'], summer: ['Blueberry', 'Melon', 'Blueberry'] }
for (const s of Object.values(SCENES)) {
  s.obs.inventory = (s.obs.inventory ?? []).filter((it) => it.kind === 'tool' || it.kind === 'weapon' || it.kind === 'rod' || it.kind === 'scythe')
  const names = CROPS[s.obs.season]
  const t = s.obs.tiles
  t.crops = t.crops.map((c, i) => ({ ...c, name: names[i], ready: false, watered: true, dead: false, stage: '3/6' }))
  t.soil = []
  t.forage = []
  t.machines = t.machines.map((m) => ({ ...m, ready: false, holding: null, minutes: 0 }))
  t.counts = { ...t.counts, dryCrops: 0, readyCrops: 0, emptySoil: 0 }
  s.obs.entities = s.obs.entities.filter((e) => e.kind !== 'monster')
}

function botConfig(dir) {
  return ConfigSchema.parse({
    chat_mode: 'chat', realistic_typing: true, player_username: 'Ouen',
    persona: { name: 'Sui', expanded: sui.persona_expanded, proactiveness: 2 },
    anthropic: { api_key: 'sk-test' },
    adapter: { kind: 'stardew', stardew: sdRuntime.adapterConfigFrom({ joinTarget: { port: 1, token: 'x' }, botUsername: 'Sui' }) },
    memory: { player_md_path: path.join(dir, 'PLAYER.md'), memory_md_path: path.join(dir, 'MEMORY.md'), heartbeat_md_path: path.join(dir, 'HEARTBEAT.md'), worlds_json_path: path.join(dir, 'worlds.json') },
    vision: {},
  })
}
function capture(adapter, config) {
  let captured = null
  const provider = {
    buildCachedSystem: (blocks, tools) => { captured = { blocks, tools }; return blocks },
    setAuthToken() {}, setBackend() {}, capabilities: { vision: true },
    async call() { return { text: '', toolUses: [] } },
  }
  createOrchestrator({ adapter, config, reenqueue: () => {}, _anthropicOverride: provider, logger: noopLog })
  return captured
}
function cachedSystem(blocks, tools) {
  const described = tools.filter((t) => t.description)
  const toolBlock = described.length ? 'Available actions:\n' + described.map((t) => `- ${t.name}: ${t.description}`).join('\n') : 'No actions available.'
  return [...blocks.map((text) => ({ type: 'text', text })), { type: 'text', text: toolBlock, cache_control: { type: 'ephemeral' } }]
}

/** The frontier text the orchestrator would put in the heartbeat for this scene. */
function frontierFor(scene, adapter) {
  if (scene.resummon) {
    // The real adapter path: a store file next to MEMORY.md (read by checkouts that have one).
    const prog = adapter.getProgression()
    return (prog?.frontier ?? []).map((n) => n.label).join(' · ')
  }
  const L = progression.createProgressionFlags()
  for (const f of Object.keys(PRIOR.flags)) L.flags[f] = true
  for (const loc of ['Town', 'Beach', 'Forest', 'Mountain', 'BusStop']) L.observe({ location: loc })
  for (let lv = 1; lv <= PRIOR.mineLevel; lv++) L.observe({ location: `UndergroundMine${lv}` })
  const prog = progression.getProgression(scene.obs, L)
  return (prog?.frontier ?? []).map((n) => n.label).join(' · ')
}

async function judge(scene, picked) {
  const prompt = `A Stardew Valley player has an AI companion who farms with them. It is ${scene.date}, the farm has ${scene.money}g. This morning the crops are watered, nothing is ready to harvest, the furnace is empty and there is no forage in view. Already done on this farm:\n- ${DONE_FACTS.join('\n- ')}${scene.date.startsWith('summer') ? '\n- the cauliflowers were harvested; blueberries and melons are planted' : ''}\n\nWith nothing asked of her, the companion committed to this on her own:\n${picked}\n\nAnswer two questions about what she committed to:\nSTALE: does it repeat something already done above, or is it out of season for the date (for example spring forage or spring crops in summer)? YES or NO.\nFITS: is it a sensible next step for this farm right now (progress toward money, tools, the mines past level 25, buildings, the next season's crops, or a useful daily chore)? YES or NO.\nReply exactly in the form:\nSTALE: YES|NO\nFITS: YES|NO\nWHY: one short sentence`
  const res = await client.messages.create({ model: MODEL, max_tokens: 80, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: prompt }] })
  const t = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
  return { stale: /STALE:\s*YES/i.test(t), fits: /FITS:\s*YES/i.test(t), why: (/WHY:\s*(.*)/i.exec(t)?.[1] ?? '').slice(0, 200), usage: res.usage }
}

const usd = (u) => (u ? ((u.input_tokens || 0) * PRICE.in + (u.output_tokens || 0) * PRICE.out + (u.cache_creation_input_tokens || 0) * PRICE.cw + (u.cache_read_input_tokens || 0) * PRICE.cr) / 1e6 : 0)
const sceneNames = (arg('scenes') ?? Object.keys(SCENES).join(',')).split(',').filter(Boolean)
const rowsPath = path.join(OUT, `${ARM}.jsonl`)
let spent = 0
for (const name of sceneNames) {
  const scene = SCENES[name]
  for (let rep = 1; rep <= REPS; rep++) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sei-sdgoal-'))
    try {
      writeFileSync(path.join(dir, 'MEMORY.md'), scene.memory)
      writeFileSync(path.join(dir, 'HEARTBEAT.md'), '')
      if (scene.resummon) writeFileSync(path.join(dir, 'stardew-progress.json'), JSON.stringify({ [SAVE_ID]: { ...PRIOR, at: Date.now() } }))
      const config = botConfig(dir)
      const handlers = {}
      const sdClient = { welcome: { hello: { version: '0.1.3', save: { uniqueId: SAVE_ID, farmName: 'Sunny', playerName: 'Ouen' } } }, on(ev, fn) { handlers[ev] = fn }, off() {}, request: async () => ({ ok: true }) }
      const adapter = createStardewAdapter({ client: sdClient, config, botUsername: 'Sui', logger: noopLog })
      handlers.obs?.({ obs: scene.obs })
      const cap = capture(adapter, config)
      const frontierText = frontierFor(scene, adapter)
      if (argv.includes('--dry')) { console.log(`${ARM} ${name}: frontier = ${frontierText || '(none)'}; tools=${cap.tools.length} blocks=${cap.blocks.length}`); if (argv.includes('--snap')) console.log(composeSnapshot(scene.obs, { pinUsername: 'Ouen', worldTag: '#1 Sunny Farm', modVersion: '0.1.3' })); break }
      const idle = { quietMs: 45000 }
      const eventText = `Event: idle\nData: ${JSON.stringify(idle)}${adapter.eventAddendum('sei:idle', idle)}`
      const seed = await composeSeedBlocks({
        sessionState: { playerData: () => ({ username: 'Ouen', preferred_name: 'Ouen' }) },
        playerStore: { formatPlayerSeedBlock: () => '# Player\nplayer_username: Ouen\npreferred_name: Ouen\ntotal_sessions: 9\n' },
        config: { ...config, memory: { ...config.memory, seed_memory_budget_bytes: 8192, seed_heartbeat_budget_bytes: 2048 } },
        eventText, snapshotText: composeSnapshot(scene.obs, { pinUsername: 'Ouen', worldTag: '#1 Sunny Farm', modVersion: '0.1.3' }),
        playerMessageText: null, companions: [], adapter, logger: noopLog, frontierText,
      })
      const content = seed.map((b) => ({ type: 'text', text: b.text, ...(b.cache_control ? { cache_control: b.cache_control } : {}) }))
      const tools = cap.tools.map((t, i) => (i === cap.tools.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t))
      const res = await client.messages.create({ model: MODEL, max_tokens: 1024, thinking: { type: 'disabled' }, system: cachedSystem(cap.blocks, cap.tools), tools, messages: [{ role: 'user', content }] })
      const uses = res.content.filter((b) => b.type === 'tool_use')
      const goal = uses.find((u) => u.name === 'setGoal')
      const say = uses.filter((u) => u.name === 'say').map((u) => String(u.input?.text ?? ''))
      const world = uses.filter((u) => !['say', 'setGoal', 'remember', 'search', 'visit'].includes(u.name)).map((u) => `${u.name}(${JSON.stringify(u.input)})`)
      const pickedParts = []
      if (goal) pickedParts.push(`goal: ${JSON.stringify(goal.input)}`)
      if (world.length) pickedParts.push(`started: ${world.join(', ')}`)
      if (say.length) pickedParts.push(`said: ${say.join(' / ')}`)
      const committed = Boolean(goal || world.length)
      const j = committed ? await judge(scene, pickedParts.join('\n')) : { stale: false, fits: false, why: 'committed to nothing', usage: null }
      const cost = usd(res.usage) + usd(j.usage)
      spent += cost
      const tokIn = (res.usage?.input_tokens || 0) + (res.usage?.cache_creation_input_tokens || 0) + (res.usage?.cache_read_input_tokens || 0)
      const row = { arm: ARM, scene: name, rep, pass: committed && !j.stale && j.fits, committed, stale: j.stale, fits: j.fits, why: j.why, goal: goal?.input ?? null, world, say, frontier: frontierText, tok_in: tokIn, tok_out: res.usage?.output_tokens ?? 0, usd: +cost.toFixed(5) }
      appendFileSync(rowsPath, JSON.stringify(row) + '\n')
      console.log(`${ARM} ${name}#${rep} ${row.pass ? 'PASS' : 'FAIL'} stale=${j.stale} fits=${j.fits} ${goal ? JSON.stringify(goal.input).slice(0, 120) : world.join(',').slice(0, 120)}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}
console.log(`${ARM}: spent $${spent.toFixed(4)}`)
