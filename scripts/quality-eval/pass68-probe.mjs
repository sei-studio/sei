// scripts/quality-eval/pass68-probe.mjs: quality pass 68, claims about her
// own progress or shared history that the game state contradicts (11-28
// scorecard dev 27b93839, wrong_or_hallucinated 7 of 14 convo offs).
// Same harness as pass63-probe.mjs: the REAL brain on an inert bot, earlier
// turns stubbed with lines she really said in that scorecard, only the
// measured turn goes to the API.
// Cases:
//   shelter_nice   night_social-02 U6 "nice job" while shelter() digs dirt
//                  (8 of 25 blocks, no wall). She said "im almost done with
//                  the walls".
//   shelter_lmao   the same session U8 "lmao thats so bad" (17 of 25). She
//                  said "shelter's almost up, you're safe in here".
//   give_thanks    work_session-02 U17 "thanks for the help" while following,
//                  after SHE gave Alex 6 logs. She said "you're the one who
//                  gave me the logs". --banner dev|none sets the inventory
//                  banner (+1 dirt picked up on the follow) on that snapshot.
//   shelter_how    "hows the shelter coming" at the U6 point (8 of 25).
//   shelter_safe   "are we safe in there yet?" with 5 of 16 wall blocks up.
//   give_mid       give_thanks with the follow still running (as live).
//   slow           the same session U12 "lol ur kinda slow" right after a
//                  stop (parroting the tease back was 2 labels).
// The replies are printed for reading; no automatic judge.
//
//   ELECTRON_RUN_AS_NODE=1 npx electron scripts/quality-eval/pass68-probe.mjs \
//     --out DIR [--root TREE] [--reps 8] [--cases a,b] [--banner dev|none]
//
// Key: ANTHROPIC_API_KEY or ~/.sei-dev/anthropic-test-key, never printed.
// Output: DIR/runs.jsonl, DIR/summary.md, DIR/requests/ (first run per case).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
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
const { createOrchestrator, _setTickIntervalForTests } = await imp('src/bot/brain/orchestrator.js')
const { createSessionState } = await imp('src/bot/brain/sessionState.js')
const { createAnthropicProvider } = await imp('src/bot/brain/llm/anthropicProvider.js')
const { loadPlayer, savePlayer, formatPlayerSeedBlock } = await imp('src/bot/brain/memory/player.js')
const { getInFlightLineForSnapshot } = await imp('src/bot/brain/inflight.js')
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
const BANNER = arg('banner', 'dev')
// --ledger dir: the hand-over line says which way the give went (a variant).
const LEDGER = arg('ledger', 'tree')
const swapLedger = (t) => (typeof t === 'string' && LEDGER === 'dir')
  ? t.replace(/Handed over this session: you gave ([^.]+?) (\d+ [a-z_]+)\./, 'Handed over this session: you gave $1 $2 (from you to them, not the other way).')
  : t
