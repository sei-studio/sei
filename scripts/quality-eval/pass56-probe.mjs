// scripts/quality-eval/pass56-probe.mjs: a fight that lands while she is
// busy with a long action (her own shelter), for quality pass 56. Same
// harness as pass53-probe.mjs (the REAL brain and Minecraft adapter on an
// inert bot, earlier turns stubbed, the measured turns go to the API, on a
// virtual clock).
//
// From the 11-14 dev scorecard, night_social-03: the player is scared of the
// dark, she starts shelter() next to them, a zombie is summoned and the
// player says "theres a zombie!! kill it". She could not see it yet and kept
// walling in. The zombie went for Alex: the defend turn said "you are
// ALREADY swinging at it on reflex, so you do not need to call attackEntity"
// and "shelter keeps running", so she said "im on it" and kept building.
// Then it hit her: "your reflexes swing back on their own" and "shelter keeps
// running", so she said "he's got me now" and kept building. While an action
// runs, the action holds the item in her hand and moves her, so those reflex
// swings were bare-handed pokes (combat.js skips the weapon swap while an
// action runs). The zombie died only once a later turn called attackEntity.
// Judge: ignored_player (kill order lost behind the shelter) and
// broken_or_failed_action (no counterattack while hit).
//
//   defend        live: the defend event (zombie on Alex, engaged) mid-shelter.
//   defend_order  the same after the stubbed "kill it" turn ("where is it??").
//   hit           live: the zombie hits her mid-shelter.
//   hit_order     the scorecard turn order: kill order, defend turn answered
//                 "im on it", then the hit (live).
//   follow_hit    control: the hit while follow runs (a background action:
//                 combat.js pauses the trail and the reflex fights with the
//                 weapon). Text is unchanged by pass 56; reported only.
// fight = an attackEntity call in the live call. away = goTo/follow/explore
// (getting away is a valid answer to a hit). ok = fight || away.
//
//   ELECTRON_RUN_AS_NODE=1 npx electron scripts/quality-eval/pass56-probe.mjs \
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
const FIGHT = new Set(['attackEntity'])
const AWAY = new Set(['goTo', 'follow', 'explore'])
const judge = (r) => {
  const tools = r.calls.flatMap((c) => c.tools)
  const fight = tools.some((t) => FIGHT.has(t.name))
  const away = !fight && tools.some((t) => AWAY.has(t.name))
  const stop = tools.some((t) => t.name === 'stop')
  const spoke = tools.some((t) => t.name === 'say')
  return { ok: fight || away, fight, away, stop, spoke }
}
const ME = v(176.5, 71, -1.5)
const ALEX = v(173.5, 71, 1.5)
const ZOMBIE_ON_ALEX = v(171.5, 71, 4.5)
const ZOMBIE_ON_ME = v(177.5, 71, -0.5)
const INV = [['iron_sword', 1], ['bread', 4], ['dirt', 5]]
// The scorecard session up to the shelter call.
const upToShelter = [
  { t: 0, idle: true, firstSpawn: true, uses: [['say', { text: "oh hey alex. first time in this world, i'm sui" }]] },
  { t: 5, player: 'how are you doing', uses: [['say', { text: "honestly good, it's night and i have bread and an iron sword and zero wood nehehe" }]] },
  { t: 15, player: 'its getting dark im kinda scared of mobs', uses: [['say', { text: "ok alex stay close to me. i got you, we'll throw up a shelter right here" }], ['shelter', { center: { x: 173, y: 71, z: 1 } }, { hold: true }]] },
]
const upToFollow = [
  { t: 0, idle: true, firstSpawn: true, uses: [['say', { text: "oh hey alex. first time in this world, i'm sui" }]] },
  { t: 5, player: 'how are you doing', uses: [['say', { text: "honestly good, it's night and i have bread and an iron sword and zero wood nehehe" }]] },
  { t: 15, player: 'its getting dark im kinda scared of mobs, stay with me', uses: [['say', { text: 'ok alex, right on your heels. nothing gets to you' }], ['follow', { player: PLAYER }, { hold: true }]] },
]
const killOrder = { t: 24, player: 'theres a zombie!! kill it', uses: [['say', { text: 'where is it?? i dont see one yet, im still walling us in' }]] }
const defendEvt = (t, extra = {}) => ({
  t, zombie: ZOMBIE_ON_ALEX, event: 'sei:attacked',
  data: () => ({ attacker: ZOMBIE(), attackerLabel: 'zombie', attackerKind: 'defend', ownerLabel: PLAYER, distance: 5, engaged: true, threat: false, ownerDistance: null, ownerHp: 20, count: null, othersOnOwner: 0, actionOnIt: false }),
  ...extra,
})
const hitEvt = (t, extra = {}) => ({
  t, zombie: ZOMBIE_ON_ME, health: 17, event: 'sei:attacked',
  data: () => ({ attacker: ZOMBIE(), attackerLabel: 'zombie', attackerKind: 'hostile_mob', pvp: false, health: 17 }),
  ...extra,
})
let ZOMBIE = () => null
const CASES = {
  defend: { steps: [...upToShelter, defendEvt(27, { live: 1 })], judge },
  defend_order: { steps: [...upToShelter, killOrder, defendEvt(27, { live: 1 })], judge },
  hit: { steps: [...upToShelter, hitEvt(30, { live: 1 })], judge },
  hit_order: { steps: [...upToShelter, killOrder, defendEvt(27, { uses: [['say', { text: 'im on it, stay behind me alex. just one so far' }]] }), hitEvt(38, { live: 1 })], judge },
  follow_hit: { steps: [...upToFollow, hitEvt(30, { live: 1 })], judge },
  // after the fight that replaced the shelter: the kill's completion turn.
  // resumed = shelter (or another build/dig for it) called again.
  resume: {
    steps: [...upToShelter, hitEvt(30, { uses: [['attackEntity', { entity: 'zombie', times: 8 }, { hold: true }], ['say', { text: 'ow ok it hit me, fighting it now alex' }]] }),
      { t: 34, gone: true, resolve: 'killed zombie (3 hits). It hit you once before it died: you went from 17/20 to 15/20 health.', health: 15, live: 1 }],
    judge: (r) => {
      const tools = r.calls.flatMap((c) => c.tools)
      const resumed = tools.some((t) => ['shelter', 'build', 'placeBlock', 'buildCuboid'].includes(t.name))
      return { ok: resumed, resumed, fight: tools.some((t) => FIGHT.has(t.name)), away: false, stop: false, spoke: tools.some((t) => t.name === 'say') }
    },
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p56-probe-'))
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
const EXTRA = [['resumed', 'resumes the build'], ['fight', 'attackEntity'], ['away', 'gets away'], ['stop', 'stop'], ['spoke', 'says a line']]
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
const lines = ['# Pass 56 probe', '', `root ${ROOT}`, `model ${MODEL}, ${ok.length} runs (${rows.length - ok.length} errors), cost $${ok.reduce((s, r) => s + (r.cost ?? 0), 0).toFixed(3)}`, '', '| case | ok (fight or away) | details |', '|---|---:|---|']
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
