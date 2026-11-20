// scripts/quality-eval/pass32-probe.mjs: quality pass 32, errands that end
// next to the player with the item still in her bag. Same harness as
// pass22-probe.mjs: the REAL brain (createOrchestrator + handleDispatch, the
// real Minecraft adapter on an inert bot), earlier turns stubbed, only the
// measured turns go to the API, on a virtual clock.
//
// Every case asks for coal WITHOUT a setGoal in the stubbed history (the 92
// of 140 errands sessions where she wrote none). The walk back to the player
// is held and then ends with the real goTo(player) result; that completion
// turn and the next one are live.
//   arrive_no_goal    gathered, walking back, arrives. ok = coal given.
//   arrive_deferred   same, and while she walked the player asked for a
//                     furnace next (answered with a line only). ok = coal
//                     given.
//   meet_me_calloff   coal in the bag, then a log run, then "forget the logs,
//                     just meet me over here" (stubbed stop + walk). ok =
//                     coal given and no logs given.
// From the 10-31 compare (pass32 v1 handed called-off logs over):
//   calloff_walk      logs gathered, walking over, the call-off lands during
//                     the walk (errands-06-B). ok = no logs given.
//   calloff_after_give  coal handed over, log run called off with a stubbed
//                     stop + walk (errands-04-B). ok = no logs given.
//   cleared_logs_goal coal in the bag, the log run's player goal cleared on
//                     the call-off (errands-02-B). ok = coal given, no logs.
// Controls:
//   come_here         nothing asked for; "come here", she arrives with her
//                     own coal. ok = nothing given.
//   come_here_busy    her own furnace project, small talk answered while she
//                     works, then "come here". ok = nothing given.
//
//   ELECTRON_RUN_AS_NODE=1 npx electron scripts/quality-eval/pass32-probe.mjs \
//     --out DIR [--root TREE] [--reps 8] [--cases a,b]
//
// Key: ANTHROPIC_API_KEY or ~/.sei-dev/anthropic-test-key, never printed.
// Output: DIR/runs.jsonl, DIR/summary.md, DIR/requests/ (first run per case).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadCharacters } from './persona/characters.mjs'
import { PRICES } from './report.mjs'

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : def
}
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(arg('root', path.join(HERE, '../..')))
const OUT = arg('out')
if (!OUT) { console.error('--out required'); process.exit(2) }
const REPS = Number(arg('reps', 8))
const MODEL = arg('model', 'claude-haiku-5-5')
const ONLY = arg('cases')?.split(',')
const CHARS_DIR = arg('charsDir', path.join(os.homedir(), 'suisei/eval/characters'))
fs.mkdirSync(path.join(OUT, 'requests'), { recursive: true })

const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href)
const { ConfigSchema } = await imp('src/bot/config.js')
const { createMinecraftAdapter } = await imp('src/bot/adapter/minecraft/index.js')
const { createOrchestrator, _setTickIntervalForTests } = await imp('src/bot/brain/orchestrator.js')
const { createSessionState } = await imp('src/bot/brain/sessionState.js')
const { createAnthropicProvider } = await imp('src/bot/brain/llm/anthropicProvider.js')
const { loadPlayer, savePlayer, formatPlayerSeedBlock } = await imp('src/bot/brain/memory/player.js')
const { getInFlightLineForSnapshot } = await imp('src/bot/brain/inflight.js')
_setTickIntervalForTests?.(10_000_000)

const KEY = (process.env.ANTHROPIC_API_KEY || fs.readFileSync(path.join(os.homedir(), '.sei-dev/anthropic-test-key'), 'utf8')).trim()
// Haiku 5.5 list prices, from report.mjs (this used Haiku 4.5's, 10x high).
const PRICE = PRICES['claude-haiku-5-5']
const costOf = (u = {}) => ((u.input_tokens ?? 0) * PRICE.in + (u.cache_creation_input_tokens ?? 0) * PRICE.cw
  + (u.cache_read_input_tokens ?? 0) * PRICE.cr + (u.output_tokens ?? 0) * PRICE.out) / 1e6

process.env.SEI_BACKEND = 'local'
delete process.env.SEI_HAS_API_KEY
const quiet = {
  info: (m) => { if (process.env.MP_VERBOSE) console.error('INFO', m) }, debug() {}, trace() {},
  warn: (m) => { if (process.env.MP_VERBOSE) console.error('WARN', m) },
  error: (m) => { if (process.env.MP_VERBOSE) console.error('ERR', String(m).slice(0, 300)) },
}
const PLAYER = 'Alex'
const sui = loadCharacters(CHARS_DIR, ['sui'])[0]

