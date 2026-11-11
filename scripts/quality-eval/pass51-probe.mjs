// scripts/quality-eval/pass51-probe.mjs: stale kill / threat state in a
// fight, for quality pass 51. Same harness as pass50-probe.mjs: the REAL brain
// (createOrchestrator + handleDispatch) and the real Minecraft adapter on an
// inert bot, the real composeSnapshot of the tree under test, earlier turns
// stubbed, only the measured turns go to the API, on a virtual clock. Deaths
// are put on the bot the way mineflayer reports them (entityDead then
// entityGone), so observers/entities.js records them.
//
// From combat_night free play (11-06 to 11-10):
//   second_zombie_defend  A01 00:54 / B03 06:39 shape: she warned about a
//                  zombie, killed it ("killed zombie"), and a second zombie
//                  hits Alex while her reflex swings: "zombie's dead alex".
//   second_zombie_player  the same, but Alex calls for help.
//   died_during_call      B01 05:08 / B03 06:01 shape: Alex shouts about a
//                  spider, it dies while her turn is being written, the turn
//                  says "i'm on it" and swings at nothing.
// The judges below read her lines (an eval measure only, never product code).
//
//   ELECTRON_RUN_AS_NODE=1 npx electron scripts/quality-eval/pass51-probe.mjs \
//     --out DIR [--root TREE] [--reps 6] [--cases a,b]
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
const REPS = Number(arg('reps', 6))
const MODEL = arg('model', 'claude-haiku-5-5')
const ONLY = arg('cases')?.split(',')
const CHARS_DIR = arg('charsDir', path.join(os.homedir(), 'suisei/eval/characters'))
fs.mkdirSync(path.join(OUT, 'requests'), { recursive: true })

const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href)
const { ConfigSchema } = await imp('src/bot/config.js')
const { createMinecraftAdapter } = await imp('src/bot/adapter/minecraft/index.js')
const { composeSnapshot } = await imp('src/bot/adapter/minecraft/observers/snapshot.js')
const { trackEntityDeaths } = await imp('src/bot/adapter/minecraft/observers/entities.js')
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
// Open grass at y 64, night.
const v = (x, y, z) => new Vec3(x, y, z)
function blockAt(p) {
  const y = Math.floor(p.y)
  if (y <= 63) return { name: y < 60 ? 'stone' : 'grass_block', shapes: [[0, 0, 0, 1, 1, 1]], position: p, biome: { name: 'plains' } }
  return { name: 'air', shapes: [], position: p, biome: { name: 'plains' } }
}

