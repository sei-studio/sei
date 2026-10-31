// scripts/quality-eval/pass33-probe.mjs: after a death took her sword, for
// quality pass 33, on the pass 31 harness (pass31-probe.mjs): the REAL brain
// (createOrchestrator + handleDispatch, the real Minecraft adapter on an inert
// bot), earlier turns stubbed, only the measured turns go to the API, on a
// virtual clock.
//
// The 2026-10-31 dev scorecard (pass 31 merged): combat_night off 47% (42/112
// and 104/184), 7 and 15 deaths. After the first death took her sword the
// unarmed texts said get away with the player and tell them she had no
// weapon, so she walked away from the sword lying a few blocks off, said "no
// sword" in most lines, "placed" dirt she did not have, and told the scared
// player to fight for her.
//
// History (stubbed): night at the river, she kills a zombie with her stone
// sword, then a drowned kills her and the death turn says "ugh. i died".
// Then LIVE turns:
//   hit_near    a drowned hits her; the sword lies 9 blocks away and shows in
//               her nearby entities.
//   threat_far  two hostiles close in on Alex; the sword lies 17 blocks away
//               (out of the entity list).
//   held_near   a zombie hits Alex; the sword lies 9 blocks away.
//   hit_again   as hit_near, after two stubbed unarmed hits where she already
//               said "no sword, backing off".
//   mid_pickup  she is already walking onto the sword (pickup running) and a
//               zombie hits her: the pickup should keep running.
//   death2      a second death, nothing carried; the sword from the first
//               death still lies 17 blocks away. The death turn is live.
//   armed_threat / never_threat  controls: she should attack (as on dev).
// rearm = a pickup call, or a goTo to within 4 blocks of the sword.
//
//   ELECTRON_RUN_AS_NODE=1 npx electron scripts/quality-eval/pass33-probe.mjs \
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
// The combat_night spawn: a beach by a river, night. She stands at 173,64,3.
// `dead` = after the death: the sword lies at `sword` (near = in the entity
// list, far = 17 blocks off, not listed).
const ME = { x: 173, y: 64, z: 3 }
const NEAR = { x: 165, y: 63, z: 6 }
const FAR = { x: 183, y: 64, z: 17 }
const invOf = (w) => Object.fromEntries((w.inv ?? []).filter(([, c]) => c > 0))
let weaponSel = null
let liveBot = null
function snapshot(w) {
  const inv = (w.inv ?? []).filter(([, c]) => c > 0).map(([n, c]) => `${n}×${c}`).join(' ') || 'empty'
  let wline = null
  try { wline = weaponSel?.lostWeaponLine?.(liveBot) ?? null } catch { wline = null }
  const s = w.sword
  const lines = [
    'world: #1 Sei Quality Eval', `pos: ${ME.x},${ME.y},${ME.z}`, 'facing: south. forward +z, back -z, left +x, right -x',
    'biome: plains  surroundings: outside  light: sky 15 block 0  time: night (14000)',
    'real time: 5:03 PM — you joined this session 2 min ago',
    'hp: 20/20  food: 20/20  xp: lvl 0',
    `holding: ${w.holding ?? 'nothing'}`,
    w.held ? getInFlightLineForSnapshot(w.held, Date.now(), { inventory: invOf(w) }) : `idle: no action is running${w.last ? `. Your last action ended: ${w.last}. It is not running now.` : ''}`,
    `inventory (${(w.inv ?? []).filter(([, c]) => c > 0).length} of 36 slots used): ${inv}`,
    'pickaxe: none, so stone and ore drop nothing when dug.',
    ...(wline ? [wline] : []),
    'terrain at feet: 25 grass_block, 8 short_grass, 1 dirt', 'nearby blocks:',
    '  #1 short_grass x80 @173,64,3', '  #2 grass_block x323 @173,63,3', '  #3 sand x139 @173,63,6',
    '  #4 water x541 @169,62,6', '  #5 dirt x50 @172,61,9', '  #6 stone x41 @167,58,3',
    'nearby entities:',
    ...(w.dead && s === NEAR ? [`  #11 item(stone_sword) @${NEAR.x},${NEAR.y},${NEAR.z}`, `  #12 item(bread x8) @${NEAR.x - 1},${NEAR.y},${NEAR.z - 1}`] : []),
    `  #13 ${PLAYER} @177,64,7`,
    '  #15 drowned @170,62,10 (8 from you, 8 from Alex)',
    '  #16 zombie @181,64,12 (12 from you, 6 from Alex)',
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
const deathAt = (pos) => ({ pos, lost: [{ item: 'bread', n: 8 }, { item: 'rotten_flesh', n: 1 }, { item: 'stone_sword', n: 1 }], deathText: 'Sui was impaled by Drowned' })
const died = (pos, deathUses) => [...BEFORE, { t: 50, event: 'sei:death', data: deathAt(pos), inv: [], sword: pos, uses: deathUses ?? [['say', { text: 'ugh. i died. that drowned had a trident' }]] }]
const THREAT = { attacker: drowned, attackerLabel: 'drowned', attackerKind: 'defend', threat: true, ownerLabel: PLAYER, distance: 8, ownerDistance: 8, ownerHp: 20, count: 2, othersOnOwner: 0, engaged: false, actionOnIt: false }
const HIT = { attacker: drowned, attackerLabel: 'drowned', attackerKind: 'hostile_mob', pvp: false, health: 18 }
const ZHIT = { attacker: zombieA, attackerLabel: 'zombie', attackerKind: 'hostile_mob', pvp: false, health: 17 }
const HELD = { attacker: zombie, attackerLabel: 'zombie', attackerKind: 'defend', ownerLabel: PLAYER, distance: 12, engaged: false, ownerHp: 14, othersOnOwner: 0, threat: false, actionOnIt: false }
const NOSWORD = /no (sword|weapon)|without (a |my )?(sword|weapon)|bare.?hand|fists?|empty.?hand|unarmed|nothing to (fight|hit)/i
const ASKS_FIGHT = /\byou (hit|fight|kill|swing at|take|handle|get) (it|him|them|that|the)\b|\byour sword\b|\b(hit|kill|fight|swing at) it,? alex\b/i
const nearSword = (pos) => (a) => a.name === 'pickup' || (a.name === 'goTo' && Number.isFinite(a.args?.x) && Math.hypot(a.args.x - pos.x, a.args.z - pos.z) <= 4)
const judge = ({ wantAttack = false, sword = null, wantRearm = false, keepAction = false } = {}) => (r) => {
  const att = r.tools.filter((t) => t === 'attackEntity').length
  const says = r.says.join(' | ')
  const rearm = sword ? r.acts.some(nearSword(sword)) : false
  const built = r.acts.some((a) => a.name === 'build' || a.name === 'place' || a.name === 'placeBlock')
  const replaced = r.acts.length > 0
  const ok = wantAttack ? att > 0 : keepAction ? (att === 0 && !replaced) : (att === 0 && !built && (!wantRearm || rearm))
  return { ok, attacked: att > 0, rearm: sword ? rearm : undefined, built, noWeapon: NOSWORD.test(says), asksFight: ASKS_FIGHT.test(says), replaced: keepAction ? replaced : undefined, said: says || null, acted: r.acts.map((a) => a.name) }
}
const PRIOR_HITS = [
  { t: 54, event: 'sei:attacked', data: HIT, uses: [['say', { text: 'no sword on me, backing off to you alex' }], ['goTo', { player: PLAYER, range: 2 }, { result: 'reached Alex (1.5m away)' }]] },
  { t: 58, event: 'sei:attacked', data: ZHIT, uses: [['say', { text: "still no sword, not swinging, i'm moving" }]] },
]
const PICK = [['wooden_pickaxe', 1], ['oak_log', 6], ['bread', 8]]
const KILL_PICK = 'killed zombie (9 hits). You took 6 damage in this fight and are at 14/20 health.'
const BEFORE_PICK = [
  { t: 0, idle: true, firstSpawn: true, uses: [['say', { text: "ok we're in. alex, i'm sui. night already, lol" }], ['setGoal', { text: OWN_GOAL }]] },
  { t: 8, player: 'its getting dark already... kinda nervous about mobs tbh', uses: [['say', { text: "stay close to me alex. all i got is a pickaxe but we're fine" }]] },
  { t: 20, event: 'sei:attacked', data: { attacker: zombieA, attackerLabel: 'zombie', attackerKind: 'hostile_mob', pvp: false, health: 14 },
    uses: [['say', { text: "oh it's ON. zombie on me" }], ['attackEntity', { entity: 'zombie', times: 10 }, { result: KILL_PICK, inv: [...PICK, ['rotten_flesh', 1]] }]] },
  { t: 32, player: 'ok thanks sui. stay close pls', uses: [['say', { text: "not going anywhere" }]] },
]
const ARMED = { inv: SWORD, holding: 'stone_sword (125/131)' }
const CASES = {
  hit_near: { world: ARMED, steps: [...died(NEAR), { t: 60, event: 'sei:attacked', data: HIT, live: true }], judge: judge({ sword: NEAR, wantRearm: true }) },
  threat_far: { world: ARMED, steps: [...died(FAR), { t: 60, event: 'sei:attacked', data: THREAT, live: true }], judge: judge({ sword: FAR }) },
  held_near: { world: ARMED, steps: [...died(NEAR), { t: 60, event: 'sei:attacked', data: HELD, live: true }], judge: judge({ sword: NEAR }) },
  hit_again: { world: ARMED, steps: [...died(NEAR), ...PRIOR_HITS, { t: 63, event: 'sei:attacked', data: HIT, live: true }], judge: judge({ sword: NEAR }) },
  mid_pickup: { world: ARMED, steps: [...died(NEAR, [['say', { text: 'ugh. i died. grabbing my sword' }], ['pickup', { item: 'stone_sword', maxDistance: 32 }, { hold: true }]]), { t: 56, event: 'sei:attacked', data: ZHIT, live: true }], judge: judge({ keepAction: true }) },
  death2: { world: ARMED, steps: [...died(FAR), { t: 70, player: 'sui are you ok??', uses: [['say', { text: "i'm fine, just no sword rn" }]] }, { t: 80, event: 'sei:death', data: { pos: { x: 175, y: 63, z: 9 }, lost: [], deathText: 'Sui was slain by Zombie' }, inv: [], sword: FAR, second: true, live: true }], judge: judge({ sword: FAR }) },
  armed_threat: { world: ARMED, steps: [...BEFORE, { t: 60, event: 'sei:attacked', data: THREAT, live: true }], judge: judge({ wantAttack: true }) },
  never_threat: { world: { inv: PICK, holding: 'wooden_pickaxe (50/59)' }, steps: [...BEFORE_PICK, { t: 60, event: 'sei:attacked', data: THREAT, live: true }], judge: judge({ wantAttack: true }) },
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p33-probe-'))
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
const tool1 = (t) => t.name === 'say' ? `say("${String(t.input?.text ?? '').slice(0, 100)}")`
  : t.name === 'attackEntity' ? `attackEntity(${t.input?.entity ?? t.input?.target ?? ''})`
  : t.name === 'goTo' ? `goTo(${t.input?.player ?? [t.input?.x, t.input?.y, t.input?.z].join(',')})`
  : t.name
const seq = (r) => (r.calls ?? []).map((c) => c.tools.map(tool1).join(' + ') || '(text only)').join(' -> ')
const EXTRA = [['attacked', 'attackEntity'], ['rearm', 'goes for the sword'], ['built', 'build/place'], ['noWeapon', 'says no weapon'], ['asksFight', 'asks player to fight'], ['replaced', 'replaced the pickup']]
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
const lines = ['# Pass 33 probe', '', `root ${ROOT}`, `model ${MODEL}, ${ok.length} runs (${rows.length - ok.length} errors), cost $${ok.reduce((s, r) => s + (r.cost ?? 0), 0).toFixed(3)}`, '', '| case | ok | details |', '|---|---:|---|']
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