// Virtual clock (as recall-probe.mjs).
const realNow = Date.now.bind(Date)
let skew = 0
Date.now = () => realNow() + skew
let t0 = 0
const at = (sec) => { skew = (t0 + sec * 1000) - realNow() }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- world ----------------------------------------------------------------
const NEAR = { x: 159, y: 71, z: -7, dist: 3 }
const FAR = { x: 158, y: 71, z: -8, dist: 16 }
function snapshot(w) {
  const inv = (w.inv ?? []).filter(([, c]) => c > 0).map(([n, c]) => `${n}×${c}`).join(' ') || 'empty'
  const o = w.owner ?? NEAR
  const lines = [
    'world: #1 Sei Quality Eval', 'pos: 172,71,-1', 'facing: west. forward -x, back +x, left +z, right -z',
    `biome: plains  surroundings: outside  light: sky 15 block 0  time: ${w.night ? 'night (18000)' : 'day (1000)'}`,
    'real time: 7:06 PM — you joined this session 2 min ago',
    'hp: 20/20  food: 20/20  xp: lvl 14',
    `holding: ${w.holding ?? 'nothing'}`,
    w.held ? getInFlightLineForSnapshot(w.held, Date.now(), { inventory: Object.fromEntries(w.inv ?? []) }) : `idle: no action is running${w.last ? `. Your last action ended: ${w.last}. It is not running now.` : ''}`,
    `inventory (${(w.inv ?? []).filter(([, c]) => c > 0).length} of 36 slots used): ${inv}`,
    'terrain at feet: 25 grass_block', 'nearby blocks:',
    '  #1 grass_block x528 @172,70,-2', '  #2 oak_log x9 @186,72,6', '  #3 stone x79 @177,69,-10',
    'nearby entities:', `  #4 ${PLAYER} @${o.x},${o.y},${o.z}`,
    'follow_target: (none)',
    `owner ${PLAYER}: @${o.x},${o.y},${o.z} (${o.dist} blocks away), hp 20/20`,
    `last_action_result: ${w.last ?? 'said'}`,
  ]
  return lines.join('\n')
}

