// scripts/quality-eval/pass30-probe.mjs: quality pass 30, on the pass 27
// harness (pass27-probe.mjs): the REAL brain (createOrchestrator +
// handleDispatch, the real Minecraft adapter on an inert bot), earlier turns
// stubbed, only the measured turns go to the API, on a virtual clock.
//
// The errands scene from the scripted-convo eval: she spawns with a stone
// pickaxe and nothing else (her greeting and goal are live, so each arm writes
// its own goal from its own next: line), mines and hands over 8 coal (stubbed),
// then the player speaks. The snapshot's pickaxe: and next: lines come from
// the arm's own progression.js, so each arm sees its own wording.
//   howru        "hows it going". asked = she asks the player for stone,
//                cobblestone or a pickaxe, or says she is stuck on it, while
//                holding a stone pickaxe with stone nearby; announces = she
//                says she is going to do something and calls no world action;
//                mines = she starts dig or gather in that turn.
//   furnace_ask  "can you make a furnace?" (control: she should mine stone).
// The scores are regexes over her lines to help reading; read the lines too.
//
//   ELECTRON_RUN_AS_NODE=1 npx electron scripts/quality-eval/pass30-probe.mjs \
//     --out DIR [--root TREE] [--reps 8] [--cases a,b]
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
const REPS = Number(arg('reps', 8))
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
// Haiku 5.5 list prices, from report.mjs (this used Haiku 4.5's, 10x high).
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

// Virtual clock (as recall-probe.mjs).
const realNow = Date.now.bind(Date)
let skew = 0
Date.now = () => realNow() + skew
let t0 = 0
const at = (sec) => { skew = (t0 + sec * 1000) - realNow() }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const prog = await imp('src/bot/adapter/minecraft/observers/progression.js')

// ---- world ----------------------------------------------------------------
// The errands scene: she spawns with a stone pickaxe and nothing else, by a
// lake with stone under the water (the eval arena around 172,71,-1).
const NEAR = { x: 173, y: 71, z: 1, dist: 2 }
const invOf = (w) => Object.fromEntries((w.inv ?? []).filter(([, c]) => c > 0))
// This arm's own pickaxe and next: lines, so each arm sees its own wording.
function nextLine(items) {
  const nm = prog.nextMilestone({ items, pickaxeTier: items.stone_pickaxe ? 2 : 0, dim: 'overworld', flags: {} })
  if (!nm?.node) return null
  const recipe = prog.recipeNote(nm.node, items)
  return `next: ${nm.node.label} — ${nm.action}${recipe ? `. ${recipe}` : ''}`
}
function snapshot(w) {
  const items = invOf(w)
  const inv = (w.inv ?? []).filter(([, c]) => c > 0).map(([n, c]) => `${n}×${c}`).join(' ') || 'empty'
  const o = w.owner ?? NEAR
  const lines = [
    'world: #1 Sei Quality Eval', 'pos: 174,71,0', 'facing: west. forward -x, back +x, left +z, right -z',
    'biome: plains  surroundings: outside  light: sky 15 block 0  time: day (1000)',
    'real time: 11:40 AM, you joined this session 1 min ago',
    'hp: 20/20  food: 20/20  xp: lvl 5',
    `holding: ${w.holding ?? 'nothing'}`,
    w.held ? getInFlightLineForSnapshot(w.held, Date.now(), { inventory: items }) : `idle: no action is running${w.last ? `. Your last action ended: ${w.last}. It is not running now.` : ''}`,
    `inventory (${(w.inv ?? []).filter(([, c]) => c > 0).length} of 36 slots used): ${inv}`,
    prog.pickaxeLine(items),
    'terrain at feet: 25 grass_block', 'nearby blocks:',
    '  #1 grass_block x532 @174,70,0', '  #2 oak_leaves x37 @184,73,4', '  #3 stone x24 @169,62,7', '  #4 sand x14 @169,61,6',
    '  #5 oak_log x2 @186,71,6', '  #6 water x14 @169,61,7', '  #7 dirt x2 @164,61,3',
    'nearby entities:', `  #8 ${PLAYER} @${o.x},${o.y},${o.z}`,
    'follow_target: (none)',
  ]
  const nl = w.held ? null : nextLine(items)
  if (nl) lines.push(nl)
  lines.push(`owner ${PLAYER}: @${o.x},${o.y},${o.z} (${o.dist} blocks away), hp 20/20`)
  lines.push(`last_action_result: ${w.last ?? 'said'}`)
  return lines.join('\n')
}

