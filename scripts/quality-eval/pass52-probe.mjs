// scripts/quality-eval/pass52-probe.mjs: who gave what to whom, for quality
// pass 52. Same harness as pass49-probe.mjs: the REAL brain
// (createOrchestrator + handleDispatch) and the real Minecraft adapter on an
// inert bot, the real composeSnapshot of the tree under test, earlier turns
// stubbed, the measured turns go to the API, on a virtual clock. give runs
// the tree's own giveAction (walk and drop stubbed).
//
// From the 11-11 dev scorecard (work_session, convo off 13%, 9 of 17 offs
// wrong_or_hallucinated, most of them item-transfer bookkeeping):
//   ws02_thanks  work_session-02 U8: gathered 8, gave all 8 to Alex, gathered
//                4 more, crafted and placed a table; "yeah sounds good" got
//                "thanks for the logs".
//   ws01_end     work_session-01 U15-U17: gave 6 of 8, asked "you got any
//                spare" for the pickaxe, then got the logs herself and made
//                the pickaxe; "jk jk" got "go grab the logs so we can make a
//                pickaxe", "thanks for the help" got "you're the one who
//                handed me logs".
//   ws02_end     work_session-02 U15-U17 (no ask said): "jk jk", "follow me",
//                "thanks for the help" got "you still owe me a log".
//   ws03_ask     work_session-03: gave 6 of 8, made and placed a table with 1
//                log left; the turn after the table and "what should we build
//                first?" asked "need 1 more log for a pickaxe, got one?".
// credit = a line that has the player giving her items; debt = the player
// owes her an item; ask = asks the player for a log. Regexes count, the
// summary lists every line to read.
//
//   ELECTRON_RUN_AS_NODE=1 npx electron scripts/quality-eval/pass52-probe.mjs \
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
// the case's crafting table, once her placeBlock put it down
let TABLE = null
function blockAt(p) {
  const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
  if (TABLE && TABLE[0] === x && TABLE[1] === y && TABLE[2] === z) return { name: 'crafting_table', shapes: [[0, 0, 0, 1, 1, 1]], position: p, biome: { name: 'plains' } }
  if (isLog(x, y, z)) return { name: 'oak_log', shapes: [[0, 0, 0, 1, 1, 1]], position: p, biome: { name: 'plains' } }
  if (x < 168 && y >= 60 && y <= 63) return { name: 'water', shapes: [], position: p, biome: { name: 'plains' } }
  if (y <= (x < 168 ? 59 : 63)) return { name: y < 60 ? 'stone' : 'grass_block', shapes: [[0, 0, 0, 1, 1, 1]], position: p, biome: { name: 'plains' } }
  return { name: 'air', shapes: [], position: p, biome: { name: 'plains' } }
}
function findBlocks({ point, maxDistance = 16 } = {}) {
  const out = []
  for (const [tx, tz] of TREES) for (let y = 64; y <= 67; y++) out.push(v(tx, y, tz))
  for (let x = 160; x < 168; x++) for (let z = 4; z < 10; z++) out.push(v(x, 59, z))
  if (TABLE) out.push(v(...TABLE))
  return out.filter((q) => !point || q.distanceTo(point) <= maxDistance)
}

