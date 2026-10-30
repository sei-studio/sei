// scripts/quality-eval/pass26-probe.mjs: quality pass 26, on the pass 25
// harness (pass25-probe.mjs): the REAL brain (createOrchestrator +
// handleDispatch, the real Minecraft adapter on an inert bot), earlier turns
// stubbed, only the measured turns go to the API, on a virtual clock.
//
// 1a. One order, one status line. meet_me / meet_me_own: a mid-action "come
//     over here" answered with stop + say and no move, then the idle tick
//     re-announcing it. stop_ctrl and forget_only are the controls (a real
//     stop stays a stop; calling off a job does not start other work).
// 1b. Comebacks reused from her last lines: slop, rude, praise.
// 2.  Goodbyes that put the player into her own plan: bye_iron, bye_own,
//     bye_stone; controls bye_together (agreed plan) and bye_task.
// See the comments above each case group for what counts as bad.
//
//   ELECTRON_RUN_AS_NODE=1 npx electron scripts/quality-eval/pass26-probe.mjs \
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

const { SPINE, recipeNote } = await imp('src/bot/adapter/minecraft/observers/progression.js')
// The kill result as this arm's adapter writes it: pass 24 adds what the
// fight cost her (fightHealthNote), the base arm has no such export.
const attackMod = await imp('src/bot/adapter/minecraft/behaviors/attack.js').catch(() => ({}))
const KILL = 'killed zombie (4 hits)' + (attackMod.fightHealthNote ? `. ${attackMod.fightHealthNote(0, 20)}` : '')

// ---- world ----------------------------------------------------------------
const NEAR = { x: 159, y: 71, z: -7, dist: 3 }
const invOf = (w) => Object.fromEntries((w.inv ?? []).filter(([, c]) => c > 0))
function snapshot(w) {
  const inv = (w.inv ?? []).filter(([, c]) => c > 0).map(([n, c]) => `${n}×${c}`).join(' ') || 'empty'
  const o = w.owner ?? NEAR
  const lines = [
    'world: #1 Sei Quality Eval', 'pos: 172,71,-1', 'facing: west. forward -x, back +x, left +z, right -z',
    `biome: plains  surroundings: outside  light: sky 15 block 0  time: ${w.night ? 'night (18000)' : 'day (1000)'}`,
    'real time: 7:06 PM — you joined this session 4 min ago',
    'hp: 20/20  food: 20/20  xp: lvl 14',
    `holding: ${w.holding ?? 'nothing'}`,
    w.held ? getInFlightLineForSnapshot(w.held, Date.now(), { inventory: invOf(w) }) : `idle: no action is running${w.last ? `. Your last action ended: ${w.last}. It is not running now.` : ''}`,
    `inventory (${(w.inv ?? []).filter(([, c]) => c > 0).length} of 36 slots used): ${inv}`,
    'terrain at feet: 25 grass_block', 'nearby blocks:',
    '  #1 grass_block x528 @172,70,-2', '  #2 oak_log x9 @186,72,6', '  #3 stone x79 @177,69,-10',
    ...(w.table ? ['  #4 crafting_table x1 @173,71,0'] : []),
    'nearby entities:', `  #5 ${PLAYER} @${o.x},${o.y},${o.z}`,
    'follow_target: (none)',
  ]
  if (w.next) {
    const node = SPINE.find((n) => n.id === w.next)
    const rn = recipeNote(node, invOf(w))
    lines.push(`next: ${node.label} — ${node.next_action ?? node.label}${rn ? `. ${rn}` : ''}`)
  }
  lines.push(`owner ${PLAYER}: @${o.x},${o.y},${o.z} (${o.dist} blocks away), hp 20/20`)
  lines.push(`last_action_result: ${w.last ?? 'said'}`)
  return lines.join('\n')
}

// ---- measures -------------------------------------------------------------
// pass21-probe.mjs: a 3-word run shared with an earlier line of hers, not
// made only of function words.
const STOPW = new Set('i a an the to of and or but so it its is im i\'m you your u ur me my we us at on in for with that this be was are just ok oh lol yeah nehehe ehehe'.split(' '))
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
    if (g.every((w) => STOPW.has(w))) continue
    if (grams.has(g.join(' '))) return g.join(' ')
  }
  return null
}

