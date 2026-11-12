// scripts/quality-eval/pass53-probe.mjs: an order she answered in words
// while busy, for quality pass 53. Same harness as pass49-probe.mjs (the REAL
// brain and Minecraft adapter on an inert bot, earlier turns stubbed, the
// measured turns go to the API, on a virtual clock).
//
// From the 11-12 dev scorecard, errands-03: her own furnace goal is set at
// the greeting, the player sends her for coal, and on the walk back "get me
// like 8 logs, i wanna build a dock" gets "8 logs for a dock, on it" and no
// action. The walk's completion turn carried the log order, she handed the
// coal over first (as the arrival note asks), and the order was gone after
// that: the next idle tick went to "8 cobble for the furnace first, then i
// go get your logs".
//   e03_fav    live: "whats ur favorite block" right after the hand-over (2 calls)
//   e03_idle   live: the idle tick after "ok" (1 call)
//   e03_ok     live: the "ok" turn itself (2 calls)
//   q_only     control: the line on the walk is a question, not an order;
//              live: the idle tick after "ok". ok = no re-answer of it.
// log = a log gather/dig/find/explore before any stone/furnace work in the
// measured calls. own = stone/cobble/furnace work first.
//
//   ELECTRON_RUN_AS_NODE=1 npx electron scripts/quality-eval/pass53-probe.mjs \
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
const { giveAction } = await imp('src/bot/adapter/minecraft/behaviors/give.js')
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
// Open grass at y 63 (stand at y 64), a few oak trees (logs y 64..67) east
// of spawn, stone under the pond west of x=168 for the stone walk.
const v = (x, y, z) => new Vec3(x, y, z)
const TREES = [[181, 9], [184, -4], [186, 6], [189, 2]]
const isLog = (x, y, z) => y >= 64 && y <= 67 && TREES.some(([tx, tz]) => tx === x && tz === z)
function blockAt(p) {
  const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
  if (isLog(x, y, z)) return { name: 'oak_log', shapes: [[0, 0, 0, 1, 1, 1]], position: p, biome: { name: 'plains' } }
  if (x < 168 && y >= 60 && y <= 63) return { name: 'water', shapes: [], position: p, biome: { name: 'plains' } }
  if (y <= (x < 168 ? 59 : 63)) return { name: y < 60 ? 'stone' : 'grass_block', shapes: [[0, 0, 0, 1, 1, 1]], position: p, biome: { name: 'plains' } }
  return { name: 'air', shapes: [], position: p, biome: { name: 'plains' } }
}
function findBlocks({ point, maxDistance = 16 } = {}) {
  const out = []
  for (const [tx, tz] of TREES) for (let y = 64; y <= 67; y++) out.push(v(tx, y, tz))
  for (let x = 160; x < 168; x++) for (let z = 4; z < 10; z++) out.push(v(x, 59, z))
  return out.filter((q) => !point || q.distanceTo(point) <= maxDistance)
}