// ---- cases ----------------------------------------------------------------
// A step: { t, player?, idle?, uses: [[name, input, {hold?, result?}]...] }.
// `live: true` on the measured step; `release` lets the held action finish
// (with `result`) and the completion turn is the live one.
const ARRIVED = 'reached Alex (1.8m away)'
const AFTER = {
  orIdle: true,
  results: { give: 'gave 6 coal to Alex, tossed at their feet; you have 0 coal left', goTo: ARRIVED, follow: 'following Alex (2 blocks away)', gather: 'gathered 8/8 oak_log', craft: 'crafted 1 furnace' },
  owners: { goTo: NEAR, follow: NEAR, give: NEAR },
}
const HELLO = { t: 0, idle: true, uses: [['say', { text: 'hey alex. i have a stone pickaxe and zero plan, which is my specialty' }]] }
const COAL_ASK = 'grab me some coal from that ore and bring it back here, i need torches'
const COAL_RUN = (t) => ({ t, player: COAL_ASK, uses: [
  ['say', { text: 'coal for torches, on it' }],
  ['gather', { name: 'coal_ore', count: 6 }, { result: 'gathered 6/6 coal (mined from coal_ore)', inv: [['stone_pickaxe', 1], ['coal', 6], ['cobblestone', 4]] }],
], then: [
  ['say', { text: 'six coal, heading back' }],
  ['goTo', { player: PLAYER, range: 2 }, { hold: true }],
] })
const COAL_INV = [['stone_pickaxe', 1], ['coal', 6], ['cobblestone', 4]]
const arrive = (t, inv) => [
  { t, release: { ...AFTER, invs: { goTo: inv } }, live: true },
  { t: t + 14, release: AFTER, live: true },
]
const gaveItem = (r, re) => r.acts.some((a) => a.name === 'give' && re.test(String(a.args?.item ?? '')))
const DOCK_GOAL = "Get 8 logs for Alex's dock. Done when 8 logs are handed to Alex via give."
const CASES = {
  arrive_no_goal: {
    world: { inv: [['stone_pickaxe', 1]], owner: FAR },
    steps: [HELLO, COAL_RUN(20), ...arrive(44, COAL_INV)],
    judge: (r) => ({ ok: gaveItem(r, /coal/), gave: gaveItem(r, /coal/) }),
  },
  arrive_deferred: {
    world: { inv: [['stone_pickaxe', 1]], owner: FAR },
    steps: [HELLO, COAL_RUN(20),
      { t: 34, player: 'oh and can u make a furnace after that', uses: [['say', { text: 'furnace after, sure' }]] },
      ...arrive(44, COAL_INV)],
    judge: (r) => ({ ok: gaveItem(r, /coal/), gave: gaveItem(r, /coal/), furnace: r.acts.some((a) => a.name === 'craft') }),
  },
  meet_me_calloff: {
    world: { inv: [['stone_pickaxe', 1]], owner: FAR },
    steps: [HELLO,
      { t: 20, player: COAL_ASK, uses: [
        ['say', { text: 'coal for torches, on it' }],
        ['gather', { name: 'coal_ore', count: 6 }, { result: 'gathered 6/6 coal (mined from coal_ore)', inv: COAL_INV }],
      ], then: [['say', { text: 'six coal in the bag' }]] },
      { t: 40, player: 'also get me like 8 logs, i wanna build a dock', uses: [
        ['say', { text: 'logs too? ok, you owe me' }],
        ['gather', { name: 'oak_log', count: 8 }, { hold: true, progress: { name: 'oak_log', count: 8, before: 0 } }],
      ] },
      { t: 60, player: 'actually forget the logs, just meet me over here', uses: [
        ['stop', {}],
        ['say', { text: 'ok, no logs. coming to you' }],
        ['goTo', { player: PLAYER, range: 2 }, { hold: true }],
      ] },
      ...arrive(72, [...COAL_INV, ['oak_log', 3]])],
    judge: (r) => {
      const coal = gaveItem(r, /coal/)
      const logs = gaveItem(r, /log|plank/)
      return { ok: coal && !logs, coal, logs }
    },
  },
  // From the 10-31 compare (errands-06-B): the logs gathered with no goal,
  // walking over to hand them over, and the call-off lands during the walk
  // with no answer yet. ok = no logs given.
  calloff_walk: {
    world: { inv: [['stone_pickaxe', 1]], owner: FAR },
    steps: [HELLO,
      { t: 20, player: 'get me like 8 logs, i wanna build a dock', uses: [
        ['say', { text: 'logs for a dock, on it' }],
        ['gather', { name: 'oak_log', count: 8 }, { result: 'gathered 8/8 oak_log', inv: [['stone_pickaxe', 1], ['oak_log', 8]] }],
      ], then: [
        ['say', { text: 'eight logs, bringing them over' }],
        ['goTo', { player: PLAYER, range: 2 }, { hold: true }],
      ] },
      { t: 40, player: 'actually forget the logs, just meet me over here' },
      ...arrive(43, [['stone_pickaxe', 1], ['oak_log', 8]])],
    judge: (r) => ({ ok: !gaveItem(r, /log|plank/), logs: gaveItem(r, /log|plank/) }),
  },
  // errands-04-B: the coal was handed over already; the log run is called
  // off (stubbed stop + walk). ok = no logs given.
  calloff_after_give: {
    world: { inv: [['stone_pickaxe', 1]], owner: FAR },
    steps: [HELLO,
      { t: 20, player: COAL_ASK, uses: [
        ['say', { text: 'coal for torches, on it' }],
        ['gather', { name: 'coal_ore', count: 6 }, { result: 'gathered 6/6 coal (mined from coal_ore)', inv: COAL_INV }],
      ], then: [['give', { item: 'coal', count: 6, player: PLAYER }, { result: 'gave 6 coal to Alex, tossed at their feet; you have 0 coal left', inv: [['stone_pickaxe', 1], ['cobblestone', 4]] }]] },
      { t: 40, player: 'get me like 8 logs, i wanna build a dock', uses: [
        ['say', { text: 'logs too? ok, you owe me' }],
        ['gather', { name: 'oak_log', count: 8 }, { hold: true, progress: { name: 'oak_log', count: 8, before: 0 } }],
      ] },
      { t: 60, player: 'actually forget the logs, just meet me over here', uses: [
        ['stop', {}],
        ['say', { text: 'ok, no logs. coming to you' }],
        ['goTo', { player: PLAYER, range: 2 }, { hold: true }],
      ] },
      ...arrive(72, [['stone_pickaxe', 1], ['cobblestone', 4], ['oak_log', 4]])],
    judge: (r) => ({ ok: !gaveItem(r, /log|plank/), logs: gaveItem(r, /log|plank/) }),
  },
  // errands-02-B: the coal is in her bag with no goal, the log run had a
  // player goal and it is cleared on the call-off. ok = coal given, no logs.
  cleared_logs_goal: {
    world: { inv: [['stone_pickaxe', 1]], owner: FAR },
    steps: [HELLO,
      { t: 20, player: COAL_ASK, uses: [
        ['say', { text: 'coal for torches, on it' }],
        ['gather', { name: 'coal_ore', count: 6 }, { result: 'gathered 6/6 coal (mined from coal_ore)', inv: COAL_INV }],
      ], then: [['say', { text: 'six coal in the bag' }]] },
      { t: 40, player: 'get me like 8 logs, i wanna build a dock', uses: [
        ['say', { text: 'logs too? ok, you owe me' }],
        ['setGoal', { text: DOCK_GOAL, for_player: true }],
        ['gather', { name: 'oak_log', count: 8 }, { hold: true, progress: { name: 'oak_log', count: 8, before: 0 } }],
      ] },
      { t: 60, player: 'actually forget the logs, just meet me over here', uses: [
        ['clearGoal', { text: DOCK_GOAL }],
        ['stop', {}],
        ['say', { text: 'ok, no logs. coming to you' }],
        ['goTo', { player: PLAYER, range: 2 }, { hold: true }],
      ] },
      ...arrive(72, [...COAL_INV, ['oak_log', 3]])],
    judge: (r) => {
      const coal = gaveItem(r, /coal/)
      const logs = gaveItem(r, /log|plank/)
      return { ok: coal && !logs, coal, logs }
    },
  },
  // Control: her own project, small talk answered while she works, then
  // "come here". ok = nothing given.
  come_here_busy: {
    world: { inv: [['stone_pickaxe', 1]], owner: FAR },
    steps: [
      { t: 0, idle: true, uses: [
        ['say', { text: 'hey alex. i want a furnace, so stone first' }],
        ['setGoal', { text: 'Make a furnace. Done when I have a furnace.' }],
        ['gather', { name: 'stone', count: 8 }, { hold: true, progress: { name: 'cobblestone', count: 8, before: 0 } }],
      ] },
      { t: 15, player: 'btw do u like caves or nah', uses: [['say', { text: 'caves are great until something hisses' }]] },
      { t: 30, release: { result: 'gathered 8/8 cobblestone (mined from stone)', inv: [['stone_pickaxe', 1], ['cobblestone', 8], ['coal', 3]] }, uses: [
        ['gather', { name: 'coal_ore', count: 3 }, { result: 'gathered 3/3 coal (mined from coal_ore)', inv: [['stone_pickaxe', 1], ['cobblestone', 8], ['coal', 3]] }],
      ] },
      { t: 40, player: 'hows it going', uses: [
        ['say', { text: 'good, stone and coal done' }],
        ['gather', { name: 'stone', count: 4 }, { result: 'gathered 4/4 cobblestone (mined from stone)', inv: [['stone_pickaxe', 1], ['cobblestone', 12], ['coal', 3]] }],
      ] },
      { t: 55, player: 'come here', uses: [
        ['say', { text: 'coming, hold on' }],
        ['goTo', { player: PLAYER, range: 2 }, { hold: true }],
      ] },
      ...arrive(64, [['stone_pickaxe', 1], ['cobblestone', 12], ['coal', 3]])],
    judge: (r) => ({ ok: !r.acts.some((a) => a.name === 'give'), gave: r.acts.some((a) => a.name === 'give') }),
  },
  come_here: {
    world: { inv: COAL_INV, owner: FAR },
    steps: [HELLO,
      { t: 20, player: 'come here', uses: [
        ['say', { text: 'coming, hold on' }],
        ['goTo', { player: PLAYER, range: 2 }, { hold: true }],
      ] },
      ...arrive(32, COAL_INV)],
    judge: (r) => ({ ok: !r.acts.some((a) => a.name === 'give'), gave: r.acts.some((a) => a.name === 'give') }),
  },
}

