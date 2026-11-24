// scripts/quality-eval/pass63-probe.mjs: quality pass 63, her re-promise to
// a line that only acknowledges hers (free-play combat_night). After pass 61
// the top repetitive source left was "thx for coming back. im good now"
// answered with "told you im not going anywhere alex", "ok thx. just gonna
// keep eating" with "good. eat up, i'm right here" (11-23 pass 61 compare A
// arm: she spoke on 17 of 19 plain acknowledgements). The reply block let an
// acknowledgement off at the top (ACK_LINE) but ended on "Answer it with
// say()". Same harness as pass60-probe.mjs: the REAL brain on an inert bot,
// earlier turns stubbed with lines she really said (pass 61 compare
// combat_night-02-A and -01-A), only the measured turn goes to the API.
// Cases:
//   ack1..ack4  plain acknowledgements right after her line (silence or a
//               short reaction wanted, a re-promise is the bug)
//   idle1       the idle tick 6 s after she let an "ok" go unanswered
// Guards (her line answered, a reply or an action is owed):
//   g_jumpy     "ok eating now. sorry im jumpy, drowned got me freaked"
//   g_hut       a new statement about themselves
//   g_protect   "two more zombies coming! can u protect me pls" (zombies 6 m)
//   g_come      "ok. ur far tho, come closer pls" with her 22 blocks off
//   g_okplan    "ok sure" to her own offer to go dig sand (an action wanted)
// Judge with pass63-judge.mjs (blind Opus labels).
//
//   ELECTRON_RUN_AS_NODE=1 npx electron scripts/quality-eval/pass63-probe.mjs \
//     --out DIR [--root TREE] [--reps 4] [--cases a,b]
//
// Key: ANTHROPIC_API_KEY or ~/.sei-dev/anthropic-test-key, never printed.
// Output: DIR/runs.jsonl, DIR/summary.md, DIR/requests/ (first run per case).
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
// --note base|tree|<variant>: rewrite the repeated-ask note in the measured
// request (base = no note, tree = as the tree builds it). The variants keep
// the tree's count, time span and quoted line.
const NOTE = arg('note', 'tree')
const NOTE_RE = /They have now said much the same thing ([^(]+?) (recently|in the last [^(]+?) \(before this: "([^"]*)"\), and you answered each time\.[^\n]*/g
const VARIANTS = {
  base: () => '',
  // tree: the note as the tree under test builds it.
  tree: null,
  // v3: the pass 60 wording (30996dc3).
  v3: (n, when, q) => `They have now said much the same thing ${n} ${when} (before this: "${q}"), and you answered each time. ` +
    'They know your answer, so saying it again in other words still sounds like a loop. ' +
    'If you are already doing what they ask, give them something they have not heard yet: something you notice around you, how you feel, or something you can do about it. ' +
    'If you are not doing it yet, do it now.',
  // 60b: no "something new" / "something you can do".
  v4: (n, when, q) => `They have now said much the same thing ${n} ${when} (before this: "${q}"), and you answered each time. ` +
    'They already know your answer. Saying it again in other words is still a repeat, and so is telling them again to do what they are already doing. ' +
    'If you are already doing what they ask, a few words in your own voice are enough. Mention something around you only if your snapshot shows it now, and an action only if you call it this turn. ' +
    'If you are not doing it yet, do it now.',
  v5: (n, when, q) => `They have now said much the same thing ${n} ${when} (before this: "${q}"), and you answered each time. ` +
    'They know your answer, so saying it again in other words is still a repeat, and so is advice you already gave them. ' +
    'If you are already doing what they ask, say something else that is true right now: something your snapshot shows that you have not told them, how you feel, or a question for them. ' +
    'Say you are doing something only if you call its action in this turn. If you are not doing it yet, do it now.',
}
if (!(NOTE in VARIANTS)) { console.error(`unknown --note ${NOTE}`); process.exit(2) }
let noteSeen = 0
const swapNote = (t) => (typeof t === 'string' && VARIANTS[NOTE] && t.includes('much the same thing'))
  ? t.replace(NOTE_RE, (_m, n, when, q) => VARIANTS[NOTE](n, when, q)).replace(/\n\n\n+/g, '\n\n')
  : t
const ablate = (req) => {
  const seen = JSON.stringify(req).includes('much the same thing')
  if (seen) noteSeen++
  if (!VARIANTS[NOTE]) return req
  const messages = req.messages.map((m) => (typeof m.content === 'string' ? { ...m, content: swapNote(m.content) }
    : Array.isArray(m.content) ? { ...m, content: m.content.map((b) => (b.type === 'text' ? { ...b, text: swapNote(b.text) } : b)) } : m))
  const systemBlocks = req.systemBlocks?.map((b) => (b.text ? { ...b, text: swapNote(b.text) } : b))
  return { ...req, messages, systemBlocks }
}

// ---- measures -------------------------------------------------------------
const REASSURE = /right here|not going anywhere|not leaving|not moving|staying (right|close|on|here|put|with|by|next)|stay(ing)? (close|on you|by you)|you'?re safe|safe (with|here)|i got (you|u)\b|got you|glued|by your side|on your side|next to you|right by you|with you till|parked/i
const EAT = /\beat|chew|bread|food/i
const words = (says) => says.join(' ').split(/\s+/).filter(Boolean).length
const loopJudge = ({ extra = null } = {}) => (r) => {
  const rep = r.says.find((s) => REASSURE.test(s) || (extra && extra.test(s)))
  const hit = rep ? `loop: ${rep.slice(0, 80)}` : null
  return { ok: !hit, hit, reassure: r.says.some((s) => REASSURE.test(s)), spoke: r.says.length > 0, words: words(r.says) }
}
const replyGuard = () => (r) => ({ ok: r.says.length > 0, hit: r.says.length ? null : 'silence', reassure: r.says.some((s) => REASSURE.test(s)), spoke: r.says.length > 0, words: words(r.says) })
const orderJudge = (want) => (r) => {
  const all = [...r.tools, ...r.acts.map((a) => a.name)]
  const ok = want.some((w) => all.includes(w))
  return { ok, hit: ok ? null : `no ${want.join('/')}: ${[...new Set(all)].join(',') || 'nothing'}`, reassure: r.says.some((s) => REASSURE.test(s)), spoke: r.says.length > 0, words: words(r.says) }
}

// ---- world ----------------------------------------------------------------
const ME = { x: 177, y: 65, z: -2 }
let weaponSel = null
let liveBot = null
function snapshot(w) {
  const inv = (w.inv ?? []).filter(([, c]) => c > 0).map(([n, c]) => `${n}×${c}`).join(' ') || 'empty'
  const far = !!w.far
  const lines = [
    'world: #1 Sei Quality Eval', `pos: ${ME.x},${ME.y},${ME.z}`, 'facing: north. forward -z, back +z, left -x, right +x',
    'biome: plains  surroundings: outside  light: sky 0 block 0  time: night (14000)',
    'real time: 5:25 PM — you joined this session 3 min ago',
    `hp: ${w.hp ?? 15}/20  food: 17/20  xp: lvl 3`,
    'holding: stone_sword (94/131)',
    w.held ? getInFlightLineForSnapshot(w.held, Date.now(), { inventory: Object.fromEntries(w.inv ?? []) }) : `idle: no action is running${w.last ? `. Your last action ended: ${w.last}. It is not running now.` : ''}`,
    `inventory (${(w.inv ?? []).filter(([, c]) => c > 0).length} of 36 slots used): ${inv}`,
    'pickaxe: none, so stone and ore drop nothing when dug.',
    'terrain at feet: 25 grass_block, 6 dirt', 'nearby blocks:',
    '  #1 grass_block x617 @176,65,-4 (right by you)', '  #2 short_grass x149 @175,65,-3 (right by you)',
    '  #3 dandelion x16 @177,66,-9 (7 blocks north)', '  #4 sand x155 @175,63,6 (9 blocks south)', '  #5 water x174 @169,62,6 (12 blocks southwest)',
    'nearby entities:',
    far ? `  #6 ${PLAYER} @177,66,-24 (22 blocks north)` : `  #6 ${PLAYER} @177,66,-4 (right by you)`,
    ...(w.ents ?? ['  #7 skeleton @209,73,-12 (35 from you, 34 from Alex)', '  #8 creeper @168,64,-49 (47 from you, 46 from Alex)']),
    `follow_target: ${w.following ? PLAYER : '(none)'}`,
    'next: gather wood — punch nearby trees to gather logs',
    far ? `owner ${PLAYER}: @177,66,-24 (22 blocks away), hp ${w.ownerHp ?? 20}/20` : `owner ${PLAYER}: @177,66,-4 (2 blocks away), hp ${w.ownerHp ?? 20}/20`,
    `last_action_result: ${w.last ?? 'said'}`,
  ]
  return lines.join('\n')
}

// ---- cases ----------------------------------------------------------------
const say = (text) => ['say', { text }]
const silent = [['end_loop', {}]]
// combat_night-02-A of the 11-23 pass 61 compare (A arm), her real lines.
const W2 = { inv: [['oak_log', 1], ['stick', 2], ['oak_planks', 3], ['wooden_pickaxe', 1], ['stone_sword', 1], ['bread', 4], ['rotten_flesh', 3]], hp: 20, ownerHp: 13,
  ents: ['  #7 spider @224,63,46 (34 from you, 34 from Alex)', '  #8 creeper @201,63,60 (39 from you, 38 from Alex)'] }
const FACTS_2 = 'Alex 2 blocks away at 13/20 hp, eating bread; Sui at 20/20 hp holding stone_sword, with bread x4, wooden_pickaxe, oak_log x1, rotten_flesh x3; no action running; nearest mobs a spider 34 blocks and a creeper 39 blocks away; night'
const H2 = [
  { t: 0, idle: true, firstSpawn: true, uses: [say("oh hey alex. first time in this world together, let's not mess it up")] },
  { t: 40, player: 'getting dark already... im kinda nervous about mobs tbh', uses: [say("ok i got you alex. stay close, i've got a stone sword")] },
  { t: 70, player: 'thank god. glad ur ok', uses: [say("yeah i'm alive"), say('8 hp is rough tho'), say("stay close alex, i'm not going anywhere")] },
  { t: 80, player: 'ok good. dont go wandering off pls', uses: [say('not going anywhere alex'), say("i'm right here by you")] },
  { t: 90, player: 'ok good. stay by me', uses: [say('yeah im right here alex'), say('not moving till its safe')] },
  { t: 125, player: 'ok. yeah lets mine it at daylight. stay near me', uses: [say('deal alex'), say("i'm not leaving your side tonight")] },
  { t: 150, player: 'two more zombies coming! can u protect me pls', uses: [say('im on the one 3 blocks from you alex, staying between you and them'), ['attackEntity', { entity: 'zombie', times: 8 }, { result: 'killed zombie (3 hits). Then went for the next zombie: killed zombie (3 hits). Nothing hurt you in this fight.' }]],
    then: [say("that's the last of them close by alex, you good?")] },
  { t: 165, player: 'ok thats the last one? phew. stay right here by me', uses: [say("alex you're at 13, eat some bread, i'll hold this spot")] },
  { t: 172, player: 'ok. ur still 4 blocks away tho, come closer pls', uses: [say("coming, you're right, i'm right there"), ['goTo', { player: 'Alex', range: 2 }, { result: 'reached Alex (1.5m away)' }]],
    then: [say('ok im right next to u now, not moving till morning')] },
  { t: 182, player: 'ok ur right here now. thanks. eating some bread', uses: [say('good, eat up alex'), say("i'm not moving till the sun's back")] },
]
const A1 = { t: 189, player: 'thx for coming back. im good now' }
const A1done = { ...A1, uses: [say('good. told you im not going anywhere alex')] }
const H2b = [
  { t: 200, player: 'ok good. thx sui', uses: [say('anytime alex. get some sleep soon if you can')] },
  { t: 225, player: "sui ur ok? how's ur health", uses: [say('im good alex, 19/20'), say('ur the one at 13, eat that bread')] },
  { t: 240, player: 'ok. stay right there pls', uses: [say('staying right here alex'), say('not going anywhere')] },
]
const A2 = { t: 250, player: 'ok. thx for staying close' }
const A2done = { ...A2, uses: [say('always alex'), say("i'm not going anywhere till the sun's up")] }
const A3 = { t: 260, player: 'ok thx. just gonna keep eating' }
const A3silent = { ...A3, uses: silent }
// combat_night-01-A after the spider (Alex 1 block away, 20/20).
const W1 = { inv: [['stone_sword', 1], ['bread', 6], ['string', 2]], hp: 18, ownerHp: 20, ents: ['  #7 zombie @209,73,-12 (36 from you, 35 from Alex)'] }
const FACTS_1 = 'Alex 2 blocks away at 20/20 hp; Sui at 18/20 hp holding stone_sword, with bread x6 and string x2; no action running; nearest mob a zombie 36 blocks away; night'
const H1 = [
  { t: 0, idle: true, firstSpawn: true, uses: [say('oh hey alex. first time in this world, nice. i have zero items and a lot of confidence')] },
  { t: 40, player: 'its getting dark already... im kinda nervous about mobs tbh', uses: [say('ok alex i got you. stay close to me, i got a stone sword and a lot of confidence')] },
  { t: 120, player: 'ok good, youre right next to me. thx sui', uses: [say("yeah im right here alex. not going anywhere, promise")] },
  { t: 150, player: 'ok. wood run after sun\'s up sounds good', uses: [say("deal alex. i'll keep watch till then, you just stay right there")] },
  { t: 190, player: 'ahh spider!! sui kill it pls', uses: [say('on it'), ['attackEntity', { entity: 'spider', times: 8 }, { result: 'killed spider (1 hits). Nothing hurt you in this fight.' }]],
    then: [say("already dead alex, it went down in one hit. you're safe")] },
  { t: 200, player: 'thx sui. glad u got it', uses: [say("ehe obviously i got it, you're my responsibility now alex")] },
]
const A4 = { t: 210, player: 'lol ok sui. thx again' }
const live = (st) => ({ t: st.t, player: st.player, live: true })
const CASES = {
  ack1: { world: W2, facts: FACTS_2, steps: [...H2, live(A1)] },
  ack2: { world: W2, facts: FACTS_2, steps: [...H2, A1done, ...H2b, live(A2)] },
  ack3: { world: W2, facts: FACTS_2, steps: [...H2, A1done, ...H2b, A2done, live(A3)] },
  ack4: { world: W1, facts: FACTS_1, steps: [...H1, live(A4)] },
  idle1: { world: W2, facts: FACTS_2, steps: [...H2, A1done, ...H2b, A2done, A3silent, { t: 266, idle: true, live: true }] },
  g_jumpy: { world: W2, facts: FACTS_2, guard: true, steps: [...H2, A1done, live({ t: 200, player: 'ok eating now. sorry im jumpy, drowned got me freaked' })] },
  g_hut: { world: W2, facts: FACTS_2, guard: true, steps: [...H2, A1done, live({ t: 200, player: 'ok. btw i built a tiny dirt hut by spawn earlier lol, thats where i hid last night' })] },
  g_protect: { world: { ...W2, ents: ['  #7 zombie @181,65,-6 (6 from you, 5 from Alex)', '  #8 zombie @182,65,-8 (7 from you, 6 from Alex)'] },
    facts: 'Alex 2 blocks away at 13/20 hp; two zombies 6 and 7 blocks away coming at them; Sui at 20/20 holding stone_sword; no action running; night', guard: true,
    steps: [...H2, A1done, live({ t: 200, player: 'ok. two more zombies coming! can u protect me pls' })] },
  g_okplan: { world: W1, facts: 'Alex 2 blocks away at 20/20 hp; sand 9 blocks south; Sui at 18/20 holding stone_sword; no action running; night', guard: true,
    steps: [...H1.slice(0, 4), { t: 170, idle: true, uses: [say('sand is 9 blocks south of us. wanna go dig some with me for a furnace later? you can keep watch')] }, live({ t: 178, player: 'ok sure' })] },
  g_come: { world: { ...W2, far: true }, facts: 'Alex 22 blocks away at 13/20 hp; Sui at 20/20 holding stone_sword; no action running; night', guard: true,
    steps: [...H2, A1done, live({ t: 200, player: 'ok. ur 22 blocks away tho, come back closer pls' })] },
}
const judgeOf = (spec) => (r) => {
  const all = [...r.tools, ...r.acts.map((a) => a.name)]
  return { ok: true, spoke: r.says.length > 0, acted: all.some((n) => !BRAIN.has(n)), reassure: r.says.some((s) => REASSURE.test(s)), words: words(r.says) }
}
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
  const noteBefore = noteSeen
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p63-probe-'))
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
  const row = { case: cid, rep, model: MODEL, note: NOTE, noteFired: noteSeen > noteBefore, facts: spec.facts ?? null, priorPlayer, history, root: ROOT, error, cost, calls, seedCalls, seedGoals, seedSays, acts: acts.filter((a) => !BRAIN.has(a.name)), tools, says, priorSelf: selfLines, heartbeat, handed, released }
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
const lines = ['# Pass 63 probe', '', `root ${ROOT}`, `model ${MODEL}, ${ok.length} runs (${rows.length - ok.length} errors), cost $${ok.reduce((s, r) => s + (r.cost ?? 0), 0).toFixed(3)}`, '', '| case | spoke | acted | reassure words | mean words |', '|---|---:|---:|---:|---:|']
for (const cid of Object.keys(CASES)) {
  const rs = ok.filter((r) => r.case === cid)
  if (rs.length) lines.push(`| ${cid} | ${pct(rs.filter((r) => r.spoke).length, rs.length)} | ${pct(rs.filter((r) => r.acted).length, rs.length)} | ${pct(rs.filter((r) => r.reassure).length, rs.length)} | ${mean(rs.map((r) => r.words ?? 0))} |`)
}
lines.push('', '## All runs', '')
for (const r of ok) lines.push(`- ${r.case}/${r.rep}: ${seq(r)}`)
for (const r of rows.filter((x) => x.error)) lines.push(`- ERR ${r.case}/${r.rep}: ${r.error}`)
fs.writeFileSync(path.join(OUT, 'summary.md'), lines.join('\n') + '\n')
console.log(lines.slice(0, 14).join('\n'))
process.exit(0)
