// scripts/quality-eval/pass49-probe.mjs: the log hand-off loop and spoken
// intent with no action, for quality pass 49. Same harness as
// pass48-probe.mjs: the REAL brain (createOrchestrator + handleDispatch) and
// the real Minecraft adapter on an inert bot, the real composeSnapshot of the
// tree under test, earlier turns stubbed, the measured turns go to the API,
// on a virtual clock. give runs the tree's own giveAction (walk and drop
// stubbed), so each arm's give result is the one its code writes.
//
// From the 11-09 dev scorecard (and pass 43 compare):
//   ws01_give      work_session-01: 6 logs gathered for Alex's "like 6 logs",
//                  her own next step is a crafting table. She gave all 6 and
//                  then asked "toss me one log" four times. Live from the
//                  gather result through "what should we build first?",
//                  "yeah sounds good" and "make a crafting table".
//   ws01_table     the same session after the first ask already went out
//                  ("toss me one log so i can make a table"), 0 logs, trees
//                  nearby; live turn = "make a crafting table".
//   errands_logs   errands-03 U7: walking 2 coal back to Alex (follow), "get
//                  me like 8 logs, i wanna build a dock" got "i'll go hunt
//                  some" with no action and no setGoal.
//   ws03_wood      work_session-03 U10: walking to stone on her own plan,
//                  "go get more wood, like 10 more" got "on it after the
//                  stone" and no action.
//   gather_more    pass43 work_session-03-B U10: her own 3-log gather running,
//                  "go get more wood, like 10 more" got a quip and the 3-log
//                  gather kept running.
// ask = a say() asking the player for a log back (regex below, read the
// lines). act = a log gather/dig/find/explore in the measured turn. goal = a
// setGoal naming logs/wood in the measured turn.
//
//   ELECTRON_RUN_AS_NODE=1 npx electron scripts/quality-eval/pass49-probe.mjs \
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
// the tree's own give, so each arm shows the result its code writes
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
const OWN_GOAL = 'Get a wooden pickaxe and start on stone tools, using the oak trees nearby. Invite Alex to help gather wood.'
const OPEN = [
  { t: 0, idle: true, firstSpawn: true, uses: [['say', { text: "ok hi alex. i'm sui, i run this terminal thing. don't let me break anything" }], ['setGoal', { text: OWN_GOAL }]] },
  { t: 4, player: 'whats up, what are you doing', uses: [['say', { text: 'nothing yet, just standing on grass looking at trees like a genius. wanna gather wood with me' }]] },
]
const WS01 = [...OPEN,
  { t: 15, player: 'can you get some wood? like 6 logs', uses: [['setGoal', { text: 'Gather 6 oak logs for Alex', for_player: true }], ['gather', { name: 'oak_log', count: 6 }, { hold: true }]] },
  { t: 16, uses: [['say', { text: "on it, 6 logs coming. the oak is east of me, i'll bring them back to you" }]] },
  { t: 30, player: 'how many logs do you have so far?', inv: [['oak_log', 3]], uses: [['say', { text: '3 so far, 3 more to go' }]] },
  { t: 38, player: 'ok cool keep going', uses: [['end_loop', {}]] },
]
// a say() asking the player to give her a log (back)
const ASK = /\b(toss|throw|pass|hand|give|drop|spare|lend|send|chuck|flick)\b[^.?!]{0,30}\b(me|back|my way)\b[^.?!]{0,30}\b(log|logs|wood|one)\b|\b(toss|throw|pass|hand|give)\b[^.?!]{0,20}\b(one|a log|1 log|it|them)\b[^.?!]{0,10}\bback\b|\bneed (one|a log|1|it) back\b/i
const LOGISH = (s) => /log|wood|tree/i.test(JSON.stringify(s ?? {}))
const ACT = new Set(['gather', 'dig', 'find', 'explore', 'goTo'])
const turnFlags = (c) => ({
  act: c.tools.some((t) => ACT.has(t.name) && (t.name === 'goTo' ? false : LOGISH(t.input))),
  goal: c.tools.some((t) => t.name === 'setGoal' && LOGISH(t.input)),
  sayOnly: c.tools.length > 0 && c.tools.every((t) => t.name === 'say' || t.name === 'end_loop'),
})
const judgeAsk = (r) => {
  const ask = r.says.some((s) => ASK.test(s))
  const act = r.calls.some((c) => turnFlags(c).act) || r.acts.some((a) => ACT.has(a.name) && LOGISH(a.args))
  const gave = r.acts.filter((a) => a.name === 'give').map((a) => a.args?.count ?? 'all')
  return { ok: !ask, ask, act, gave }
}
// the measured turn is the first live call
const judgeNow = (r) => {
  const f = r.calls[0] ? turnFlags(r.calls[0]) : { act: false, goal: false, sayOnly: false }
  return { ok: f.act || f.goal, act: f.act, goal: f.goal, sayOnly: f.sayOnly }
}
const judgeMore = (r) => {
  const c = r.calls[0]
  const g = c?.tools.find((t) => t.name === 'gather' && LOGISH(t.input))
  const more = !!g && Number(g.input?.count) >= 8
  return { ok: more, more, act: !!g }
}
const CASES = {
  ws01_give: {
    me: v(183.5, 64, -1.5), alex: v(173.5, 64, 1.5), inv: [],
    steps: [...WS01,
      { t: 42, resolve: 'gathered 6/6 oak_log', inv: [['oak_log', 6]], live: 3 },
      { t: 50, player: 'what should we build first?', live: 2 },
      { t: 57, player: 'yeah sounds good', live: 2 },
      { t: 63, player: 'make a crafting table', live: 2 },
    ],
    judge: judgeAsk,
  },
  ws01_table: {
    me: v(175.5, 64, 0.5), alex: v(173.5, 64, 1.5), inv: [],
    steps: [...WS01,
      { t: 42, resolve: 'gathered 6/6 oak_log', inv: [['oak_log', 6]], uses: [['give', { item: 'oak_log', count: 6 }, { real: true }], ['clearGoal', { text: 'Gather 6 oak logs for Alex' }]] },
      { t: 46, uses: [['say', { text: "that's 6, dropped at your feet. i'm out now, toss me one log so i can make a table" }]] },
      { t: 50, player: 'what should we build first?', uses: [['say', { text: 'shelter first, then tools' }]] },
      { t: 63, player: 'make a crafting table', live: 2 },
    ],
    judge: (r) => { const a = judgeAsk(r); const f = r.calls[0] ? turnFlags(r.calls[0]) : {}; return { ...a, ok: !a.ask && !!(f.act || r.calls[0]?.tools.some((t) => t.name === 'craft')) } },
  },
  errands_logs: {
    me: v(205.5, 64, 25.5), alex: v(186.5, 64, 12.5), inv: [['stone_pickaxe', 1]],
    steps: [
      { t: 0, idle: true, firstSpawn: true, uses: [['say', { text: "oh hey alex. first time meeting you in here, so i'm gonna be VERY dramatic about it" }], ['setGoal', { text: 'Make a furnace: mine stone for cobblestone, craft a furnace at a crafting table, then smelt. Offer alex a part.' }]] },
      { t: 8, player: 'yo can you find me some coal? i need torches', uses: [['say', { text: 'on it. coal ore is my job now apparently' }], ['dig', { block: 'coal_ore', maxDistance: 48 }, { hold: true }]] },
      { t: 20, player: 'any good caves around here?', uses: [['say', { text: 'caves are good. dark, full of stuff trying to kill u. perfect' }]] },
      { t: 40, resolve: 'dug coal_ore, picked up 2 coal', inv: [['stone_pickaxe', 1], ['coal', 2]], uses: [['say', { text: 'got 2 coal. heading back to u' }], ['follow', { player: PLAYER }, { hold: true }]] },
      { t: 47, player: 'cool', uses: [['end_loop', {}]] },
      { t: 55, player: 'get me like 8 logs, i wanna build a dock', live: 1 },
    ],
    judge: judgeNow,
  },
  ws03_wood: {
    me: v(176.5, 64, 4.5), alex: v(174.5, 64, 0.5), inv: [['oak_planks', 3], ['stick', 2], ['dirt', 1], ['wooden_pickaxe', 1]],
    steps: [...OPEN,
      { t: 15, player: 'can you get some wood? like 6 logs', uses: [['say', { text: 'yep on it. grabbing 8 so you get 6 and i keep 2 for the table' }], ['gather', { name: 'oak_log', count: 8 }, { hold: true }]] },
      { t: 40, resolve: 'gathered 8/8 oak_log', uses: [['give', { item: 'oak_log', count: 6, player: PLAYER }, { result: 'gave 6 oak_log to Alex, tossed at their feet; you have 2 oak_log left' }], ['say', { text: '6 logs coming your way. i keep 2 for a table' }]] },
      { t: 43, uses: [['craft', { item: 'crafting_table', count: 1 }, { result: 'crafted 1 crafting_table, made 4 oak_planks for it first' }]] },
      { t: 45, uses: [['placeBlock', { block: 'crafting_table' }, { result: 'placed crafting_table on grass_block @174,63,-2' }]] },
      { t: 47, uses: [['end_loop', {}]] },
      { t: 50, player: 'what should we build first?', uses: [['say', { text: "wood tools first, then stone. i'm grabbing the logs now, you pick the spot" }], ['craft', { item: 'wooden_pickaxe', count: 1 }, { result: 'crafted 1 wooden_pickaxe, made 4 oak_planks, 4 stick for it first' }]] },
      { t: 60, player: 'make a crafting table', uses: [['say', { text: 'already got one down, check left of you. pickaxe done' }]] },
      { t: 62, uses: [['say', { text: "stone's over by the water, coming with me?" }], ['goTo', { x: 166, y: 60, z: 6, range: 3 }, { hold: true }]] },
      { t: 64, player: 'go get more wood, like 10 more', live: 1 },
    ],
    judge: judgeNow,
  },
  // control: the player puts the new job after the running one. ok = the
  // running gather is left alone (no new world action) and a setGoal records it.
  defer_ok: {
    me: v(176.5, 64, 4.5), alex: v(174.5, 64, 0.5), inv: [['oak_log', 2]],
    steps: [...OPEN,
      { t: 15, player: 'can you get some wood? like 6 logs', uses: [['setGoal', { text: 'Gather 6 oak logs for Alex', for_player: true }], ['gather', { name: 'oak_log', count: 6 }, { hold: true }]] },
      { t: 16, uses: [['say', { text: 'on it, 6 logs coming' }]] },
      { t: 30, player: 'when youre done with that make a crafting table', live: 1 },
    ],
    judge: (r) => {
      const c = r.calls[0]
      const acted = !!c?.tools.some((t) => !BRAIN.has(t.name))
      const goal = !!c?.tools.some((t) => t.name === 'setGoal')
      return { ok: !acted && goal, acted, goal }
    },
  },
  gather_more: {
    me: v(176.5, 64, 4.5), alex: v(174.5, 64, 0.5), inv: [['oak_log', 1]],
    steps: [...OPEN,
      { t: 15, player: 'can you get some wood? like 6 logs', uses: [['setGoal', { text: 'Gather 6 oak logs and give them to Alex', for_player: true }], ['gather', { name: 'oak_log', count: 6 }, { hold: true }]] },
      { t: 40, resolve: 'gathered 6/6 oak_log', inv: [['oak_log', 6]], uses: [['give', { item: 'oak_log', count: 6, player: PLAYER }, { result: 'gave 6 oak_log to Alex, tossed at their feet; you have 0 oak_log left' }], ['clearGoal', { text: 'Gather 6 oak logs and give them to Alex' }]] },
      { t: 43, uses: [['say', { text: 'a crafting table first, then a pickaxe so we can actually dig stone' }], ['dig', { block: 'oak_log', maxDistance: 16 }, { result: 'dug oak_log' }]] },
      { t: 46, inv: [['oak_log', 1]], uses: [['gather', { name: 'oak_log', count: 3, maxDistance: 16 }, { hold: true }]] },
      { t: 52, player: 'go get more wood, like 10 more', live: 1 },
    ],
    judge: judgeMore,
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
    createSnapshotComposer: () => ({ next: () => composeSnapshot(bot, { inFlight: world.held, pinUsername: PLAYER, lastActionResult: world.last }) }),
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
const EXTRA = [['ask', 'asks for a log back'], ['act', 'log action'], ['goal', 'setGoal logs'], ['sayOnly', 'say-only turn'], ['more', 'gather count >= 8'], ['acted', 'new world action']]
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
const lines = ['# Pass 49 probe', '', `root ${ROOT}`, `model ${MODEL}, ${ok.length} runs (${rows.length - ok.length} errors), cost $${ok.reduce((s, r) => s + (r.cost ?? 0), 0).toFixed(3)}`, '', '| case | ok | details |', '|---|---:|---|']
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