// ---- cases ----------------------------------------------------------------
const FURNACE = 'Make a furnace: mine stone for cobblestone, craft 8 cobblestone into a furnace at a crafting table'
const LOGISH = (s) => /log|wood|tree|oak/i.test(JSON.stringify(s ?? {}))
const STONEISH = (s) => /stone|cobble|furnace/i.test(JSON.stringify(s ?? {}))
const WORK = new Set(['gather', 'dig', 'find', 'explore', 'goTo', 'craft', 'digCuboid', 'digIn'])
// the first work call in the measured calls: 'log', 'own' or null
function firstWork(r) {
  for (const c of r.calls) for (const t of c.tools) {
    if (!WORK.has(t.name)) continue
    if (t.name === 'goTo' && !t.input?.x && !t.input?.block) continue
    if (LOGISH(t.input)) return 'log'
    if (STONEISH(t.input)) return 'own'
  }
  return null
}
const judgeLog = (r) => {
  const w = firstWork(r)
  const goal = r.calls.some((c) => c.tools.some((t) => t.name === 'setGoal' && LOGISH(t.input)))
  return { ok: w === 'log', log: w === 'log', own: w === 'own', goal }
}
const judgeQ = (r) => {
  // an answered question brought up again (the walk line, or the caves line before it)
  const re = r.says.some((s) => /favou?rite|block|cave/i.test(s))
  const w = firstWork(r)
  return { ok: !re, re, own: w === 'own', log: w === 'log' }
}
// errands-03 up to the hand-over. `walkLine` is the player's line on the walk
// back, answered in words only.
const upToGive = (walkLine, walkReply) => [
  { t: 0, idle: true, firstSpawn: true, uses: [['say', { text: 'oh hey alex. finally, someone to hold the pickaxe for me lol' }], ['setGoal', { text: FURNACE }]] },
  { t: 4, player: 'can u grab me some coal from that ore over there and bring it back here? i need torches', uses: [['say', { text: 'coal, got it. checking where the ore is rn' }], ['dig', { block: 'coal_ore', maxDistance: 48 }, { hold: true }]] },
  { t: 14, player: 'btw do u like caves or nah', uses: [['say', { text: "no clue yet, i haven't been in a real one. dark and full of mobs sounds like a bad time tbh" }]] },
  { t: 34, resolve: 'dug coal_ore; 2 coal reached your inventory (you have 2 now)', inv: [['stone_pickaxe', 1], ['coal', 2]], uses: [['say', { text: 'got 2 coal, heading back to you' }], ['goTo', { player: PLAYER, range: 2 }, { hold: true }]] },
  { t: 40, player: walkLine, uses: [['say', { text: walkReply }]] },
  { t: 48, resolve: 'reached Alex (1.4m away)', uses: [['give', { item: 'coal', count: 2, player: PLAYER }, { real: true }]] },
  { t: 49, uses: [['end_loop', {}]] },
]
// The inert bot's block survey is thin and varies by turn. The live turn
// saw stone nearer than the trees ("the stone is closer"); this is that list
// in the probe world's coordinates.
const NEARBY = ['grass_block x779 @175,63,1', 'stone x113 @167,59,4', 'sand x39 @167,60,6', 'water x136 @167,61,6', 'oak_log x8 @181,64,9']
const withNearby = (text) => typeof text === 'string'
  ? text.replace(/nearby blocks:\n(?:  .*\n)*?(?=nearby entities:)/, `nearby blocks:\n${NEARBY.map((b, i) => `  #${i + 1} ${b}`).join('\n')}\n`)
  : text
const ME = v(175.5, 64, 0.5)
const ALEX = v(173.5, 64, 1.5)
const LOGS = 'get me like 8 logs, i wanna build a dock'
const CASES = {
  e03_fav: {
    me: ME, alex: ALEX, inv: [['stone_pickaxe', 1]],
    steps: [...upToGive(LOGS, '8 logs for a dock, on it'),
      { t: 51, player: 'whats ur favorite block', inv: [['stone_pickaxe', 1]], live: 2 },
    ],
    judge: judgeLog,
  },
  e03_idle: {
    me: ME, alex: ALEX, inv: [['stone_pickaxe', 1]],
    steps: [...upToGive(LOGS, '8 logs for a dock, on it'),
      { t: 51, player: 'whats ur favorite block', inv: [['stone_pickaxe', 1]], uses: [['say', { text: "honestly no idea yet. probably whatever block i'm holding when i finally get a good build going" }]] },
      { t: 60, player: 'ok', uses: [['end_loop', {}]] },
      { t: 67, idle: true, live: 1 },
    ],
    judge: judgeLog,
  },
  e03_ok: {
    me: ME, alex: ALEX, inv: [['stone_pickaxe', 1]],
    steps: [...upToGive(LOGS, '8 logs for a dock, on it'),
      { t: 51, player: 'whats ur favorite block', inv: [['stone_pickaxe', 1]], uses: [['say', { text: "honestly no idea yet. probably whatever block i'm holding when i finally get a good build going" }]] },
      { t: 60, player: 'ok', live: 2 },
    ],
    judge: judgeLog,
  },
  q_only: {
    me: ME, alex: ALEX, inv: [['stone_pickaxe', 1]],
    steps: [...upToGive('whats ur favorite block', "honestly no idea yet. probably whatever block i'm holding when i finally get a good build going"),
      { t: 60, player: 'ok', inv: [['stone_pickaxe', 1]], uses: [['end_loop', {}]] },
      { t: 67, idle: true, live: 1 },
    ],
    judge: judgeQ,
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

function makeBot(spec, inv) {
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p49-probe-'))
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
  const inv = new Map(spec.inv)
  const bot = makeBot(spec, inv)
  const setInv = (list) => { inv.clear(); for (const [k, c] of list) inv.set(k, c) }
  const giveResults = []
  const realGive = async (args) => { const r = await giveAction(args, bot, config, {
    goTo: async () => { const a = bot.players[PLAYER].entity.position; bot.entity.position = a.offset(1.5, 0, 0); return 'reached' },
    drop: async ({ item, count }) => { const have = inv.get(item) ?? 0; const n = Math.min(count ?? have, have); inv.set(item, have - n); return `dropped ${n} ${item}` },
  }); giveResults.push(r); return r }
  const realAdapter = createMinecraftAdapter({ bot, config, visionEnabled: false })
  const world = { held: null, last: 'said' }
  const acts = []
  let live = false
  let held = null
  let heldId = 0
  const pendingActs = []
  const overrides = {
    // the brain's own options (hideNext etc.), with the probe's running action
    createSnapshotComposer: () => ({ next: (o = {}) => withNearby(composeSnapshot(bot, { ...o, inFlight: world.held, pinUsername: PLAYER, lastActionResult: world.last })) }),
    closeAnySessions: async () => {},
    executeAction: async (name, args, opts) => {
      const k = pendingActs.findIndex((p) => p.name === name)
      const scripted = k >= 0 ? pendingActs.splice(k, 1)[0] : null
      if (!scripted) acts.push({ name, args })
      const o = scripted?.o ?? {}
      if (name === 'give' && (!scripted || o.real)) { world.last = await realGive(args); return world.last }
      if (scripted && !o.hold) { world.last = o.result ?? `${name}: done`; return world.last }
      const w = { id: ++heldId, name, args, startedAt: Date.now() - (scripted ? 9000 : 0) }
      // gather's progress, as the real gather reports it, so the in_flight line names the count
      if (name === 'gather' && typeof args?.name === 'string') w.progress = { items: [args.name], total: Number(args.count) || 1, before: inv.get(args.name) ?? 0 }
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
      if (st.inv) setInv(st.inv)
      if (st.live) { live = true; liveLeft += Number(st.live) } else if (!chained(st)) {
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
  const row = { case: cid, rep, model: MODEL, root: ROOT, error, cost, calls, acts: acts.filter((a) => !BRAIN.has(a.name)), tools, says, giveResults: [...giveResults] }
  if (!calls.length && !error) row.error = 'no live call'
  Object.assign(row, row.error ? { ok: null } : spec.judge(row))
  return row
}

const pct = (n, d) => (d ? `${n}/${d} (${Math.round((100 * n) / d)}%)` : '-')
const tool1 = (t) => t.name === 'say' ? `say("${String(t.input?.text ?? '').slice(0, 100)}")`
  : t.name === 'goTo' ? `goTo(${t.input?.player ?? [t.input?.x, t.input?.y, t.input?.z].join(',')})`
  : `${t.name}(${JSON.stringify(t.input ?? {}).slice(0, 60)})`
const seq = (r) => (r.calls ?? []).map((c) => c.tools.map(tool1).join(' + ') || '(text only)').join(' -> ')
const EXTRA = [['log', 'log work first'], ['own', 'stone/furnace first'], ['goal', 'setGoal logs'], ['re', 're-answers the question']]
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
const lines = ['# Pass 53 probe', '', `root ${ROOT}`, `model ${MODEL}, ${ok.length} runs (${rows.length - ok.length} errors), cost $${ok.reduce((s, r) => s + (r.cost ?? 0), 0).toFixed(3)}`, '', '| case | ok | details |', '|---|---:|---|']
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