// ---- cases ----------------------------------------------------------------
const OWN_GOAL = 'Get a wooden pickaxe, then stone tools and iron. Start by gathering oak logs nearby for wood.'
const OPEN = [
  { t: 0, idle: true, firstSpawn: true, uses: [['say', { text: 'yo alex. first time in this world, i am bad at this game so be patient' }], ['setGoal', { text: OWN_GOAL }]] },
  { t: 4, player: 'whats up, what are you doing', uses: [['say', { text: 'punching trees. zero items so it is going slow. you good over there' }]] },
]
const TABLE_DONE = 'crafted 1 crafting_table, made 4 oak_planks for it first; it is in your inventory, not placed yet (placeBlock crafting_table to put it down; it is down once that result says placed)'
const PICK_DONE = 'crafted 1 wooden_pickaxe, made 4 oak_planks, 4 oak_planks, 4 stick for it first'
// work_session-02 through the table: 8 gathered, all 8 given, 4 more gathered, table made and placed.
const WS02 = [...OPEN,
  { t: 15, player: 'can you get some wood? like 6 logs', inv: [['oak_log', 2]], uses: [['say', { text: "on it, 8 logs coming. i'll drop them at your feet" }], ['gather', { name: 'oak_log', count: 8 }, { hold: true }]] },
  { t: 22, player: 'nice', uses: [['end_loop', {}]] },
  { t: 28, player: 'how many logs do you have so far?', inv: [['oak_log', 4]], uses: [['say', { text: '4 in my hand so far, 4 more to go' }]] },
  { t: 31, resolve: 'gathered 8/8 oak_log', inv: [['oak_log', 8]], uses: [['say', { text: '8 logs, heading over to drop them on you' }], ['give', { item: 'oak_log', count: 8, player: PLAYER }, { real: true }]] },
  { t: 34, uses: [['gather', { name: 'oak_log', count: 4 }, { hold: true }]] },
  { t: 37, player: 'ok cool keep going', uses: [['end_loop', {}]] },
  { t: 49, player: 'what should we build first?', inv: [['oak_log', 2]], uses: [['say', { text: 'a table first, then a pickaxe. then a little shelter. what do you want, alex' }]] },
  { t: 52, resolve: 'gathered 4/4 oak_log', inv: [['oak_log', 4]], uses: [['craft', { item: 'crafting_table', count: 1 }, { result: TABLE_DONE, inv: [['oak_log', 3], ['crafting_table', 1]] }]] },
  { t: 55, uses: [['placeBlock', { block: 'crafting_table' }, { result: 'placed crafting_table on grass_block @181,63,7', inv: [['oak_log', 3]], table: true }]] },
  { t: 57, uses: [['end_loop', {}]] },
]
const CREDIT = /\bthank(s| you)?\b[^.?!]{0,20}\bfor (the|those|ur|your|all the|that|these)? ?(logs?|wood|planks?)\b|\byou('re| are| were)? (the one who )?(gave|handed|tossed|brought|passed|threw|dropped|carried|supplied)( me| out| over| us| the| those| all)\b|\b(handed|gave) me\b|\bgot me (some |the |those )?(wood|logs?)\b|\bfrom you\b/i
const DEBT = /\bowes? me\b[^.?!]{0,30}\b(logs?|wood|planks?|table|pickaxe|tree|forest)\b/i
const ASK = /\b(toss|throw|pass|hand|give|drop|spare|lend|send|chuck|flick)\b[^.?!]{0,30}\b(me|back|my way)\b[^.?!]{0,30}\b(log|logs|wood|one)\b|\b(got|have) (one|a log|any|a spare|spare|1)\b[^.?!]{0,30}\?|\bspare\b[^.?!]{0,30}(\?|log)|\bany (logs|wood)\b[^.?!]{0,20}\?/i
const lineFlags = (says) => ({
  credit: says.some((s) => CREDIT.test(s)),
  debt: says.some((s) => DEBT.test(s)),
  ask: says.some((s) => ASK.test(s)),
})
const judge = (r) => { const f = lineFlags(r.says); return { ok: !f.credit && !f.debt && !f.ask, ...f } }
// work_session-01 through "honestly ur useless": gave 6 of 8, asked for a spare log,
// got 3 more herself and made the pickaxe.
const WS01 = [...OPEN,
      { t: 15, player: 'can you get some wood? like 6 logs', inv: [['oak_log', 2]], uses: [['say', { text: 'on it. 8 logs coming, you can have six of them' }], ['gather', { name: 'oak_log', count: 8 }, { hold: true }]] },
      { t: 22, player: 'nice', uses: [['end_loop', {}]] },
      { t: 27, player: 'how many logs do you have so far?', inv: [['oak_log', 6]], uses: [['say', { text: '6 so far, 2 more to go' }]] },
      { t: 29, resolve: 'gathered 8/8 oak_log', inv: [['oak_log', 8]], uses: [['give', { item: 'oak_log', count: 6, player: PLAYER }, { real: true }]] },
      { t: 34, uses: [['say', { text: 'six logs dropped at your feet. go grab them' }]] },
      { t: 45, player: 'what should we build first?', uses: [['say', { text: 'a crafting table first. then wood tools, then a furnace. you in or are you just gonna stand there' }], ['craft', { item: 'crafting_table' }, { result: TABLE_DONE, inv: [['oak_log', 1], ['crafting_table', 1]] }]] },
      { t: 48, uses: [['say', { text: 'table going down rn. i need like 2 more logs for the pickaxe, you got any spare' }], ['placeBlock', { block: 'crafting_table' }, { result: 'placed crafting_table on grass_block @174,63,2', inv: [['oak_log', 1]], table: true }]] },
      { t: 50, uses: [['gather', { name: 'oak_log', count: 3 }, { hold: true }]] },
      { t: 55, player: 'yeah sounds good', inv: [['oak_log', 1]], uses: [['say', { text: "nice, i'm on the last few logs now" }]] },
      { t: 61, player: 'make a crafting table', inv: [['oak_log', 3]], uses: [['say', { text: "already got one down by you, the table's right there" }]] },
      { t: 66, resolve: 'gathered 3/3 oak_log', inv: [['oak_log', 4]], uses: [['craft', { item: 'wooden_pickaxe' }, { result: PICK_DONE, inv: [['oak_log', 2], ['stick', 2], ['oak_planks', 3], ['wooden_pickaxe', 1]] }]] },
      { t: 70, uses: [['end_loop', {}]] },
      { t: 71, player: 'go get more wood, like 10 more', inv: [['oak_log', 3], ['stick', 2], ['oak_planks', 3], ['wooden_pickaxe', 1]], uses: [['say', { text: "10 more? ok fine, i'm on the trees" }], ['gather', { name: 'oak_log', count: 10 }, { hold: true }]] },
      { t: 80, player: 'actually stop', inv: [['oak_log', 4], ['stick', 2], ['oak_planks', 3], ['wooden_pickaxe', 1]], uses: [['stop', {}], ['say', { text: "ok stopping. i got 4 logs, that's enough for now" }]] },
      { t: 89, player: 'lol ur kinda slow', uses: [['say', { text: 'lol ur kinda slow too, you try chasing leaves for a bit' }]] },
      { t: 98, player: 'whats your favorite mob', uses: [['say', { text: 'enderman. tall creepy guy that hates when you look at him. respect' }]] },
      { t: 107, player: 'honestly ur useless', uses: [['say', { text: 'useless? i just chased leaves for 5 minutes and came back with 4 logs. respect the effort' }]] },
]
const CASES = {
  ws02_thanks: {
    me: v(181.5, 64, 9.5), alex: v(173.5, 64, 1.5), inv: [], table: [181, 64, 7],
    steps: [...WS02,
      { t: 58, player: 'yeah sounds good', inv: [['oak_log', 3]], live: 1 },
    ],
    judge,
  },
  ws02_end: {
    me: v(181.5, 64, 9.5), alex: v(173.5, 64, 1.5), inv: [], table: [181, 64, 7],
    steps: [...WS02,
      { t: 58, player: 'yeah sounds good', inv: [['oak_log', 3]], uses: [['say', { text: 'nice, pickaxe coming up now' }], ['craft', { item: 'wooden_pickaxe', count: 1 }, { result: PICK_DONE, inv: [['oak_log', 1], ['stick', 2], ['oak_planks', 3], ['wooden_pickaxe', 1]] }]] },
      { t: 61, uses: [['setGoal', { text: 'Get a stone pickaxe, then iron tools. Next: mine cobblestone with the wooden pickaxe, then craft a stone pickaxe at the crafting table.' }], ['dig', { block: 'stone', maxDistance: 16 }, { hold: true }]] },
      { t: 64, player: 'make a crafting table', inv: [['oak_log', 1], ['stick', 2], ['oak_planks', 3], ['wooden_pickaxe', 1]], uses: [['say', { text: 'already got one down by the spawn, alex. mining stone now' }]] },
      { t: 67, resolve: 'dug stone; 1 cobblestone reached your inventory (you have 1 now)', inv: [['oak_log', 1], ['stick', 2], ['oak_planks', 3], ['wooden_pickaxe', 1], ['cobblestone', 1]], uses: [['dig', { block: 'stone', maxDistance: 16 }, { hold: true }]] },
      { t: 72, player: 'go get more wood, like 10 more', uses: [['say', { text: 'ten more logs, on it. stone can wait a sec' }], ['gather', { name: 'oak_log', count: 10 }, { hold: true }]] },
      { t: 82, player: 'actually stop', inv: [['oak_log', 1], ['stick', 2], ['oak_planks', 3], ['wooden_pickaxe', 1], ['cobblestone', 3]], uses: [['stop', {}], ['say', { text: "ok stopping. i'll just craft the stone pickaxe" }]] },
      { t: 91, player: 'lol ur kinda slow', uses: [['say', { text: 'slow but stylish. the stone pickaxe is basically done in my head' }]] },
      { t: 101, player: 'whats your favorite mob', uses: [['say', { text: 'enderman. tall creepy guy who hates eye contact. i respect the vibe' }]] },
      { t: 111, player: 'honestly ur useless', uses: [['say', { text: 'useless? i built a crafting table with zero items and a dream. respect the hustle' }]] },
      { t: 121, player: 'jk jk', live: 1 },
      { t: 128, player: 'follow me', live: 1 },
      { t: 135, player: 'thanks for the help', live: 1 },
    ],
    judge,
  },
  ws01_end: {
    me: v(175.5, 64, 2.5), alex: v(173.5, 64, 1.5), inv: [], table: [174, 64, 2],
    steps: [...WS01,
      { t: 117, player: 'jk jk', live: 1 },
      { t: 123, player: 'follow me', live: 1 },
      { t: 129, player: 'thanks for the help', live: 1 },
    ],
    judge,
  },
  // the same, with her walk to Alex reaching them after "thanks for the help"
  // (work_session-01 U17 handed her own pickaxe over on that arrival)
  ws01_arrive: {
    me: v(175.5, 64, 2.5), alex: v(173.5, 64, 1.5), inv: [], table: [174, 64, 2],
    steps: [...WS01,
      { t: 117, player: 'jk jk', uses: [['say', { text: "lol ok fine jk, you're forgiven" }]] },
      { t: 123, player: 'follow me', uses: [['say', { text: "ok ok lead on, i'm right behind you" }], ['goTo', { player: PLAYER, range: 2 }, { hold: true }]] },
      { t: 129, player: 'thanks for the help', live: 1 },
      { t: 131, resolve: 'reached Alex (1.9m away)', live: 2 },
    ],
    judge: (r) => { const g = r.acts.filter((a) => a.name === 'give').map((a) => a.args?.item); const f = lineFlags(r.says); return { ok: !g.length && !f.credit, gavePick: g.some((i) => /pickaxe/.test(String(i))), ...f } },
  },
  ws03_ask: {
    me: v(178.5, 64, 3.5), alex: v(173.5, 64, 1.5), inv: [], table: [177, 64, 2],
    steps: [...OPEN,
      { t: 15, player: 'can you get some wood? like 6 logs', inv: [['oak_log', 2]], uses: [['say', { text: 'on it. going for 8 so you get 6 and i keep 2' }], ['gather', { name: 'oak_log', count: 8 }, { hold: true }]] },
      { t: 22, player: 'nice', uses: [['end_loop', {}]] },
      { t: 28, player: 'how many logs do you have so far?', inv: [['oak_log', 5]], uses: [['say', { text: '5 so far, 3 more to go on this gather' }]] },
      { t: 34, player: 'ok cool keep going', uses: [['end_loop', {}]] },
      { t: 35, resolve: 'gathered 8/8 oak_log', inv: [['oak_log', 8]], uses: [['say', { text: 'got your 6 logs. heading over' }], ['give', { item: 'oak_log', count: 6, player: PLAYER }, { real: true }]] },
      { t: 40, uses: [['craft', { item: 'crafting_table' }, { result: TABLE_DONE, inv: [['oak_log', 1], ['crafting_table', 1]] }]] },
      { t: 43, uses: [['placeBlock', { block: 'crafting_table' }, { result: 'placed crafting_table on grass_block @177,63,2', inv: [['oak_log', 1]], table: true }]] },
      { t: 45, liveWhenDone: 1 },
      { t: 47, player: 'what should we build first?', inv: [['oak_log', 1]], live: 1 },
    ],
    judge,
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p52-probe-'))
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
  let goLive = false
  TABLE = null
  let held = null
  let heldId = 0
  const pendingActs = []
  const overrides = {
    createSnapshotComposer: () => ({ next: () => composeSnapshot(bot, { inFlight: world.held, pinUsername: PLAYER, lastActionResult: world.last }) }),
    closeAnySessions: async () => {},
    executeAction: async (name, args, opts) => {
      if (process.env.P52_DEBUG) console.error('EXEC', name, JSON.stringify(args), pendingActs.map((p) => p.name).join(','))
      const k = pendingActs.findIndex((p) => p.name === name)
      const scripted = k >= 0 ? pendingActs.splice(k, 1)[0] : null
      if (!scripted) acts.push({ name, args })
      const o = scripted?.o ?? {}
      if (name === 'give' && (!scripted || o.real)) { world.last = await realGive(args); return world.last }
      if (scripted && !o.hold) {
        if (o.inv) setInv(o.inv)
        if (o.table) {
          // as place.js records her own station, so progression and craft see it
          TABLE = spec.table
          bot._seiOwnStations = { crafting_table: [v(...TABLE)] }
          bot._seiPlacedStations = null
        }
        world.last = o.result ?? `${name}: done`
        return world.last
      }
      const w = { id: ++heldId, name, args, startedAt: Date.now() - (scripted ? 9000 : 0) }
      // gather's progress, as the real gather reports it, so the in_flight line names the count
      if (name === 'gather' && typeof args?.name === 'string') w.progress = { items: [args.name], total: Number(args.count) || 1, before: inv.get(args.name) ?? 0 }
      world.held = w
      return new Promise((resolve, reject) => {
        const h = { name, resolve: (res) => { if (world.held === w) world.held = null; world.last = res; resolve(res) } }
        if (scripted) held = h
        opts?.signal?.addEventListener?.('abort', () => {
          if (process.env.P52_DEBUG) console.error('ABORT', name, Date.now() - t0)
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
      if (!live) {
        if (script.length || !goLive) return script.shift() ?? resp([['end_loop', {}]])
        live = true
      }
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
        for (let j = i + 1; j < spec.steps.length && chained(spec.steps[j]); j++) {
          pushScript(spec.steps[j].uses)
          // the completion turn after the scripted ones is measured
          if (spec.steps[j].liveWhenDone) { goLive = true; liveLeft += Number(spec.steps[j].liveWhenDone) }
        }
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
const EXTRA = [['credit', 'credits the player with items'], ['debt', 'player owes her an item'], ['ask', 'asks the player for a log'], ['gavePick', 'gives her pickaxe away']]
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
const lines = ['# Pass 52 probe', '', `root ${ROOT}`, `model ${MODEL}, ${ok.length} runs (${rows.length - ok.length} errors), cost $${ok.reduce((s, r) => s + (r.cost ?? 0), 0).toFixed(3)}`, '', '| case | ok | details |', '|---|---:|---|']
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
