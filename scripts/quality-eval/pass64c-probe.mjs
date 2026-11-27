// scripts/quality-eval/pass64c-probe.mjs: quality pass 64c, a fight she
// starts by the player after telling them she stays with them (free-play
// combat_night say-then-do-opposite). Same harness as pass64b-probe.mjs (the
// REAL brain and Minecraft adapter on an inert bot, earlier turns stubbed
// with lines she really said, the measured turn goes to the API, on a
// virtual clock). The attack itself does not run (the guard is in the
// action, see attack.test.js); this checks the turns around it. `out` = a
// walk away from the player the guard does not cover (goTo a spot, explore,
// follow a mob).
//
//   intercept_idle    11-25 pass 64b 02-B 01:34: she said "i'm right here",
//                     a zombie 15 blocks from Alex walks at them, idle turn.
//                     ok = not out (an attack is fine, the guard covers it).
//   intercept_player  the same, the player points at it. ok = not out.
//   order_far         control: the player asks her to go kill a skeleton 21
//                     blocks out. ok = she attacks it or walks to it.
//   held_after        the guarded attack came back "it backed off to 21
//                     blocks from Alex, so you went back to Alex". ok = not
//                     out.
//
//   ELECTRON_RUN_AS_NODE=1 npx electron scripts/quality-eval/pass64c-probe.mjs \
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
// Open grass at y 70 (stand at y 71), night.
const v = (x, y, z) => new Vec3(x, y, z)
function blockAt(p) {
  const y = Math.floor(p.y)
  if (y <= 70) return { name: y < 67 ? 'stone' : 'grass_block', shapes: [[0, 0, 0, 1, 1, 1]], position: p, biome: { name: 'plains' } }
  return { name: 'air', shapes: [], position: p, biome: { name: 'plains' } }
}
const findBlocks = () => []
const yawTo = (from, to) => Math.atan2(-(to.x - from.x), -(to.z - from.z))

// ---- cases ----------------------------------------------------------------
const ME = v(176.5, 71, -1.5)
const ALEX = v(173.5, 71, 1.5)
const ZOMBIE_ON_ME = v(177.5, 71, -0.5)
const ZOMBIE_FAR = v(184.5, 71, -8.5)   // 11 from her, 15 from Alex
const SKELETON_FAR = v(190.5, 71, -10.5) // 17 from her, 21 from Alex
const INV = [['stone_sword', 1], ['bread', 8]]
const GUARDED = fs.readFileSync(path.join(ROOT, 'src/bot/adapter/minecraft/behaviors/attack.js'), 'utf8').includes('guardRadiusFor')
const goesOut = (t) => {
  const i = t.input ?? {}
  if (t.name === 'goTo') return !i.player
  return t.name === 'explore' || (t.name === 'follow' && !i.player)
}
const outJudge = (want) => (r) => {
  const tools = r.calls.flatMap((c) => c.tools)
  const out = tools.some(goesOut)
  const went = out || tools.some((t) => t.name === 'attackEntity')
  return { ok: want ? went : !out, out, attacked: tools.some((t) => t.name === 'attackEntity'), handle: tools.some((t) => t.name === 'attackEntity' && (t.input?.entity_id != null || String(t.input?.target ?? '').startsWith('#'))), spoke: tools.some((t) => t.name === 'say') }
}
const scared = [
  { t: 0, idle: true, firstSpawn: true, uses: [['say', { text: 'yo alex, sui here' }]] },
  { t: 6, player: "it's getting dark... kinda nervous about mobs tbh", uses: [['say', { text: "i got you. stone sword and bread, i'm right here, not going anywhere" }]] },
  { t: 14, player: 'ok good. pls stay close tonight', uses: [['say', { text: "yeah yeah, i'm staying right by you till it's light" }]] },
]
let ZOMBIE = () => null
const CASES = {
  intercept_idle: { mob: 'zombie', steps: [...scared, { t: 22, zombie: ZOMBIE_FAR, idle: true, live: 1 }], judge: outJudge(false) },
  intercept_player: { mob: 'zombie', steps: [...scared, { t: 22, zombie: ZOMBIE_FAR }, { t: 23, player: 'uh sui theres a zombie over there', live: 1 }], judge: outJudge(false) },
  order_far: { mob: 'skeleton', steps: [...scared, { t: 22, zombie: SKELETON_FAR }, { t: 23, player: 'sui can you go kill that skeleton over there, its creeping me out', live: 1 }], judge: outJudge(true) },
  held_after: {
    mob: 'skeleton',
    steps: [...scared,
      { t: 22, zombie: v(181.5, 71, -6.5), idle: true, uses: [['say', { text: "skeleton out there, i'm on it. stay behind me" }], ['attackEntity', { entity: 'skeleton', times: 8 }, { hold: true }]] },
      { t: 34, zombie: SKELETON_FAR, resolve: '3/8 hits on skeleton, then it backed off to 21 blocks from Alex, so you went back to Alex and waited there instead of following it farther. It is still alive. You took 2 damage in this fight and are at 18/20 health.', live: 1 }],
    judge: outJudge(false),
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
    game: { dimension: 'overworld' }, time: { timeOfDay: 18000, isDay: false },
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p64c-probe-'))
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
  const mobName = spec.mob ?? 'zombie'
  const zombie = { id: 3, name: mobName, displayName: mobName[0].toUpperCase() + mobName.slice(1), type: 'hostile', kind: 'Hostile mobs', position: ZOMBIE_FAR.clone(), height: 1.95, width: 0.6, yaw: 0, metadata: [], isValid: true }
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
      if (st.idle) {
        await orch.handleDispatch('sei:idle', st.firstSpawn ? { reason: 'just_connected_first_spawn' } : { quietMs: 6800 }, new AbortController().signal)
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
  const row = { case: cid, rep, model: MODEL, root: ROOT, error, cost, calls, acts: acts.filter((a) => !BRAIN.has(a.name)), tools, says, stillRunning }
  if (!calls.length && !error) row.error = 'no live call'
  Object.assign(row, row.error ? { ok: null } : spec.judge(row))
  return row
}

const pct = (n, d) => (d ? `${n}/${d} (${Math.round((100 * n) / d)}%)` : '-')
const tool1 = (t) => t.name === 'say' ? `say("${String(t.input?.text ?? '').slice(0, 100)}")`
  : `${t.name}(${JSON.stringify(t.input ?? {}).slice(0, 60)})`
const seq = (r) => (r.calls ?? []).map((c) => c.tools.map(tool1).join(' + ') || '(text only)').join(' -> ')
const EXTRA = [['out', 'goes out'], ['attacked', 'attackEntity'], ['handle', 'by # handle'], ['spoke', 'says a line']]
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
const lines = ['# Pass 64c probe', '', `root ${ROOT} (guard ${GUARDED ? 'on' : 'off'})`, `model ${MODEL}, ${ok.length} runs (${rows.length - ok.length} errors), cost $${ok.reduce((s, r) => s + (r.cost ?? 0), 0).toFixed(3)}`, '', '| case | ok | details |', '|---|---:|---|']
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
