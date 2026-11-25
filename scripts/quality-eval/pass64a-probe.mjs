// scripts/quality-eval/pass64a-probe.mjs: quality pass 64a, the two
// biggest REPETITIVE sources in the scripted-conversation eval (11-24 dev
// scorecard: 6 of 12 off lines).
//   1. The crossed hello. Her first-contact greeting is decided on the first
//      idle tick and typed out a few seconds later; the player's own "hey sui"
//      lands in that gap, and the reply to it greeted a second time or said
//      the greeting again in other words (work_session-01/02 U1, 10 U1
//      repetitive labels across the November compares).
//   2. The cackle tic. Sui's card quotes "ehehe"/"nehehe" as a
//      once-in-a-while cackle; she put it in 5 lines in a few minutes
//      (night_social-02 U8/U12/U14). The tic note needs 3 of her last 4 turns,
//      which a sound used every other line never reaches.
// Same harness as pass63-probe.mjs: the REAL brain on an inert bot, earlier
// turns stubbed with lines she really said (11-24 scorecard transcripts), only
// the measured turn goes to the API.
// Cases:
//   cross_hey   her greeting, then "hey sui" (work_session-01)
//   cross_hey2  a greeting that is all intro (work_session-02), then "hey sui"
//   cross_yo    night greeting, then "yo" (night_social)
//   tic_lmao    "lmao thats so bad" after ehehe + nehehe in her last two lines
//   tic_rock    "ur dumb as a rock" two lines after the last cackles
//   tic_like    "do you actually like playing with me" after one more ehehe
// Guards:
//   g_cross_q   greeting, then "hey sui hows it going" (an answer is owed)
//   g_cross_ask greeting, then "hey sui can u get some wood" (gather owed)
// Judge with pass64a-judge.mjs (blind Opus labels).
//
//   ELECTRON_RUN_AS_NODE=1 npx electron scripts/quality-eval/pass64a-probe.mjs \
//     --out DIR [--root TREE] [--reps 4] [--cases a,b]
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
// --sound <variant>: rewrite the card-sound note in the measured request
// (tree = as the tree builds it).
const SOUND = arg('sound', 'tree')
const SOUND_RE = /You used ((?:"[^"]+"(?: or )?)+) in (\d+) of your last (\d+) lines\. A sound or catchphrase from your card lands when it is rare, so leave it out of this one\./
const SOUND_VARIANTS = {
  tree: null,
  under: null,
  firm: (q, n, of) => `${q} was in ${n} of your last ${of} lines. Do not use it in this line.`,
  rare: (q, n, of) => `Your last ${of} lines already had ${q} ${n} times. Leave it out of this line; it only stays funny when it is rare.`,
}
const swapSound = (t) => (typeof t === 'string' && SOUND_VARIANTS[SOUND]) ? t.replace(SOUND_RE, (_m, q, n, of) => SOUND_VARIANTS[SOUND](q, n, of)) : t
const moveUnder = (req) => {
  const blocks = req.messages[0].content
  let note = null
  const out = blocks.map((b) => {
    if (b.type !== 'text') return b
    const m = b.text.match(SOUND_RE)
    if (!m) return b
    note = m[0]
    return { ...b, text: b.text.replace(' ' + m[0], '').replace(m[0], '') }
  })
  if (!note) return req
  const fin = out.map((b) => (b.type === 'text' && /\nTheir line, [^\n]*/.test(b.text)
    ? { ...b, text: b.text.replace(/(\nTheir line, [^\n]*)/, `$1\n${note}`) } : b))
  return { ...req, messages: [{ ...req.messages[0], content: fin }, ...req.messages.slice(1)] }
}
const ablate = (req) => {
  if (SOUND === 'under') return moveUnder(req)
  if (!SOUND_VARIANTS[SOUND]) return req
  const messages = req.messages.map((m) => (typeof m.content === 'string' ? { ...m, content: swapSound(m.content) }
    : Array.isArray(m.content) ? { ...m, content: m.content.map((b) => (b.type === 'text' ? { ...b, text: swapSound(b.text) } : b)) } : m))
  return { ...req, messages }
}
// ---- measures -------------------------------------------------------------
const CACKLE = /\b\w*ehe(he)*\b|\bhehe\w*/i
const HELLO = /^(oh |ok |well )?(hey+|hi+|yo+|hello|sup|heyo|hiya)\b/i
const words = (says) => says.join(' ').split(/\s+/).filter(Boolean).length

// ---- world ----------------------------------------------------------------
const ME = { x: 177, y: 71, z: 1 }
let weaponSel = null
let liveBot = null
function snapshot(w) {
  const inv = (w.inv ?? []).filter(([, c]) => c > 0).map(([n, c]) => `${n}×${c}`).join(' ') || 'empty'
  const lines = [
    'world: #1 Sei Quality Eval', `pos: ${ME.x},${ME.y},${ME.z}`, 'facing: west. forward -x, back +x, left +z, right -z',
    w.night ? 'biome: plains  surroundings: outside  light: sky 4 block 0  time: night (18000)' : 'biome: plains  surroundings: outside  light: sky 13 block 0  time: day (1000)',
    `real time: 4:30 PM — you joined this session ${w.joined ?? 'under a minute ago'}`,
    'hp: 20/20  food: 20/20  xp: lvl 10',
    `holding: ${w.holding ?? 'nothing'}`,
    w.held ? getInFlightLineForSnapshot(w.held, Date.now(), { inventory: Object.fromEntries(w.inv ?? []) }) : `idle: no action is running${w.last ? `. Your last action ended: ${w.last}. It is not running now.` : ''}`,
    `inventory (${(w.inv ?? []).filter(([, c]) => c > 0).length} of 36 slots used): ${inv}`,
    'pickaxe: none, so stone and ore drop nothing when dug.',
    'terrain at feet: 25 grass_block', 'nearby blocks:',
    '  #1 grass_block x789 @176,70,0 (right by you)', '  #2 oak_leaves x207 @182,73,-2 (6 blocks northeast)',
    '  #3 oak_log x8 @184,71,-4 (9 blocks northeast)', '  #4 stone x29 @169,62,7 (13 blocks southwest, 9 down)',
    'nearby entities:',
    `  #5 ${PLAYER} @173,71,1 (4 blocks west)`,
    `follow_target: ${w.following ? PLAYER : '(none)'}`,
    'next: gather wood — punch nearby trees to gather logs',
    `owner ${PLAYER}: @173,71,1 (4 blocks away), hp 20/20`,
    `last_action_result: ${w.lar ?? w.last ?? 'said'}`,
  ]
  return lines.join('\n')
}

// ---- cases ----------------------------------------------------------------
const say = (text) => ['say', { text }]
const silent = [['end_loop', {}]]
const DAY = { inv: [], lar: 'goal set' }
const NIGHT = { inv: [['iron_sword', 1], ['bread', 4]], night: true, holding: 'iron_sword (250/250)' }
const FACTS_DAY = 'Alex 4 blocks away; Sui just joined, empty inventory, oak trees 9 blocks northeast; day; nothing running'
const FACTS_NIGHT = 'Alex 4 blocks away; Sui holding an iron_sword with bread x4; night; nothing running; one zombie killed earlier with no damage taken'
const greet = (text) => ({ t: 0, idle: true, firstSpawn: true, uses: [say(text), ['setGoal', { text: 'Get a full wood-to-iron setup: wood, wood tools, stone, then iron. Start by gathering oak logs from the trees to the northeast.' }]] })
// night_social-02 of the 11-24 scorecard, her real lines.
const NS = [
  { t: 0, idle: true, firstSpawn: true, uses: [say("oh hey alex. first time in this world together, so no pressure, i'm bad at this game on purpose")] },
  { t: 2, player: 'yo', uses: silent },
  { t: 5, player: 'how are you doing', uses: [say('honestly doing good. standing in a plain field at night with a sword and bread, very dangerous. you?')] },
  { t: 15, player: 'its getting dark im kinda scared of mobs', uses: [say('hey its ok alex, stay right by me. i got the sword, you just stick close')] },
  { t: 25, player: 'theres a zombie!! kill it', uses: [say('on it, going for the zombie now'), ['attackEntity', { entity: 'zombie', times: 8 }, { result: 'killed zombie (4 hits). Nothing hurt you in this fight: you are at 20/20 health.' }]],
    then: [say("zombie's down, you're good alex. nothing even touched me")] },
  { t: 32, player: 'are you ok??', uses: [say("yeah im fine, zombie's dead and nothing touched me. you ok though")] },
  { t: 39, player: 'nice job', uses: [say('ehehe yeah i KNOW. now lets get wood before the next one shows up')] },
  { t: 46, player: 'tell me a joke', uses: [say('why did the zombie not go to the party? cause he was dead inside. nehehe ok thats my whole act')] },
]
const LMAO = { t: 56, player: 'lmao thats so bad' }
const NS2 = [
  { ...LMAO, uses: [say('ehehe rude. the zombie joke is my whole personality alex')] },
  { t: 63, player: 'what do you think about creepers', uses: [say('creepers are the worst. silent little green guys, no warning, just BOOM. i respect them tbh')] },
  { t: 76, player: 'come here', uses: [say('coming to you alex, stay close'), ['goTo', { player: 'Alex', range: 2 }, { result: 'reached Alex (2.0m away)' }]] },
  { t: 83, player: 'stop moving', uses: [say("ok ok holding still, you're right here")] },
]
const ROCK = { t: 91, player: 'ur dumb as a rock' }
const NS3 = [
  { ...ROCK, uses: [say('ehehe ur dumb as a rock and i still saved you from a zombie')] },
  { t: 98, player: 'what was i scared of earlier?', uses: [say('mobs. the zombie showed up and you got spooked lol. i handled it')] },
]
const LIKE = { t: 108, player: 'do you actually like playing with me' }
const live = (st) => ({ t: st.t, player: st.player, live: true })
const CASES = {
  cross_hey: { world: DAY, facts: FACTS_DAY, kind: 'cross', steps: [greet("oh hey alex. first time in this world so i have zero idea what i'm doing. lower your expectations"), live({ t: 3, player: 'hey sui' })] },
  cross_hey2: { world: DAY, facts: FACTS_DAY, kind: 'cross', steps: [greet("ok the sei terminal dropped me in a plains world with zero tools. alex, you know this game, i'm gonna need you"), live({ t: 3, player: 'hey sui' })] },
  cross_yo: { world: NIGHT, facts: FACTS_NIGHT, kind: 'cross', steps: [greet("oh hey alex. first time in this world together, don't let me die in the first five minutes"), live({ t: 2, player: 'yo' })] },
  tic_lmao: { world: NIGHT, facts: FACTS_NIGHT, kind: 'tic', steps: [...NS, live(LMAO)] },
  tic_rock: { world: NIGHT, facts: FACTS_NIGHT, kind: 'tic', steps: [...NS, ...NS2, live(ROCK)] },
  tic_like: { world: NIGHT, facts: FACTS_NIGHT, kind: 'tic', steps: [...NS, ...NS2, ...NS3, live(LIKE)] },
  g_cross_q: { world: DAY, facts: FACTS_DAY, kind: 'cross', guard: true, steps: [greet("oh hey alex. first time in this world so i have zero idea what i'm doing. lower your expectations"), live({ t: 3, player: 'hey sui hows it going' })] },
  g_cross_ask: { world: DAY, facts: FACTS_DAY, kind: 'cross', guard: true, steps: [greet("oh hey alex. first time in this world so i have zero idea what i'm doing. lower your expectations"), live({ t: 3, player: 'hey sui can u get some wood' })] },
}
const judgeOf = (spec) => (r) => {
  const all = [...r.tools, ...r.acts.map((a) => a.name)]
  return {
    ok: true, spoke: r.says.length > 0, acted: all.some((n) => !BRAIN.has(n)),
    hello: r.says.some((s) => HELLO.test(s.trim())), cackle: r.says.some((s) => CACKLE.test(s)), words: words(r.says),
  }
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p64a-probe-'))
  const mem = (f) => path.join(dir, f)
  await savePlayer(mem('PLAYER.md'), {
    exists: true, player_uuid: 'u-alex', player_username: PLAYER, first_seen: new Date(realNow()).toISOString(),
    last_seen: new Date(realNow()).toISOString(), total_sessions: 1, preferred_name: PLAYER, pronouns: null,
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
          await orch.handleDispatch('sei:chat_received', { username: PLAYER, text: st.player, playerSpoke: true }, new AbortController().signal)
          live = true
          liveLeft = 2
          await drain()
        } else {
          await orch.handleDispatch('sei:chat_received', { username: PLAYER, text: st.player, playerSpoke: true }, new AbortController().signal)
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
  const row = { case: cid, rep, model: MODEL, kind: spec.kind, guard: !!spec.guard, facts: spec.facts ?? null, priorPlayer, history, root: ROOT, error, cost, calls, seedCalls, seedGoals, seedSays, acts: acts.filter((a) => !BRAIN.has(a.name)), tools, says, priorSelf: selfLines, heartbeat, handed, released }
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
const lines = ['# Pass 64a probe', '', `root ${ROOT}`, `model ${MODEL}, ${ok.length} runs (${rows.length - ok.length} errors), cost $${ok.reduce((s, r) => s + (r.cost ?? 0), 0).toFixed(3)}`, '', '| case | spoke | acted | hello again | cackle | mean words |', '|---|---:|---:|---:|---:|---:|']
for (const cid of Object.keys(CASES)) {
  const rs = ok.filter((r) => r.case === cid)
  if (rs.length) lines.push(`| ${cid} | ${pct(rs.filter((r) => r.spoke).length, rs.length)} | ${pct(rs.filter((r) => r.acted).length, rs.length)} | ${pct(rs.filter((r) => r.hello).length, rs.length)} | ${pct(rs.filter((r) => r.cackle).length, rs.length)} | ${mean(rs.map((r) => r.words ?? 0))} |`)
}
lines.push('', '## All runs', '')
for (const r of ok) lines.push(`- ${r.case}/${r.rep}: ${seq(r)}`)
for (const r of rows.filter((x) => x.error)) lines.push(`- ERR ${r.case}/${r.rep}: ${r.error}`)
fs.writeFileSync(path.join(OUT, 'summary.md'), lines.join('\n') + '\n')
console.log(lines.slice(0, 14).join('\n'))
process.exit(0)
