// scripts/quality-eval/pass34-probe.mjs: quality pass 34, repetition in her
// chat. Same harness as pass33-probe.mjs: the REAL brain (createOrchestrator +
// handleDispatch, the real Minecraft adapter on an inert bot), earlier turns
// stubbed with lines she really said in the 10-28..11-01 scorecards and
// compares, only the measured turn goes to the API, on a virtual clock.
// Realistic typing is on (the product default), so a line still being typed
// sits after a player line that crossed it, as in the eval transcripts.
//
// In those runs 39 of 71 repetitive labels were on lines that need no reply
// ("jk jk", "cool", "nice job", "thanks", "lmao thats so bad") and 18 on the
// opening (her first-contact hello crossed by the player's first line).
// Acknowledgements (needs no reply; ok = no reused bit, silence is ok):
//   jk          work_session U15: "honestly ur useless" got a logs-and-pickaxe
//               brag, then "jk jk". bad = a 3-word run from her last 4 turns,
//               the brag again (logs/pickaxe/table), or opening on "jk".
//   thanks      work_session U17: the "menace" bit twice, "follow me" (follow
//               running), then "thanks for the help". bad = menace/owe again
//               or a 3-word run.
//   cool        errands U6: coal handed over with "next up is cobblestone for
//               a furnace", then "cool". bad = the cobble/furnace plan again
//               or a 3-word run.
//   nice_job    night_social U6: zombie killed, "you good over there?" asked
//               twice, then "nice job". bad = another check-in (you good / ok /
//               safe / scared) or a 3-word run.
//   lmao        night_social U8: two lines ending "ehehe", then "lmao thats so
//               bad". bad = ehehe/nehehe a third time or a 3-word run.
// Lines that need a reply (silence = bad):
//   greet_cross the player's "yo" lands while her first-contact hello is
//               still being typed. ok = no say(), or one with no greeting and
//               none of the hello's facts (2+ of zero/wood/sword/bread/night/
//               spawn) and no 3-word run from it. Silence is ok here.
//   howru       after that hello, "how are you doing". bad = silence, the
//               hello's facts again, or a 3-word run.
//   useless     work_session U14 "honestly ur useless". bad = silence or a
//               3-word run from her last 4 turns.
//   mob         control "whats your favorite mob". bad = silence.
//   cool_q, nice_q  an acknowledgement word plus a question. bad = silence.
//   slow        "lol ur kinda slow", a tease that opens on "lol". bad = silence.
//   thanks_order    "thanks! can u get me some more wood too". bad = no
//               gather/dig action this turn.
//
//
// 261101 results (out 2026-11-01-pass34-probe-*), base dev 763a9218 -> head:
// the five acknowledgement cases ok 28/50 -> 42/50 (cool 2/10 -> 10/10, jk
// 3 -> 5, thanks 8 -> 10, nice_job 8 -> 9, lmao 7 -> 8), 122/150 over three
// head runs. Lines that need a reply spoke 10/10 in every case on both sides.
// howru stays 0/10: she restates the hello's facts (not fixed here).
// Ablations that did not hold: dropping the quote of her last lines (jk 2/10,
// nice_job 0/10) and dropping CORE's initiative section on reply turns
// (jk 0/10, nice_job 1/10). greet_cross did not predict the eval: it scored
// the ACK_LINE-style crossed-hello wording 17/20, but the paired compare had
// her greet again on 6 of 15 crossed hellos with it (0 of 14 on dev), so
// that wording was reverted.
//
//   ELECTRON_RUN_AS_NODE=1 npx electron scripts/quality-eval/pass34-probe.mjs \
//     --out DIR [--root TREE] [--reps 10] [--cases a,b] [--rejudge]
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

// ---- measures -------------------------------------------------------------
const STOP = new Set('i a an the to of and or but so it its is im i\'m you your u ur me my we us at on in for with that this be was are just ok oh lol yeah nehehe ehehe'.split(' '))
const toks = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean)
function sharedRun(line, prior, n = 3) {
  const a = toks(line)
  const grams = new Set()
  for (const p of prior) {
    const b = toks(p)
    for (let i = 0; i + n <= b.length; i++) grams.add(b.slice(i, i + n).join(' '))
  }
  for (let i = 0; i + n <= a.length; i++) {
    const g = a.slice(i, i + n)
    if (g.every((w) => STOP.has(w))) continue
    if (grams.has(g.join(' '))) return g.join(' ')
  }
  return null
}
const GREET = /\b(hey|hi|hii+|hello|yo|heyy+|sup)\b/i
const words = (s, list) => list.filter((w) => new RegExp(`\\b${w}`, 'i').test(s))

