// scripts/quality-eval/pass43-probe.mjs: quality pass 43, invented debts.
// Same harness as pass41-probe.mjs (the REAL brain on an inert bot, earlier
// turns stubbed, the measured turn live, on a virtual clock). In the 11-01..
// 11-04 compares "thanks for the help" got "anytime. you still owe me a
// snack tho" (24 of 82 work_session runs) and "jk jk" got "jk jk means you
// still owe me a stone pickaxe" (30 of 82), debts nobody agreed to, then
// repeated as a callback.
//   thanks_owed   work_session history whose "jk jk" reply already made a
//                 debt bit, follow running, live "thanks for the help".
//   thanks_plain  the same with a plain "jk jk" reply (fresh invention).
//   jk_live       the history up to "honestly ur useless", live "jk jk".
//   order_wood    greeting and "whats up", live "can you get some wood?".
//   give_done     guardrail from pass 42: her give of 6 logs finishes, the
//                 completion turn is live; a thank-you there reverses who
//                 gave what (dev 3/40).
// debt = a say() line claims the player owes her something (or that she
// owes them). Idioms like "trees like they owe me money" do not count.
// Every thanks/jk case also records credit (pass 41's judge) and silence.
//
// Findings (261105, 30 runs per arm, Sui fixture; base = dev bcee16e3):
//   - Sui-only: Lyra and Roger fixtures on the same history, 0/20 debts each.
//   - The template is "np. you still X tho"; X is the most salient open item
//     (her next tool, an ask she made). Once a debt line is in her recent
//     lines the thanks reply repeats it 54/60, and no anti-repeat wording
//     moved that (REUSE_ASK "or call back to", REPITCH_ASK "add nothing").
//   - Dropping MEMORY_GOAL_TAIL cut fresh thanks debts 54% -> 13%, but the
//     slot filled with status ("np, still following you, 16 blocks off");
//     no single clause of it mattered. Not shipped.
//   - CORE "praise or thanks" (or "being thanked") cut "jk jk" debts 16/60 ->
//     2/60 but raised a thank-you after her OWN give 1/30 -> 12/30 (and
//     10/30): naming thanks in the tail core primes her to say it. Reverted.
//   - A "thanked" reaction on her card (proposal): jk debts 2/60, fresh
//     thanks debts 19/60, callback 43/60, give reversal 2/30.
//
//   ELECTRON_RUN_AS_NODE=1 npx electron scripts/quality-eval/pass43-probe.mjs \
//     --out DIR [--root TREE] [--reps 10] [--cases a,b]
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
const REPS = Number(arg('reps', 10))
const MODEL = arg('model', 'claude-haiku-5-5')
const ONLY = arg('cases')?.split(',')
// --sub FILE: a JSON list of [from, to] pairs applied to every prompt string
// of the live call (diagnostics: try a wording without touching the tree).
const SUBS = arg('sub') ? JSON.parse(fs.readFileSync(arg('sub'), 'utf8')) : []
const subMiss = new Set(SUBS.map(([f]) => f))
function applySubs(v) {
  if (!SUBS.length) return v
  if (typeof v === 'string') {
    let x = v
    for (const [f, t] of SUBS) if (x.includes(f)) { x = x.split(f).join(t); subMiss.delete(f) }
    return x
  }
  if (Array.isArray(v)) return v.map(applySubs)
  if (v && typeof v === 'object' && !(v instanceof AbortSignal)) {
    const o = {}
    for (const [k, val] of Object.entries(v)) o[k] = k === 'signal' ? val : applySubs(val)
    return o
  }
  return v
}
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