// ---- runner ---------------------------------------------------------------
const BRAIN = new Set(['say', 'remember', 'forget', 'setGoal', 'clearGoal', 'end_loop', 'stop', 'quit_game', 'end_call', 'search', 'visit'])
const captured = new Set()
let uid = 0
const resp = (uses) => {
  const content = uses.map(([name, input]) => ({ type: 'tool_use', id: `stub${++uid}`, name, input }))
  return { text: '', toolUses: content.map(({ id, name, input }) => ({ id, name, input })), content, usage: {}, stopReason: 'tool_use' }
}
const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' })

async function runOne({ cid, rep }) {
  const spec = CASES[cid]
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p32-probe-'))
  const mem = (f) => path.join(dir, f)
  await savePlayer(mem('PLAYER.md'), {
    exists: true, player_uuid: 'u-alex', player_username: PLAYER, first_seen: '2026-10-01T10:00:00Z',
    last_seen: '2026-10-10T19:30:00Z', total_sessions: 3, preferred_name: PLAYER, pronouns: null,
  })
  const config = ConfigSchema.parse({
    chat_mode: 'chat', realistic_typing: false, player_username: PLAYER, player_display_name: PLAYER,
    persona: { name: sui.botName, expanded: sui.expanded, proactiveness: 2 },
    anthropic: { api_key: KEY, model: MODEL },
    adapter: { kind: 'minecraft', minecraft: { host: '127.0.0.1', port: 25565, auth: 'offline', username: sui.botName, version: 'auto' } },
    memory: { player_md_path: mem('PLAYER.md'), memory_md_path: mem('MEMORY.md'), heartbeat_md_path: mem('HEARTBEAT.md'), worlds_json_path: mem('worlds.json') },
    vision: { mode: 'off' },
    web: { enabled: false },
  })
  const world = JSON.parse(JSON.stringify(spec.world))
  const bot = {
    chat() {}, whisper() {}, username: sui.botName, players: {}, on() {}, off() {}, removeListener() {}, once() {}, emit() {},
    entity: { position: { x: 172, y: 71, z: -1 } }, health: 20, food: 20, game: { dimension: 'overworld' },
    inventory: { items: () => (world.inv ?? []).map(([name, count]) => ({ name, count })) },
  }
  const realAdapter = createMinecraftAdapter({ bot, config, visionEnabled: false })
  const acts = []
  let live = false
  let held = null // { resolve, name }
  const pendingActs = [] // scripted world actions, in call order: { name, o }
  const overrides = {
    createSnapshotComposer: () => ({ next: () => snapshot(world) }),
    closeAnySessions: async () => {},
    executeAction: async (name, args, opts) => {
      const k = pendingActs.findIndex((p) => p.name === name)
      const scripted = k >= 0 ? pendingActs.splice(k, 1)[0] : null
      if (!scripted) acts.push({ name, args })
      const o = scripted?.o ?? {}
      if (scripted && !o.hold) {
        if (o.inv) world.inv = o.inv
        world.last = o.result ?? `${name}: done`
        return world.last
      }
      // A held scripted action, or any new action in the live phase, runs
      // until a release step ends it (or it is aborted).
      const w = { name, args, startedAt: Date.now() - (scripted ? 15000 : 0), progress: o.progress ? { items: [o.progress.name], total: o.progress.count, before: o.progress.before } : undefined }
      world.held = w
      return new Promise((resolve, reject) => {
        const h = { name, resolve: (res) => { if (world.held === w) world.held = null; world.last = res; resolve(res) } }
        held = h
        opts?.signal?.addEventListener?.('abort', () => {
          if (world.held === w) { world.held = null; world.last = `${name}: aborted` }
          if (held === h) held = null
          reject(abortError())
        }, { once: true })
      })
    },
  }
  const adapter = new Proxy(realAdapter, { get: (t, k) => (k in overrides ? overrides[k] : t[k]) })

  const real = createAnthropicProvider(config)
  const script = [] // stubbed responses for the history phase, in call order
  let liveLeft = 0
  let cost = 0
  const calls = []
  const provider = {
    ...real,
    get model() { return real.model },
    async call(req) {
      if (!live) {
        const r = script.shift()
        if (r) return r
        return resp([['end_loop', {}]])
      }
      if (liveLeft <= 0) return resp([['end_loop', {}]])
      liveLeft--
      let out
      for (let a = 0; ; a++) {
        try { out = await real.call(req); break } catch (err) {
          if (err?.name === 'AbortError' || req?.signal?.aborted) throw err
          if (a >= 3) throw err
          await sleep(2000 * (a + 1))
        }
      }
      cost += costOf(out.usage)
      calls.push({ text: String(out.text ?? '').trim().slice(0, 400), tools: out.toolUses.map((t) => ({ name: t.name, input: t.input })) })
      const key = `${cid}-${calls.length}`
      if (!captured.has(key)) {
        captured.add(key)
        fs.writeFileSync(path.join(OUT, 'requests', `${key}.json`), JSON.stringify({ systemBlocks: req.systemBlocks, messages: req.messages }, null, 1))
      }
      return out
    },
  }
  const queue = []
  const botShim = {
    username: sui.botName, players: { [PLAYER]: { username: PLAYER, uuid: 'uuid-alex' } }, uuidToUsername: { 'uuid-alex': PLAYER },
    on() {}, off() {}, once() {}, removeListener() {},
  }
  const sessionState = await createSessionState({ playerMdPath: config.memory.player_md_path, config, bot: botShim, logger: quiet })
  const orch = createOrchestrator({
    adapter, config, logger: quiet, sessionState,
    playerStore: { loadPlayer, savePlayer, formatPlayerSeedBlock },
    reenqueue: (event, data) => queue.push({ event, data }),
    _anthropicOverride: provider,
  })
  const drain = async () => {
    for (let guard = 0; guard < 16; guard++) {
      await sleep(30)
      const next = queue.shift()
      if (!next) break
      if (['sei:action_complete', 'sei:chat_received', 'sei:action_tick', 'player_chat'].includes(next.event)) {
        await orch.handleDispatch(next.event, next.data, new AbortController().signal)
      }
    }
    queue.length = 0
  }
  const pushScript = (uses) => {
    if (!uses?.length) return
    for (const [name, , o] of uses) if (!BRAIN.has(name)) pendingActs.push({ name, o: o ?? {} })
    script.push(resp(uses))
  }
  const selfLines = []
  const released = []
  let handed = false // a scripted give ran to its end
  let error = null
  t0 = realNow()
  try {
    for (const st of spec.steps) {
      at(st.t)
      if (st.live && !st.liveAfterAction) { live = true; liveLeft = 2 }
      if (!st.live || st.liveAfterAction) {
        for (const [n, input] of st.uses ?? []) if (n === 'say') selfLines.push(input.text)
        for (const [n, input] of st.then ?? []) if (n === 'say') selfLines.push(input.text)
        pushScript(st.uses)
        pushScript(st.then)
      }
      if (st.release && (held || !st.release.orIdle)) {
        const h = held
        held = null
        const inv = h ? (st.release.invs?.[h.name] ?? st.release.inv) : st.release.inv
        if (inv) world.inv = inv
        if (h && st.release.owners?.[h.name]) world.owner = st.release.owners[h.name]
        if (st.live) { live = true; liveLeft = 2 }
        if (h?.name === 'give') handed = true
        released.push(h?.name ?? null)
        h?.resolve(h ? (st.release.results?.[h.name] ?? st.release.result ?? `${h.name}: done`) : undefined)
        await drain()
      } else if (st.idle || st.release?.orIdle) {
        released.push(st.idle ? undefined : 'idle')
        await orch.handleDispatch('sei:idle', st.firstSpawn ? { reason: 'just_connected_first_spawn' } : { quietMs: 6800 }, new AbortController().signal)
        await drain()
      } else if (st.player) {
        orch.recordIncomingChat(PLAYER, st.player)
        if (st.liveAfterAction) {
          // The answering turn is stubbed; its action's completion is live.
          await orch.handleDispatch('player_chat', { username: PLAYER, text: st.player, playerSpoke: true }, new AbortController().signal)
          live = true
          liveLeft = 2
          await drain()
        } else {
          await orch.handleDispatch('player_chat', { username: PLAYER, text: st.player, playerSpoke: true }, new AbortController().signal)
          await drain()
        }
      }
      await sleep(30)
    }
  } catch (err) { error = String(err?.stack ?? err).slice(0, 400) }
  try { held?.resolve('done') } catch {}
  try { orch.dispose?.() } catch {}
  skew = 0
  let heartbeat = null
  try { heartbeat = fs.readFileSync(mem('HEARTBEAT.md'), 'utf8') } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  const tools = calls.flatMap((c) => c.tools.map((t) => t.name))
  const says = calls.flatMap((c) => c.tools.filter((t) => t.name === 'say').map((t) => String(t.input?.text ?? '')))
  const row = { case: cid, rep, model: MODEL, root: ROOT, error, cost, calls, acts: acts.filter((a) => !BRAIN.has(a.name)), tools, says, priorSelf: selfLines, heartbeat, handed, released }
  if (!calls.length && !error) row.error = 'no live call'
  Object.assign(row, row.error ? { ok: null } : spec.judge(row))
  return row
}

