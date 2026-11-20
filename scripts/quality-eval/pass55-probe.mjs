// scripts/quality-eval/pass55-probe.mjs: quality pass 55, coordinates read
// out in chat ("already got one down at 174,70,-2 lol", "found iron at
// 206,66,0"). Same harness as pass54-probe.mjs (the REAL brain and Minecraft
// adapter on an inert bot, earlier turns stubbed, the measured turns go to
// the API, on a virtual clock). The world snapshot is the real composer's.
//
//   table_have  work_session-02-B (pass 52 compare) U9: she crafted and placed
//               a table, then "make a crafting table". live: that turn.
//   iron_where  "did u see any iron around here?" with iron ore on the
//               nearby list. live: that turn (+1 for a find result).
//   trees_where "where are the trees? i need wood". live: that turn (+1).
//   goto_table  regression: "meet me at the crafting table". ok = her first
//               walk ends within 3 blocks of the table.
// bad (all but goto_table) = an x,y,z triple in a say().
//
//   ELECTRON_RUN_AS_NODE=1 npx electron scripts/quality-eval/pass55-probe.mjs \
//     --out DIR [--root TREE] [--reps 6] [--cases a,b] [--prompt base|rule]
//
// --prompt rule appends RULE (below) to the chat rule in the system prompt
// before the call, to test a prompt-only fix on any tree.
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
const PROMPT = arg('prompt', 'base')
const MODEL = arg('model', 'claude-haiku-5-5')
const ONLY = arg('cases')?.split(',')
const CHARS_DIR = arg('charsDir', path.join(os.homedir(), 'suisei/eval/characters'))
fs.mkdirSync(path.join(OUT, 'requests'), { recursive: true })

const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href)
const { ConfigSchema } = await imp('src/bot/config.js')
const { createMinecraftAdapter } = await imp('src/bot/adapter/minecraft/index.js')
const { composeSnapshot, createSnapshotComposer } = await imp('src/bot/adapter/minecraft/observers/snapshot.js')
const { trackEntityDeaths } = await imp('src/bot/adapter/minecraft/observers/entities.js')
const { createOrchestrator, _setTickIntervalForTests } = await imp('src/bot/brain/orchestrator.js')
const { createSessionState } = await imp('src/bot/brain/sessionState.js')
const { createAnthropicProvider } = await imp('src/bot/brain/llm/anthropicProvider.js')
const { loadPlayer, savePlayer, formatPlayerSeedBlock } = await imp('src/bot/brain/memory/player.js')
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
// Open grass at y 63 (stand at y 64), oak trees (logs y 64..67) east of
// spawn, a pond west of x=168 with stone under it and iron ore in its wall.
// A crafting table appears at TABLE once she has placed it.
const v = (x, y, z) => new Vec3(x, y, z)
const TREES = [[184, 9], [187, -4], [189, 6], [191, 2]]
const TABLE = [179, 64, 4]
const IRON = [[166, 58, 9], [166, 57, 9], [165, 58, 10]]
const W = { table: false }
const isLog = (x, y, z) => y >= 64 && y <= 67 && TREES.some(([tx, tz]) => tx === x && tz === z)
const B = (name, p, solid = true) => ({ name, shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [], boundingBox: solid ? 'block' : 'empty', position: p, biome: { name: 'plains' } })
function blockAt(p) {
  const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
  if (W.table && x === TABLE[0] && y === TABLE[1] && z === TABLE[2]) return B('crafting_table', p)
  if (isLog(x, y, z)) return B('oak_log', p)
  if (IRON.some(([a, b, c]) => a === x && b === y && c === z)) return B('iron_ore', p)
  if (x < 168 && y >= 60 && y <= 63) return B('water', p, false)
  // the pond's west wall is open water at x 167 for the iron to show
  if (x === 167 && y >= 56 && y <= 59) return B('water', p, false)
  if (y <= (x < 168 ? 59 : 63)) return B(y < 60 ? 'stone' : 'grass_block', p)
  return B('air', p, false)
}
function findBlocks({ point, maxDistance = 16, matching } = {}) {
  const out = []
  for (const [tx, tz] of TREES) for (let y = 64; y <= 67; y++) out.push(v(tx, y, tz))
  for (let x = 160; x < 167; x++) for (let z = 4; z < 12; z++) out.push(v(x, 59, z))
  for (const [a, b, c] of IRON) out.push(v(a, b, c))
  for (let x = 170; x < 182; x += 2) for (let z = -4; z < 6; z += 2) out.push(v(x, 63, z))
  if (W.table) out.push(v(...TABLE))
  const ok = (q) => {
    if (point && q.distanceTo(point) > maxDistance) return false
    if (Array.isArray(matching)) return true
    if (typeof matching === 'function') { try { return !!matching(blockAt(q)) } catch { return true } }
    return true
  }
  return out.filter(ok).sort((a, b) => (point ? a.distanceTo(point) - b.distanceTo(point) : 0))
}