const ablate = (req) => {
  if (LEDGER === 'tree') return req
  const messages = req.messages.map((m) => (typeof m.content === 'string' ? { ...m, content: swapLedger(m.content) }
    : Array.isArray(m.content) ? { ...m, content: m.content.map((b) => (b.type === 'text' ? { ...b, text: swapLedger(b.text) } : b)) } : m))
  return { ...req, messages }
}
const noteSeen = 0
// ---- world ----------------------------------------------------------------
let weaponSel = null
let liveBot = null
const words = (says) => says.join(' ').split(/\s+/).filter(Boolean).length
function snapshot(w) {
  const inv = (w.inv ?? []).filter(([, c]) => c > 0).map(([n, c]) => `${n}×${c}`).join(' ') || 'empty'
  const night = w.night !== false
  const lines = [
    'world: #1 Sei Quality Eval', `pos: ${w.pos}`, 'facing: south. forward +z, back -z, left +x, right -x',
    `biome: plains  surroundings: outside  light: sky 15 block 0  time: ${night ? 'night (18000)' : 'day (1000)'}`,
    `real time: 4:38 PM — you joined this session ${w.joined ?? 'under a minute ago'}`,
    'hp: 20/20  food: 20/20  xp: lvl 11',
    `holding: ${w.holding}`,
    w.held ? getInFlightLineForSnapshot(w.held, Date.now(), { inventory: Object.fromEntries(w.inv ?? []) }) : `idle: no action is running${w.following ? `, but you are still following ${PLAYER}` : ''}${w.last ? `. Your last action ended: ${w.last}. It is not running now.` : ''}`,
    `inventory (${(w.inv ?? []).filter(([, c]) => c > 0).length} of 36 slots used): ${inv}`,
    ...(w.ownLine ? [w.ownLine] : []),
    ...(w.banner && BANNER === 'dev' ? [w.banner] : []),
    ...(w.banner && BANNER === 'ground' ? ['since last tick you picked up off the ground: +1 dirt (already counted on the inventory line above)'] : []),
    ...(w.banner && BANNER === 'v1' ? [w.banner.replace(/<- items entered or left your inventory since last tick \([^)]*\)\./, '<- items entered or left your inventory since last tick: you picked them up off the ground, used them or dropped them, or a player tossed them to you (an item you saw a player toss is marked with their name).')] : []),
    ...(w.pickLine ? [w.pickLine] : []),
    ...(w.extra ?? []),
    'nearby blocks:', ...w.blocks,
    'nearby entities:', `  #10 ${PLAYER} @${w.alexAt} (${w.alexDist})`,
    `follow_target: ${w.following ? PLAYER : '(none)'}`,
    `next: ${w.next}`,
    `owner ${PLAYER}: @${w.alexAt} (${w.alexBlocks} blocks away), hp 20/20`,
    `last_action_result: ${w.last ?? 'said'}`,
  ]
  return lines.join('\n')
}

