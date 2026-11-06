// scripts/quality-eval/pass44-probe.mjs: turns that land while attackEntity
// runs, for quality pass 44, on the pass 33 harness (pass33-probe.mjs): the
// REAL brain (createOrchestrator + handleDispatch) and the real Minecraft
// adapter on an inert bot, earlier turns stubbed, only the measured turn goes
// to the API, on a virtual clock. Unlike pass 33 the snapshot is the REAL
// composeSnapshot of the tree under test, on a fake world with a river (water
// hides a mob from the sight filter), so each arm shows what its own code
// writes.
//
// From the 11-03 dev scorecard and the 10-31 / 11-02 compares:
//   stay_close     combat_night-01 02:29. Her attack is on a zombie in the
//                  river (one killed already), a second zombie stands in the
//                  water near Alex; "ok thx sui. still kinda jumpy lol. stay
//                  close pls". Dev: "zombies are down", goTo(Alex).
//   dont_go_far    combat_night-01 02:43, same world: "ok. stay close pls,
//                  dont go far".
//   two_zombies    combat_night 04-A (10-31) / 01-B (11-02): she is swinging
//                  at a zombie next to her and Alex, a second one is closing
//                  on Alex; "sui two zombies coming from the left, pls protect
//                  me". Dev: attackEntity(zombie) again, which switched mobs.
//   defend_second  combat_night-02 02:17: a defend event (Alex hit by the
//                  zombie the attack is on, one more on them) read just after
//                  the attack started. Dev: attackEntity on the other one.
//   come_now       control, stay_close world: "sui stop fighting and come here
//                  right now". She should leave the fight (goTo/follow/stop).
//   come_back_hurt control, combat_night-01-A (10-31) 03:20: she chased a
//                  zombie 14 blocks off; "im at 6 hp sui, where are u, come
//                  back to me". She should go to Alex.
// kept = the attack is still running after the turn (no world action, or
// only attackEntity calls the adapter folded into the running fight).
//
//   ELECTRON_RUN_AS_NODE=1 npx electron scripts/quality-eval/pass44-probe.mjs \
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
// A beach with a river: water fills y 60..62 west of x=169 (the bank), sand
// and grass at y 63 east of it. A mob standing in the water is out of sight.
const v = (x, y, z) => new Vec3(x, y, z)
function blockAt(p) {
  const x = Math.floor(p.x); const y = Math.floor(p.y)
  if (x < 169 && y >= 60 && y <= 62) return { name: 'water', shapes: [], position: p, biome: { name: 'river' } }
  if (y <= (x < 169 ? 59 : 63)) return { name: x < 169 ? 'sand' : 'grass_block', shapes: [[0, 0, 0, 1, 1, 1]], position: p, biome: { name: 'river' } }
  return { name: 'air', shapes: [], position: p, biome: { name: 'river' } }
}
const mob = (id, name, p) => ({ id, name, type: 'hostile', position: p, height: 1.95, width: 0.6, isValid: true })
// Each world: her position, Alex's, the mobs, the mob her attack is on.
const WORLDS = {
  river: { me: v(163.5, 62, 3.5), alex: v(172.5, 64, 5.5), mobs: [mob(31, 'zombie', v(166.5, 60, 6.5)), mob(32, 'zombie', v(165.5, 60, 10.5))], on: 31, kills: 1, used: 4 },
  beach: { me: v(171.5, 64, 4.5), alex: v(172.5, 64, 6.5), mobs: [mob(31, 'zombie', v(170.5, 64, 3)), mob(32, 'zombie', v(176.5, 64, 8.5))], on: 31, kills: 0, used: 1 },
  far: { me: v(160.5, 64, -6.5), alex: v(172.5, 64, 5.5), mobs: [mob(31, 'zombie_villager', v(159.5, 64, -8.5))], on: 31, kills: 0, used: 6 },
}