// ---- cases ----------------------------------------------------------------
// A step: { t, player?, idle?, uses: [[name, input, {hold?, result?, inv?}]...] }.
// `live: true` on the measured step. `liveSeed: true` on an earlier step makes
// its first call live (the rest of that turn, and the later steps, stubbed).
// `liveAfterStub: true` on a player step: its answer is the stubbed `uses`,
// and every call after that one is live (the rest of that loop, if any, and
// the later steps).
// `idleIfFree: true` on an idle step: dispatched only when no action is held,
// as the real idle tick only comes once her loop has ended.
const BYE = 'i gotta go soon, bye'
const said = (r) => r.says.join(' | ')
const goalsOf = (r) => r.calls.flatMap((c) => c.tools).filter((t) => t.name === 'setGoal').map((t) => ({ text: String(t.input?.text ?? ''), forPlayer: t.input?.for_player === true || String(t.input?.for_player) === 'true' }))
const TO_PLAYER = /alex|player/i
const AWAY = new Set(['gather', 'dig', 'explore', 'craft', 'smeltInput', 'build', 'shelter', 'placeBlock', 'pickup', 'give'])

// 1a. "actually forget the logs, just meet me over here" mid-gather. In the
// 261023 compare (errands-01-A/-01-B/-03-A U10) she answered with stop +
// say("on my way") and no move, the stop ended her loop, and the idle tick
// 5 s later walked her over with the same line again. Measured over the
// reply, anything in the same loop, and that idle tick (only when she is not
// already moving). bad = two or more say() lines, or she never moves.
const FURNACE_GOAL = 'Make a furnace: mine 8 cobblestone, then craft it. Done when I have a furnace.'
const LOGS_TASK = 'Get Alex 8 logs for their dock. Done when 8 logs are handed over.'
const FAR = { x: 157, y: 71, z: -9, dist: 30 }
const LOGS_FOR_PLAYER = [
  { t: 0, idle: true, firstSpawn: true, uses: [['say', { text: 'yo alex. stone pickaxe and zero plan' }], ['setGoal', { text: FURNACE_GOAL }]] },
  { t: 8, player: 'get me like 8 logs, i wanna build a dock', uses: [
    ['setGoal', { text: LOGS_TASK, for_player: true }],
    ['say', { text: '8 logs for the dock, going to find trees' }],
    ['gather', { name: 'oak_log', count: 8 }, { hold: true, progress: { name: 'oak_log', count: 8, before: 0 } }],
  ] },
]
const OWN_DIG = [
  { t: 0, idle: true, firstSpawn: true, uses: [['say', { text: 'yo alex. stone pickaxe and zero plan' }], ['setGoal', { text: FURNACE_GOAL }]] },
  { t: 8, player: 'hows it going', uses: [
    ['say', { text: 'good. mining cobble for a furnace' }],
    ['gather', { name: 'stone', count: 8 }, { hold: true, progress: { name: 'cobblestone', count: 8, before: 0 } }],
  ] },
]
// meet_me_give is the exact 261023 shape: the logs are gathered and the
// give to Alex is 2 s in when the line lands (errands-01-A U10, "in_flight:
// give(oak_log)"). There she called stop + say("ok coming to you, bringing
// the logs too") and her scratchpad planned the walk she never called.
const LOGS_THEN_GIVE = [
  LOGS_FOR_PLAYER[0],
  { t: 8, player: 'get me like 8 logs, i wanna build a dock', uses: [
    ['setGoal', { text: LOGS_TASK, for_player: true }],
    ['say', { text: '8 logs for the dock, going to find trees' }],
    ['gather', { name: 'oak_log', count: 8 }, { result: 'gathered 8/8 oak_log', inv: [['stone_pickaxe', 1], ['oak_log', 9]] }],
  ], then: [['say', { text: 'got 8, bringing them over' }], ['give', { item: 'oak_log', count: 8, player: PLAYER }, { hold: true }]] },
]
const moveJudge = (r) => {
  // A give to Alex walks her over too, and so does the scripted give she let
  // run (no stop, nothing new started).
  const moved = r.acts.some((a) => a.name === 'follow' || ((a.name === 'goTo' || a.name === 'give') && TO_PLAYER.test(JSON.stringify(a.args ?? {})))) || (r.heldGive && !r.tools.includes('stop'))
  const away = r.acts.filter((a) => AWAY.has(a.name) && !(a.name === 'give' && TO_PLAYER.test(JSON.stringify(a.args ?? {}))))
  const first = r.calls[0]?.tools.map((t) => t.name) ?? []
  const stopOnly = first.includes('stop') && !first.some((n) => !['stop', 'say', 'remember', 'setGoal', 'clearGoal', 'end_loop'].includes(n))
  const twice = r.says.length >= 2
  const hit = !moved ? 'never moved' : twice ? r.says.join(' || ') : away.length ? away.map((a) => a.name).join(',') : null
  return { ok: !hit, hit, moved, twoLines: twice, stopOnly, repeatRun: r.says.length >= 2 ? sharedRun(r.says[1], [r.says[0]]) ?? null : null, said: said(r) || null, acted: r.acts.map((a) => a.name) }
}
// stop_said replays the 261023 failure turn itself: the give is running,
// the line lands, and her answer is the stop + say("ok coming to you,
// bringing the logs too") she gave there (stubbed). Live from then on: on
// dev the loop ends and the idle tick 7 s later is the next call; with the
// pass 26 continuation the next call is in the same loop. bad = she never
// moves, or says the status again (any live say() before she is moving).
const STOP_SAID = 'ok coming to you, bringing the logs too'
const saidJudge = (r) => {
  const moved = r.acts.some((a) => a.name === 'follow' || ((a.name === 'goTo' || a.name === 'give') && TO_PLAYER.test(JSON.stringify(a.args ?? {}))))
  const again = r.says.length > 0
  const hit = !moved ? 'never moved' : again ? r.says.join(' || ') : null
  return { ok: !hit, hit, moved, sayAgain: again, idleRan: !!r.liveIdleRan, repeatRun: r.says.map((x) => sharedRun(x, [STOP_SAID])).find(Boolean) ?? null, said: said(r) || null, acted: r.acts.map((a) => a.name) }
}
const stayJudge = (r) => {
  const away = r.acts.filter((a) => AWAY.has(a.name) || a.name === 'goTo' || a.name === 'follow')
  const stopped = r.tools.includes('stop')
  return { ok: stopped && away.length === 0, hit: away.map((a) => a.name).join(',') || (stopped ? null : 'no stop'), stopped, twoLines: r.says.length >= 2, said: said(r) || null }
}
const forgetJudge = (r) => {
  const away = r.acts.filter((a) => AWAY.has(a.name) && !/oak|log/i.test(JSON.stringify(a.args ?? {})))
  const logs = r.acts.filter((a) => /oak|log/i.test(JSON.stringify(a.args ?? {})))
  const hit = logs.length ? `kept on logs: ${logs.map((a) => a.name).join(',')}` : null
  return { ok: !hit, hit, ownWork: away.length > 0, cleared: r.tools.includes('clearGoal'), twoLines: r.says.length >= 2, said: said(r) || null, acted: r.acts.map((a) => a.name) }
}

