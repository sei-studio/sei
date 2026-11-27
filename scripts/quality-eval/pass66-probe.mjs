// scripts/quality-eval/pass66-probe.mjs: quality pass 66, she tells the
// scared player she is staying, then a quiet tick starts her own work and
// walks her off (free-play combat_night, 7 of 10 self-started-work
// stay-then-leave incidents in the 11-25/11-26 transcripts began on an idle
// tick). Same harness as pass64b-probe.mjs (the REAL brain and Minecraft
// adapter on an inert bot, earlier turns stubbed with lines she really
// said, the measured idle tick goes to the API, on a virtual clock).
//
//   ask_thanks   11-25 pass64b 01-A/02-A/02-B, 11-26 01-B: nervous player,
//                "dont wander off pls", a fight, "thx sui ur the best", her
//                "not budging", then a quiet tick. left = gather/dig/find/
//                explore/mineVein or a goTo to a spot (walks her off).
//   promise      11-26 01-A: she promised "staying in the box till morning",
//                the player said they are staying put by her, quiet tick.
//   ask_old      11-26 03-B: "stay close pls" before two fights, nothing
//                since, quiet tick.
//   released     control: same as ask_thanks, then the player tells her to
//                go get wood. ok = she works (left).
//   day_calm     control: day, no fear, nothing asked. ok = she works.
//   morning      report: the promise case, but it is day and no mobs.
//
//   ELECTRON_RUN_AS_NODE=1 npx electron scripts/quality-eval/pass66-probe.mjs \
//     --out DIR [--root TREE] [--reps 8] [--cases a,b] [--variant name]
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
const VARIANT = arg('variant', 'base')
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
_setTickIntervalForTests?.(10_000_000)
const lib = await imp('src/bot/brain/promptLibrary.js')
// Prompt variants tried in-process on the same tree (see VARIANTS below).
const VARIANTS = (await import('./pass66-variants.mjs')).default
if (VARIANT !== 'base') {
  const v = VARIANTS[VARIANT]
  if (!v) { console.error('unknown variant', VARIANT); process.exit(2) }
  v(lib)
}

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
// Open grass at y 70 (stand at y 71), oak trees 10-14 blocks north-east.
const v = (x, y, z) => new Vec3(x, y, z)
const TREES = [[186, -10], [188, -12], [184, -14], [190, -7]]
const isLog = (x, y, z) => y >= 71 && y <= 74 && TREES.some(([tx, tz]) => tx === x && tz === z)
function blockAt(p) {
  const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
  if (isLog(x, y, z)) return { name: 'oak_log', shapes: [[0, 0, 0, 1, 1, 1]], position: p, biome: { name: 'plains' } }
  if (y <= 70) return { name: y < 67 ? 'stone' : 'grass_block', shapes: [[0, 0, 0, 1, 1, 1]], position: p, biome: { name: 'plains' } }
  return { name: 'air', shapes: [], position: p, biome: { name: 'plains' } }
}
function findBlocks({ point, maxDistance = 16 } = {}) {
  const out = []
  for (const [tx, tz] of TREES) for (let y = 71; y <= 74; y++) out.push(v(tx, y, tz))
  return out.filter((q) => !point || q.distanceTo(point) <= maxDistance)
}
const yawTo = (from, to) => Math.atan2(-(to.x - from.x), -(to.z - from.z))

// ---- cases ----------------------------------------------------------------
const ME = v(176.5, 71, -1.5)
const ALEX = v(175.5, 71, 0.5)
const ZOMBIE_ON_ALEX = v(172.5, 71, 3.5)
const ZOMBIE_ON_ME = v(177.5, 71, -0.5)
const INV = [['stone_sword', 1], ['bread', 8]]
const GOAL = 'Get iron tools: gather wood, make wood then stone pickaxe, mine stone and iron, smelt iron ingots. Start with wood.'
const WORK = new Set(['gather', 'dig', 'find', 'explore', 'mineVein', 'pickup'])
const leaves = (t) => WORK.has(t.name) || (t.name === 'goTo' && !t.input?.player) || (t.name === 'follow' && false)
const judgeOf = (wantWork) => (r) => {
  const tools = r.calls.flatMap((c) => c.tools)
  const left = tools.some(leaves)
  const spoke = tools.some((t) => t.name === 'say')
  const asked = tools.some((t) => t.name === 'say' && /\?/.test(String(t.input?.text ?? '')))
  return { ok: wantWork ? left : !left, left, spoke, asked }
}
const greet = { t: 0, idle: true, firstSpawn: true, uses: [['say', { text: 'oh hey alex. i have a pickaxe-less body and zero plan so this is gonna be fun' }], ['setGoal', { text: GOAL }]] }
const hitEvt = (t, extra = {}) => ({
  t, zombie: ZOMBIE_ON_ALEX, health: 18, event: 'sei:attacked',
  data: () => ({ attacker: ZOMBIE(), attackerLabel: 'zombie', attackerKind: 'hostile_mob', pvp: false, health: 18 }),
  ...extra,
})
const fightKill = (t, say = "zombie on you, i got it. stay behind me alex") => [
  hitEvt(t, { uses: [['say', { text: say }], ['attackEntity', { entity: 'zombie', times: 8 }, { hold: true }]] }),
  { t: t + 5, gone: true, resolve: 'killed zombie (4 hits). Nothing hurt you in this fight: you are at 18/20 health.', health: 18, uses: [['say', { text: "zombie's dead. you good alex?" }]] },
]
let ZOMBIE = () => null
const nervous = (t) => ({ t, player: 'its getting dark already... im kinda nervous about mobs tbh', uses: [['say', { text: "ok alex stay chill, i got a stone sword and 8 bread. i'm right here" }], ['goTo', { player: PLAYER, range: 2 }, { result: 'reached Alex (2.0m away)' }]] })
const ASK_THANKS = [greet, nervous(8),
  { t: 14, player: 'ok good. dont wander off pls', uses: [['say', { text: "not going anywhere. i'm right by you" }]] },
  ...fightKill(24),
  { t: 34, player: 'phew thx sui. ur the best', uses: [['say', { text: "yeah i KNOW. i'm not budging from right here" }]] }]