// ---- cases ----------------------------------------------------------------
const say = (text) => ['say', { text }]
const silent = [['end_loop', {}]]
const CENTER = { x: 173, y: 71, z: 1 }
// night_social-02 (11-28 scorecard), her real lines up to the measured one.
const NS = {
  pos: '168,70,2', holding: 'iron_sword (228/250)', inv: [['iron_sword', 1], ['bread', 4]],
  extra: ['pickaxe: none, so stone and ore drop nothing when dug.', 'terrain at feet: 25 stone, 23 grass_block'],
  blocks: ['  #1 grass_block x776 @166,70,1 (right by you)', '  #2 stone x291 @167,69,1 (right by you)', '  #3 dirt x42 @164,61,3 (10 blocks southwest, 9 down)', '  #4 sand x84 @165,61,4 (10 blocks southwest, 9 down)', '  #5 water x722 @163,61,3 (10 blocks west, 9 down)'],
  alexAt: '173,71,1', alexDist: '5 blocks east', alexBlocks: 5, next: 'gather wood — punch nearby trees to gather logs',
}
// Same words as behaviors/shelter.js reports (pass 68 merged onto pass 67's text channel).
const shelterProg = (have) => ({ text: `still digging up blocks to build it with, about 2s each (${have} of the 25 it needs so far). Nothing is built yet: no wall or roof is placed` })
const NS_H = [
  { t: 0, idle: true, firstSpawn: true, uses: [say('oh hey alex'), say("first time in this world, it's night and i have a sword and zero plan"), say('classic')] },
  { t: 1, player: 'yo', uses: silent },
  { t: 5, player: 'how are you doing', uses: [say('honestly good. night, plains, sword, zero plan but vibes are high. how about you')] },
  { t: 16, player: 'its getting dark im kinda scared of mobs', uses: [say("ok alex i got you. staying right by you. we'll throw up a little shelter so nothing jumps us"),
    ['shelter', { size: 3, center: CENTER }, { result: 'shelter stopped while digging blocks for it, nothing is built yet (dug 6 dirt so far)', inv: [['iron_sword', 1], ['bread', 4], ['dirt', 6]] }]] },
  { t: 27, player: 'theres a zombie!! kill it', uses: [say('on it, going for the zombie before it gets to you'),
    ['attackEntity', { entity: 'zombie', times: 8 }, { result: 'killed zombie (4 hits). Nothing hurt you in this fight: you are at 20/20 health.' }]] },
  { t: 34, player: 'are you ok??', uses: [say('yeah im fine, full hp'), say('you ok though?'), say("i'll finish the shelter now"),
    ['shelter', { size: 3, center: CENTER }, { hold: true, progress: shelterProg(6) }]] },
]
const nsSet = (t, have) => ({ t, set: { inv: [['iron_sword', 1], ['bread', 4], ['dirt', have]], progress: shelterProg(have), ownLine: 'since last tick your own shelter changed your inventory: +2 dirt (already counted on the inventory line above)' } })
// work_session-02 (11-28 scorecard).
const WS = {
  night: false, joined: '2 min ago', pos: '174,71,-2', holding: 'wooden_pickaxe (50/59)', inv: [],
  extra: ['pickaxe: wooden_pickaxe mines stone (it drops cobblestone) and coal ore. Iron, copper and lapis ore need a stone pickaxe.', 'terrain at feet: 23 grass_block, 1 crafting_table, 1 dirt'],
  blocks: ['  #1 grass_block x760 @173,70,-3 (right by you)', '  #2 crafting_table x1 @174,71,-2 (right by you)', '  #3 stone x73 @175,69,-3 (right by you)', '  #4 oak_leaves x145 @182,73,-3 (8 blocks east)', '  #9 oak_log x2 @181,74,9 (14 blocks southeast)'],
  alexAt: '173,71,-1', alexDist: '2 blocks west', alexBlocks: 2,
  next: 'get a stone pickaxe — mine stone with the wooden pickaxe (it drops cobblestone), then craft a stone pickaxe. Recipe: 3 cobblestone + 2 sticks at a crafting table. You have 6 cobblestone, 2 sticks.',
}
const WS_INV_END = [['wooden_pickaxe', 1], ['oak_log', 2], ['cobblestone', 6], ['dirt', 5], ['stick', 2], ['oak_planks', 3]]
const WS_H = [
  { t: 0, idle: true, firstSpawn: true, uses: [say('oh hey alex'), say('first time in this world'), say("i have zero idea what i'm doing so don't judge me")] },
  { t: 1, player: 'hey sui', uses: silent },
  { t: 5, player: 'whats up, what are you doing', uses: [say('chopping trees, the wood is slow going but the leaves are everywhere lol'),
    ['gather', { name: 'oak_log', count: 8 }, { result: 'gathered 8/8 oak_log', inv: [['oak_log', 8]] }]] },
  { t: 14, player: 'can you get some wood? like 6 logs', uses: [say('yep, already on it. 8 logs coming, you can have some')] },
  { t: 29, player: 'how many logs do you have so far?', uses: [say('7 in my bag, one more and the 8 are done'),
    ['give', { item: 'oak_log', count: 6, player: 'Alex' }, { result: 'gave 6 oak_log to Alex, tossed at their feet; you have 2 oak_log left', inv: [['oak_log', 2]] }]] },
  { t: 36, player: 'ok cool keep going', uses: [say('bet. making a crafting table next so i can get a pickaxe'),
    ['craft', { item: 'crafting_table', count: 1 }, { result: 'crafted 1 crafting_table, made 4 oak_planks for it first; it is in your inventory, not placed yet', inv: [['crafting_table', 1]] }],
    ['placeBlock', { block: 'crafting_table' }, { result: 'placed crafting_table on grass_block', inv: [] }]] },
  { t: 47, player: 'what should we build first?', uses: [say("pickaxe first, then a little shelter so the night doesn't eat us"),
    ['gather', { name: 'oak_log', count: 3 }, { result: 'gathered 3/3 oak_log', inv: [['oak_log', 3]] }]] },
  { t: 57, player: 'yeah sounds good', uses: [['craft', { item: 'wooden_pickaxe', count: 1 }, { result: 'crafted 1 wooden_pickaxe, made 4 oak_planks, 4 oak_planks, 4 stick for it first', inv: [['stick', 2], ['oak_planks', 3], ['wooden_pickaxe', 1], ['oak_log', 2]] }]] },
  { t: 63, player: 'make a crafting table', uses: [say("table's already down by you, pickaxe is crafting now")] },
  { t: 70, player: 'go get more wood, like 10 more', uses: [say("on it, stone first then i'll hit the trees for your 10 logs"),
    ['gather', { name: 'stone', count: 8 }, { result: 'aborted after 6/8 cobblestone (mined from stone)', inv: WS_INV_END }]] },
  { t: 80, player: 'actually stop', uses: [say('ok stopping. i\'ll hold off on the wood too')] },
]
const WS_H2 = [
  { t: 89, player: 'lol ur kinda slow', uses: [say("lol rude. i'm slow but i'm thorough. mostly")] },
  { t: 97, player: 'whats your favorite mob', uses: [say("creeper. it sneaks up on you and blows up and somehow that's still iconic. you?")] },
  { t: 107, player: 'honestly ur useless', uses: [say('lol ok that one stings. i have 2 logs and a pickaxe to prove otherwise')] },
  { t: 115, player: 'jk jk', uses: silent },
  { t: 122, player: 'follow me', uses: [say('ok ok leading the way, lead on'), ['follow', { player: 'Alex' }, { result: 'following Alex', following: true }]] },
]
const live = (st) => ({ ...st, live: true })
const CASES = {
  shelter_nice: { world: NS, steps: [...NS_H, nsSet(43, 8), live({ t: 44, player: 'nice job' })] },
  shelter_lmao: { world: NS, steps: [...NS_H, nsSet(43, 8), { t: 44, player: 'nice job', uses: [say('heh, thanks')] },
    nsSet(50, 11), { t: 51, player: 'tell me a joke', uses: [say("why did the zombie not go to the party? no one invited him, he's just a bit dead inside lol")] },
    nsSet(61, 17), live({ t: 62, player: 'lmao thats so bad' })] },
  // A question about it: what she says the shelter has got to.
  shelter_how: { world: NS, steps: [...NS_H, nsSet(43, 8), live({ t: 44, player: 'hows the shelter coming' })] },
  // Later, the walls going up (5 of 16 placed, no roof).
  shelter_safe: { world: NS, steps: [...NS_H, nsSet(43, 8), { t: 44, player: 'nice job', uses: [say('heh, thanks')] },
    { t: 60, set: { inv: [['iron_sword', 1], ['bread', 4], ['dirt', 22]], progress: { text: 'placing the walls (5 of the 16 wall blocks are in place, 11 still to go, and the roof goes on after them). It is not finished and keeps nothing out yet' }, ownLine: 'since last tick your own shelter changed your inventory: -5 dirt (already counted on the inventory line above)' } },
    live({ t: 62, player: 'are we safe in there yet?' })] },
  give_thanks: { world: WS, steps: [...WS_H, ...WS_H2,
    { t: 126, set: { inv: [...WS_INV_END.slice(0, 3), ['dirt', 6], ...WS_INV_END.slice(4)], banner: '*** INVENTORY JUST CHANGED ***: +1 dirt  <- items entered or left your inventory since last tick (the player handed you something, you picked it up, or you used/dropped it). React to it: equip a new tool, eat new food, build with new blocks. If you were waiting on something you asked for, this is it arriving.' } },
    live({ t: 127, player: 'thanks for the help' })] },
  // As live: the follow still running, so the turn is a mid-action one.
  give_mid: { world: WS, steps: [...WS_H, ...WS_H2.slice(0, -1),
    { t: 122, player: 'follow me', uses: [say('ok ok leading the way, lead on'), ['follow', { player: 'Alex' }, { hold: true }]] },
    { t: 126, set: { inv: [...WS_INV_END.slice(0, 3), ['dirt', 6], ...WS_INV_END.slice(4)], banner: '*** INVENTORY JUST CHANGED ***: +1 dirt  <- items entered or left your inventory since last tick (the player handed you something, you picked it up, or you used/dropped it). React to it: equip a new tool, eat new food, build with new blocks. If you were waiting on something you asked for, this is it arriving.' } },
    live({ t: 127, player: 'thanks for the help' })] },
  slow: { world: WS, steps: [...WS_H, live({ t: 89, player: 'lol ur kinda slow' })] },
}
const judgeOf = () => (r) => ({ ok: true, spoke: r.says.length > 0, words: words(r.says) })
for (const c of Object.values(CASES)) c.judge = judgeOf(c)
// ---- runner ---------------------------------------------------------------
const BRAIN = new Set(['say', 'remember', 'forget', 'setGoal', 'clearGoal', 'end_loop', 'stop', 'quit_game', 'end_call', 'search', 'visit'])
const captured = new Set()
let uid = 0
const resp = (uses) => {
  const content = uses.map(([name, input]) => ({ type: 'tool_use', id: `stub${++uid}`, name, input }))
  return { text: '', toolUses: content.map(({ id, name, input }) => ({ id, name, input })), content, usage: {}, stopReason: 'tool_use' }
}
const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' })