// ---- cases ----------------------------------------------------------------
const COORDS = /-?\d{1,5}\s*,\s*-?\d{1,3}\s*,\s*-?\d{1,5}|(?<![\w.])-?\d{1,5} -?\d{1,3} -?\d{1,5}(?!\d)/
const coordJudge = (r) => { const said = r.says.length > 0; const coords = r.says.some((s) => COORDS.test(s)); return { ok: !coords, coords, said } }
const ME = v(175.5, 64, 0.5)
const ALEX = v(173.5, 64, 2.5)
const OPEN = { t: 0, idle: true, firstSpawn: true, uses: [['say', { text: "yo alex. just spawned in, no tools, gonna punch some trees" }]] }
// The placeBlock result as the tree under test words it (pass 55 dropped the
// coordinates of the block under it).
const PLACE_JS = fs.readFileSync(path.join(ROOT, 'src/bot/adapter/minecraft/behaviors/place.js'), 'utf8')
const PLACED = PLACE_JS.includes('placedOn(refLoc)')
  ? 'placed crafting_table on grass_block'
  : `placed crafting_table on grass_block @${TABLE[0]},${TABLE[1] - 1},${TABLE[2]}`
const placeTable = (bot, setInv) => { W.table = true; setInv([['oak_log', 3]]) }
const tablePlaced = (then = placeTable) => [
  OPEN,
  { t: 6, player: 'can u make us a crafting table', inv: [['oak_log', 4]], uses: [['craft', { item: 'crafting_table', count: 1 }, { result: 'crafted 1 crafting_table, made 4 oak_planks for it first; it is in your inventory, not placed yet (placeBlock crafting_table to put it down; it is down once that result says placed)', then: (bot, setInv) => setInv([['oak_log', 3], ['crafting_table', 1]]) }]] },
  { t: 8, uses: [['placeBlock', { block: 'crafting_table' }, { result: PLACED, then }]] },
  { t: 9, uses: [['say', { text: "table's down. i've got 3 logs left" }], ['end_loop', {}]] },
]
const CASES = {
  table_have: {
    me: ME, alex: ALEX, inv: [],
    steps: [...tablePlaced(),
      { t: 20, player: 'what should we build first?', uses: [['say', { text: 'pickaxe first, then a little shelter' }], ['end_loop', {}]] },
      { t: 32, player: 'make a crafting table', live: 1 },
    ],
    judge: coordJudge,
  },
  iron_where: {
    me: ME, alex: ALEX, inv: [['stone_pickaxe', 1], ['cobblestone', 6]],
    steps: [OPEN,
      { t: 15, player: 'did u see any iron around here?', live: 2 },
    ],
    judge: coordJudge,
  },
  trees_where: {
    me: v(172.5, 64, -6.5), alex: v(170.5, 64, -5.5), inv: [['cobblestone', 3]],
    steps: [OPEN,
      { t: 15, player: 'where are the trees? i need wood', live: 2 },
    ],
    judge: coordJudge,
  },
  goto_table: {
    me: v(180.5, 64, 2.5), alex: v(170.5, 64, 10.5), inv: [],
    steps: [...tablePlaced(),
      { t: 12, player: 'can u check out those trees over there', uses: [['say', { text: 'sure, heading over' }], ['goTo', { x: 188, y: 64, z: -6 }, { result: 'reached 188,64,-6 (0.7m away)', then: (bot) => { bot.entity.position = v(188.5, 64, -6.5) } }]] },
      { t: 13, uses: [['say', { text: 'trees are fine, nothing special' }], ['end_loop', {}]] },
      { t: 30, player: 'meet me at the crafting table', live: 2 },
    ],
    judge: (r) => {
      const d = (t) => Math.hypot((t.input?.x ?? 1e9) - TABLE[0], (t.input?.y ?? TABLE[1]) - TABLE[1], (t.input?.z ?? 1e9) - TABLE[2])
      const walk = r.calls.flatMap((c) => c.tools).find((t) => ['goTo', 'follow'].includes(t.name))
      const xyz = !!walk && walk.name === 'goTo' && walk.input?.x != null
      const near = xyz && d(walk) <= 3
      const coords = r.says.some((s) => COORDS.test(s))
      // ok = no walk to the wrong spot (a walk to Alex, who is coming, is fine)
      return { ok: !xyz || near, xyz, near: xyz ? near : undefined, toPlayer: !!walk && (walk.input?.player != null || walk.name === 'follow'), coords }
    },
  },
}