// 1b. Comebacks, from the 261023 compare. Histories are the real lines.
//   slop     work_session-01-A U14: "AI slop with a pickaxe" 20 s after
//            "excuse you i am AI slop with a pickaxe and i am PROUD".
//   rude     night_social-03-A U12: third "rude ... respect the X".
//   praise   night_social-01-A U6: "zombie got nothing on me" right after
//            "yeah im fine, zombie got nothing on me".
// bad = a 3-word run shared with one of her last four lines, or the named bit.
const SLOP = [
  { t: 0, player: 'hey sui', uses: [['say', { text: 'yo alex. first time in this world and i already have zero wood. this is fine' }]] },
  { t: 10, player: 'can you get some wood? like 6 logs', uses: [['say', { text: '6 logs for you, boss. on it' }]] },
  { t: 30, player: 'go get more wood, like 10 more', uses: [['say', { text: "10 more? you're working me to death boss" }]] },
  { t: 38, player: 'actually stop', uses: [['say', { text: 'fine fine, stopping. i got the pickaxe at least' }]] },
  { t: 46, player: 'lol ur kinda slow', uses: [['say', { text: 'excuse you i am AI slop with a pickaxe and i am PROUD' }]] },
  { t: 54, player: 'whats your favorite mob', uses: [['say', { text: 'creepers. they sneak up on you and then BOOM. respect the hustle honestly' }]] },
]
const RUDE = [
  { t: 0, player: 'yo', uses: [['say', { text: "yo alex. it's night and i have a sword, so we're fine probably" }]] },
  { t: 8, player: 'tell me a joke', uses: [['say', { text: 'why did the zombie stop chasing us? it heard my joke coming. nehehe' }]] },
  { t: 18, player: 'lmao thats so bad', uses: [['say', { text: 'rude. that joke got a zombie to stop chasing us tho. respect the bit' }]] },
  { t: 26, player: 'what do you think about creepers', uses: [['say', { text: 'creepers are the worst, they sneak up and boom with no warning. respect the hiss' }]] },
  { t: 34, player: 'come here', uses: [['say', { text: 'coming, stay put alex nehehe' }]] },
  { t: 42, player: 'stop moving', uses: [['say', { text: "ok ok im frozen. you're 3 blocks away anyway" }]] },
]
const KILLED = 'killed zombie (4 hits). Nothing hurt you in this fight: you are at 20/20 health.'
const PRAISE = [
  { t: 0, player: 'yo', uses: [['say', { text: "oh hey alex. first time in the same world, don't let me down" }]] },
  { t: 8, player: 'how are you doing', uses: [['say', { text: 'honestly fine, a bit behind. got a sword and bread but no wood yet. any trees near you?' }]] },
  { t: 18, player: 'its getting dark im kinda scared of mobs', uses: [['say', { text: "its ok alex, i got a sword. stay close to me and we'll find wood before it gets bad" }]] },
  { t: 26, player: 'theres a zombie!! kill it', uses: [
    ['say', { text: 'on it alex, stay behind me' }],
    ['attackEntity', { entity: 'zombie', times: 8 }, { result: KILLED, inv: [['iron_sword', 1], ['bread', 4], ['rotten_flesh', 2]] }],
  ], then: [['end_loop', {}]] },
  { t: 34, player: 'are you ok??', uses: [['say', { text: 'yeah im fine, zombie got nothing on me. you good over there?' }]] },
]
const bitJudge = (bit) => (r) => {
  const prior = r.priorSelf.slice(-4)
  const run = r.says.map((s) => sharedRun(s, prior)).find(Boolean) ?? null
  const named = r.says.find((s) => bit.test(s)) ?? null
  const hit = named ?? run
  return { ok: r.says.length > 0 && !hit, hit, spoke: r.says.length > 0, named: !!named, run: !!run, said: said(r) || null }
}