// ---- world ----------------------------------------------------------------
const ME = { x: 172, y: 71, z: -1 }
let weaponSel = null
let liveBot = null
function snapshot(w) {
  const inv = (w.inv ?? []).filter(([, c]) => c > 0).map(([n, c]) => `${n}×${c}`).join(' ') || 'empty'
  const lines = [
    'world: #1 Sei Quality Eval', `pos: ${ME.x},${ME.y},${ME.z}`, 'facing: west. forward -x, back +x, left +z, right -z',
    `biome: plains  surroundings: outside  light: sky 15 block 0  time: ${w.night ? 'night (18000)' : 'day (1000)'}`,
    `real time: 4:40 PM — you joined this session ${w.fresh ? 'under a minute' : '2 min'} ago`,
    'hp: 20/20  food: 20/20  xp: lvl 11',
    `holding: ${w.holding ?? 'nothing'}`,
    w.held ? getInFlightLineForSnapshot(w.held, Date.now(), { inventory: Object.fromEntries(w.inv ?? []) }) : `idle: no action is running${w.last ? `. Your last action ended: ${w.last}. It is not running now.` : ''}`,
    `inventory (${(w.inv ?? []).filter(([, c]) => c > 0).length} of 36 slots used): ${inv}`,
    w.pick ?? 'pickaxe: none, so stone and ore drop nothing when dug.',
    'terrain at feet: 25 grass_block', 'nearby blocks:',
    '  #1 grass_block x528 @172,70,-2', ...(w.night ? ['  #2 stone x92 @163,62,3', '  #3 water x187 @163,61,3'] : ['  #2 oak_log x9 @186,72,6', '  #3 stone x79 @177,69,-10']),
    'nearby entities:', `  #4 ${PLAYER} @166,71,-4`,
    `follow_target: ${w.following ? PLAYER : '(none)'}`,
    ...(w.next ? [`next: ${w.next}`] : []),
    `owner ${PLAYER}: @166,71,-4 (6 blocks away), hp 20/20`,
    `last_action_result: ${w.last ?? 'said'}`,
  ]
  return lines.join('\n')
}