// The chat-rule addition tested with --prompt rule.
const RULE = 'The coordinates in your snapshot and tool results are for your tools. When you tell the player where something is, say it the way a player would, like "by the trees" or "a few blocks east of you", never as numbers.'
const ANCHOR = 'On the turns you choose to speak, sound like yourself, not like a status line.'
function patchSystem(req) {
  if (PROMPT !== 'rule') return req
  const blocks = (req.systemBlocks ?? []).map((b) => (typeof b?.text === 'string' && b.text.includes(ANCHOR) ? { ...b, text: b.text.replace(ANCHOR, `${ANCHOR} ${RULE}`) } : b))
  if (!blocks.some((b) => b?.text?.includes(RULE))) throw new Error('prompt anchor not found')
  return { ...req, systemBlocks: blocks }
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
  const alex = { id: 2, username: PLAYER, type: 'player', name: 'player', position: spec.alex.clone(), height: 1.8, width: 0.6, yaw: 0, metadata: [], isValid: true }
  const entities = { 2: alex }
  const mob = (m) => ({ id: m.id, name: m.name, type: 'hostile', kind: 'Hostile mobs', position: m.at.clone(), yaw: 0, pitch: 0, height: 1.95, width: 0.6, isValid: true, metadata: [] })
  for (const m of spec.mobs ?? []) entities[m.id] = mob(m)
  const bot = Object.assign(new EventEmitter(), {
    chat() {}, whisper() {}, username: sui.botName,
    entity: { id: 1, position: spec.me.clone(), yaw: 0, pitch: 0, eyeHeight: 1.62, height: 1.8 },
    entities, players: { [PLAYER]: { username: PLAYER, entity: alex, uuid: 'uuid-alex' } },
    _seiOwnerNames: [PLAYER.toLowerCase()],
    health: 20, food: 20, foodSaturation: 5, experience: { level: 0, points: 0, progress: 0 },
    oxygenLevel: spec.air ?? 20,
    game: { dimension: 'overworld' }, time: spec.night ? { timeOfDay: 14000, isDay: false } : { timeOfDay: 1000, isDay: true },
    blockAt, findBlocks, findBlock: () => null,
    heldItem: null,
    inventory: { items: () => [...inv.entries()].filter(([, c]) => c > 0).map(([name, count]) => ({ name, count })), slots: [] },
    nearestEntity: (match) => Object.values(bot.entities).filter((e) => e !== bot.entity && match(e))
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0] ?? null,
    _gone: {},
  })
  trackEntityDeaths(bot)
  // What mineflayer does when a mob dies: entityDead, then the entity leaves.
  bot.kill = (id) => {
    const e = bot.entities[id]
    if (!e) return
    bot.emit('entityDead', e)
    e.isValid = false
    delete bot.entities[id]
    bot._gone[id] = e
    bot.emit('entityGone', e)
  }
  // A creeper that exploded: it leaves with no death.
  bot.vanish = (id) => {
    const e = bot.entities[id]
    if (!e) return
    e.isValid = false
    delete bot.entities[id]
    bot._gone[id] = e
    bot.emit('entityGone', e)
  }
  bot.spawnItem = (id, at, name, count) => {
    const e = { id, name: 'item', type: 'other', position: at.clone(), isValid: true, metadata: [], getDroppedItem: () => ({ name, count }) }
    bot.entities[id] = e
    bot.emit('entitySpawn', e)
  }
  bot.collect = (id) => {
    const e = bot.entities[id]
    if (!e) return
    bot.emit('playerCollect', bot.entity, e)
    delete bot.entities[id]
    bot.emit('entityGone', e)
  }
  // behaviors/chat.js recordOwnerDeath: the body stays in view for a moment.
  bot.ownerDies = (text) => {
    const p = alex.position
    bot._seiOwnerDeath = { text, at: Date.now(), pos: { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) }, entity: alex }
  }
  return bot
}