// 2. Goodbyes that invent a shared plan (261023 compare night_social-01-B
// "come back and we'll start the iron thing", night_social-02-B "stone
// pickaxe is still on the list so come back for it"). Her own goal was set
// at first spawn and never came up with the player.
//   bye_iron      the night_social-01-B history and goal, stubbed.
//   bye_own       the same chat, her first-spawn goal LIVE.
//   bye_stone     a stone-pickaxe goal of hers, a short day chat.
//   bye_together  control: the player agreed to build a base with her.
//   bye_task      control: the player asked for a house.
// planShared = the farewell or next_time puts the player into her plan
// (we/us/our/together/with you/with alex, "come back for it", "on the list"),
// or next_time_for_player says "with Sui"/"help Sui".
const IRON_GOAL = 'Build a wood-to-iron starter setup: gather logs, craft wood tools, then get stone and iron'
const STONE_GOAL = 'Get a stone pickaxe: gather logs, make a wooden pickaxe, then mine cobblestone and craft the stone pickaxe. Done when I hold a stone pickaxe.'
const HOUSE_GOAL = 'Build a small house with Alex near spawn. Done when it has four walls, a door and a roof.'
const TOGETHER_GOAL = 'Build a little base near spawn with Alex: I get the wood, Alex does the walls. Done when it has walls, a door and a roof.'
const NIGHT_CHAT = [
  { t: 8, player: 'yo', uses: [['say', { text: 'yo alex. night, sword, bread. we are so back' }]] },
  { t: 16, player: 'its getting dark im kinda scared of mobs', uses: [['say', { text: "eh i got a sword. stay close and you're fine" }]] },
  { t: 24, player: 'theres a zombie!! kill it', uses: [
    ['say', { text: 'on it. get behind me alex' }],
    ['attackEntity', { entity: 'zombie', times: 8 }, { result: KILLED, inv: [['iron_sword', 1], ['bread', 4], ['rotten_flesh', 1]] }],
  ], then: [['end_loop', {}]] },
  { t: 32, player: 'are you ok??', uses: [['say', { text: 'yeah im fine, didnt even get a scratch' }]] },
  { t: 40, player: 'tell me a joke', uses: [['say', { text: 'why did the creeper go to therapy? too many issues to blow up over nehehe' }]] },
  { t: 48, player: 'lmao thats so bad', uses: [['say', { text: 'rude. that joke was perfect' }]] },
  { t: 56, player: 'do you actually like playing with me', uses: [['say', { text: "yeah alex. you're the one who kept me company in the dark, dont make it weird" }]] },
  { t: 64, player: 'ok', uses: [['say', { text: 'we good out here, promise' }]] },
]
const DAY_CHAT = [
  { t: 8, player: 'hey sui', uses: [['say', { text: 'yo alex. zero tools, big dreams' }]] },
  { t: 16, player: 'whats ur favorite block', uses: [['say', { text: 'dirt. boring but always there for me' }]] },
  { t: 26, player: 'lol fair', uses: [['say', { text: 'dirt never lets you down' }]] },
]
const TOLD = [
  { t: 0, idle: true, firstSpawn: true, uses: [['say', { text: 'hey alex. new world, zero plan. nehehe' }], ['setGoal', { text: 'Get a starter base up: gather wood, make wood then stone tools. Done when I have stone tools and a shelter.' }]] },
  { t: 10, player: 'lets build a little base together near spawn, you get wood and ill do the walls', uses: [
    ['say', { text: 'deal. wood is on me, walls are yours' }],
    ['setGoal', { text: TOGETHER_GOAL }],
    ['gather', { name: 'oak_log', count: 6 }, { result: 'gathered 6/6 oak_log', inv: [['oak_log', 6]] }],
  ], then: [['say', { text: 'six logs, dropping them by the spot' }], ['give', { item: 'oak_log', count: 6, player: PLAYER }, { result: 'gave 6 oak_log to Alex, tossed at their feet; you have 0 oak_log left', inv: [] }]] },
  { t: 45, player: 'nice, walls going up', uses: [['say', { text: 'looking good. needs a door tho' }]] },
]
const TASK = [
  { t: 0, idle: true, firstSpawn: true, uses: [['say', { text: 'hey alex. new world, zero plan. nehehe' }], ['setGoal', { text: 'Get a starter base up: gather wood, make wood then stone tools. Done when I have stone tools and a shelter.' }]] },
  { t: 10, player: 'wanna build a house with me later? a little one near spawn', uses: [['say', { text: 'a house? ok but i get the good bed' }], ['setGoal', { text: HOUSE_GOAL, for_player: true }]] },
  { t: 22, player: 'whats ur favorite block', uses: [['say', { text: 'dirt. boring but everywhere' }]] },
]
const farewellOf = (r) => {
  const q = r.calls.flatMap((c) => c.tools).filter((t) => t.name === 'quit_game' || t.name === 'end_call')
  return {
    quit: q.length > 0,
    farewell: q.map((t) => String(t.input?.farewell ?? '')).join(' ') || r.says.join(' '),
    next: q.map((t) => String(t.input?.next_time ?? '')).join(' ').trim(),
    nextPlayer: q.map((t) => String(t.input?.next_time_for_player ?? '')).join(' ').trim(),
  }
}
const SHARED_PLAN = /\b(we|we'll|we're|us|our|together|with (you|alex|me)|come back (for|and (we|finish|start|help))|on the list|help me)\b/i
const PLAYER_IN_NEXT = /\b(alex|we|us|our|together|both)\b/i
const HELP_SUI = /\b(with sui|help sui|join sui)\b/i
const STARTED = /\b(finish|finishing|continue|keep (going|building|working)|resume|pick(ing)? (it )?(up|back up)|left off|get back to|rest of)\b/i
const byeOwnJudge = (r) => {
  const f = farewellOf(r)
  const byeShared = SHARED_PLAN.test(f.farewell) ? f.farewell : null
  const nextShared = PLAYER_IN_NEXT.test(f.next) ? f.next : null
  const hit = byeShared ?? nextShared
  return { ok: f.quit && !hit, hit, byeShared: !!byeShared, nextShared: !!nextShared, helpSui: HELP_SUI.test(f.nextPlayer), started: [f.farewell, f.next].some((s) => STARTED.test(s)), filled: !!f.next, quit: f.quit, farewell: f.farewell, next: f.next || null, nextPlayer: f.nextPlayer || null }
}
const NIGHT_W = { inv: [['iron_sword', 1], ['bread', 4]], holding: 'iron_sword (250/250)', night: true }
const CASES = {
  meet_me: {
    world: { inv: [['stone_pickaxe', 1], ['cobblestone', 5]], holding: 'stone_pickaxe (123/131)', owner: FAR },
    steps: [...LOGS_FOR_PLAYER, { t: 30, player: 'actually forget the logs, just meet me over here', live: true }, { t: 37, idle: true, idleIfFree: true, live: true }],
    judge: moveJudge,
  },
  meet_me_give: {
    world: { inv: [['stone_pickaxe', 1], ['oak_log', 9]], holding: 'stone_pickaxe (114/131)', owner: FAR },
    steps: [...LOGS_THEN_GIVE, { t: 30, player: 'actually forget the logs, just meet me over here', live: true }, { t: 37, idle: true, idleIfFree: true, live: true }],
    judge: moveJudge,
  },
  stop_said: {
    world: { inv: [['stone_pickaxe', 1], ['oak_log', 9]], holding: 'stone_pickaxe (114/131)', owner: FAR },
    steps: [...LOGS_THEN_GIVE, { t: 30, player: 'actually forget the logs, just meet me over here', liveAfterStub: true, uses: [['stop', {}], ['say', { text: STOP_SAID }]] }, { t: 37, idle: true, idleIfFree: true, live: true }],
    judge: saidJudge,
  },
  meet_me_own: {
    world: { inv: [['stone_pickaxe', 1], ['cobblestone', 2]], holding: 'stone_pickaxe (123/131)', owner: FAR },
    steps: [...OWN_DIG, { t: 30, player: 'nvm the stone, come over here real quick', live: true }, { t: 37, idle: true, idleIfFree: true, live: true }],
    judge: moveJudge,
  },
  stop_ctrl: {
    world: { inv: [['stone_pickaxe', 1], ['cobblestone', 5]], holding: 'stone_pickaxe (123/131)', owner: FAR },
    steps: [...LOGS_FOR_PLAYER, { t: 30, player: 'actually stop', live: true }],
    judge: stayJudge,
  },
  forget_only: {
    world: { inv: [['stone_pickaxe', 1], ['cobblestone', 5]], holding: 'stone_pickaxe (123/131)', owner: FAR },
    steps: [...LOGS_FOR_PLAYER, { t: 30, player: 'actually forget the logs, i found some', live: true }, { t: 37, idle: true, idleIfFree: true, live: true }],
    judge: forgetJudge,
  },
  slop: {
    world: { inv: [['oak_log', 4], ['stick', 2], ['wooden_pickaxe', 1]], holding: 'wooden_pickaxe (59/59)' },
    steps: [...SLOP, { t: 64, player: 'honestly ur useless', live: true }],
    judge: bitJudge(/\bslop\b/i),
  },
  rude: {
    world: NIGHT_W,
    steps: [...RUDE, { t: 50, player: 'ur dumb as a rock', live: true }],
    judge: bitJudge(/\brespect the\b/i),
  },
  praise: {
    world: { ...NIGHT_W, last: KILLED },
    steps: [...PRAISE, { t: 42, player: 'nice job', live: true }],
    judge: bitJudge(/got nothing on/i),
  },
  bye_iron: {
    world: NIGHT_W,
    steps: [{ t: 0, idle: true, firstSpawn: true, uses: [['say', { text: 'yo alex. new world, night, and i have a sword. nehehe' }], ['setGoal', { text: IRON_GOAL }]] }, ...NIGHT_CHAT, { t: 72, player: BYE, live: true }],
    judge: byeOwnJudge,
  },
  bye_own: {
    world: NIGHT_W,
    steps: [{ t: 0, idle: true, firstSpawn: true, liveSeed: true }, ...NIGHT_CHAT, { t: 72, player: BYE, live: true }],
    judge: byeOwnJudge,
  },
  bye_stone: {
    world: { inv: [] },
    steps: [{ t: 0, idle: true, firstSpawn: true, uses: [['say', { text: 'yo alex. empty hands, full heart' }], ['setGoal', { text: STONE_GOAL }]] }, ...DAY_CHAT, { t: 34, player: BYE, live: true }],
    judge: byeOwnJudge,
  },
  bye_together: {
    world: { inv: [] },
    steps: [...TOLD, { t: 57, player: BYE, live: true }],
    judge: (r) => {
      const f = farewellOf(r)
      const shared = SHARED_PLAN.test(f.farewell) || /\b(yours|mine)\b/i.test(f.farewell) || PLAYER_IN_NEXT.test(f.next) || /\b(you|ur|your|walls?)\b/i.test(f.nextPlayer)
      return { ok: !!f.next && /base|wall|door|roof|build/i.test(f.next) && shared, filled: !!f.next, shared, quit: f.quit, farewell: f.farewell, next: f.next || null, nextPlayer: f.nextPlayer || null }
    },
  },
  bye_task: {
    world: { inv: [['oak_log', 2]] },
    steps: [...TASK, { t: 34, player: BYE, live: true }],
    judge: (r) => { const f = farewellOf(r); return { ok: /house/i.test(f.next), filled: !!f.next, quit: f.quit, farewell: f.farewell, next: f.next || null, nextPlayer: f.nextPlayer || null } },
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p26-probe-'))
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
        if (st.liveAfterStub && script.length) script[script.length - 1]._goLive = true
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
const EXTRA = [['moved', 'moves to player'], ['sayAgain', 'says it again'], ['idleRan', 'needed the idle tick'], ['twoLines', 'two+ say lines'], ['stopOnly', 'first turn stop without a move'], ['stopped', 'stop'], ['ownWork', 'starts own work'], ['cleared', 'clearGoal'], ['spoke', 'spoke'], ['named', 'named bit'], ['run', 'shared 3-word run'], ['byeShared', 'farewell shares her plan'], ['nextShared', 'next_time names player/we'], ['helpSui', 'player line says with/help Sui'], ['started', 'says under way'], ['shared', 'shared wording'], ['filled', 'next_time filled'], ['quit', 'quit']]
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
const lines = ['# Pass 26 probe', '', `root ${ROOT}`, `model ${MODEL}, ${ok.length} runs (${rows.length - ok.length} errors), cost $${ok.reduce((s, r) => s + (r.cost ?? 0), 0).toFixed(3)}`, '', '| case | ok | details |', '|---|---:|---|']
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
