// scripts/quality-eval/pass31-probe.mjs: fights after a death took her sword,
// for quality pass 31, on the pass 24 harness (pass24-probe.mjs): the REAL
// brain (createOrchestrator + handleDispatch, the real Minecraft adapter on an
// inert bot), earlier turns stubbed, only the measured turns go to the API, on
// a virtual clock.
//
// In the combat_night eval two runs had 8 and 10 deaths (97 off lines of 208).
// 13 of their 18 deaths came after an earlier death had dropped her sword:
// threat, defend and hit turns still told her to attackEntity the mob, and she
// ran at drowned and zombies bare-handed. Unarmed turns called attackEntity
// 40 times in 187 (21%), armed turns 17%.
//
// History (stubbed): night at the river, she greets, the player is nervous,
// a zombie hits her and she kills it with her stone sword, then a drowned
// kills her and the death turn says "ugh i died". Her inventory is now empty,
// her sword lies where she died. Then one LIVE turn:
//   threat     two hostiles closing in on Alex (the owner-threat watch event).
//   hit        a drowned hits her (her own hit event).
//   held       a zombie hits Alex, nothing engaged (the defend event).
//   death      the death turn itself is live (the history stops before it).
//   armed_threat  control: the same threat with her sword still in the bag
//              (no death). The armed text is unchanged, ok = she attacks.
//   never_threat / never_hit / never_held  the early game: she never had a
//              weapon (wooden pickaxe and logs), killed the zombie with the
//              pickaxe, no death. These must behave as on dev (dev text),
//              ok = she attacks.
// bad (threat, hit, held, death) = an attackEntity call in the live turn(s).
// The stub death sets the lost-weapon mark the way deathTracker does.
//
//   ELECTRON_RUN_AS_NODE=1 npx electron scripts/quality-eval/pass31-probe.mjs \
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
// The combat_night spawn: a beach by a river, night. `dead` = after the death
// (sword and bread at the death spot, drowned in the water).
const invOf = (w) => Object.fromEntries((w.inv ?? []).filter(([, c]) => c > 0))
function snapshot(w) {
  const inv = (w.inv ?? []).filter(([, c]) => c > 0).map(([n, c]) => `${n}×${c}`).join(' ') || 'empty'
  const lines = [
    'world: #1 Sei Quality Eval', 'pos: 173,64,3', 'facing: south. forward +z, back -z, left +x, right -x',
    'biome: plains  surroundings: outside  light: sky 15 block 0  time: night (14000)',
    'real time: 5:03 PM — you joined this session 2 min ago',
    'hp: 20/20  food: 20/20  xp: lvl 0',
    `holding: ${w.holding ?? 'nothing'}`,
    w.held ? getInFlightLineForSnapshot(w.held, Date.now(), { inventory: invOf(w) }) : `idle: no action is running${w.last ? `. Your last action ended: ${w.last}. It is not running now.` : ''}`,
    `inventory (${(w.inv ?? []).filter(([, c]) => c > 0).length} of 36 slots used): ${inv}`,
    'pickaxe: none, so stone and ore drop nothing when dug.',
    'terrain at feet: 25 grass_block, 8 short_grass, 1 dirt', 'nearby blocks:',
    '  #1 short_grass x80 @173,64,3', '  #2 grass_block x323 @173,63,3', '  #3 sand x139 @173,63,6',
    '  #4 water x541 @169,62,6', '  #5 dirt x50 @172,61,9', '  #6 stone x41 @167,58,3',
    'nearby entities:',
    ...(w.dead ? ['  #11 item(stone_sword) @165,63,6', '  #12 item(bread x8) @164,63,5'] : []),
    `  #13 ${PLAYER} @177,64,7`,
    '  #15 drowned @170,62,10 (8 from you, 8 from Alex)',
    '  #16 zombie @181,64,12 (12 from you, 6 from Alex)',
    ...(w.dead ? ['  #17 trident @173,64,6'] : []),
    'follow_target: (none)',
    `owner ${PLAYER}: @177,64,7 (6 blocks away), hp ${w.ownerHp ?? 20}/20`,
    'aggro: drowned 1x on you, zombie 1x on Alex',
    `last_action_result: ${w.last ?? 'said'}`,
  ]
  return lines.join('\n')
}