// ---- cases ----------------------------------------------------------------
const OWN_GOAL = 'Get a wooden pickaxe and stone tools, then build a small shelter by the water'
const OPEN = [
  { t: 0, idle: true, firstSpawn: true, uses: [['say', { text: "oh hey alex. night's coming, i got a sword and bread, stay close" }], ['setGoal', { text: OWN_GOAL }]] },
]
const BRAIN = new Set(['say', 'remember', 'forget', 'setGoal', 'clearGoal', 'end_loop', 'stop', 'quit_game', 'end_call', 'search', 'visit'])
// Lines from the measured calls (call 0 = a stubbed line still typing out).
const liveSays = (r) => r.heard.filter((h) => h.live && h.call >= 1).map((h) => h.text).join(' | ')
const zombie = (id, at) => ({ id, name: 'zombie', at })
// She fought zombie 31 after warning about it, and killed it.
const FIRST_FIGHT = [...OPEN,
  { t: 20, event: 'sei:attacked', data: (bot) => ({ attacker: bot.entities[31], attackerLabel: 'zombie', attackerKind: 'mob', health: 18 }),
    uses: [['say', { text: "zombie on me alex, swinging" }], ['attackEntity', { entity: 'zombie', times: 8 }, { hold: true }]] },
  { t: 26, do: (bot) => bot.kill(31) },
  { t: 26.1, resolve: 'killed zombie (4 hits)', uses: [['say', { text: "zombie's down" }]] },
  { t: 32, do: (bot) => bot.spawn({ ...zombie(32, v(181.5, 64, 10.5)), yaw: -Math.PI / 2 }) },
]
// "i got it" is a promise, not a kill; "another one down" is a kill claim
// about the live zombie, so it counts.
const DEAD_CLAIM = /\b(dead|down|killed|dropped|done for|took care of|finished)\b|(zombie|it)('?s| is) gone|no more zombie/i
const NEW_ONE = /\b(another|new|second|one more|other|next|2nd)\b (one|zombie)?\s*(on|at|coming|here|behind|hitting|showed|spawned)\b/i
const judgeSecond = (r) => {
  const s = liveSays(r)
  const falseDead = DEAD_CLAIM.test(s) && !NEW_ONE.test(s)
  const attacked = r.acts.some((a) => a.name === 'attackEntity')
  return { ok: !falseDead, falseDead, silent: !s, attacked }
}
const CASES = {
  second_zombie_defend: {
    me: v(180.5, 64, 8.5), alex: v(183.5, 64, 9.5), alexHp: 18,
    inv: [['stone_sword', 1], ['bread', 8]],
    mobs: [zombie(31, v(178.5, 64, 7.5))],
    steps: [...FIRST_FIGHT,
      { t: 33, event: 'sei:attacked', data: (bot) => ({ attacker: bot.entities[32], attackerLabel: 'zombie', attackerKind: 'defend', ownerLabel: 'Alex', distance: 2, engaged: true, othersOnOwner: 0, ownerHp: 16 }), live: 1 },
    ],
    judge: judgeSecond,
  },
  second_zombie_player: {
    me: v(180.5, 64, 8.5), alex: v(183.5, 64, 9.5), alexHp: 16,
    inv: [['stone_sword', 1], ['bread', 8]],
    mobs: [zombie(31, v(178.5, 64, 7.5))],
    steps: [...FIRST_FIGHT,
      { t: 34, player: 'sui its hitting me!! help', live: 1 },
    ],
    judge: judgeSecond,
  },
  died_during_call: {
    me: v(180.5, 64, 8.5), alex: v(183.5, 64, 9.5), alexHp: 15,
    inv: [['stone_sword', 1], ['bread', 8]],
    mobs: [{ id: 30, name: 'spider', at: v(185.5, 64, 10.5) }],
    // The spider dies while the first live turn is being written.
    onFirstLiveCall: (bot) => bot.kill(30),
    steps: [...OPEN,
      { t: 20, player: 'sui spider!! get it', live: 2 },
    ],
    // bad = she says she is going for / hitting the spider after it died
    judge: (r) => {
      const intent = /\b(on it|get(ting)? it|going for|hitting|swing|coming|i'?ll|im on|i'?m on|got this|kill it|attack)/i
      const staleLine = r.heard.some((h) => h.live && h.call === 1 && intent.test(h.text))
      const swungAtNothing = r.acts.some((a) => a.name === 'attackEntity' && /spider/.test(JSON.stringify(a.args)))
      return { ok: !staleLine, staleLine, swungAtNothing, silent: !liveSays(r) }
    },
  },
}

// ---- runner ---------------------------------------------------------------
const captured = new Set()
let uid = 0
const resp = (uses) => {
  const content = uses.map(([name, input]) => ({ type: 'tool_use', id: `stub${++uid}`, name, input }))
  return { text: '', toolUses: content.map(({ id, name, input }) => ({ id, name, input })), content, usage: {}, stopReason: 'tool_use' }
}
const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' })

function makeBot(spec) {
  const mkAlex = (pos, hp) => ({ id: 2, username: PLAYER, type: 'player', name: 'player', position: pos.clone(), height: 1.8, width: 0.6, yaw: 0, metadata: [hp], isValid: true })
  const alex = mkAlex(spec.alex, spec.alexHp ?? 20)
  const entities = { 2: alex }
  for (const m of spec.mobs ?? []) {
    entities[m.id] = { id: m.id, name: m.name, type: 'hostile', kind: 'Hostile mobs', position: m.at.clone(), yaw: m.yaw ?? 0, pitch: 0, height: 1.95, width: 0.6, isValid: true, metadata: [] }
  }
  const bot = Object.assign(new EventEmitter(), {
    chat(text) { bot._heard?.(text) }, whisper() {}, username: sui.botName,
    entity: { id: 1, position: spec.me.clone(), yaw: 0, pitch: 0, eyeHeight: 1.62, height: 1.8 },
    entities, players: { [PLAYER]: { username: PLAYER, entity: alex, uuid: 'uuid-alex' } },
    _seiOwnerNames: [PLAYER.toLowerCase()],
    // only the player's health slot, which ownerHealth() reads
    registry: { entitiesByName: { player: { metadataKeys: ['health'] } } },
    health: 20, food: 20, foodSaturation: 5, experience: { level: 0, points: 0, progress: 0 },
    oxygenLevel: 20,
    game: { dimension: 'overworld' }, time: { timeOfDay: 14000, isDay: false },
    blockAt, findBlocks: () => [], findBlock: () => null,
    heldItem: null,
    inventory: { items: () => spec.inv.map(([name, count]) => ({ name, count })), slots: [] },
    nearestEntity: (match) => Object.values(bot.entities).filter((e) => e !== bot.entity && match(e))
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0] ?? null,
  })
  // What mineflayer does when a mob dies: entityDead, then the entity leaves.
  bot.kill = (id) => {
    const e = bot.entities[id]
    if (!e) return
    bot.emit('entityDead', e)
    e.isValid = false
    delete bot.entities[id]
    bot.emit('entityGone', e)
  }
  // createSnapshotComposer and combat.js attach this in the app; the probe
  // composes snapshots itself.
  trackEntityDeaths(bot)
  bot.spawn = (m) => {
    bot.entities[m.id] = { id: m.id, name: m.name, type: 'hostile', kind: 'Hostile mobs', position: m.at.clone(), yaw: m.yaw ?? 0, pitch: 0, height: 1.95, width: 0.6, isValid: true, metadata: [] }
    bot.emit('entitySpawn', bot.entities[m.id])
  }
  return bot
}

