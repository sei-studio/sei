// scripts/quality-eval/pass48-probe.mjs: lines that report an action's
// result before it has one, and the drowning heads-up, for quality pass 48.
// Same harness as pass44-probe.mjs: the REAL brain (createOrchestrator +
// handleDispatch) and the real Minecraft adapter on an inert bot, the real
// composeSnapshot of the tree under test, earlier turns stubbed, only the
// measured turn goes to the API, on a virtual clock.
//
// From the pass 45-47 compares and the 11-03 dev scorecard:
//   place_furnace  pass45 01-B 03:55: craft furnace just finished ("it is in
//                  your inventory, not placed yet"); her completion turn said
//                  "furnace is in" with the placeBlock, which then failed.
//   place_table    pass47 03-A 04:05: craft wooden_pickaxe failed (needs a
//                  table, she carries one); "table's down right here" with the
//                  placeBlock, which then failed.
//   planks         pass45 02-B 01:06: gather 8/8 oak_log finished, the player
//                  wants a table; "8 logs turned into planks" with the craft.
//   smelt          pass47 02-B 04:38: furnace open and empty, wooden pickaxe
//                  just crafted for Alex; "iron's in the furnace, wooden
//                  pickaxe for you" with smeltInput / give.
//   drown_gather   pass46 02-A 02:18: the drowning heads-up (10 of 20 air)
//                  while a stone dig runs; "almost drowned in a puddle lol" at
//                  full health.
// early = a say() in the measured turn, sent with a world action, that states
// the result as done (regex below, read the lines). drown = says she almost or
// nearly drowned.
//
//   ELECTRON_RUN_AS_NODE=1 npx electron scripts/quality-eval/pass48-probe.mjs \
//     --out DIR [--root TREE] [--reps 10] [--cases a,b]
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
const REPS = Number(arg('reps', 10))
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
const DONE = /\b(is|'s|are|'re|got|now) (down|in|up|placed|set|done|ready|cooking|smelting|in the furnace|yours)\b|\b(turned into|went into|made (the|some|8|4)|crafted|placed|put (it|the \w+) down|it'?s down|in the furnace|grabbed|got (it|em|them))\b/i
const DROWN = /\b(almost|nearly|kinda|basically) drown|drowned\b|close call/i
const judgeEarly = (r) => {
  const early = r.calls.some((c) => c.tools.some((t) => !BRAIN.has(t.name)) && c.tools.some((t) => t.name === 'say' && DONE.test(String(t.input?.text ?? ''))))
  return { ok: !early, early }
}
const judgeDrown = (r) => {
  const drown = r.says.some((s) => DROWN.test(s))
  return { ok: !drown, drown }
}
const CASES = {
  place_furnace: {
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
  place_table: {
    me: v(199.5, 64, -2.5), alex: v(200.5, 64, -1.5),
    inv: [['stone_pickaxe', 1], ['cobblestone', 6], ['wooden_pickaxe', 1], ['dirt', 16], ['oak_log', 5], ['wheat_seeds', 1], ['oak_planks', 3], ['crafting_table', 1]],
    steps: [...OPEN,
      { t: 20, player: 'ok good. stay close, we keep looking for iron around this hill', uses: [['say', { text: 'yes boss. standing right next to you, not wandering off' }]] },
      { t: 40, player: 'make me a wooden pickaxe real quick', uses: [['say', { text: "you want one? ok fine, making it now, then it's yours" }], ['craft', { item: 'wooden_pickaxe', count: 1 }, { hold: true }]] },
      { t: 42, resolve: "can't craft wooden_pickaxe here: it needs a crafting table, and there is none in reach. You have one in your inventory: place it (placeBlock crafting_table), then craft", live: true },
    ],
    judge: judgeEarly,
  },
  planks: {
    me: v(188.5, 64, 23.5), alex: v(186.5, 64, 6.5),
    inv: [['oak_log', 8]],
    steps: [...OPEN,
      { t: 10, player: 'hey. get some wood, we need a crafting table asap', uses: [['say', { text: 'on it. punching trees now, you owe me a crafting table joke later' }], ['gather', { name: 'oak_log', count: 8, maxDistance: 48 }, { hold: true }]] },
      { t: 22, player: 'lol deal. just hurry up, need that table', uses: [['say', { text: "got 2 logs so far, the rest is coming. table's gonna be fast once i have 4 planks" }]] },
      { t: 65, resolve: 'gathered 8/8 oak_log', live: true },
    ],
    judge: judgeEarly,
  },
  smelt: {
    me: v(185.5, 64, 5.5), alex: v(186.5, 64, 7.5),
    inv: [['oak_log', 4], ['wooden_pickaxe', 2], ['cobblestone', 12], ['oak_planks', 2], ['stone_pickaxe', 1], ['raw_iron', 6], ['dirt', 1]],
    steps: [...OPEN,
      { t: 20, player: 'nice 6 iron. come on down and we smelt, need that wooden pickaxe too', uses: [['say', { text: 'almost there, one sec' }], ['openFurnace', { block: 'furnace' }, { result: 'opened furnace: input empty, fuel empty, output empty (not burning)' }]] },
      { t: 23, uses: [['craft', { item: 'wooden_pickaxe', count: 1 }, { hold: true }]] },
      { t: 25, resolve: 'crafted 1 wooden_pickaxe, made 4 oak_planks for it first', live: true },
    ],
    judge: judgeEarly,
  },
  drown_gather: {
    me: v(165.5, 61, 6.5), alex: v(180.5, 64, 2.5), air: 10,
    inv: [['wooden_pickaxe', 1], ['oak_sapling', 1], ['oak_planks', 1]],
    steps: [...OPEN,
      { t: 20, player: 'ok so we need stone. go look for gray stuff', uses: [['say', { text: 'gray stuff, obviously. on it' }], ['dig', { block: 'stone' }, { hold: true }]] },
      { t: 30, event: 'sei:attacked', data: { attacker: null, attackerLabel: 'deep water', attackerKind: 'reflex', survivalKind: 'drowning', count: 1, air: 10 }, live: true },
    ],
    judge: judgeDrown,
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p48-probe-'))
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
const EXTRA = [['early', 'states the result early'], ['drown', 'says she (almost) drowned']]
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
const lines = ['# Pass 48 probe', '', `root ${ROOT}`, `model ${MODEL}, ${ok.length} runs (${rows.length - ok.length} errors), cost $${ok.reduce((s, r) => s + (r.cost ?? 0), 0).toFixed(3)}`, '', '| case | ok | details |', '|---|---:|---|']
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