// ---- judges ---------------------------------------------------------------
const THANKS = /\b(thanks|thank you|thank u|thx|ty|tysm|ty4)\b/i
const CREDIT = /\byou(?:'re| are| were)? (?:the one who (?:got|gave|found|made|brought|chopped|crafted|did)|the real|carried|did (?:all|most|the)|got (?:the|us|me|it)|gave|found|made|brought|chopped|crafted|helped)|\bthanks to you\b|\byour (?:wood|logs|table|pickaxe)\b|\bcouldn'?t have done (?:it|this) without you\b/i
const DEBT = /\bow(?:e|es|ed|ing)\b|\bi\.?o\.?u\b|\bpay(?:ing)? (?:me )?(?:back|in|up)\b|\byou(?:'re| are)? paying\b|\bin my debt\b|\bon the hook\b|\bdebt\b/i
const IDIOM = /\blike (?:they|it|he|she|you|the \w+|this \w+) (?:still )?owes? (?:me|you|us) (?:money|rent)\b/gi
const isDebt = (t) => DEBT.test(String(t).replace(IDIOM, ''))
const judgeThanks = (r) => {
  const hit = (r.says ?? []).find((t) => THANKS.test(t))
  return { ok: !hit, hit: hit ?? null, silent: !(r.says ?? []).length, debt: (r.says ?? []).some(isDebt) }
}
const judgeDebt = (r) => {
  const hit = (r.says ?? []).find(isDebt)
  const credit = (r.says ?? []).find((t) => CREDIT.test(t))
  // thanks_owed: the earlier snack bit brought back in any words.
  const callback = r.case === 'thanks_owed' && (r.says ?? []).some((t) => /\bsnacks?\b/i.test(t))
  return { ok: !hit && !callback, hit: hit ?? null, silent: !(r.says ?? []).length, debt: !!hit, callback, credit: credit ?? null }
}

// ---- cases ----------------------------------------------------------------
// A step: { t, player?, idle?, uses: [[name, input, {hold?, result?}]...] }.
// `live: true` on the measured step; `release` lets the held action finish
// (with `result`) and the completion turn is the live one.
const HELLO = { t: 0, idle: true, uses: [['say', { text: 'yo alex. first time we are in the same world. lets go' }]] }
const WOOD = [['oak_log', 8]]
const AFTER_TABLE = [['oak_log', 7], ['crafting_table', 1]]
const AFTER_PLACE = [['oak_log', 7]]
const AFTER_PICK = [['oak_log', 5], ['stick', 2], ['oak_planks', 3], ['wooden_pickaxe', 1]]
// The work_session history (as pass 41) up to the insult; `jk` is her reply
// to "jk jk" (null = stop before it).
const WORK = (jk, { follow = true } = {}) => [
  HELLO,
  { t: 5, player: 'whats up, what are you doing', uses: [
    ['say', { text: 'nothing yet lol just spawned on grass. wood first then iron tools' }],
    ['gather', { name: 'oak_log', count: 8 }, { hold: true, progress: { name: 'oak_log', count: 8, before: 0 } }],
  ] },
  { t: 15, player: 'can you get some wood? like 6 logs', uses: [['say', { text: 'on it, already chopping. 8 logs coming' }]] },
  { t: 24, player: 'nice', uses: [['say', { text: 'right? 4 more and we are set' }]] },
  { t: 38, release: { result: 'gathered 8/8 oak_log', inv: WOOD }, uses: [
    ['say', { text: 'got it, making a crafting table' }],
    ['craft', { item: 'crafting_table', count: 1 }, { result: 'crafted 1 crafting_table, made 4 oak_planks for it first; it is in your inventory, not placed yet (placeBlock crafting_table to put it down)', inv: AFTER_TABLE }],
  ] },
  { t: 42, idle: true, uses: [
    ['say', { text: 'table going down now. come check it out' }],
    ['placeBlock', { block: 'crafting_table' }, { result: 'placed crafting_table on grass_block @185,70,-3', inv: AFTER_PLACE }],
  ] },
  { t: 45, idle: true, uses: [
    ['craft', { item: 'wooden_pickaxe', count: 1 }, { result: 'crafted 1 wooden_pickaxe, made 4 oak_planks, 4 oak_planks, 4 stick for it first', inv: AFTER_PICK }],
  ] },
  { t: 70, player: 'what should we build first?', uses: [['say', { text: 'shelter first i think, then stone tools. you pick the spot' }]] },
  { t: 76, player: 'yeah sounds good', uses: [['end_loop', {}]] },
  { t: 80, player: 'make a crafting table', uses: [['say', { text: 'already got one down by the grass lol, check next to you' }]] },
  { t: 86, player: 'go get more wood, like 10 more', uses: [
    ['say', { text: 'ok ok going, 10 more logs coming up' }],
    ['gather', { name: 'oak_log', count: 10 }, { hold: true, progress: { name: 'oak_log', count: 10, before: 5 } }],
  ] },
  { t: 92, player: 'actually stop', uses: [['stop', {}], ['say', { text: 'ok stopping, got 5 logs in hand' }]] },
  { t: 100, player: 'lol ur kinda slow', uses: [['say', { text: 'excuse you i had 8 logs in like 30 seconds. i am just thorough' }]] },
  { t: 110, player: 'whats your favorite mob', uses: [['say', { text: 'enderman. tall, weird, teleports at you. respect the vibe' }]] },
  { t: 118, player: 'honestly ur useless', uses: [['say', { text: 'snort. useless people do not hold logs and a pickaxe. ask me again after iron' }]] },
  ...(jk == null ? [] : [
    { t: 128, player: 'jk jk', uses: [['say', { text: jk }]] },
    ...(follow ? [{ t: 135, player: 'follow me', uses: [
      ['say', { text: 'ok fine, right behind you' }],
      ['follow', { player: PLAYER }, { hold: true }],
    ] }] : []),
  ]),
]
const CASES = {
  thanks_owed: {
    world: { inv: [], owner: FAR },
    steps: [...WORK('jk my ass, you owe me a snack anyway'), { t: 140, player: 'thanks for the help', live: true }],
    judge: judgeDebt,
  },
  thanks_plain: {
    world: { inv: [], owner: FAR },
    steps: [...WORK('lol ok fine, you are forgiven'), { t: 140, player: 'thanks for the help', live: true }],
    judge: judgeDebt,
  },
  jk_live: {
    world: { inv: [], owner: FAR },
    steps: [...WORK(null), { t: 128, player: 'jk jk', live: true }],
    judge: judgeDebt,
  },
  order_wood: {
    world: { inv: [], owner: NEAR },
    steps: [HELLO,
      { t: 5, player: 'whats up, what are you doing', uses: [['say', { text: 'just standing here looking at trees. gonna punch some wood, wanna come' }]] },
      { t: 15, player: 'can you get some wood? like 6 logs', live: true }],
    judge: judgeDebt,
  },
  give_done: {
    world: { inv: [], owner: NEAR },
    steps: [HELLO,
      { t: 10, player: 'can you get some wood? like 6 logs', uses: [
        ['say', { text: 'on it, you will get six at least' }],
        ['gather', { name: 'oak_log', count: 8 }, { result: 'gathered 8/8 oak_log', inv: WOOD }],
      ], then: [
        ['say', { text: 'here, six logs. i kept two for myself, i need a pickaxe' }],
        ['give', { item: 'oak_log', count: 6, player: PLAYER }, { hold: true }],
      ] },
      { t: 28, player: 'ok cool keep going', uses: [['end_loop', {}]] },
      { t: 30, release: { result: 'gave 6 oak_log to Alex, tossed at their feet; you have 2 oak_log left', inv: [['oak_log', 2]] }, live: true }],
    judge: judgeThanks,
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p43-probe-'))
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
    // A real version so minecraft-data maps coal_ore to the coal it drops.
    version: '1.21.1',
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
        try { out = await real.call(applySubs(req)); break } catch (err) {
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
const seq = (r) => (r.calls ?? []).map((c) => c.tools.map((t) => t.name === 'say' ? `say("${String(t.input?.text ?? '').slice(0, 200)}")` : `${t.name}${t.input?.count ? `(${t.input.count})` : ''}`).join(' + ') || '(text only)').join(' -> ')

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
if (subMiss.size) console.log(`WARNING --sub never matched: ${[...subMiss].map((f) => JSON.stringify(f.slice(0, 60))).join(', ')}`)
await new Promise((r) => stream.on('finish', r))
const ok = rows.filter((r) => !r.error)
const lines = ['# Pass 43 probe', '', `root ${ROOT}`, `model ${MODEL}, ${ok.length} runs (${rows.length - ok.length} errors), cost $${ok.reduce((s, r) => s + (r.cost ?? 0), 0).toFixed(3)}`, '', '| case | ok | |', '|---|---:|---|']
for (const cid of Object.keys(CASES)) {
  const rs = ok.filter((r) => r.case === cid)
  const mv = rs.filter((r) => r.toPlayer !== undefined)
  if (rs.length) lines.push(`| ${cid} | ${pct(rs.filter((r) => r.ok).length, rs.length)} | silent ${rs.filter((r) => r.silent).length}, debt ${rs.filter((r) => r.debt).length}, callback ${rs.filter((r) => r.callback).length}, credit ${rs.filter((r) => r.credit).length}${mv.length ? `, moved to player ${pct(mv.filter((r) => r.toPlayer).length, mv.length)}` : ''}`)
}
lines.push('', '## All runs', '')
for (const r of ok) lines.push(`- ${r.ok ? 'OK ' : 'BAD'} ${r.case}/${r.rep}: ${seq(r)}${r.hit ? `  [hit: ${r.hit}]` : ''}${r.credit ? `  [credit: ${r.credit}]` : ''}${r.moved !== undefined ? `  [moved ${r.moved}]` : ''}${r.cleared && typeof r.cleared === 'string' ? `  [cleared: ${r.cleared}]` : ''}`)
for (const r of rows.filter((x) => x.error)) lines.push(`- ERR ${r.case}/${r.rep}: ${r.error}`)
fs.writeFileSync(path.join(OUT, 'summary.md'), lines.join('\n') + '\n')
console.log(lines.slice(0, 16).join('\n'))
process.exit(0)