async function runOne({ cid, rep }) {
  const spec = CASES[cid]
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p51-probe-'))
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
  const heard = []
  bot._heard = (text) => heard.push({ text: String(text), live, call: calls.length })
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
      if (!scripted && name === 'attackEntity') {
        const res = await Promise.race([realAdapter.executeAction(name, args, opts), sleep(3000).then(() => null)])
        if (res != null) { world.last = String(res); return world.last }
      }
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
  let hooked = false
  let cost = 0
  const calls = []
  const provider = {
    ...real,
    get model() { return real.model },
    async call(req) {
      if (!live) return script.shift() ?? resp([['end_loop', {}]])
      if (liveLeft <= 0) return resp([['end_loop', {}]])
      liveLeft--
      if (spec.onFirstLiveCall && !hooked) { hooked = true; await sleep(5); spec.onFirstLiveCall(bot); await sleep(5) }
      if (process.env.DRY) {
        fs.writeFileSync(path.join(OUT, 'requests', `${cid}-dry.json`), JSON.stringify({ systemBlocks: req.systemBlocks, messages: req.messages }, null, 1))
        calls.push({ text: '', tools: [] })
        return resp([['end_loop', {}]])
      }
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
    const chained = (st) => !st.live && !st.idle && !st.resolve && !st.event && !st.player && !st.do && !st.chatOnly
    for (let i = 0; i < spec.steps.length; i++) {
      const st = spec.steps[i]
      at(st.t)
      // A step with no trigger of its own is the completion turn of the step
      // before, so its script is queued with that step.
      if (st.live) { live = true; liveLeft = st.live === true ? 1 : st.live } else if (!chained(st)) {
        pushScript(st.uses)
        for (let j = i + 1; j < spec.steps.length && chained(spec.steps[j]); j++) pushScript(spec.steps[j].uses)
      }
      if (st.do) { st.do(bot); await sleep(10); continue }
      if (st.chatOnly) { orch.recordIncomingChat(PLAYER, st.chatOnly); continue }
      if (st.idle) {
        await orch.handleDispatch('sei:idle', st.firstSpawn ? { reason: 'just_connected_first_spawn' } : { quietMs: 6800 }, new AbortController().signal)
        await drain()
      } else if (st.resolve) {
        if (!held) throw new Error('nothing held to resolve')
        held.resolve(st.resolve)
        held = null
        await drain()
      } else if (st.event) {
        const data = typeof st.data === 'function' ? st.data(bot) : st.data
        if (st.event === 'sei:attacked') { try { orch.recordGameEvent?.('attacked', data) } catch {} }
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
  } catch (err) { error = String(err?.stack ?? err).slice(0, 400) }
  try { held?.resolve('done') } catch {}
  try { orch.dispose?.() } catch {}
  skew = 0
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  const tools = calls.flatMap((c) => c.tools.map((t) => t.name))
  const says = calls.flatMap((c) => c.tools.filter((t) => t.name === 'say').map((t) => String(t.input?.text ?? '')))
  const row = { case: cid, rep, model: MODEL, root: ROOT, error, cost, calls, acts: acts.filter((a) => !BRAIN.has(a.name)), tools, says, heard }
  if (!calls.length && !error) row.error = 'no live call'
  Object.assign(row, row.error ? { ok: null } : spec.judge(row))
  return row
}

const pct = (n, d) => (d ? `${n}/${d} (${Math.round((100 * n) / d)}%)` : '-')
const tool1 = (t) => t.name === 'say' ? `say("${String(t.input?.text ?? '').slice(0, 100)}")`
  : t.name === 'goTo' ? `goTo(${t.input?.player ?? [t.input?.x, t.input?.y, t.input?.z].join(',')})`
  : `${t.name}(${JSON.stringify(t.input ?? {}).slice(0, 60)})`
const seq = (r) => (r.calls ?? []).map((c) => c.tools.map(tool1).join(' + ') || '(text only)').join(' -> ') + ' || heard: ' + (r.heard ?? []).filter((h) => h.live && h.call >= 1).map((h) => `[${h.call}] ${h.text}`).join(' / ')
const EXTRA = [['falseDead', 'says the zombie is dead/down'], ['staleLine', 'heard an attack line about the dead spider'], ['swungAtNothing', 'attackEntity on the dead spider ran'], ['attacked', 'attackEntity'], ['silent', 'said nothing']]
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
const lines = ['# Pass 51 probe', '', `root ${ROOT}`, `model ${MODEL}, ${ok.length} runs (${rows.length - ok.length} errors), cost $${ok.reduce((s, r) => s + (r.cost ?? 0), 0).toFixed(3)}`, '', '| case | ok | details |', '|---|---:|---|']
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