// ---- cases ----------------------------------------------------------------
const OWN_GOAL = 'Get a stone pickaxe and a small starter base on this beach, starting from wood.'
const SWORD = [['stone_sword', 1], ['bread', 8]]
const KILL = 'killed zombie (3 hits). Nothing hurt you in this fight: you are at 20/20 health.'
const BEFORE = [
  { t: 0, idle: true, firstSpawn: true, uses: [['say', { text: "yo alex, i'm sui. spawned on a beach with zero tools" }], ['setGoal', { text: OWN_GOAL }]] },
  { t: 8, player: 'getting dark already... im kinda nervous about mobs tbh', uses: [['say', { text: "stay close, i got you" }]] },
  { t: 20, player: 'zombie right next to me!! kill it pls', uses: [['say', { text: 'zombie on us, i got it' }], ['attackEntity', { target: 'zombie', times: 8 }, { result: KILL }]] },
  { t: 40, player: 'thx sui. that was close lol', uses: [['say', { text: "you're safe now, i'm not going anywhere" }]] },
]
const fight = (line, target = 'zombie') => [
  { t: 60, player: line, uses: [['say', { text: "two of em? fine. they're going down, you stay behind me" }], ['attackEntity', { target, times: 8 }, { hold: true }]] },
]
const DEFEND = (bot) => ({ attacker: bot.entities[31], attackerLabel: 'zombie', attackerKind: 'defend', ownerLabel: PLAYER, distance: 1, engaged: true, othersOnOwner: 1, ownerHp: 17, threat: false, actionOnIt: false })
const CLAIM = /\b(down|dead|gone|got (em|them|both|it)|killed|both of them|they're done|it's done|handled)\b/i
const judgeKeep = (r) => ({ ok: r.acts.length === 0 && !r.stopped, kept: r.acts.length === 0 && !r.stopped, claimDown: CLAIM.test(r.says.join(' | ')) })
const judgeLeave = (r) => {
  const toAlex = r.acts.some((a) => (a.name === 'goTo' && a.args?.player) || a.name === 'follow')
  return { ok: toAlex || r.stopped, kept: r.acts.length === 0 && !r.stopped, toAlex }
}
const CASES = {
  stay_close: { world: 'river', steps: [...BEFORE, ...fight('two more zombies coming from the north. pls keep them off me sui'), { t: 71, player: 'ok thx sui. still kinda jumpy lol. stay close pls', live: true }], judge: judgeKeep },
  dont_go_far: { world: 'river', steps: [...BEFORE, ...fight('two more zombies coming from the north. pls keep them off me sui'), { t: 71, player: 'ok. stay close pls, dont go far', live: true }], judge: judgeKeep },
  two_zombies: { world: 'beach', steps: [...BEFORE, ...fight('another zombie sui!!'), { t: 63, player: 'sui two zombies coming from the left, pls protect me', live: true }], judge: judgeKeep },
  defend_second: { world: 'beach', steps: [...BEFORE, ...fight('another zombie sui!!'), { t: 62, event: 'sei:attacked', data: DEFEND, live: true }], judge: judgeKeep },
  come_now: { world: 'river', steps: [...BEFORE, ...fight('two more zombies coming from the north. pls keep them off me sui'), { t: 71, player: 'sui stop fighting and come here right now, im scared', live: true }], judge: judgeLeave },
  come_back_hurt: { world: 'far', steps: [...BEFORE, ...fight('zombie villager sui, get it', 'zombie_villager'), { t: 72, player: 'im at 6 hp sui, where are u, come back to me', live: true }], judge: judgeLeave },
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

function makeBot(w) {
  const alex = { id: 2, username: PLAYER, type: 'player', position: w.alex.clone(), height: 1.8, width: 0.6 }
  const entities = { 2: alex }
  for (const m of w.mobs) entities[m.id] = { ...m, position: m.position.clone() }
  const bot = Object.assign(new EventEmitter(), {
    chat() {}, whisper() {}, username: sui.botName,
    entity: { id: 1, position: w.me.clone(), yaw: 0, pitch: 0, eyeHeight: 1.62, height: 1.8 },
    entities, players: { [PLAYER]: { username: PLAYER, entity: alex, uuid: 'uuid-alex' } },
    _seiOwnerNames: [PLAYER.toLowerCase()],
    health: 20, food: 20, foodSaturation: 5, experience: { level: 0, points: 0, progress: 0 },
    game: { dimension: 'overworld' }, time: { timeOfDay: 14000, isDay: false },
    blockAt, findBlocks: () => [], findBlock: () => null,
    heldItem: { name: 'stone_sword', type: 1, maxDurability: 131, durabilityUsed: 10 },
    inventory: { items: () => SWORD.map(([name, count]) => ({ name, count })), slots: [] },
    nearestEntity: (match) => Object.values(bot.entities).filter((e) => e !== bot.entity && match(e))
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0] ?? null,
  })
  return bot
}