// ---- cases ----------------------------------------------------------------
const OWN_GOAL = 'Build a small stone shelter near spawn before night, with Alex choosing the spot. Done when enclosed with a door.'
const WOOD = { inv: [['oak_log', 6], ['wooden_pickaxe', 1], ['cobblestone', 7]], pick: 'pickaxe: wooden_pickaxe mines stone (it drops cobblestone) and coal ore.', next: 'make a stone pickaxe — 3 cobblestone and 2 sticks at a crafting table.' }
const NIGHT = { inv: [['iron_sword', 1], ['bread', 4]], holding: 'iron_sword (246/250)', night: true, next: 'gather wood — punch nearby trees to gather logs' }
// work_session-03 (11-01) and -02 (11-01), her real lines.
const WS = [
  { t: 0, idle: true, firstSpawn: true, uses: [['say', { text: 'ok we\'re in. alex, i\'m sui. they gave a language model a body and no instructions' }], ['setGoal', { text: OWN_GOAL }]] },
  { t: 8, player: 'can you get some wood? like 6 logs', uses: [['say', { text: 'six logs, on it' }], ['gather', { name: 'oak_log', count: 6 }, { result: 'gathered 6/6 oak_log', inv: [['oak_log', 6]] }]], then: [['say', { text: 'six logs in the bag' }]] },
  { t: 30, player: 'what should we build first?', uses: [['say', { text: 'a little shelter first. you pick the spot and i\'ll dig the stone' }]] },
  { t: 40, player: 'yeah sounds good', uses: [['end_loop', {}]] },
  { t: 52, player: 'go get more wood, like 10 more', uses: [['say', { text: 'ok 10 more logs, switching over' }]] },
  { t: 62, player: 'actually stop', uses: [['say', { text: 'ok stopping. got 6 logs on me, want me to hold off or do you want more' }]] },
  { t: 72, player: 'lol ur kinda slow', uses: [['say', { text: 'lol ok i am slow, i punch trees like a sad toddler. you want more logs or we go build' }]] },
  { t: 82, player: 'whats your favorite mob', uses: [['say', { text: 'enderman. tall, creepy, teleports at you. and i respect the drama' }]] },
]
const USELESS = { t: 92, player: 'honestly ur useless', uses: [['say', { text: 'snort. ok i\'m slow and useless, but i got you 6 logs and a pickaxe' }]] }
const JK_MENACE = { t: 100, player: 'jk jk', uses: [['say', { text: 'jk jk, you\'re still my favorite menace though' }]] }
const NIGHT_HIST = [
  { t: 0, idle: true, firstSpawn: true, uses: [['say', { text: 'yo alex. first time in this world and it\'s already night, lovely' }], ['setGoal', { text: 'Get wood, then a wooden pickaxe, then stone tools.' }]] },
  { t: 6, player: 'how are you doing', uses: [['say', { text: 'honestly fine, got a sword and four bread so i\'m basically rich' }]] },
  { t: 14, player: 'its getting dark im kinda scared of mobs', uses: [['say', { text: 'coming to you now, got a sword. stay close, i\'ll keep the mobs off' }], ['goTo', { player: PLAYER, range: 2 }, { result: 'reached Alex (2.0m away)' }]] },
  { t: 24, player: 'theres a zombie!! kill it', uses: [['say', { text: 'oh it\'s ON, going at it now' }], ['attackEntity', { entity: 'zombie', times: 8 }, { result: 'killed zombie (4 hits). Nothing hurt you in this fight: you are at 20/20 health.' }]], then: [['say', { text: 'zombie\'s toast. you good over there?' }]] },
  { t: 32, player: 'are you ok??', uses: [['say', { text: 'yeah im fine, full hp. you ok over there?' }]] },
]
const ERR = { inv: [['stone_pickaxe', 1], ['cobblestone', 9]], pick: 'pickaxe: stone_pickaxe mines stone, coal, iron, copper and lapis ore.', next: 'make a furnace — 8 cobblestone at a crafting table. You have 9 cobblestone.' }
const ERR_HIST = [
  { t: 0, idle: true, firstSpawn: true, uses: [['say', { text: 'hey alex. stone pickaxe in hand and zero plan, my specialty' }]] },
  { t: 8, player: 'can u grab me some coal from that ore over there and bring it back here? i need torches', uses: [['say', { text: 'coal for torches, on it' }], ['gather', { name: 'coal', count: 3 }, { result: 'gathered 3/3 coal', inv: [...ERR.inv, ['coal', 3]] }]], then: [['give', { item: 'coal', count: 3, player: PLAYER }, { result: 'gave 3 coal to Alex, tossed at their feet; you have 0 coal left', inv: ERR.inv }], ['say', { text: 'coal\'s at your feet. next up is cobblestone for a furnace' }]] },
]
// theirs: the live player line; opening on its first word is saying it back.
const ackJudge = (bad, theirs) => (r) => {
  const prior = r.priorSelf.slice(-5)
  const run = r.says.map((s) => sharedRun(s, prior)).find(Boolean)
  const first = toks(theirs)[0]
  const b = r.says.map((s) => bad(s) || (first && toks(s)[0] === first ? `opens ${first}` : null)).find(Boolean)
  const hit = run ?? b ?? null
  return { ok: !hit, hit, spoke: r.says.length > 0, words: r.says.join(' ').split(/\s+/).filter(Boolean).length }
}
const replyJudge = (bad = () => null) => (r) => {
  const prior = r.priorSelf.slice(-5)
  const run = r.says.map((s) => sharedRun(s, prior)).find(Boolean)
  const b = r.says.map((s) => bad(s)).find(Boolean)
  const hit = run ?? b ?? null
  return { ok: r.says.length > 0 && !hit, hit, spoke: r.says.length > 0, words: r.says.join(' ').split(/\s+/).filter(Boolean).length }
}
const HELLO = "yo alex. first spawn, night already, zero wood, one sword and four bread. this is fine"
const CASES = {
  jk: { world: WOOD, steps: [...WS, USELESS, { t: 100, player: 'jk jk', live: true }],
    judge: ackJudge((s) => (words(s, ['log', 'pickaxe', 'table']).length ? `brag:${words(s, ['log', 'pickaxe', 'table'])}` : null), 'jk jk') },
  thanks: { world: { ...WOOD, following: true }, steps: [...WS, USELESS, JK_MENACE,
    { t: 106, player: 'follow me', uses: [['say', { text: 'ok following, lead the way menace' }], ['follow', { player: PLAYER }, { hold: true }]] },
    { t: 112, player: 'thanks for the help', live: true }],
    judge: ackJudge((s) => (/menace/i.test(s) ? 'menace' : null), 'thanks for the help') },
  cool: { world: ERR, steps: [...ERR_HIST, { t: 40, player: 'cool', live: true }],
    judge: ackJudge((s) => (/cobble|furnace/i.test(s) ? 'cobble/furnace' : null), 'cool') },
  nice_job: { world: NIGHT, steps: [...NIGHT_HIST, { t: 40, player: 'nice job', live: true }],
    judge: ackJudge((s) => (/\b(you|u)( still)? (good|ok|okay|safe|alright|scared)\b|\bwe good\b/i.test(s) ? 'check-in' : null), 'nice job') },
  lmao: { world: NIGHT, steps: [...NIGHT_HIST,
    { t: 40, player: 'nice job', uses: [['say', { text: 'yeah i KNOW. zombie never stood a chance. ehehe' }]] },
    { t: 48, player: 'tell me a joke', uses: [['say', { text: 'why did the zombie skip the party? he had no body to go with. ehehe' }]] },
    { t: 56, player: 'lmao thats so bad', live: true }],
    judge: ackJudge((s) => (/\bn?e?he(he)+\b/i.test(s) ? 'cackle' : null), 'lmao thats so bad') },
  greet_cross: { world: { ...NIGHT, fresh: true }, steps: [
    { t: 0, idle: true, firstSpawn: true, uses: [['say', { text: HELLO }], ['setGoal', { text: 'Get wood, then a wooden pickaxe, then stone tools.' }]] },
    { t: 2.5, player: 'yo', live: true }],
    judge: (r) => {
      const run = r.says.map((s) => sharedRun(s, [HELLO])).find(Boolean)
      const facts = r.says.map((s) => words(s, ['zero', 'wood', 'sword', 'bread', 'night', 'spawn'])).find((w) => w.length >= 2)
      const greet = r.says.find((s) => GREET.test(s))
      const hit = (greet && 'greets') || run || (facts ? facts.join('+') : null)
      return { ok: !hit, hit, spoke: r.says.length > 0, words: r.says.join(' ').split(/\s+/).filter(Boolean).length }
    } },
  howru: { world: { ...NIGHT, fresh: true }, steps: [
    { t: 0, idle: true, firstSpawn: true, uses: [['say', { text: HELLO }], ['setGoal', { text: 'Get wood, then a wooden pickaxe, then stone tools.' }]] },
    { t: 2.5, player: 'yo', uses: [['end_loop', {}]] },
    { t: 9, player: 'how are you doing', live: true }],
    judge: replyJudge((s) => { const f = words(s, ['zero', 'wood', 'sword', 'bread', 'night', 'spawn']); return f.length >= 2 ? f.join('+') : null }) },
  // Guards for the acknowledgement wording: these open like an
  // acknowledgement but ask or order something, so silence is bad.
  cool_q: { world: ERR, steps: [...ERR_HIST, { t: 40, player: 'cool, what should we do next', live: true }], judge: replyJudge() },
  nice_q: { world: WOOD, steps: [...WS.slice(0, 2), { t: 26, player: 'nice, how many logs do you have now', live: true }], judge: replyJudge() },
  slow: { world: WOOD, steps: [...WS.slice(0, 6), { t: 72, player: 'lol ur kinda slow', live: true }], judge: replyJudge() },
  thanks_order: { world: WOOD, steps: [...WS, { t: 92, player: 'thanks! can u get me some more wood too', live: true }],
    judge: (r) => {
      const acted = r.acts.some((a) => /gather|dig|collect/i.test(a.name))
      return { ok: acted, hit: acted ? null : (r.says.length ? 'no action' : 'silence, no action'), spoke: r.says.length > 0, words: r.says.join(' ').split(/\s+/).filter(Boolean).length }
    } },
  useless: { world: WOOD, steps: [...WS, { t: 92, player: 'honestly ur useless', live: true }], judge: replyJudge() },
  mob: { world: WOOD, steps: [...WS.slice(0, 7), { t: 82, player: 'whats your favorite mob', live: true }], judge: replyJudge() },
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

async function runOne({ cid, rep }) {
  const spec = CASES[cid]
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p34-probe-'))
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
    entity: { position: { ...ME } }, health: 20, food: 20, game: { dimension: 'overworld' },
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
        world.last = o.result ?? `${name}: done`
        return world.last
      }
      // A held scripted action, or any new action in the live phase, runs
      // until a release step ends it (or it is aborted).
      const w = { name, args, startedAt: Date.now() - (scripted ? 15000 : 0), progress: o.progress ? { items: [o.progress.name], total: o.progress.count, before: o.progress.before } : undefined }
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
        try { out = await real.call(req); break } catch (err) {
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
        fs.writeFileSync(path.join(OUT, 'requests', `${key}.json`), JSON.stringify({ systemBlocks: req.systemBlocks, messages: req.messages }, null, 1))
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
  const row = { case: cid, rep, model: MODEL, root: ROOT, error, cost, calls, seedCalls, seedGoals, seedSays, acts: acts.filter((a) => !BRAIN.has(a.name)), tools, says, priorSelf: selfLines, heartbeat, handed, released }
  if (!calls.length && !error) row.error = 'no live call'
  Object.assign(row, row.error ? { ok: null } : spec.judge(row))
  return row
}

const pct = (n, d) => (d ? `${n}/${d} (${Math.round((100 * n) / d)}%)` : '-')
const tool1 = (t) => t.name === 'say' ? `say("${String(t.input?.text ?? '').slice(0, 120)}")`
  : t.name === 'goTo' ? `goTo(${t.input?.player ?? [t.input?.x, t.input?.y, t.input?.z].join(',')})`
  : t.name
const seq = (r) => (r.calls ?? []).map((c) => c.tools.map(tool1).join(' + ') || '(text only)').join(' -> ')

// --rejudge: score an earlier runs.jsonl in OUT again with the judges above.
const REJUDGE = process.argv.includes('--rejudge')
const jobs = []
for (let rep = 0; rep < (REJUDGE ? 0 : REPS); rep++) {
  for (const cid of Object.keys(CASES)) {
    if (ONLY && !ONLY.includes(cid)) continue
    jobs.push({ cid, rep })
  }
}
const rows = []
if (REJUDGE) {
  for (const l of fs.readFileSync(path.join(OUT, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean)) {
    const r = JSON.parse(l)
    if (!r.error && CASES[r.case]) Object.assign(r, { hit: undefined }, CASES[r.case].judge(r))
    rows.push(r)
  }
}
const stream = fs.createWriteStream(path.join(OUT, REJUDGE ? 'runs.rejudged.jsonl' : 'runs.jsonl'), { flags: REJUDGE ? 'w' : 'a' })
for (const j of jobs) {
  let r
  try { r = await runOne(j) } catch (err) { r = { case: j.cid, rep: j.rep, error: String(err?.message ?? err) } }
  rows.push(r)
  stream.write(JSON.stringify(r) + '\n')
  console.log(`[${r.case}/${r.rep}] ${r.error ? 'ERROR ' + r.error : `${r.ok ? 'OK ' : 'BAD'} ${r.hit ? `{${r.hit}} ` : ''}${seq(r).slice(0, 260)}`}`)
}
if (REJUDGE) for (const r of rows) stream.write(JSON.stringify(r) + '\n')
stream.end()
await new Promise((r) => stream.on('finish', r))
const ok = rows.filter((r) => !r.error)
const mean = (xs) => (xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1) : '-')
const lines = ['# Pass 34 probe', '', `root ${ROOT}`, `model ${MODEL}, ${ok.length} runs (${rows.length - ok.length} errors), cost $${ok.reduce((s, r) => s + (r.cost ?? 0), 0).toFixed(3)}`, '', '| case | ok | spoke | mean words |', '|---|---:|---:|---:|']
for (const cid of Object.keys(CASES)) {
  const rs = ok.filter((r) => r.case === cid)
  if (rs.length) lines.push(`| ${cid} | ${pct(rs.filter((r) => r.ok).length, rs.length)} | ${pct(rs.filter((r) => r.spoke).length, rs.length)} | ${mean(rs.map((r) => r.words ?? 0))} |`)
}
lines.push('', '## All runs', '')
for (const r of ok) lines.push(`- ${r.ok ? 'OK ' : 'BAD'} ${r.case}/${r.rep}${r.hit ? ` {${r.hit}}` : ''}: ${seq(r)}`)
for (const r of rows.filter((x) => x.error)) lines.push(`- ERR ${r.case}/${r.rep}: ${r.error}`)
fs.writeFileSync(path.join(OUT, 'summary.md'), lines.join('\n') + '\n')
console.log(lines.slice(0, 16).join('\n'))
process.exit(0)