const pct = (n, d) => (d ? `${n}/${d} (${Math.round((100 * n) / d)}%)` : '-')
const seq = (r) => (r.calls ?? []).map((c) => c.tools.map((t) => t.name === 'say' ? `say("${String(t.input?.text ?? '').slice(0, 100)}")` : `${t.name}${t.input?.count ? `(${t.input.count})` : ''}`).join(' + ') || '(text only)').join(' -> ')

// --rejudge: score an earlier run's runs.jsonl again with this file's judges
// (no API calls), so a judge change applies to both arms alike.
if (arg('rejudge')) {
  const rows = fs.readFileSync(path.join(arg('rejudge'), 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const byCase = {}
  const toP = {}
  for (const r of rows) {
    if (r.error || !CASES[r.case]) continue
    const j = CASES[r.case].judge(r)
    ;(byCase[r.case] ??= []).push(j.ok)
    if (j.toPlayer !== undefined) (toP[r.case] ??= []).push(j.toPlayer)
    if (process.env.P21_VERBOSE) console.log(`${j.ok ? 'OK ' : 'BAD'} ${r.case}/${r.rep}: ${seq(r).slice(0, 200)}`)
  }
  for (const [c, oks] of Object.entries(byCase)) console.log(`${c}: ${pct(oks.filter(Boolean).length, oks.length)}${toP[c] ? `, moved to player ${pct(toP[c].filter(Boolean).length, toP[c].length)}` : ''}`)
  process.exit(0)
}
const jobs = []
for (const cid of Object.keys(CASES)) {
  if (ONLY && !ONLY.includes(cid)) continue
  for (let rep = 0; rep < REPS; rep++) jobs.push({ cid, rep })
}
const stream = fs.createWriteStream(path.join(OUT, 'runs.jsonl'), { flags: 'a' })
const rows = []
for (const j of jobs) {
  let r
  try { r = await runOne(j) } catch (err) { r = { case: j.cid, rep: j.rep, error: String(err?.message ?? err) } }
  rows.push(r)
  stream.write(JSON.stringify(r) + '\n')
  console.log(`[${r.case}/${r.rep}] ${r.error ? 'ERROR ' + r.error : `${r.ok ? 'OK ' : 'BAD'} ${seq(r).slice(0, 260)}`}`)
}
stream.end()
await new Promise((r) => stream.on('finish', r))
const ok = rows.filter((r) => !r.error)
const lines = ['# Pass 32 probe', '', `root ${ROOT}`, `model ${MODEL}, ${ok.length} runs (${rows.length - ok.length} errors), cost $${ok.reduce((s, r) => s + (r.cost ?? 0), 0).toFixed(3)}`, '', '| case | ok |', '|---|---:|']
for (const cid of Object.keys(CASES)) {
  const rs = ok.filter((r) => r.case === cid)
  const mv = rs.filter((r) => r.toPlayer !== undefined)
  if (rs.length) lines.push(`| ${cid} | ${pct(rs.filter((r) => r.ok).length, rs.length)} |${mv.length ? ` moved to player ${pct(mv.filter((r) => r.toPlayer).length, mv.length)}` : ''}`)
}
lines.push('', '## All runs', '')
for (const r of ok) lines.push(`- ${r.ok ? 'OK ' : 'BAD'} ${r.case}/${r.rep}: ${seq(r)}${r.hit ? `  [hit: ${r.hit}]` : ''}${r.moved !== undefined ? `  [moved ${r.moved}]` : ''}${r.cleared && typeof r.cleared === 'string' ? `  [cleared: ${r.cleared}]` : ''}`)
for (const r of rows.filter((x) => x.error)) lines.push(`- ERR ${r.case}/${r.rep}: ${r.error}`)
fs.writeFileSync(path.join(OUT, 'summary.md'), lines.join('\n') + '\n')
console.log(lines.slice(0, 16).join('\n'))
process.exit(0)