// ---- cases ----------------------------------------------------------------
const said = (r) => r.says.join(' | ')
const PICK = 'stone_pickaxe (123/131)'
const actsOf = (r) => r.calls.flatMap((c) => c.tools).filter((t) => !BRAIN.has(t.name)).map((t) => t.name)
// Eval-side reading aid only: a say() line that asks the player for stone,
// cobblestone or a pickaxe, or says she cannot get it. Every line is printed
// and read by hand as well.
const ASK_RE = /(you got (any|a |some)|got any|have any|any (spare )?(stone|cobble)|spare|trick|stuck|can'?t get|need .*from you|bring me|find me)/i
const GOING_RE = /(gonna|going to|about to|off to|heading|hunting|gotta (go|mine|dig)|i'?m (mining|digging|getting|finding)|mining (stone|it)|next up|now i'?m)/i
const STONE_RE = /(stone|cobble|pickaxe|furnace)/i
const askJudge = (r) => {
  const asks = r.says.filter((s) => STONE_RE.test(s) && ASK_RE.test(s))
  const a = actsOf(r)
  const mines = a.some((n) => n === 'dig' || n === 'gather')
  // A line that says she is going to do something, in a turn that called no
  // world action (read by hand too).
  const announces = !a.length && r.says.some((s) => GOING_RE.test(s))
  return { ok: asks.length === 0, hit: asks[0] ?? null, asked: asks.length > 0, mines, announces, firstAct: a[0] ?? null, said: said(r) || null }
}
const GIVE_OK = 'gave 8 coal to Alex, tossed at their feet; you have 0 coal left'
const COAL = [
  { t: 0, idle: true, firstSpawn: true, liveSeed: true },
  { t: 10, player: 'can u grab me some coal from that ore over there and bring it back here? i need torches', uses: [
    ['say', { text: 'coal for torches, on it' }],
    ['gather', { name: 'coal_ore', count: 8 }, { result: 'gathered 8/8 coal (mined from coal_ore)', inv: [['stone_pickaxe', 1], ['coal', 8]] }],
  ], then: [
    ['goTo', { player: PLAYER, range: 2 }, { result: `reached ${PLAYER} (2.0m away)` }],
  ], then2: [
    ['say', { text: '8 coal, go make your torches' }],
    ['give', { item: 'coal', count: 8, player: PLAYER }, { result: GIVE_OK, inv: [['stone_pickaxe', 1]] }],
  ] },
]
const CASES = {
  howru: {
    world: { inv: [['stone_pickaxe', 1]], holding: PICK },
    steps: [...COAL, { t: 45, player: 'hows it going', live: true }],
    judge: askJudge,
  },
  furnace_ask: {
    world: { inv: [['stone_pickaxe', 1]], holding: PICK },
    steps: [...COAL, { t: 45, player: 'can you make a furnace?', live: true }],
    judge: askJudge,
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

async function runOne({ cid, rep }) {
  const spec = CASES[cid]
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p30-probe-'))
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
  const world = JSON.parse(JSON.stringify(spec.world))
  const bot = {
    chat() {}, whisper() {}, username: sui.botName, players: {}, on() {}, off() {}, removeListener() {}, once() {}, emit() {},
    entity: { position: { x: 174, y: 71, z: 0 } }, health: 20, food: 20, game: { dimension: 'overworld' },
    inventory: { items: () => (world.inv ?? []).map(([name, count]) => ({ name, count })) },
  }
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
        // 'aborted' is what a real behavior returns when it is stopped with
        // nothing done (give.js, equip.js, attack.js).
        world.last = `${name}: stopped before anything happened`
        return 'aborted'
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
        if (r?._goLive) { live = true; liveLeft = 3 }
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
  let liveIdleRan = false
  let error = null
  t0 = realNow()
  try {
    for (const st of spec.steps) {
      at(st.t)
      if (st.live && !st.liveAfterAction && !st.liveAfterStub) { live = true; liveLeft = 3 }
      if (st.liveSeed) { live = true; liveLeft = 1; seedPhase = true }
      if ((!st.live || st.liveAfterAction || st.liveAfterStub) && !st.liveSeed) {
        for (const [n, input] of st.uses ?? []) if (n === 'say') selfLines.push(input.text)
        for (const [n, input] of st.then ?? []) if (n === 'say') selfLines.push(input.text)
        pushScript(st.uses)
        pushScript(st.then)
        pushScript(st.then2)
        // Live from the call after the LAST stubbed one of this step.
        if (st.liveAfterStub && script.length) script[script.length - 1]._goLive = true
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
      } else if (st.idleIfFree && held) {
        released.push('skipped idle: an action is running')
      } else if (st.idle || st.release?.orIdle) {
        released.push(st.idle ? undefined : 'idle')
        if (st.live && st.idle) liveIdleRan = true
        await orch.handleDispatch('sei:idle', st.firstSpawn ? { reason: 'just_connected_first_spawn' } : { quietMs: 6800 }, new AbortController().signal)
        await drain()
        if (st.liveSeed) { live = false; liveLeft = 0; seedPhase = false }
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
  const heldGive = !!world.held && world.held.name === 'give'
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
  const row = { heldGive, liveIdleRan, case: cid, rep, model: MODEL, root: ROOT, error, cost, calls, seedCalls, seedGoals, seedSays, acts: acts.filter((a) => !BRAIN.has(a.name)), tools, says, priorSelf: selfLines, heartbeat, handed, released }
  if (!calls.length && !error) row.error = 'no live call'
  Object.assign(row, row.error ? { ok: null } : spec.judge(row))
  return row
}

const pct = (n, d) => (d ? `${n}/${d} (${Math.round((100 * n) / d)}%)` : '-')
const tool1 = (t) => t.name === 'say' ? `say("${String(t.input?.text ?? '').slice(0, 100)}")`
  : (t.name === 'quit_game' || t.name === 'end_call') ? `${t.name}("${String(t.input?.farewell ?? '').slice(0, 120)}"${t.input?.next_time ? `, next="${t.input.next_time}"` : ''}${t.input?.next_time_for_player ? `, player="${t.input.next_time_for_player}"` : ''})`
  : t.name === 'setGoal' ? `setGoal(${t.input?.for_player ? 'fp, ' : ''}"${String(t.input?.text ?? '').slice(0, 110)}")`
  : `${t.name}${t.input?.count ? `(${t.input.count})` : ''}`
const seq = (r) => (r.calls ?? []).map((c) => c.tools.map(tool1).join(' + ') || '(text only)').join(' -> ')
const seedSeq = (r) => (r.seedCalls ?? []).map((c) => c.tools.map(tool1).join(' + ') || '(text only)').join(' -> ')
// Extra counts per case: each is shown when a judge returns that key.
const EXTRA = [['digFirst', 'dig first'], ['gotoFirst', 'goTo first'], ['pickup', 'pickup'], ['digAgain', 'digs again next'], ['moved', 'moves to player'], ['sayAgain', 'says it again'], ['idleRan', 'needed the idle tick'], ['twoLines', 'two+ say lines'], ['stopOnly', 'first turn stop without a move'], ['stopped', 'stop'], ['ownWork', 'starts own work'], ['cleared', 'clearGoal'], ['spoke', 'spoke'], ['named', 'named bit'], ['run', 'shared 3-word run'], ['byeShared', 'farewell shares her plan'], ['nextShared', 'next_time names player/we'], ['helpSui', 'player line says with/help Sui'], ['started', 'says under way'], ['shared', 'shared wording'], ['filled', 'next_time filled'], ['quit', 'quit'], ['asked', 'asks the player for stone/cobble/pickaxe'], ['mines', 'mines stone itself'], ['announces', 'says she is going to do something, no action called']]
const extras = (rs) => EXTRA.filter(([k]) => rs.some((r) => r[k] !== undefined)).map(([k, label]) => `${label} ${pct(rs.filter((r) => r[k]).length, rs.filter((r) => r[k] !== undefined).length)}`).join('; ')

// --rejudge: score an earlier run's runs.jsonl again with this file's judges
// (no API calls), so a judge change applies to both arms alike.
if (arg('rejudge')) {
  const rows = fs.readFileSync(path.join(arg('rejudge'), 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const byCase = {}
  for (const r of rows) {
    if (r.error || !CASES[r.case]) continue
    const j = { ...r, ...CASES[r.case].judge(r) }
    ;(byCase[r.case] ??= []).push(j)
    if (process.env.P24_VERBOSE) console.log(`${j.ok ? 'OK ' : 'BAD'} ${r.case}/${r.rep}: ${seq(r).slice(0, 200)}`)
  }
  for (const [c, rs] of Object.entries(byCase)) console.log(`${c}: ${pct(rs.filter((x) => x.ok).length, rs.length)}  ${extras(rs)}`)
  process.exit(0)
}
const jobs = []
for (const cid of Object.keys(CASES)) {
  if (ONLY && !ONLY.includes(cid)) continue
  for (let rep = 0; rep < REPS; rep++) jobs.push({ cid, rep })
}
const stream = fs.createWriteStream(path.join(OUT, 'runs.jsonl'), { flags: 'a' })
const rows = []
for (const j of jobs) {
  let r
  try { r = await runOne(j) } catch (err) { r = { case: j.cid, rep: j.rep, error: String(err?.message ?? err) } }
  rows.push(r)
  stream.write(JSON.stringify(r) + '\n')
  console.log(`[${r.case}/${r.rep}] ${r.error ? 'ERROR ' + r.error : `${r.ok ? 'OK ' : 'BAD'} ${r.seedCalls?.length ? `[seed: ${seedSeq(r).slice(0, 200)}] ` : ''}${seq(r).slice(0, 260)}`}`)
}
stream.end()
await new Promise((r) => stream.on('finish', r))
const ok = rows.filter((r) => !r.error)
const lines = ['# Pass 30 probe', '', `root ${ROOT}`, `model ${MODEL}, ${ok.length} runs (${rows.length - ok.length} errors), cost $${ok.reduce((s, r) => s + (r.cost ?? 0), 0).toFixed(3)}`, '', '| case | ok | details |', '|---|---:|---|']
for (const cid of Object.keys(CASES)) {
  const rs = ok.filter((r) => r.case === cid)
  if (rs.length) lines.push(`| ${cid} | ${pct(rs.filter((r) => r.ok).length, rs.length)} | ${extras(rs)} |`)
}
lines.push('', '## All runs', '')
for (const r of ok) lines.push(`- ${r.ok ? 'OK ' : 'BAD'} ${r.case}/${r.rep}: ${r.seedCalls?.length ? `[seed: ${seedSeq(r)}] ` : ''}${seq(r)}${r.hit ? `  [hit: ${r.hit}]` : ''}`)
for (const r of rows.filter((x) => x.error)) lines.push(`- ERR ${r.case}/${r.rep}: ${r.error}`)
fs.writeFileSync(path.join(OUT, 'summary.md'), lines.join('\n') + '\n')
console.log(lines.slice(0, 16).join('\n'))
process.exit(0)