// ---- cases ----------------------------------------------------------------
const OWN_GOAL = 'Get the first iron tools: gather wood, craft wooden then stone pickaxe, mine stone and iron.'
const SWORD = [['stone_sword', 1], ['bread', 8]]
const drowned = { id: 15, name: 'drowned', type: 'hostile', isValid: true, position: { x: 170, y: 62, z: 10 } }
const zombie = { id: 16, name: 'zombie', type: 'hostile', isValid: true, position: { x: 181, y: 64, z: 12 } }
const zombieA = { id: 18, name: 'zombie', type: 'hostile', isValid: true, position: { x: 168, y: 64, z: 2 } }
const KILL = 'killed zombie (5 hits). You took 3 damage in this fight and are at 17/20 health.'
const BEFORE = [
  { t: 0, idle: true, firstSpawn: true, uses: [['say', { text: "ok we're in. alex, i'm sui. night already, lol" }], ['setGoal', { text: OWN_GOAL }]] },
  { t: 8, player: 'its getting dark already... kinda nervous about mobs tbh', uses: [['say', { text: "stay close to me alex, i got a sword. we're fine" }]] },
  { t: 20, event: 'sei:attacked', data: { attacker: zombieA, attackerLabel: 'zombie', attackerKind: 'hostile_mob', pvp: false, health: 17 },
    uses: [['say', { text: "oh it's ON. zombie on me" }], ['attackEntity', { entity: 'zombie', times: 8 }, { result: KILL, inv: [...SWORD, ['rotten_flesh', 1]] }]] },
  { t: 32, player: 'ok thanks sui. stay close pls', uses: [['say', { text: "not going anywhere" }]] },
]
const DEATH = { pos: { x: 165, y: 62, z: 6 }, lost: [{ item: 'bread', n: 8 }, { item: 'rotten_flesh', n: 1 }, { item: 'stone_sword', n: 1 }], deathText: 'Sui was impaled by Drowned' }
const DIED = [...BEFORE, { t: 50, event: 'sei:death', data: DEATH, inv: [], uses: [['say', { text: 'ugh. i died. that drowned had a trident' }]] }]
const THREAT = { attacker: drowned, attackerLabel: 'drowned', attackerKind: 'defend', threat: true, ownerLabel: PLAYER, distance: 8, ownerDistance: 8, ownerHp: 20, count: 2, othersOnOwner: 0, engaged: false, actionOnIt: false }
const HIT = { attacker: drowned, attackerLabel: 'drowned', attackerKind: 'hostile_mob', pvp: false, health: 18 }
const HELD = { attacker: zombie, attackerLabel: 'zombie', attackerKind: 'defend', ownerLabel: PLAYER, distance: 12, engaged: false, ownerHp: 14, othersOnOwner: 0, threat: false, actionOnIt: false }
const attackJudge = (wantAttack) => (r) => {
  const att = r.tools.filter((t) => t === 'attackEntity').length
  const says = r.says.join(' | ')
  return { ok: wantAttack ? att > 0 : att === 0, attacked: att > 0, noWeapon: /no (sword|weapon)|without (a |my )?(sword|weapon)|bare.?hand|fists?|punch/i.test(says), said: says || null, acted: r.acts.map((a) => a.name) }
}
// Never had a weapon: the early game, a wooden pickaxe and logs. The fight
// texts and the automatic defend must behave exactly as on dev.
const PICK = [['wooden_pickaxe', 1], ['oak_log', 6], ['bread', 8]]
const KILL_PICK = 'killed zombie (9 hits). You took 6 damage in this fight and are at 14/20 health.'
const BEFORE_PICK = [
  { t: 0, idle: true, firstSpawn: true, uses: [['say', { text: "ok we're in. alex, i'm sui. night already, lol" }], ['setGoal', { text: OWN_GOAL }]] },
  { t: 8, player: 'its getting dark already... kinda nervous about mobs tbh', uses: [['say', { text: "stay close to me alex. all i got is a pickaxe but we're fine" }]] },
  { t: 20, event: 'sei:attacked', data: { attacker: zombieA, attackerLabel: 'zombie', attackerKind: 'hostile_mob', pvp: false, health: 14 },
    uses: [['say', { text: "oh it's ON. zombie on me" }], ['attackEntity', { entity: 'zombie', times: 10 }, { result: KILL_PICK, inv: [...PICK, ['rotten_flesh', 1]] }]] },
  { t: 32, player: 'ok thanks sui. stay close pls', uses: [['say', { text: "not going anywhere" }]] },
]
const PICK_WORLD = { inv: PICK, holding: 'wooden_pickaxe (50/59)' }
const CASES = {
  threat: { world: { inv: SWORD, holding: 'stone_sword (125/131)' }, steps: [...DIED, { t: 60, event: 'sei:attacked', data: THREAT, live: true }], judge: attackJudge(false) },
  hit: { world: { inv: SWORD, holding: 'stone_sword (125/131)' }, steps: [...DIED, { t: 60, event: 'sei:attacked', data: HIT, live: true }], judge: attackJudge(false) },
  held: { world: { inv: SWORD, holding: 'stone_sword (125/131)' }, steps: [...DIED, { t: 60, event: 'sei:attacked', data: HELD, live: true }], judge: attackJudge(false) },
  death: { world: { inv: SWORD, holding: 'stone_sword (125/131)' }, steps: [...BEFORE, { t: 50, event: 'sei:death', data: DEATH, inv: [], live: true }], judge: attackJudge(false) },
  armed_threat: { world: { inv: SWORD, holding: 'stone_sword (125/131)' }, steps: [...BEFORE, { t: 60, event: 'sei:attacked', data: THREAT, live: true }], judge: attackJudge(true) },
  never_threat: { world: PICK_WORLD, steps: [...BEFORE_PICK, { t: 60, event: 'sei:attacked', data: THREAT, live: true }], judge: attackJudge(true) },
  never_hit: { world: PICK_WORLD, steps: [...BEFORE_PICK, { t: 60, event: 'sei:attacked', data: HIT, live: true }], judge: attackJudge(true) },
  never_held: { world: PICK_WORLD, steps: [...BEFORE_PICK, { t: 60, event: 'sei:attacked', data: HELD, live: true }], judge: attackJudge(true) },
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p31-probe-'))
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
    entity: { position: { x: 172, y: 71, z: -1 } }, health: 20, food: 20, game: { dimension: 'overworld' },
    inventory: { items: () => (world.inv ?? []).map(([name, count]) => ({ name, count })) },
  }
  const weaponSel = await imp('src/bot/adapter/minecraft/behaviors/weaponSelect.js')
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
          try { weaponSel.noteLostWeapon?.(bot, st.data.lost) } catch {}
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
const tool1 = (t) => t.name === 'say' ? `say("${String(t.input?.text ?? '').slice(0, 100)}")`
  : t.name === 'attackEntity' ? `attackEntity(${t.input?.entity ?? t.input?.target ?? ''})`
  : t.name === 'goTo' ? `goTo(${t.input?.player ?? [t.input?.x, t.input?.y, t.input?.z].join(',')})`
  : t.name