const PROMISE = [greet, nervous(8),
  ...fightKill(20, 'zombie on you, hold still, im on it'),
  { t: 30, player: 'ok sui thanks, im staying put by you', uses: [['say', { text: "that one's dead. i'm at 18 hp so we're staying right here till morning" }]] },
  { t: 40, player: 'ok sui. you good?', uses: [['say', { text: 'yeah im good. stay close alex' }]] }]
const CASES = {
  ask_thanks: { steps: [...ASK_THANKS, { t: 62, idle: true, quietMs: 27000, live: 2 }], judge: judgeOf(false) },
  promise: { steps: [...PROMISE, { t: 68, idle: true, quietMs: 27000, live: 2 }], judge: judgeOf(false) },
  ask_old: {
    steps: [greet, nervous(8),
      { t: 14, player: 'ok good, stay close pls', uses: [['say', { text: "yeah im right here, not leaving you alone in the dark" }]] },
      ...fightKill(22), ...fightKill(32, 'another one on you, swinging'),
      { t: 40, idle: true, uses: [['say', { text: 'both dead, we are good. creeper way off southwest so stay away from that' }]] },
      { t: 70, idle: true, quietMs: 28000, live: 2 }],
    judge: judgeOf(false),
  },
  released: {
    steps: [...ASK_THANKS,
      { t: 44, player: 'ok im good now honestly. go get wood if u want, ill wait right here', uses: [['say', { text: 'bet, back in a sec' }]] },
      { t: 60, idle: true, quietMs: 15000, live: 2 }],
    judge: judgeOf(true),
  },
  day_calm: {
    day: true,
    steps: [greet,
      { t: 8, player: 'yo sui. this world looks nice lol', uses: [['say', { text: 'right?? ok i need wood before anything else' }]] },
      { t: 40, idle: true, quietMs: 30000, live: 2 }],
    judge: judgeOf(true),
  },
  morning: {
    steps: [...PROMISE, { t: 68, idle: true, quietMs: 27000, live: 2, makeDay: true }],
    judge: judgeOf(true),
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

function makeBot(inv) {
  const alex = { id: 2, username: PLAYER, type: 'player', name: 'player', position: ALEX.clone(), height: 1.8, width: 0.6, yaw: 0, metadata: [] }
  const entities = { 2: alex }
  const bot = Object.assign(new EventEmitter(), {
    chat() {}, whisper() {}, username: sui.botName,
    entity: { id: 1, position: ME.clone(), yaw: 0, pitch: 0, eyeHeight: 1.62, height: 1.8 },
    entities, players: { [PLAYER]: { username: PLAYER, entity: alex, uuid: 'uuid-alex' } },
    _seiOwnerNames: [PLAYER.toLowerCase()],
    health: 20, food: 20, foodSaturation: 5, experience: { level: 11, points: 0, progress: 0 },
    oxygenLevel: 20,
    game: { dimension: 'overworld' }, time: { timeOfDay: 14000, isDay: false },
    blockAt, findBlocks, findBlock: () => null,
    heldItem: null,
    inventory: { items: () => [...inv.entries()].filter(([, c]) => c > 0).map(([name, count]) => ({ name, count })), slots: [] },
    nearestEntity: (match) => Object.values(bot.entities).filter((e) => e !== bot.entity && match(e))
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0] ?? null,
  })
  return bot
}

async function runOne({ cid, rep }) {
  const spec = CASES[cid]
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p66-probe-'))
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
  const inv = new Map(INV)
  const bot = makeBot(inv)
  if (spec.day) bot.time = { timeOfDay: 1000, isDay: true }
  const zombie = { id: 3, name: 'zombie', displayName: 'Zombie', type: 'hostile', kind: 'Hostile mobs', position: ZOMBIE_ON_ALEX.clone(), height: 1.95, width: 0.6, yaw: 0, metadata: [], isValid: true }
  ZOMBIE = () => zombie
  const realAdapter = createMinecraftAdapter({ bot, config, visionEnabled: false })
  const world = { held: null, last: 'said' }
  const acts = []
  let live = false
  let held = null
  let heldId = 0
  const pendingActs = []
  const overrides = {
    createSnapshotComposer: () => ({ next: (o = {}) => composeSnapshot(bot, { ...o, inFlight: world.held, pinUsername: PLAYER, lastActionResult: world.last }) }),
    closeAnySessions: async () => {},
    executeAction: async (name, args, opts) => {
      const k = pendingActs.findIndex((p) => p.name === name)
      const scripted = k >= 0 ? pendingActs.splice(k, 1)[0] : null
      if (!scripted) acts.push({ name, args })
      const o = scripted?.o ?? {}
      if (scripted && !o.hold) { world.last = o.result ?? `${name}: done`; return world.last }
      const w = { id: ++heldId, name, args, startedAt: Date.now() - (scripted ? 9000 : 0) }
      world.held = w
      // A body-owning action keeps the counter up while it runs, as the
      // real executeAction does (follow too: its handler blocks).
      bot._seiActionActive = (bot._seiActionActive ?? 0) + 1
      const done = () => { bot._seiActionActive = Math.max(0, (bot._seiActionActive ?? 1) - 1) }
      return new Promise((resolve, reject) => {
        const h = { name, resolve: (res) => { done(); if (world.held === w) world.held = null; world.last = res; resolve(res) } }
        if (scripted) held = h
        opts?.signal?.addEventListener?.('abort', () => {
          done()
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
      if (['sei:action_complete', 'sei:chat_received', 'sei:action_tick', 'player_chat', 'sei:attacked'].includes(next.event)) {
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
    for (let i = 0; i < spec.steps.length; i++) {
      const st = spec.steps[i]
      at(st.t)
      if (st.zombie) {
        zombie.position = st.zombie.clone()
        const victim = st.zombie === ZOMBIE_ON_ME ? bot.entity.position : bot.players[PLAYER].entity.position
        zombie.yaw = yawTo(zombie.position, victim)
        bot.entities[3] = zombie
      }
      if (Number.isFinite(st.health)) bot.health = st.health
      if (st.gone) { delete bot.entities[3]; zombie.isValid = false; (bot._seiDeadEntityIds ??= new Set()).add(3) }
      if (st.live) { live = true; liveLeft += Number(st.live) } else pushScript(st.uses)
      if (st.makeDay) { bot.time = { timeOfDay: 1000, isDay: true } }
      if (st.idle) {
        await orch.handleDispatch('sei:idle', st.firstSpawn ? { reason: 'just_connected_first_spawn' } : { quietMs: st.quietMs ?? 6800 }, new AbortController().signal)
        await drain()
      } else if (st.resolve) {
        if (!held) throw new Error('nothing held to resolve')
        held.resolve(st.resolve)
        held = null
        await drain()
      } else if (st.event) {
        const data = st.data()
        try { orch.recordGameEvent?.('attacked', data) } catch {}
        await orch.handleDispatch(st.event, data, new AbortController().signal)
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
    // let a parked live call settle
    for (let k = 0; k < 100 && live && liveLeft > 0; k++) await sleep(50)
    await sleep(200)
  } catch (err) { error = String(err?.stack ?? err).slice(0, 400) }
  const stillRunning = world.held?.name ?? null
  try { held?.resolve('done') } catch {}
  try { orch.dispose?.() } catch {}
  skew = 0
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  const tools = calls.flatMap((c) => c.tools.map((t) => t.name))
  const says = calls.flatMap((c) => c.tools.filter((t) => t.name === 'say').map((t) => String(t.input?.text ?? '')))
  const row = { case: cid, rep, variant: VARIANT, model: MODEL, root: ROOT, error, cost, calls, acts: acts.filter((a) => !BRAIN.has(a.name)), tools, says, stillRunning }
  if (!calls.length && !error) row.error = 'no live call'
  Object.assign(row, row.error ? { ok: null } : spec.judge(row))
  return row
}

const pct = (n, d) => (d ? `${n}/${d} (${Math.round((100 * n) / d)}%)` : '-')
const tool1 = (t) => t.name === 'say' ? `say("${String(t.input?.text ?? '').slice(0, 100)}")`
  : `${t.name}(${JSON.stringify(t.input ?? {}).slice(0, 60)})`
const seq = (r) => (r.calls ?? []).map((c) => c.tools.map(tool1).join(' + ') || '(text only)').join(' -> ')
const EXTRA = [['left', 'leaves for work'], ['spoke', 'says a line'], ['asked', 'asks a question']]
const extras = (rs) => EXTRA.map(([k, label]) => `${label} ${pct(rs.filter((r) => r[k]).length, rs.length)}`).join('; ')

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
const lines = ['# Pass 66 probe', '', `root ${ROOT}`, `variant ${VARIANT}, model ${MODEL}, ${ok.length} runs (${rows.length - ok.length} errors), cost $${ok.reduce((s, r) => s + (r.cost ?? 0), 0).toFixed(3)}`, '', '| case | ok | details |', '|---|---:|---|']
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