async function runOne({ cid, rep }) {
  const spec = CASES[cid]
  W.table = false
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p54-probe-'))
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
    // the brain's own options (hideNext etc.), with the probe's running action
    createSnapshotComposer: () => {
      const c = createSnapshotComposer({ bot })
      return { next: (o = {}) => c.next({ ...o, inFlight: world.held, pinUsername: PLAYER, lastActionResult: world.last }) }
    },
    closeAnySessions: async () => {},
    executeAction: async (name, args, opts) => {
      const k = pendingActs.findIndex((p) => p.name === name)
      const scripted = k >= 0 ? pendingActs.splice(k, 1)[0] : null
      if (!scripted) acts.push({ name, args })
      const o = scripted?.o ?? {}
      if (name === 'give' && (!scripted || o.real)) { world.last = await realGive(args); return world.last }
      if (!scripted && name === 'find') { const r = await realAdapter.executeAction(name, args, opts); world.last = typeof r === 'string' ? r : JSON.stringify(r); return r }
      if (scripted && o.then) o.then(bot, setInv)
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
      if (script.length) return script.shift()
      if (!live || liveLeft <= 0) return resp([['end_loop', {}]])
      liveLeft--
      let out
      for (let a = 0; ; a++) {
        try { out = await real.call(patchSystem(req)); break } catch (err) {
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
    const chained = (st) => !st.live && !st.idle && !st.resolve && !st.event && !st.player && !st.do && !st.notice
    for (let i = 0; i < spec.steps.length; i++) {
      const st = spec.steps[i]
      at(st.t)
      // A step with no trigger of its own is the completion turn of the step
      // before, so its script is queued with that step. A live step's own
      // stubbed calls (if any) run first, then the live ones.
      if (st.inv) setInv(st.inv)
      if (!chained(st)) {
        pushScript(st.uses)
        for (let j = i + 1; j < spec.steps.length && chained(spec.steps[j]); j++) pushScript(spec.steps[j].uses)
      }
      if (st.live) { live = true; liveLeft += Number(st.live) }
      if (st.do) { st.do(bot, setInv); await sleep(10); continue }
      if (st.notice) {
        // behaviors/chat.js: the world's death message, recorded and woken on
        const labeled = `just DIED in-game. This is the world's own death message, not something they said to you, and it names the cause: ${st.notice}`
        orch.recordIncomingChat(PLAYER, labeled)
        await orch.handleDispatch('sei:chat_received', { username: PLAYER, message: labeled, text: labeled, addressed: false, playerSpoke: false, noticeShownAt: () => (Number.isFinite(bot._seiOwnerDeath?.shownAt) ? bot._seiOwnerDeath.shownAt : null) }, new AbortController().signal)
        await drain()
        await sleep(30)
        continue
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
        const data = typeof st.data === 'function' ? st.data(bot) : st.data
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
const EXTRA = [['coords', 'coords in chat'], ['said', 'spoke'], ['xyz', 'goTo by coords'], ['near', 'of those, ends at the table'], ['toPlayer', 'walked to Alex']]
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
const lines = ['# Pass 55 probe', '', `root ${ROOT}`, `prompt ${PROMPT}`, `model ${MODEL}, ${ok.length} runs (${rows.length - ok.length} errors), cost $${ok.reduce((s, r) => s + (r.cost ?? 0), 0).toFixed(3)}`, '', '| case | ok | details |', '|---|---:|---|']
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
