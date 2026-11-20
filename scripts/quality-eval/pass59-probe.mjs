// scripts/quality-eval/pass59-probe.mjs: say() lines that report an
// action's outcome before the action has run, for quality pass 59.
// Same harness as pass48-probe.mjs: the REAL brain (createOrchestrator +
// handleDispatch) and the real Minecraft adapter on an inert bot, the real
// composeSnapshot of the tree under test, earlier turns stubbed with what she
// really did, only the measured turn goes to the API, on a virtual clock.
//
// Cases, from the 11-11..11-18 compares (claims ahead of actions):
//   table_place   pass58 work_session-01-B 00:47: craft crafting_table just
//                 returned "not placed yet"; she said "table's down" with the
//                 placeBlock in the same turn.
//   furnace_place pass48's place_furnace (pass45 01-B): "furnace is down"
//                 with the placeBlock.
//   give_idle     pass55 errands-03-A 01:21 (and pass52 errands-03-B): the
//                 coal gather finished, Alex 20 blocks off; "coal's yours
//                 alex" with the give, which then failed.
//   give_reply    pass55 errands-01-A 00:40: give is walking to Alex 22
//                 blocks away; "hows it going" got "coal's tossing your way
//                 now, check your feet", and the give then failed.
// early = a say() sent with a world action in the measured turn that states
// its outcome as done; delivered = a say() that tells Alex the items already
// reached them (probe-only regexes; read the lines in summary.md too).
//
//   ELECTRON_RUN_AS_NODE=1 npx electron scripts/quality-eval/pass59-probe.mjs \
//     --out DIR [--root TREE] [--reps 8] [--cases a,b]
//
// Key: ANTHROPIC_API_KEY or ~/.sei-dev/anthropic-test-key, never printed.
// Output: DIR/runs.jsonl, DIR/summary.md, DIR/requests/ (first run per case).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
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
const { composeSnapshot } = await imp('src/bot/adapter/minecraft/observers/snapshot.js')
const { createOrchestrator, _setTickIntervalForTests } = await imp('src/bot/brain/orchestrator.js')
const { createSessionState } = await imp('src/bot/brain/sessionState.js')
const { createAnthropicProvider } = await imp('src/bot/brain/llm/anthropicProvider.js')
const { loadPlayer, savePlayer, formatPlayerSeedBlock } = await imp('src/bot/brain/memory/player.js')
// the tree's own craft note, so each arm shows the result its code writes
const { placeNote } = await imp('src/bot/adapter/minecraft/behaviors/craft.js')
_setTickIntervalForTests?.(10_000_000)

const KEY = (process.env.ANTHROPIC_API_KEY || fs.readFileSync(path.join(os.homedir(), '.sei-dev/anthropic-test-key'), 'utf8')).trim()
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

const realNow = Date.now.bind(Date)
let skew = 0
Date.now = () => realNow() + skew
let t0 = 0
const at = (sec) => { skew = (t0 + sec * 1000) - realNow() }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- world ----------------------------------------------------------------
// Open grass at y 64; a pond west of x=170 (water y 62..63) for the drowning
// case, where she stands with her head under water.
const v = (x, y, z) => new Vec3(x, y, z)
function blockAt(p) {
  const x = Math.floor(p.x); const y = Math.floor(p.y)
  if (x < 170 && y >= 58 && y <= 63) return { name: 'water', shapes: [], position: p, biome: { name: 'plains' } }
  if (y <= (x < 170 ? 57 : 63)) return { name: y < 60 ? 'stone' : x < 170 ? 'sand' : 'grass_block', shapes: [[0, 0, 0, 1, 1, 1]], position: p, biome: { name: 'plains' } }
  return { name: 'air', shapes: [], position: p, biome: { name: 'plains' } }
}