async function runOne({ cid, rep }) {
  const spec = CASES[cid]
  const W = WORLDS[spec.world]
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p44-probe-'))
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
  const bot = makeBot(W)
  const realAdapter = createMinecraftAdapter({ bot, config, visionEnabled: false })
  const world = { held: null, last: 'said' }
  const acts = []
  let live = false
  let held = null
  let heldId = 0
  const pendingActs = []
  const startRun = (signal) => {
    const run = {
      open: true, name: bot.entities[W.on].name, mobTarget: true,
      ctx: {
        currentId: W.on, deadIds: new Set(W.kills ? [99] : []), tagged: new Set(W.kills ? [99, W.on] : [W.on]),
        used: W.used, budget: 8, signal, hardDeadline: Date.now() + 36_000, fightStartedAt: Date.now(),
      },
    }
    bot._seiAttackRun = run
    bot._seiOffensiveTarget = W.on
    return run
  }
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
      const run = scripted && name === 'attackEntity' ? startRun(opts?.signal ?? null) : null
      return new Promise((resolve, reject) => {
        const h = { name, resolve: (res) => { if (world.held === w) world.held = null; world.last = res; resolve(res) } }
        held = h
        opts?.signal?.addEventListener?.('abort', () => {
          if (world.held === w) { world.held = null; world.last = `${name}: aborted` }
          if (run) { run.open = false; if (bot._seiAttackRun === run) bot._seiAttackRun = null; bot._seiOffensiveTarget = null }
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
  let snapAtLive = null
  t0 = realNow()
  try {
    for (const st of spec.steps) {
      at(st.t)
      if (st.live) {
        live = true; liveLeft = 1
        try { snapAtLive = composeSnapshot(bot, { inFlight: world.held, pinUsername: PLAYER }) } catch (e) { snapAtLive = String(e) }
      } else pushScript(st.uses)
      if (st.idle) {
        await orch.handleDispatch('sei:idle', st.firstSpawn ? { reason: 'just_connected_first_spawn' } : { quietMs: 6800 }, new AbortController().signal)
        await drain()
      } else if (st.event) {
        const data = typeof st.data === 'function' ? st.data(bot) : st.data
        try { orch.recordGameEvent?.('attacked', data) } catch {}
        await orch.handleDispatch(st.event, data, new AbortController().signal)
        await drain()
      } else if (st.player) {
        orch.recordIncomingChat(PLAYER, st.player)
        await orch.handleDispatch('player_chat', { username: PLAYER, text: st.player, playerSpoke: true }, new AbortController().signal)
        await drain()
      }
      await sleep(30)
    }
  } catch (err) { error = String(err?.stack ?? err).slice(0, 400) }
  const stillRunning = !!bot._seiAttackRun?.open
  try { held?.resolve('done') } catch {}
  try { orch.dispose?.() } catch {}
  skew = 0
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  const tools = calls.flatMap((c) => c.tools.map((t) => t.name))
  const says = calls.flatMap((c) => c.tools.filter((t) => t.name === 'say').map((t) => String(t.input?.text ?? '')))
  const stopped = tools.includes('stop') || !stillRunning && acts.length === 0
  const row = { case: cid, rep, model: MODEL, root: ROOT, error, cost, calls, acts: acts.filter((a) => !BRAIN.has(a.name)), tools, says, stopped, stillRunning, flight: (snapAtLive ?? '').split('\n').find((l) => l.startsWith('in_flight:')) ?? null }
  if (!calls.length && !error) row.error = 'no live call'
  Object.assign(row, row.error ? { ok: null } : spec.judge(row))
  return row
}

const pct = (n, d) => (d ? `${n}/${d} (${Math.round((100 * n) / d)}%)` : '-')
const tool1 = (t) => t.name === 'say' ? `say("${String(t.input?.text ?? '').slice(0, 90)}")`
  : t.name === 'attackEntity' ? `attackEntity(${t.input?.entity ?? t.input?.target ?? ''})`
  : t.name === 'goTo' ? `goTo(${t.input?.player ?? [t.input?.x, t.input?.y, t.input?.z].join(',')})`
  : t.name
const seq = (r) => (r.calls ?? []).map((c) => c.tools.map(tool1).join(' + ') || '(text only)').join(' -> ')
const EXTRA = [['kept', 'attack kept'], ['claimDown', 'claims they are down'], ['toAlex', 'goes to Alex']]
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
  console.log(`[${r.case}/${r.rep}] ${r.error ? 'ERROR ' + r.error : `${r.ok ? 'OK ' : 'BAD'} ${seq(r).slice(0, 260)}`}`)
}
stream.end()
await new Promise((r) => stream.on('finish', r))
const ok = rows.filter((r) => !r.error)
const lines = ['# Pass 44 probe', '', `root ${ROOT}`, `model ${MODEL}, ${ok.length} runs (${rows.length - ok.length} errors), cost $${ok.reduce((s, r) => s + (r.cost ?? 0), 0).toFixed(3)}`, '', '| case | ok | details |', '|---|---:|---|']
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