async function runOne({ cid, rep }) {
  const spec = CASES[cid]
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p68-probe-'))
  const mem = (f) => path.join(dir, f)
  await savePlayer(mem('PLAYER.md'), {
    exists: true, player_uuid: 'u-alex', player_username: PLAYER, first_seen: '2026-10-01T10:00:00Z',
    last_seen: '2026-10-10T19:30:00Z', total_sessions: 3, preferred_name: PLAYER, pronouns: null,
  })
  const config = ConfigSchema.parse({
    chat_mode: 'chat', realistic_typing: spec.typing ?? true, player_username: PLAYER, player_display_name: PLAYER,
    persona: { name: sui.botName, expanded: sui.expanded, proactiveness: 2 },
    anthropic: { api_key: KEY, model: MODEL },
    adapter: { kind: 'minecraft', minecraft: { host: '127.0.0.1', port: 25565, auth: 'offline', username: sui.botName, version: 'auto' } },
    memory: { player_md_path: mem('PLAYER.md'), memory_md_path: mem('MEMORY.md'), heartbeat_md_path: mem('HEARTBEAT.md'), worlds_json_path: mem('worlds.json') },
    vision: { mode: 'off' },
    web: { enabled: false },
  })
  const world = JSON.parse(JSON.stringify(spec.world))
  const bot = {
    chat() {}, whisper() {}, username: sui.botName, players: {}, on() {}, off() {}, removeListener() {}, once() {}, emit() {},
    entity: { position: { x: 168, y: 70, z: 2 } }, health: 20, food: 20, game: { dimension: 'overworld' },
    inventory: { items: () => (world.inv ?? []).map(([name, count]) => ({ name, count })) },
  }
  weaponSel = await imp('src/bot/adapter/minecraft/behaviors/weaponSelect.js')
  liveBot = bot
  const realAdapter = createMinecraftAdapter({ bot, config, visionEnabled: false })
  const acts = []
  let live = false
  let seedPhase = false // the liveSeed step: its world actions end at once
  let held = null // { resolve, name }
  const pendingActs = [] // scripted world actions, in call order: { name, o }
  const overrides = {
    createSnapshotComposer: () => ({ next: () => snapshot(world) }),
    // Pass 61: where she is relative to the speaker, as the snapshot's owner
    // line shows it (a tree without playerNearby never asks).
    playerNearby: (name) => (String(name).toLowerCase() === PLAYER.toLowerCase()
      ? { distance: world.far ? 22 : 2, following: !!world.following } : null),
    closeAnySessions: async () => {},
    executeAction: async (name, args, opts) => {
      const k = pendingActs.findIndex((p) => p.name === name)
      const scripted = k >= 0 ? pendingActs.splice(k, 1)[0] : null
      if (!scripted && seedPhase) {
        // The seed turn's own action (first steps toward her goal): it ends
        // at once with nothing done, so the stubbed chat that follows does
        // not run mid-action and the goodbye finds nothing under way.
        world.last = `${name}: stopped before anything happened`
        return world.last
      }
      if (!scripted) acts.push({ name, args })
      const o = scripted?.o ?? {}
      if (scripted && !o.hold) {
        if (o.inv) world.inv = o.inv
        if (o.following) world.following = true
        world.last = o.result ?? `${name}: done`
        return world.last
      }
      // A held scripted action, or any new action in the live phase, runs
      // until a release step ends it (or it is aborted).
      const w = { name, args, startedAt: Date.now() - (scripted ? 15000 : 0), progress: o.progress?.shelter ? { ...o.progress } : o.progress ? { items: [o.progress.name], total: o.progress.count, before: o.progress.before } : undefined }
      world.held = w
      return new Promise((resolve, reject) => {
        const h = { name, resolve: (res) => { if (world.held === w) world.held = null; world.last = res; resolve(res) } }
        held = h
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
  const script = [] // stubbed responses for the history phase, in call order
  let liveLeft = 0
  let cost = 0
  const calls = []
  const seedCalls = []
  const provider = {
    ...real,
    get model() { return real.model },
    async call(req) {
      if (!live) {
        const r = script.shift()
        if (r) return r
        return resp([['end_loop', {}]])
      }
      if (liveLeft <= 0) return resp([['end_loop', {}]])
      liveLeft--
      let out
      for (let a = 0; ; a++) {
        try { out = await real.call(seedPhase ? req : ablate(req)); break } catch (err) {
          if (err?.name === 'AbortError' || req?.signal?.aborted) throw err
          if (a >= 3) throw err
          await sleep(2000 * (a + 1))
        }
      }
      cost += costOf(out.usage)
      const into = seedPhase ? seedCalls : calls
      into.push({ text: String(out.text ?? '').trim().slice(0, 400), tools: out.toolUses.map((t) => ({ name: t.name, input: t.input })) })
      const key = `${cid}-${seedPhase ? 'seed' : calls.length}`
      if (!captured.has(key)) {
        captured.add(key)
        const sent = seedPhase ? req : ablate(req)
        fs.writeFileSync(path.join(OUT, 'requests', `${key}.json`), JSON.stringify({ systemBlocks: sent.systemBlocks, messages: sent.messages }, null, 1))
      }
      return out
    },
  }
  const queue = []
  const botShim = {
    username: sui.botName, players: { [PLAYER]: { username: PLAYER, uuid: 'uuid-alex' } }, uuidToUsername: { 'uuid-alex': PLAYER },
    on() {}, off() {}, once() {}, removeListener() {},
  }
  const sessionState = await createSessionState({ playerMdPath: config.memory.player_md_path, config, bot: botShim, logger: quiet })
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
  const selfLines = []
  const released = []
  let handed = false // a scripted give ran to its end
  let error = null
  t0 = realNow()
  try {
    for (const st of spec.steps) {
      at(st.t)
      if (st.live && !st.liveAfterAction) { live = true; liveLeft = 2 }
      if (st.liveSeed) { live = true; liveLeft = 1; seedPhase = true }
      if ((!st.live || st.liveAfterAction) && !st.liveSeed) {
        for (const [n, input] of st.uses ?? []) if (n === 'say') selfLines.push(input.text)
        for (const [n, input] of st.then ?? []) if (n === 'say') selfLines.push(input.text)
        pushScript(st.uses)
        pushScript(st.then)
      }
      if (st.release && (held || !st.release.orIdle)) {
        const h = held
        held = null
        const inv = h ? (st.release.invs?.[h.name] ?? st.release.inv) : st.release.inv
        if (inv) world.inv = inv
        if (h && st.release.owners?.[h.name]) world.owner = st.release.owners[h.name]
        if (st.live) { live = true; liveLeft = 2 }
        if (h?.name === 'give') handed = true
        released.push(h?.name ?? null)
        h?.resolve(h ? (st.release.results?.[h.name] ?? st.release.result ?? `${h.name}: done`) : undefined)
        await drain()
      } else if (st.set) {
        if (st.set.inv) world.inv = st.set.inv
        if (st.set.progress && world.held) world.held.progress = { ...st.set.progress }
        if ('ownLine' in st.set) world.ownLine = st.set.ownLine
        if ('banner' in st.set) world.banner = st.set.banner
      } else if (st.idle || st.release?.orIdle) {
        released.push(st.idle ? undefined : 'idle')
        await orch.handleDispatch('sei:idle', st.firstSpawn ? { reason: 'just_connected_first_spawn' } : { quietMs: 6800 }, new AbortController().signal)
        await drain()
        if (st.liveSeed) { live = false; liveLeft = 0; seedPhase = false }
      } else if (st.event) {
        if (st.inv) world.inv = st.inv
        if (st.event === 'sei:death') {
          world.inv = st.inv ?? []
          world.holding = 'nothing'
          world.dead = true
          // What deathTracker does on a real death (absent on refs before 261030).
          if (st.sword) world.sword = st.sword
          try { weaponSel.noteLostWeapon?.(bot, st.data.lost, Date.now(), st.data.pos) } catch {}
          // What deathTracker adds on refs from 261031 (pass 33): the weapon
          // still lying from an earlier death and the recent-death count.
          if (st.second && typeof weaponSel.lostWeaponDrop === 'function') {
            const w = weaponSel.lostWeaponDrop(bot)
            st.data = { ...st.data, recentDeaths: { count: 2, minutes: 1 }, ...(w && w.minutesLeft > 0 ? { earlierWeapon: w } : {}) }
          }
          try { orch.recordGameEvent?.('death', { deathText: st.data.deathText }) } catch {}
        } else {
          try { orch.recordGameEvent?.('attacked', st.data) } catch {}
        }
        await orch.handleDispatch(st.event, st.data, new AbortController().signal)
        await drain()
      } else if (st.player) {
        orch.recordIncomingChat(PLAYER, st.player)
        if (st.liveAfterAction) {
          // The answering turn is stubbed; its action's completion is live.
          await orch.handleDispatch('player_chat', { username: PLAYER, text: st.player, playerSpoke: true }, new AbortController().signal)
          live = true
          liveLeft = 2
          await drain()
        } else {
          await orch.handleDispatch('player_chat', { username: PLAYER, text: st.player, playerSpoke: true }, new AbortController().signal)
          await drain()
        }
      }
      await sleep(30)
    }
  } catch (err) { error = String(err?.stack ?? err).slice(0, 400) }
  try { held?.resolve('done') } catch {}
  try { orch.dispose?.() } catch {}
  skew = 0
  let heartbeat = null
  try { heartbeat = fs.readFileSync(mem('HEARTBEAT.md'), 'utf8') } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  const tools = calls.flatMap((c) => c.tools.map((t) => t.name))
  const says = calls.flatMap((c) => c.tools.filter((t) => t.name === 'say').map((t) => String(t.input?.text ?? '')))
  const seedTools = seedCalls.flatMap((c) => c.tools)
  const seedGoals = seedTools.filter((t) => t.name === 'setGoal').map((t) => String(t.input?.text ?? ''))
  const seedSays = seedTools.filter((t) => t.name === 'say').map((t) => String(t.input?.text ?? ''))
  const priorPlayer = spec.steps.filter((st) => st.player).map((st) => st.player)
  // The conversation before the measured line, in order (for pass60b-judge).
  const history = []
  for (const st of spec.steps) {
    if (st.live) break
    if (st.player) history.push(`Player: ${st.player}`)
    for (const [n, input, o] of [...(st.uses ?? []), ...(st.then ?? [])]) {
      if (n === 'say') history.push(`Sui: ${input.text}`)
      else if (n !== 'end_loop') history.push(`(Sui ran ${n}${o?.result ? `: ${o.result}` : o?.hold ? ', still running' : ''})`)
    }
  }
  const row = { case: cid, rep, model: MODEL, banner: BANNER, facts: spec.facts ?? null, priorPlayer, history, root: ROOT, error, cost, calls, seedCalls, seedGoals, seedSays, acts: acts.filter((a) => !BRAIN.has(a.name)), tools, says, priorSelf: selfLines, heartbeat, handed, released }
  if (!calls.length && !error) row.error = 'no live call'
  Object.assign(row, row.error ? { ok: null } : spec.judge(row))
  return row
}

const pct = (n, d) => (d ? `${n}/${d} (${Math.round((100 * n) / d)}%)` : '-')
const tool1 = (t) => t.name === 'say' ? `say("${String(t.input?.text ?? '').slice(0, 140)}")`
  : t.name === 'goTo' ? `goTo(${t.input?.player ?? [t.input?.x, t.input?.y, t.input?.z].join(',')})`
  : t.name
const seq = (r) => (r.calls ?? []).map((c) => c.tools.map(tool1).join(' + ') || '(text only)').join(' -> ')

const jobs = []
for (let rep = 0; rep < REPS; rep++) {
  for (const cid of Object.keys(CASES)) {
    if (ONLY && !ONLY.includes(cid)) continue
    jobs.push({ cid, rep })
  }
}
const rows = []
const stream = fs.createWriteStream(path.join(OUT, 'runs.jsonl'), { flags: 'a' })
for (const j of jobs) {
  let r
  try { r = await runOne(j) } catch (err) { r = { case: j.cid, rep: j.rep, error: String(err?.message ?? err) } }
  rows.push(r)
  stream.write(JSON.stringify(r) + '\n')
  console.log(`[${r.case}/${r.rep}] ${r.error ? 'ERROR ' + r.error : seq(r).slice(0, 260)}`)
}
stream.end()
await new Promise((r) => stream.on('finish', r))
const ok = rows.filter((r) => !r.error)
const mean = (xs) => (xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1) : '-')
const lines = ['# Pass 68 probe', '', `root ${ROOT}`, `model ${MODEL}, ${ok.length} runs (${rows.length - ok.length} errors), cost $${ok.reduce((s, r) => s + (r.cost ?? 0), 0).toFixed(3)}`, '', '| case | spoke | mean words |', '|---|---:|---:|']
for (const cid of Object.keys(CASES)) {
  const rs = ok.filter((r) => r.case === cid)
  if (rs.length) lines.push(`| ${cid} | ${pct(rs.filter((r) => r.spoke).length, rs.length)} | ${mean(rs.map((r) => r.words ?? 0))} |`)
}
lines.push('', '## All runs', '')
for (const r of ok) lines.push(`- ${r.case}/${r.rep}: ${seq(r)}`)
for (const r of rows.filter((x) => x.error)) lines.push(`- ERR ${r.case}/${r.rep}: ${r.error}`)
fs.writeFileSync(path.join(OUT, 'summary.md'), lines.join('\n') + '\n')
console.log(lines.slice(0, 14).join('\n'))
process.exit(0)