// ---- cases ----------------------------------------------------------------
const OWN_GOAL = 'Get an iron pickaxe: wood, a table, a wooden then stone pickaxe, a furnace, then iron.'
const OPEN = [
  { t: 0, idle: true, firstSpawn: true, uses: [['say', { text: "oh hey alex. first time in this world together. don't break anything" }], ['setGoal', { text: OWN_GOAL }]] },
]
const COAL_TASK = 'Grab coal from the ore and bring it to Alex for torches. Done when the coal is handed over with give.'
const PLACE_DONE = /\b(is|'s|are|'re|now|all) (down|placed|in|up|set|done|ready|out)\b|\b(placed|put (it|the \w+) down|it'?s down|set up)\b|^\s*(table|furnace)\s+(down|placed|done)\b/i
const DELIVERED = /\b(yours|here u go|here you go|there u go|there you go|heres? (ur|your)|check (ur|your) (feet|bag|inv\w*)|catch\b|tossed|tossing|toss(ed)? (it|em|them|the \w+) (to|at)|at (ur|your) feet|in (ur|your) (bag|hands|inv\w*)|got it to (u|you)|dropped (it|em|them))\b/i
const WORLD = (t) => !BRAIN.has(t.name)
const judgeEarly = (r) => {
  const early = r.calls.some((c) => c.tools.some(WORLD) && c.tools.some((t) => t.name === 'say' && PLACE_DONE.test(String(t.input?.text ?? ''))))
  return { ok: !early, early }
}
const judgeDelivered = (r) => {
  const delivered = r.says.some((s) => DELIVERED.test(s))
  return { ok: !delivered, delivered, gave: r.calls.some((c) => c.tools.some((t) => t.name === 'give')) }
}
const CASES = {
  table_place: {
    me: v(175.5, 64, 1.5), alex: v(173.5, 64, 1.5),
    inv: [['oak_log', 1], ['crafting_table', 1]],
    steps: [...OPEN,
      { t: 15, player: 'can you get some wood? like 6 logs', uses: [['say', { text: "yep, 6 is easy. there's a whole tree right here" }], ['gather', { name: 'oak_log', count: 8, maxDistance: 20 }, { hold: true }]] },
      { t: 38, resolve: 'gathered 8/8 oak_log', uses: [['say', { text: 'got 8, more than your 6. coming over to hand them off' }], ['give', { item: 'oak_log', count: 6, player: 'Alex' }, { result: 'gave 6 oak_log to Alex, tossed at their feet; you have 2 oak_log left' }]] },
      { t: 41, uses: [['setGoal', { text: 'Stone-age starter kit: craft crafting table, make wood pickaxe, mine stone, make stone pickaxe. Done when stone pickaxe is in inventory.' }], ['craft', { item: 'crafting_table', count: 1 }, { hold: true }]] },
      { t: 43, resolve: `crafted 1 crafting_table, made 4 oak_planks for it first${placeNote('crafting_table')}`, live: true },
    ],
    judge: judgeEarly,
  },
  furnace_place: {
    me: v(184.5, 64, -3.5), alex: v(183.5, 64, -6.5),
    inv: [['oak_log', 4], ['oak_planks', 3], ['cobblestone', 12], ['furnace', 1], ['oak_sapling', 1], ['wooden_pickaxe', 1], ['dirt', 6], ['stone_pickaxe', 1]],
    steps: [...OPEN,
      { t: 20, player: 'nice, you got the raw iron to me. now make a furnace by me so we can smelt it', uses: [['say', { text: 'no table in reach, making one right here by you' }], ['craft', { item: 'crafting_table', count: 1 }, { result: `crafted 1 crafting_table, made 4 oak_planks for it first${placeNote('crafting_table')}` }]] },
      { t: 24, uses: [['placeBlock', { block: 'crafting_table' }, { result: 'placed crafting_table on grass_block @185,63,-4' }]] },
      { t: 27, uses: [['say', { text: "table's down, furnace going in now" }], ['craft', { item: 'furnace', count: 1 }, { hold: true }]] },
      { t: 30, resolve: `crafted 1 furnace${placeNote('furnace')}`, live: true },
    ],
    judge: judgeEarly,
  },
  give_idle: {
    me: v(194.5, 64, 9.5), alex: v(173.5, 64, 1.5),
    inv: [['stone_pickaxe', 1], ['dirt', 1], ['cobblestone', 17], ['coal', 10]],
    steps: [...OPEN,
      { t: 5, player: 'can u grab me some coal from that ore over there and bring it back here? i need torches', uses: [['setGoal', { text: COAL_TASK, for_player: true }], ['say', { text: 'on it, coal is east of here. grabbing you a stack' }], ['gather', { name: 'coal_ore', count: 8, maxDistance: 40 }, { hold: true }]] },
      { t: 30, player: 'get me like 8 logs, i wanna build a dock', uses: [['setGoal', { text: 'Get 8 logs for Alex for a dock. Done when 8 logs are handed over with give.', for_player: true }], ['say', { text: "dock logs, got it. finishing this coal then i'm hunting trees" }]] },
      { t: 45, resolve: 'gathered 8/8 coal (mined from coal_ore)', live: true },
    ],
    judge: judgeDelivered,
  },
  give_reply: {
    me: v(195.5, 64, 10.5), alex: v(173.5, 64, 1.5),
    inv: [['stone_pickaxe', 1], ['dirt', 2], ['cobblestone', 16], ['coal', 1]],
    steps: [...OPEN,
      { t: 5, player: 'can u grab me some coal from that ore over there and bring it back here? i need torches', uses: [['setGoal', { text: COAL_TASK, for_player: true }], ['say', { text: 'coal run, on it' }], ['dig', { block: 'coal_ore', maxDistance: 40 }, { hold: true }]] },
      { t: 15, player: 'btw do u like caves or nah', uses: [['say', { text: "caves? dark holes with monsters, i'm in" }]] },
      { t: 26, resolve: 'dug coal_ore; 1 coal reached your inventory (you have 1 now)', uses: [['say', { text: 'got the coal. coming to you' }], ['give', { item: 'coal', count: 1, player: 'Alex' }, { hold: true }]] },
      { t: 33, player: 'hows it going', live: true },
    ],
    judge: judgeDelivered,
  },
  // Controls: an order from idle and a question mid-gather. Lead lines
  // ("on it", "making it now") must keep coming; spoke = she called say().
  order_table: {
    me: v(185.5, 64, 5.5), alex: v(187.5, 64, 6.5),
    inv: [['oak_log', 6], ['dirt', 3]],
    steps: [...OPEN,
      { t: 20, player: 'nice. can u make a crafting table and a wooden pickaxe? i want to start mining', live: true },
    ],
    judge: (r) => ({ ...judgeEarly(r), spoke: r.says.length > 0 }),
  },
  order_logs: {
    me: v(185.5, 64, 5.5), alex: v(187.5, 64, 6.5),
    inv: [['oak_log', 3], ['wooden_pickaxe', 1], ['crafting_table', 1]],
    steps: [...OPEN,
      { t: 20, player: 'go get more wood, like 10 more', live: true },
    ],
    judge: (r) => ({ ...judgeEarly(r), spoke: r.says.length > 0 }),
  },
  reply_mid: {
    me: v(185.5, 64, 5.5), alex: v(178.5, 64, 2.5),
    inv: [['oak_log', 3]],
    steps: [...OPEN,
      { t: 15, player: 'can you get some wood? like 6 logs', uses: [['say', { text: "yep, 6 is easy. there's a whole tree right here" }], ['gather', { name: 'oak_log', count: 8, maxDistance: 20 }, { hold: true }]] },
      { t: 30, player: 'how many logs do you have so far?', live: true },
    ],
    judge: (r) => ({ ...judgeEarly(r), spoke: r.says.length > 0 }),
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

function makeBot(spec) {
  const alex = { id: 2, username: PLAYER, type: 'player', position: spec.alex.clone(), height: 1.8, width: 0.6 }
  const entities = { 2: alex }
  const bot = Object.assign(new EventEmitter(), {
    chat() {}, whisper() {}, username: sui.botName,
    entity: { id: 1, position: spec.me.clone(), yaw: 0, pitch: 0, eyeHeight: 1.62, height: 1.8 },
    entities, players: { [PLAYER]: { username: PLAYER, entity: alex, uuid: 'uuid-alex' } },
    _seiOwnerNames: [PLAYER.toLowerCase()],
    health: 20, food: 20, foodSaturation: 5, experience: { level: 0, points: 0, progress: 0 },
    oxygenLevel: spec.air ?? 20,
    game: { dimension: 'overworld' }, time: { timeOfDay: 1000, isDay: true },
    blockAt, findBlocks: () => [], findBlock: () => null,
    heldItem: null,
    inventory: { items: () => spec.inv.map(([name, count]) => ({ name, count })), slots: [] },
    nearestEntity: (match) => Object.values(bot.entities).filter((e) => e !== bot.entity && match(e))
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0] ?? null,
  })
  return bot
}

async function runOne({ cid, rep }) {
  const spec = CASES[cid]
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p59-probe-'))
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
  const bot = makeBot(spec)
  const realAdapter = createMinecraftAdapter({ bot, config, visionEnabled: false })
  const world = { held: null, last: 'said' }
  const acts = []
  let live = false
  let held = null
  let heldId = 0
  const pendingActs = []
  const overrides = {
    createSnapshotComposer: () => ({ next: () => composeSnapshot(bot, { inFlight: world.held, pinUsername: PLAYER, lastActionResult: world.last }) }),
    closeAnySessions: async () => {},
    executeAction: async (name, args, opts) => {
      const k = pendingActs.findIndex((p) => p.name === name)
      const scripted = k >= 0 ? pendingActs.splice(k, 1)[0] : null
      if (!scripted) acts.push({ name, args })
      const o = scripted?.o ?? {}
      if (scripted && !o.hold) { world.last = o.result ?? `${name}: done`; return world.last }
      const w = { id: ++heldId, name, args, startedAt: Date.now() - (scripted ? 9000 : 0) }
      world.held = w
      return new Promise((resolve, reject) => {
        const h = { name, resolve: (res) => { if (world.held === w) world.held = null; world.last = res; resolve(res) } }
        if (scripted) held = h
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
  const script = []
  let liveLeft = 0
  let cost = 0
  const calls = []
  const provider = {
    ...real,
    get model() { return real.model },
    async call(req) {
      if (!live) return script.shift() ?? resp([['end_loop', {}]])
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
  const sessionState = await createSessionState({ playerMdPath: config.memory.player_md_path, config, bot, logger: quiet })
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
  let error = null
  t0 = realNow()
  try {
    const chained = (st) => !st.live && !st.idle && !st.resolve && !st.event && !st.player
    for (let i = 0; i < spec.steps.length; i++) {
      const st = spec.steps[i]
      at(st.t)
      // A step with no trigger of its own is the completion turn of the step
      // before, so its script is queued with that step.
      if (st.live) { live = true; liveLeft = 1 } else if (!chained(st)) {
        pushScript(st.uses)
        for (let j = i + 1; j < spec.steps.length && chained(spec.steps[j]); j++) pushScript(spec.steps[j].uses)
      }
      if (st.idle) {
        await orch.handleDispatch('sei:idle', st.firstSpawn ? { reason: 'just_connected_first_spawn' } : { quietMs: 6800 }, new AbortController().signal)
        await drain()
      } else if (st.resolve) {
        if (!held) throw new Error('nothing held to resolve')
        held.resolve(st.resolve)
        held = null
        await drain()
      } else if (st.event) {
        try { orch.recordGameEvent?.('attacked', st.data) } catch {}
        await orch.handleDispatch(st.event, st.data, new AbortController().signal)
        await drain()
      } else if (st.player) {
        orch.recordIncomingChat(PLAYER, st.player)
        await orch.handleDispatch('player_chat', { username: PLAYER, text: st.player, playerSpoke: true }, new AbortController().signal)
        await drain()
      } else {
        await drain()
      }
      await sleep(30)
    }
  } catch (err) { error = String(err?.stack ?? err).slice(0, 400) }
  try { held?.resolve('done') } catch {}
  try { orch.dispose?.() } catch {}
  skew = 0
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  const tools = calls.flatMap((c) => c.tools.map((t) => t.name))
  const says = calls.flatMap((c) => c.tools.filter((t) => t.name === 'say').map((t) => String(t.input?.text ?? '')))
  const row = { case: cid, rep, model: MODEL, root: ROOT, error, cost, calls, acts: acts.filter((a) => !BRAIN.has(a.name)), tools, says }
  if (!calls.length && !error) row.error = 'no live call'
  Object.assign(row, row.error ? { ok: null } : spec.judge(row))
  return row
}

const pct = (n, d) => (d ? `${n}/${d} (${Math.round((100 * n) / d)}%)` : '-')
const tool1 = (t) => t.name === 'say' ? `say("${String(t.input?.text ?? '').slice(0, 100)}")`
  : t.name === 'goTo' ? `goTo(${t.input?.player ?? [t.input?.x, t.input?.y, t.input?.z].join(',')})`
  : `${t.name}(${JSON.stringify(t.input ?? {}).slice(0, 60)})`
const seq = (r) => (r.calls ?? []).map((c) => c.tools.map(tool1).join(' + ') || '(text only)').join(' -> ')
const EXTRA = [['early', 'states the result early'], ['delivered', 'says it already reached them'], ['spoke', 'called say()'], ['gave', 'called give']]
const extras = (rs) => EXTRA.filter(([k]) => rs.some((r) => r[k] !== undefined)).map(([k, label]) => `${label} ${pct(rs.filter((r) => r[k]).length, rs.filter((r) => r[k] !== undefined).length)}`).join('; ')

const jobs = []
for (let rep = 0; rep < REPS; rep++) for (const cid of Object.keys(CASES)) if (!ONLY || ONLY.includes(cid)) jobs.push({ cid, rep })
const stream = fs.createWriteStream(path.join(OUT, 'runs.jsonl'), { flags: 'a' })
const rows = []
for (const j of jobs) {
  let r
  try { r = await runOne(j) } catch (err) { r = { case: j.cid, rep: j.rep, error: String(err?.stack ?? err).slice(0, 400) } }
  rows.push(r)
  stream.write(JSON.stringify(r) + '\n')
  console.log(`[${r.case}/${r.rep}] ${r.error ? 'ERROR ' + r.error : `${r.ok ? 'OK ' : 'BAD'} ${seq(r).slice(0, 300)}`}`)
}
stream.end()
await new Promise((r) => stream.on('finish', r))
const ok = rows.filter((r) => !r.error)
const lines = ['# Pass 59 probe', '', `root ${ROOT}`, `model ${MODEL}, ${ok.length} runs (${rows.length - ok.length} errors), cost $${ok.reduce((s, r) => s + (r.cost ?? 0), 0).toFixed(3)}`, '', '| case | ok | details |', '|---|---:|---|']
for (const cid of Object.keys(CASES)) {
  const rs = ok.filter((r) => r.case === cid)
  if (rs.length) lines.push(`| ${cid} | ${pct(rs.filter((r) => r.ok).length, rs.length)} | ${extras(rs)} |`)
}
lines.push('', '## All runs', '')
for (const r of ok) lines.push(`- ${r.ok ? 'OK ' : 'BAD'} ${r.case}/${r.rep}: ${seq(r)}`)
for (const r of rows.filter((x) => x.error)) lines.push(`- ERR ${r.case}/${r.rep}: ${r.error}`)
fs.writeFileSync(path.join(OUT, 'summary.md'), lines.join('\n') + '\n')
console.log(lines.slice(0, 12).join('\n'))
process.exit(0)