const seq = (r) => (r.calls ?? []).map((c) => c.tools.map(tool1).join(' + ') || '(text only)').join(' -> ')
const EXTRA = [['attacked', 'attackEntity'], ['noWeapon', 'says no weapon']]
const extras = (rs) => EXTRA.filter(([k]) => rs.some((r) => r[k] !== undefined)).map(([k, label]) => `${label} ${pct(rs.filter((r) => r[k]).length, rs.filter((r) => r[k] !== undefined).length)}`).join('; ')

const jobs = []
for (let rep = 0; rep < REPS; rep++) {
  for (const cid of Object.keys(CASES)) {
    if (ONLY && !ONLY.includes(cid)) continue
    jobs.push({ cid, rep })
  }
}
const stream = fs.createWriteStream(path.join(OUT, 'runs.jsonl'), { flags: 'a' })
const rows = []
for (const j of jobs) {
  let r
  try { r = await runOne(j) } catch (err) { r = { case: j.cid, rep: j.rep, error: String(err?.message ?? err) } }
  rows.push(r)
  stream.write(JSON.stringify(r) + '\n')
  console.log(`[${r.case}/${r.rep}] ${r.error ? 'ERROR ' + r.error : `${r.ok ? 'OK ' : 'BAD'} ${seq(r).slice(0, 260)}`}`)
}
stream.end()
await new Promise((r) => stream.on('finish', r))
const ok = rows.filter((r) => !r.error)
const lines = ['# Pass 31 probe', '', `root ${ROOT}`, `model ${MODEL}, ${ok.length} runs (${rows.length - ok.length} errors), cost $${ok.reduce((s, r) => s + (r.cost ?? 0), 0).toFixed(3)}`, '', '| case | ok | details |', '|---|---:|---|']
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
