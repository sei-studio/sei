#!/usr/bin/env node
/**
 * scripts/probe-brain.mjs — offline single-iteration brain probe.
 *
 * Replays in-game states reconstructed from the play logs against the REAL
 * prompt assembly (BASELINE_INSTRUCTIONS + renderPersona + adapter prompts +
 * composeSeedBlocks + renderHeartbeat) and the REAL tool list, then calls the
 * live Anthropic API and prints, per scenario:
 *   - the model's raw text
 *   - what postProcessSay() would actually let reach chat (the telemetry filter)
 *   - tool calls (name + input)
 *   - whether a private thinking block was produced
 *
 * No mineflayer, no Electron — just the brain's text path. Reads the key from
 * ANTHROPIC_API_KEY in the environment (never written to disk).
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... node scripts/probe-brain.mjs            # thinking off
 *   ANTHROPIC_API_KEY=... node scripts/probe-brain.mjs --thinking 1024
 *   ANTHROPIC_API_KEY=... node scripts/probe-brain.mjs --only A   # one scenario
 */
import Anthropic from '@anthropic-ai/sdk'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

import {
  BASELINE_INSTRUCTIONS,
  PERSONALITY_TOOL_DESCRIPTIONS,
  NUDGES,
  renderPersona,
} from '../src/bot/brain/prompts.js'
import {
  CAPABILITY_PARAGRAPH,
  WORLD_PRIMER,
  ACTION_RULES,
  CUBOID_GRAMMAR,
  ACTION_DESCRIPTIONS,
  eventAddendum,
} from '../src/bot/adapter/minecraft/prompts.js'
import { composeSeedBlocks, postProcessSay, splitChatMessages } from '../src/bot/brain/orchestrator.js'

const MODEL = 'claude-haiku-4-5'

// ── CLI ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
function flag(name, def = null) {
  const i = argv.indexOf(name)
  return i >= 0 ? (argv[i + 1] ?? true) : def
}
const THINKING = Number(flag('--thinking', 0)) || 0
const ONLY = flag('--only', null)

// 260615: matrix mode. The harness ALWAYS validates offline prompt assembly
// (composeSeedBlocks + renderHeartbeat + the IDEAS block) so it is useful with
// no key; live model calls are guarded behind a resolved key. Never invent a
// key — if absent we print "LIVE EVAL PENDING KEY" and still assemble + check.
//
// Key resolution (dev-only, NEVER bundled into prod — scripts/ is excluded from
// the electron-builder package): ANTHROPIC_API_KEY env wins; otherwise fall back
// to the developer's secure out-of-repo key file at ~/.sei-dev/anthropic-test-key
// (mode 600, outside the git tree so it can never be committed). This lets the
// matrix run autonomously without re-exporting the key each session.
function resolveApiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY
  try {
    const home = process.env.HOME || process.env.USERPROFILE || ''
    const k = readFileSync(join(home, '.sei-dev', 'anthropic-test-key'), 'utf8').trim()
    return k || undefined
  } catch {
    return undefined
  }
}
const apiKey = resolveApiKey()
const LIVE = Boolean(apiKey)
const client = LIVE ? new Anthropic({ apiKey }) : null

// ── Real tool list (personality + movement) ─────────────────────────────────
const personalityTools = [
  { name: 'remember', description: PERSONALITY_TOOL_DESCRIPTIONS.remember, input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'forget', description: PERSONALITY_TOOL_DESCRIPTIONS.forget, input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'setGoal', description: PERSONALITY_TOOL_DESCRIPTIONS.setGoal, input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'clearGoal', description: PERSONALITY_TOOL_DESCRIPTIONS.clearGoal, input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'end_loop', description: PERSONALITY_TOOL_DESCRIPTIONS.end_loop, input_schema: { type: 'object', properties: {}, additionalProperties: false } },
]
// Movement tools, hand-mirrored from adapter/minecraft/registry.js. Descriptions
// are the REAL ones (ACTION_DESCRIPTIONS); schemas are representative — the probe
// tests prompt/behavior, not arg validation, and importing the live registry
// pulls in the Electron-ABI vision native (gl/webgl.node), which won't load
// under system Node.
const MOVEMENT_SCHEMAS = {
  goTo: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, range: { type: 'number' } },
  dig: { block: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
  find: { name: { type: 'string' } },
  explore: { orientation: { type: 'string' }, angle: { type: 'number' }, blocks: { type: 'number' } },
  look: { orientation: { type: 'string' }, angle: { type: 'number' }, around: { type: 'boolean' } },
  gather: { name: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
  placeBlock: { block: { type: 'string' }, against: { type: 'object' } },
  build: { from: { type: 'object' }, to: { type: 'object' }, block: { type: 'string' }, hollow: { type: 'boolean' } },
  equip: { item: { type: 'string' }, destination: { type: 'string' } },
  attackEntity: { entity: { type: 'string' }, target: { type: 'string' }, times: { type: 'number' } },
  follow: { player: { type: 'string' }, entity: { type: 'string' } },
  unfollow: {},
  consumeItem: { item: { type: 'string' } },
  lookAt: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, entity: { type: 'string' } },
  dropItem: { item: { type: 'string' }, count: { type: 'number' } },
  activateItem: {},
  sleep: {},
  openContainer: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
  depositItem: { item: { type: 'string' }, count: { type: 'number' } },
  withdrawItem: { item: { type: 'string' }, count: { type: 'number' } },
}
const movementTools = Object.entries(MOVEMENT_SCHEMAS).map(([name, props]) => ({
  name,
  description: ACTION_DESCRIPTIONS[name] ?? `Action: ${name}`,
  input_schema: { type: 'object', properties: props, additionalProperties: true },
}))
const TOOLS = [...personalityTools, ...movementTools]

// ── System prompt (matches rebuildPersonalitySystem) ─────────────────────────
function systemBlocks(persona) {
  return [
    BASELINE_INSTRUCTIONS,
    renderPersona(persona),
    CAPABILITY_PARAGRAPH,
    WORLD_PRIMER,
    ACTION_RULES,
  ].map((text) => ({ type: 'text', text }))
}

// ── Personas (loaded from the edited default JSONs) ──────────────────────────
function loadPersona(slug) {
  const path = new URL(`../resources/default-characters/${slug}.json`, import.meta.url)
  const c = JSON.parse(readFileSync(path, 'utf8'))
  return {
    name: c.username ?? c.name,
    expanded: c.persona.expanded,
    proactiveness: c.metadata?.proactiveness ?? 1,
  }
}
const MARV = loadPersona('marv')   // proactiveness 0 (Passive)
const SUI = loadPersona('sui')      // proactiveness 2 (Agentic)
const LYRA = loadPersona('lyra')    // proactiveness 1 (Reactive)
const BASE_PERSONAS = { Marv: MARV, Sui: SUI, Lyra: LYRA }
// Override a persona's authored proactiveness so we can sweep every level for
// every voice (matrix dimension), independent of the JSON default.
function withLevel(persona, level) {
  return { ...persona, proactiveness: level }
}

const PLAYER_SEED = `# Player\nplayer_username: SSk1tz\npreferred_name: Ouen\ntotal_sessions: 23\n`

// ── Scenarios reconstructed from the play logs ───────────────────────────────
const MARV_MEMORY = [
  '- [2026-06-11T20:30:33.195Z] ouen actually explores with me. not leaving me to rot. noteworthy.',
  '- [2026-06-13T23:13:49.875Z] ouen said "help me get some wood." followed immediately. still learning they mean it when they ask.',
].join('\n')
const MARV_STANDING_ORDER =
  '- [2026-06-13T23:16:54.000Z] standing order from ouen: every time i join, gather wood until i have ten logs, then build a statue. not done until the statue exists.'

const SNAP_A = `snapshot: pos: 80,64,-54
biome: plains  surroundings: outside  time: day (9724)
hp: 20/20  food: 20/20  xp: lvl 0
holding: dirt
in_flight: gather() started=20.1s ago — 2/5
inventory (3/36 slots): dirt×3 oak_log×4 oak_sapling×2
terrain at feet: 24 grass_block, 12 short_grass
nearby blocks:
  #1 oak_log x5 @78,65,-56
  #2 grass_block x481 @80,63,-54
nearby entities:
  #3 SSk1tz @81,64,-57
follow_target: (none)
owner SSk1tz: @81,64,-57 (3 blocks away)`

const SNAP_B = `snapshot: pos: 78,65,-57
biome: plains  surroundings: outside  time: day (11224)
hp: 20/20  food: 20/20  xp: lvl 0
holding: dirt
inventory (4/36 slots): dirt×3 oak_log×10 oak_sapling×2
terrain at feet: 25 grass_block
nearby blocks:
  #1 grass_block x520 @78,63,-58
  #2 dirt x2 @78,63,-56
nearby entities:
  #3 SSk1tz @83,64,-57
follow_target: (none)
owner SSk1tz: @83,64,-57 (5 blocks away)
last_action_result: gathered 2/3 oak_log`

const SNAP_C = `snapshot: pos: 120,64,30
biome: plains  surroundings: outside  time: day (3000)
hp: 20/20  food: 20/20  xp: lvl 0
holding: (empty)
inventory (2/36 slots): oak_log×6 dirt×4
terrain at feet: 25 grass_block, 8 short_grass
nearby blocks:
  #1 oak_log x8 @118,65,28
  #2 stone x40 @122,60,33
nearby entities:
  #3 SSk1tz @126,64,35
follow_target: (none)
owner SSk1tz: @126,64,35 (8 blocks away)`

// 260615: the exact failing state from the play log — Sui spawned with logs +
// dirt and NO pickaxe, then set "mine down to y:12 and collect diamonds". This
// is the realism anchor: a good goal here is wood/stone-tools/food/shelter, NOT
// mining (you can't mine stone without a pickaxe).
const SNAP_NOTOOL = `snapshot: pos: 64,70,-12
biome: forest  surroundings: outside  time: day (1200)
hp: 20/20  food: 18/20  xp: lvl 0
holding: oak_log
inventory (2/36 slots): oak_log×8 dirt×1
terrain at feet: 20 grass_block, 6 oak_leaves
nearby blocks:
  #1 oak_log x12 @62,71,-14
  #2 stone x60 @66,66,-15
nearby entities:
  #3 SSk1tz @67,70,-15
follow_target: (none)
owner SSk1tz: @67,70,-15 (4 blocks away)`

// Already-satisfied standing order: ten logs are in the bag and a statue line
// is in nearby blocks → expect clearGoal, not a re-pursuit.
const SNAP_GOAL_DONE = `snapshot: pos: 78,65,-57
biome: plains  surroundings: outside  time: day (11224)
hp: 20/20  food: 20/20  xp: lvl 0
holding: cobblestone
inventory (5/36 slots): oak_log×12 dirt×3 cobblestone×40
terrain at feet: 25 grass_block
nearby blocks:
  #1 cobblestone x30 @78,65,-56 (the statue)
  #2 grass_block x520 @78,63,-58
nearby entities:
  #3 SSk1tz @83,64,-57
follow_target: (none)
owner SSk1tz: @83,64,-57 (5 blocks away)
last_action_result: built statue`

// 260616: the loop-1 SPAWN state from the play log (Sui, driven, no goal yet):
// plains, oak_log×8 + dirt, player ~29 blocks off. The failure was THREE
// narration messages ("i'm in a plains biome with some logs and dirt" /
// "ouen's off to the side" / "let me start a real project ..."). Assert the
// emitted chat is ONE short line or empty — never multi-sentence snapshot
// narration — and ≤2 non-fragment messages after split.
const SNAP_SPAWN = `snapshot: pos: 100,68,40
biome: plains  surroundings: outside  time: day (1000)
hp: 20/20  food: 20/20  xp: lvl 0
holding: oak_log
inventory (2/36 slots): oak_log×8 dirt×3
terrain at feet: 22 grass_block, 9 short_grass
nearby blocks:
  #1 oak_log x6 @103,69,42
  #2 dirt x4 @100,67,39
nearby entities:
  #3 SSk1tz @122,66,58
follow_target: (none)
owner SSk1tz: @122,66,58 (29 blocks away)`

// 260616 (log bbf5b66f ...03-37): the EXACT failing loop-1 spawn — Sui, driven,
// no goal, EMPTY inventory (no wood at all), plains with NO logs in nearby blocks
// (nearest tree is ~40m off, off-snapshot), player ~19 blocks away. This single
// state reproduces all four reported bugs at once:
//   1 spam   — model emitted 2-3 sentences/turn → 2-3 separate chat pings
//   2 leak   — "ouen's right here" (3rd person real name) + "wood's at 41,111,-4" (coords)
//   3 follow — "gotta catch up first" + follow(), though Sui is independent
//   4 halluc — "lemme just punch these trees around us" with NO trees in snapshot
const SNAP_LOG_SPAWN = `snapshot: pos: -3,109,2
biome: plains  surroundings: outside  time: day (3819)
hp: 20/20  food: 20/20  xp: lvl 0
holding: nothing
inventory (0/36 slots): empty
terrain at feet: 13 dirt, 13 grass_block, 3 stone
nearby blocks:
  #1 grass_block x261 @-4,108,1
  #2 dirt x115 @-3,109,0
  #3 short_grass x26 @-1,111,1
  #4 stone x20 @-8,101,1
  #5 gravel x1 @-3,97,7
nearby entities:
  #6 SSk1tz @1,116,-15
  #7 cow @16,113,4
  #8 sheep @-7,116,-21
  #9 pig @15,115,-12
follow_target: (none)
owner SSk1tz: @1,116,-15 (19 blocks away)`

const MULTI_GOAL = [
  '- [2026-06-13T23:16:54.000Z] standing order: gather wood until ten logs then build a statue',
  '- [2026-06-14T10:00:00.000Z] build a stone base by the river, walls + roof + door',
].join('\n')

// ── Scenario matrix ──────────────────────────────────────────────────────────
// Core narrative scenarios (kept from the original probe) ...
const NARRATIVE = [
  {
    id: 'A',
    title: 'Marv — silent action-tick mid-gather (tone: must NOT leak telemetry)',
    persona: MARV,
    memory: MARV_MEMORY,
    heartbeat: MARV_STANDING_ORDER,
    eventText: NUDGES.actionTurn({ action: 'gather oak_log', stopTool: 'end_loop', elapsedSec: 20 }),
    snapshot: SNAP_A,
    expect: 'empty text OR one short human line; no "(gather 2/5 ... staying silent)".',
    kind: 'tone',
  },
  {
    id: 'TONE-WAIT',
    title: 'Sui mid-dig, player says "wait for me" (intent: HOLD, do NOT follow/come)',
    persona: SUI,
    memory: '',
    heartbeat: '',
    eventText: NUDGES.actionTurn({ action: 'dig', stopTool: 'end_loop', playerLine: 'wait for me', who: 'Ouen' }),
    snapshot: SNAP_C,
    expect: 'holds / keeps digging in place; does NOT call follow or path to the player.',
    kind: 'intent-hold',
  },
  {
    id: 'TONE-GO',
    title: 'Sui following, player says "ok lets go" (tone: in-character, NOT "got it" filler)',
    persona: SUI,
    memory: '',
    heartbeat: '',
    eventText: NUDGES.actionTurn({ action: 'follow SSk1tz', stopTool: 'unfollow', playerLine: 'ok lets go', who: 'Ouen' }),
    snapshot: SNAP_C,
    expect: 'in-character reply or silent action; no assistant filler ("got it", "sure", "on it").',
    kind: 'no-filler',
  },
  {
    id: 'B',
    title: 'Marv — loop_end at 10 logs (execution: must continue to BUILD, not stall)',
    persona: MARV,
    memory: MARV_MEMORY,
    heartbeat: MARV_STANDING_ORDER,
    eventText: eventAddendum('sei:loop_end'),
    snapshot: SNAP_B,
    expect: 'starts the statue (build / placeBlock), not follow + wait.',
    kind: 'execution',
  },
  {
    id: 'C',
    title: 'Sui — idle, no orders (agentic/level 2: SET a REALISTIC big goal + first action)',
    persona: SUI,
    memory: '',
    heartbeat: '',
    eventText: eventAddendum('sei:idle'),
    snapshot: SNAP_C,
    expect: 'setGoal with a multi-step project STARTABLE from inventory + a concrete first action.',
    kind: 'realism',
  },
]

// Edge cases that target the bugs this task fixes.
const EDGE = [
  {
    id: 'LOG-SPAWN',
    title: 'Sui driven spawn, empty inv, no nearby trees, player 19m off (the 03-37 log) — all 4 bugs',
    persona: withLevel(SUI, 2),
    memory: '',
    heartbeat: '',
    eventText: eventAddendum('sei:idle'),
    snapshot: SNAP_LOG_SPAWN,
    expect: '≤1-2 short msgs, NO coords, NO "ouen\'s X" 3rd person, NO follow(), NO "punch these trees" (none in snapshot).',
    kind: 'spawn-clean',
  },
  {
    id: 'STUCK-UNREACHABLE',
    title: 'Sui has a base goal, goTo to far wood just timed out unreachable, no wood nearby (the 04-27 freeze)',
    persona: withLevel(SUI, 2),
    memory: '',
    heartbeat: '- [2026-06-16T00:33:09.333Z] build a complete base with walls, roof, and door; finish when it is a shelter i can sleep in',
    eventText: eventAddendum('sei:loop_end'),
    snapshot: `snapshot: pos: -2,109,1
biome: plains  surroundings: outside  time: night (17179)
hp: 20/20  food: 20/20  xp: lvl 0
holding: nothing
inventory (0/36 slots): empty
terrain at feet: 20 dirt, 15 grass_block, 6 stone
nearby blocks:
  #1 grass_block x264 @-2,109,1
  #2 dirt x112 @-3,109,0
  #3 short_grass x27 @-1,111,1
  #4 stone x16 @-8,101,1
nearby entities:
  #6 sheep @16,113,5
  #7 cow @29,110,15
  #11 SSk1tz @31,112,9
follow_target: (none)
owner SSk1tz: @31,112,9 (34 blocks away)
last_action_result: timeout — unreachable — try build to Y=112`,
    expect: 'recovers by explore / look / find (a new approach to the far wood) — does NOT just end_loop and freeze, does NOT follow the player.',
    kind: 'recover',
  },
  {
    id: 'LOG-ACTIONTICK',
    title: 'Sui mid-goTo, player adjacent, no goal, no nearby trees (log line 319) — the worst spam line',
    persona: withLevel(SUI, 2),
    memory: '',
    heartbeat: '',
    eventText: NUDGES.actionTurn({ action: 'goTo', stopTool: 'end_loop', elapsedSec: 10 }),
    snapshot: `snapshot: pos: -2,109,2
biome: plains  surroundings: outside  time: day (4399)
hp: 20/20  food: 20/20  xp: lvl 0
holding: nothing
in_flight: goTo(@41,111,-4) started=10.0s ago
inventory (0/36 slots): empty
terrain at feet: 20 dirt, 15 grass_block, 6 stone, 1 short_grass
nearby blocks:
  #1 grass_block x264 @-2,109,1
  #2 dirt x112 @-1,108,2
  #3 short_grass x27 @-1,111,1
  #4 stone x16 @-8,101,1
  #5 gravel x1 @-3,97,7
nearby entities:
  #6 SSk1tz @-1,108,4
  #7 pig @1,116,-6
  #8 cow @20,112,8
follow_target: (none)
owner SSk1tz: @-1,108,4 (2 blocks away)
last_action_result: {"found":true,"id":"cherry_log","pos":{"x":41,"y":111,"z":-4},"distance":43.7}`,
    expect: 'silent (empty) — NO coords, NO "ouen\'s right here", NO "punch these trees", NO multi-sentence monologue.',
    kind: 'spawn-clean',
  },
  {
    id: 'SPAWN-NARR',
    title: 'Sui idle SPAWN, no goal (the loop-1 state) — chat must NOT narrate the snapshot',
    persona: withLevel(SUI, 2),
    memory: '',
    heartbeat: '',
    eventText: eventAddendum('sei:idle'),
    snapshot: SNAP_SPAWN,
    expect: 'emitted chat is ONE short line or empty (a boast, not snapshot narration); ≤2 non-fragment messages; NO "i\'m in a plains biome" / "ouen\'s off to the side".',
    kind: 'chat-discipline',
  },
  {
    id: 'TICK-SILENT',
    title: 'Routine mid-action tick (Sui mid-gather) — emitted chat must be empty/silent',
    persona: withLevel(SUI, 2),
    memory: '',
    heartbeat: '- [2026-06-14T10:00:00.000Z] gather wood until ten logs then build a base',
    eventText: NUDGES.actionTurn({ action: 'gather oak_log', stopTool: 'end_loop', elapsedSec: 15 }),
    snapshot: SNAP_A,
    expect: 'empty/silent — no step narration ("let me get more logs", "almost there"), no progress count.',
    kind: 'chat-discipline-silent',
  },
  {
    id: 'FOLLOW-TICK',
    title: 'Agentic char mid-follow, 10s tick, goal waiting — should PEEL OFF to the goal, not silently trail',
    persona: withLevel(SUI, 2),
    memory: '',
    heartbeat: '- [2026-06-14T10:00:00.000Z] build a complete base with walls, roof, and door; finish when it is a shelter i can sleep in',
    eventText: NUDGES.actionTurn({ action: 'follow SSk1tz', stopTool: 'unfollow', elapsedSec: 10 }),
    snapshot: SNAP_C,
    expect: 'peels off to advance the base goal (gather/dig/build/goTo to a work site or unfollow), not silently trailing.',
    kind: 'execution',
  },
  {
    id: 'TICK-GATHER-STAY',
    title: 'Agentic char mid-gather (gather DOES serve the goal), 10s tick — must stay silent, NOT thrash/peel',
    persona: withLevel(SUI, 2),
    memory: '',
    heartbeat: '- [2026-06-14T10:00:00.000Z] gather wood until ten logs then build a base',
    eventText: NUDGES.actionTurn({ action: 'gather oak_log', stopTool: 'end_loop', elapsedSec: 12 }),
    snapshot: SNAP_A,
    expect: 'empty/silent, keeps gathering (gather already advances the goal — should NOT switch actions or narrate).',
    kind: 'chat-discipline-silent',
  },
  {
    id: 'FOLLOW-DRIFT',
    title: 'Sui drifted from player mid-task (the loop-4 bug) — must NOT follow, should re-find the task',
    persona: withLevel(SUI, 2),
    memory: '',
    heartbeat: '- [2026-06-14T10:00:00.000Z] build a complete base with walls, roof, and door; finish when it is a shelter i can sleep in',
    eventText: eventAddendum('sei:idle'),
    snapshot: `snapshot: pos: 33,69,-45
biome: sparse_jungle  surroundings: outside  time: day (4315)
hp: 20/20  food: 20/20  xp: lvl 0
holding: oak_log
inventory (3/36 slots): oak_log×8 dirt×6 oak_sapling×1
terrain at feet: 24 grass_block, 16 oak_leaves, 1 jungle_log
nearby blocks:
  #1 jungle_log x1 @31,69,-46
  #2 oak_leaves x56 @33,69,-47
nearby entities:
  #3 SSk1tz @37,69,-40
follow_target: (none)
owner SSk1tz: @37,69,-40 (7 blocks away)
last_action_result: out of range (18.8m, need ≤4.5) for oak_log @16,71,-54`,
    expect: 'gathers/finds wood or advances the base goal; does NOT call follow and does NOT apologize for "wandering off".',
    kind: 'execution',
  },
  {
    id: 'NOTOOL',
    title: 'No-tool early game (the log) — must NOT set a mining/diamond goal',
    persona: withLevel(SUI, 2),
    memory: '',
    heartbeat: '',
    eventText: eventAddendum('sei:idle'),
    snapshot: SNAP_NOTOOL,
    expect: 'setGoal for wood/stone-tools/food/shelter; NO "mine"/"diamond" goal (no pickaxe).',
    kind: 'realism',
  },
  {
    id: 'RESUME',
    title: 'Active goal + idle tick — must RESUME the goal, not drift to follow',
    persona: withLevel(LYRA, 1),
    memory: '',
    heartbeat: '- [2026-06-14T10:00:00.000Z] build a stone base by the river, walls + roof + door',
    eventText: eventAddendum('sei:idle'),
    snapshot: SNAP_C,
    expect: 'advances the base goal (build/dig/gather), does not just follow the player.',
    kind: 'execution',
  },
  {
    id: 'RESUME2',
    title: 'Active goal + idle tick @ level 2 — must RESUME the goal, not drift to follow',
    persona: withLevel(LYRA, 2),
    memory: '',
    heartbeat: '- [2026-06-14T10:00:00.000Z] build a stone base by the river, walls + roof + door',
    eventText: eventAddendum('sei:idle'),
    snapshot: SNAP_C,
    expect: 'advances the base goal (build/dig/gather), does not just follow the player.',
    kind: 'execution',
  },
  {
    id: 'RESUME3',
    title: 'Active goal + idle tick @ agentic/level 2 (the reported Sui bug) — must RESUME, not follow',
    persona: withLevel(SUI, 2),
    memory: '',
    heartbeat: '- [2026-06-14T10:00:00.000Z] build a wooden base, walls + roof + door, then start a mine',
    eventText: eventAddendum('sei:idle'),
    snapshot: SNAP_C,
    expect: 'advances the base goal (build/dig/gather/setGoal step), does NOT just follow the player.',
    kind: 'execution',
  },
  {
    id: 'MULTI',
    title: 'Multiple active goals — pick one and advance it',
    persona: withLevel(SUI, 2),
    memory: '',
    heartbeat: MULTI_GOAL,
    eventText: eventAddendum('sei:loop_end'),
    snapshot: SNAP_B,
    expect: 'advances ONE of the two goals; does not stall or ask "what next?".',
    kind: 'execution',
  },
  {
    id: 'DONE',
    title: 'Goal already satisfied — expect clearGoal',
    persona: withLevel(MARV, 0),
    memory: MARV_MEMORY,
    heartbeat: MARV_STANDING_ORDER,
    eventText: eventAddendum('sei:loop_end'),
    snapshot: SNAP_GOAL_DONE,
    expect: 'clearGoal (finish condition met: ten logs + statue exists).',
    kind: 'cleanup',
  },
  {
    id: 'PASSIVE-NOGOAL',
    title: 'Passive (level 0) idle, no goal — must NOT invent a project',
    persona: withLevel(MARV, 0),
    memory: '',
    heartbeat: '',
    eventText: eventAddendum('sei:idle'),
    snapshot: SNAP_C,
    expect: 'no setGoal, no new project; silence or one weary line.',
    kind: 'passivity',
  },
]

// Persona × level sweep on the no-tool early-game state (the realism stressor).
const SWEEP = []
for (const [pname, persona] of Object.entries(BASE_PERSONAS)) {
  for (const level of [0, 1, 2]) {
    SWEEP.push({
      id: `SWEEP-${pname}-${level}`,
      title: `${pname} @ level ${level} — idle, no-tool early game`,
      persona: withLevel(persona, level),
      memory: '',
      heartbeat: '',
      eventText: eventAddendum('sei:idle'),
      snapshot: SNAP_NOTOOL,
      expect: level === 0
        ? 'no setGoal (passive invents nothing); silence or one comment.'
        : level === 1
          ? 'no own setGoal; a comment or an in-character offer to help, no project of its own.'
          : 'a REALISTIC startable goal (wood/stone-tools/food/shelter), NOT diamonds/mining.',
      kind: level === 2 ? 'realism' : (level === 0 ? 'passivity' : 'reactive'),
    })
  }
}

const SCENARIOS = [...NARRATIVE, ...EDGE, ...SWEEP]

// ── Heuristic evaluator ──────────────────────────────────────────────────────
// Best-effort pass/fail. Inputs: scenario, model text, tool calls. Returns
// { verdict: 'PASS'|'FAIL'|'WARN', notes: [] }. Intentionally conservative —
// it flags the clear failures (mining with no pickaxe, passive inventing a
// project, satisfied goal not cleared) and otherwise WARNs for human review.
function hasNoPickaxe(snapshot) {
  return /inventory[^\n]*/i.test(snapshot) && !/pickaxe/i.test(snapshot)
}
function evaluate(s, text, tools, messages = []) {
  const notes = []
  const names = tools.map(t => t.name)
  const setGoal = tools.find(t => t.name === 'setGoal')
  const goalText = (setGoal?.input?.text ?? '').toLowerCase()
  const noPick = hasNoPickaxe(s.snapshot)
  const miningGoal = /\b(mine|mining|dig down|diamond|iron ore|underground)\b/.test(goalText)
  // A goal that ACQUIRES the prerequisite tool first (craft/make a pickaxe,
  // gather wood→stone tools) is realistic progression, not the log bug — only
  // a goal that jumps STRAIGHT to mining with no tool-acquisition step fails.
  // 260616: the bot CAN'T craft — it now correctly DELEGATES tools to the player
  // ("ask ouen for a pickaxe"). So acquiring a tool counts whether it's crafted
  // OR requested from the player; only a mining goal with no tool-acquisition
  // step at all is the bug.
  const acquiresTool = /\b(craft|make|build|ask|request|get|grab|demand|have|need)\b[^.]{0,45}\b(pickaxe|pick|tools?|crafting table|axe)\b|\b(wood|stone)\b.{0,20}\b(tools?|pickaxe)\b/.test(goalText)

  // Realism gate: no pickaxe + a mining/diamond goal that does NOT first acquire
  // a pickaxe = hard fail (the original log bug: "mine down to diamonds" cold).
  if (noPick && miningGoal && !acquiresTool) {
    notes.push('FAIL: jumps straight to mining/diamonds with no pickaxe and no tool-crafting step')
    return { verdict: 'FAIL', notes }
  }
  if (noPick && miningGoal && acquiresTool) {
    notes.push('note: mining goal but correctly crafts the pickaxe first (valid progression)')
  }
  // Snapshot-narration shapes the chat must NEVER contain (issue #1).
  const narrationMarkers = [
    /\bbiome\b/, /off to (the|one) side/, /\bwandered off\b/, /got cut off/,
    /^let me /, /^lemme /, /^i'?m (gonna|going to)/, /^need to /, /^looking at/,
  ]
  switch (s.kind) {
    case 'recover': {
      // After an unreachable goTo, the bot must try a NEW way to the target, not
      // freeze or fall back to following the player.
      const recovers = names.some((n) => ['explore', 'look', 'find', 'goTo', 'gather', 'dig'].includes(n))
      if (names.includes('follow')) { notes.push('FAIL: fell back to follow instead of recovering the goal'); return { verdict: 'FAIL', notes } }
      if (names.length === 0 || (names.length === 1 && names[0] === 'end_loop')) {
        notes.push('FAIL: froze (end_loop / no action) after unreachable goTo'); return { verdict: 'FAIL', notes }
      }
      if (recovers) {
        const used = names.filter((n) => ['explore', 'look', 'find', 'goTo', 'gather', 'dig'].includes(n))
        notes.push(`recovered via ${used.join(',')}`)
        return { verdict: 'PASS', notes }
      }
      notes.push(`WARN: non-freeze but unclear recovery: ${names.join(',')}`); return { verdict: 'WARN', notes }
    }
    case 'spawn-clean': {
      // The 03-37 log state — assert all four fixes at once.
      const t = (text || '').toLowerCase()
      const fails = []
      // 1 spam: >2 chat pings from one turn is the splitter-spam failure.
      if (messages.length > 2) fails.push(`${messages.length} msgs (>2) — spam`)
      // 2a coords: any x,y,z triple read into chat.
      if (/-?\d+\s*,\s*-?\d+\s*,\s*-?\d+/.test(t)) fails.push('coords leaked into chat')
      // 2b 3rd person: the player's real name as a subject ("ouen's right here").
      if (/\bouen'?s\b/.test(t) || /\bssk1tz'?s\b/.test(t)) fails.push('3rd-person real-name subject')
      // 3 follow: Sui is independent — closing distance to the player is the bug.
      if (names.includes('follow')) fails.push('follow() — Sui is independent, should not chase')
      // 4 hallucinated nearby resource (no logs anywhere in the snapshot).
      if (/(these|the)\s+trees?\s+(around|right here|here|near)|trees?\s+around us|wood'?s?\s+(right\s+)?here|punch these/.test(t)) {
        fails.push('claims trees/wood are right here (none in snapshot)')
      }
      if (narrationMarkers.some(re => re.test(t))) fails.push('scene/procedure narration')
      if (fails.length) { notes.push('FAIL: ' + fails.join('; ')); return { verdict: 'FAIL', notes } }
      notes.push(messages.length === 0
        ? 'clean: silent or pure action'
        : `clean: ${JSON.stringify(messages)}${names.length ? ' + ' + names.join(',') : ''}`)
      return { verdict: 'PASS', notes }
    }
    case 'chat-discipline': {
      // After postProcessSay + splitChatMessages, chat must be empty OR one
      // short line — never multi-sentence snapshot narration.
      const t = (text || '').toLowerCase()
      const narrates = narrationMarkers.some(re => re.test(t))
      if (messages.length > 2) { notes.push(`FAIL: ${messages.length} messages (>2) — splitter spam`); return { verdict: 'FAIL', notes } }
      if (narrates) { notes.push('FAIL: chat narrates the snapshot/procedure'); return { verdict: 'FAIL', notes } }
      notes.push(messages.length === 0 ? 'silent (or filtered)' : `one short line: ${JSON.stringify(messages)}`)
      return { verdict: 'PASS', notes }
    }
    case 'chat-discipline-silent': {
      // A routine mid-action tick: emitted chat should be empty/silent.
      if (messages.length === 0) { notes.push('silent on routine tick, as expected'); return { verdict: 'PASS', notes } }
      const t = (text || '').toLowerCase()
      if (narrationMarkers.some(re => re.test(t))) { notes.push(`FAIL: narrated on routine tick: ${JSON.stringify(messages)}`); return { verdict: 'FAIL', notes } }
      notes.push(`WARN: spoke on a routine tick (allowed only at a milestone): ${JSON.stringify(messages)}`)
      return { verdict: 'WARN', notes }
    }
    case 'passivity':
      if (names.includes('setGoal')) { notes.push('FAIL: passive level set a goal'); return { verdict: 'FAIL', notes } }
      return { verdict: 'PASS', notes: ['no goal set, as expected for passive'] }
    case 'cleanup':
      if (names.includes('clearGoal')) return { verdict: 'PASS', notes: ['cleared the satisfied goal'] }
      notes.push('WARN: expected clearGoal on a satisfied goal'); return { verdict: 'WARN', notes }
    case 'intent-hold':
      if (names.includes('follow')) { notes.push('FAIL: called follow on "wait for me" (player is coming to you — should hold)'); return { verdict: 'FAIL', notes } }
      notes.push('held / did not path to player'); return { verdict: 'PASS', notes }
    case 'no-filler': {
      const t = (text || '').toLowerCase()
      const banned = ['got it', 'sure thing', 'on it', 'will do', 'sounds good', 'no problem', 'understood', 'happy to', 'as you wish']
      const hit = banned.find(b => t.startsWith(b) || t.includes(`. ${b}`) || t.includes(`"${b}`))
      if (hit) { notes.push(`FAIL: assistant filler "${hit}" in reply`); return { verdict: 'FAIL', notes } }
      notes.push('no assistant filler'); return { verdict: 'PASS', notes }
    }
    case 'realism':
      if (!names.includes('setGoal')) { notes.push('WARN: expected a setGoal'); return { verdict: 'WARN', notes } }
      notes.push(`goal: "${goalText}"`)
      return { verdict: 'PASS', notes }
    case 'execution': {
      const moved = names.some(n => ['build', 'dig', 'gather', 'placeBlock', 'goTo', 'find'].includes(n))
      const followedOnly = names.length > 0 && names.every(n => n === 'follow' || n === 'unfollow')
      if (followedOnly) { notes.push('FAIL: drifted to follow instead of advancing the goal'); return { verdict: 'FAIL', notes } }
      if (moved) return { verdict: 'PASS', notes: ['advanced the goal'] }
      notes.push('WARN: no concrete goal-advancing action'); return { verdict: 'WARN', notes }
    }
    default:
      return { verdict: 'WARN', notes: ['no automatic verdict — review manually'] }
  }
}

// ── Runner ───────────────────────────────────────────────────────────────────
async function runScenario(s, dir) {
  const memPath = join(dir, `${s.id}-MEMORY.md`)
  const hbPath = join(dir, `${s.id}-HEARTBEAT.md`)
  await writeFile(memPath, s.memory ? `# Memory\n\n${s.memory}\n` : '')
  await writeFile(hbPath, s.heartbeat ? `# Heartbeat\n\n${s.heartbeat}\n` : '')

  const config = {
    persona: { proactiveness: s.persona.proactiveness },
    memory: {
      memory_md_path: memPath,
      heartbeat_md_path: hbPath,
      seed_memory_budget_bytes: 8192,
      seed_heartbeat_budget_bytes: 2048,
    },
  }
  const seedBlocks = await composeSeedBlocks({
    sessionState: { playerData: () => ({ username: 'SSk1tz', preferred_name: 'Ouen' }) },
    playerStore: { formatPlayerSeedBlock: () => PLAYER_SEED },
    config,
    eventText: s.eventText,
    snapshotText: s.snapshot,
    adapter: { cuboidGrammar: () => CUBOID_GRAMMAR },
    logger: console,
  })
  const userContent = seedBlocks.map((b) => ({ type: 'text', text: b.text }))
  const assembledSeed = userContent.map(b => b.text).join('\n\n')

  // Offline validation of prompt assembly — always runs, key or no key.
  const offline = { ok: true, problems: [] }
  if (!/# HEARTBEAT/.test(assembledSeed)) { offline.ok = false; offline.problems.push('no # HEARTBEAT block in seed') }
  if (s.heartbeat && !assembledSeed.includes(s.heartbeat.split(']').pop().trim().slice(0, 12))) {
    offline.problems.push('seeded goal text not found in assembled seed (check budget/format)')
  }

  console.log(`\n${'═'.repeat(78)}`)
  console.log(`SCENARIO ${s.id}: ${s.title}`)
  console.log(`  proactiveness=${s.persona.proactiveness}  thinking=${THINKING > 0 ? THINKING : 'off'}`)
  console.log(`  EXPECT: ${s.expect}`)
  console.log('─'.repeat(78))
  console.log(`  offline asm: ${offline.ok ? 'OK' : 'PROBLEM'}${offline.problems.length ? ' — ' + offline.problems.join('; ') : ''}`)

  if (!LIVE) {
    console.log('  live       : LIVE EVAL PENDING KEY (set ANTHROPIC_API_KEY to run the model)')
    return { id: s.id, verdict: offline.ok ? 'OFFLINE-OK' : 'OFFLINE-FAIL' }
  }

  const req = {
    model: MODEL,
    max_tokens: THINKING > 0 ? THINKING + 1024 : 1024,
    system: systemBlocks(s.persona),
    tools: TOOLS,
    messages: [{ role: 'user', content: userContent }],
  }
  if (THINKING > 0) req.thinking = { type: 'enabled', budget_tokens: THINKING }

  const resp = await client.messages.create(req)
  let text = ''
  let thinking = false
  const tools = []
  for (const block of resp.content ?? []) {
    if (block.type === 'text') text += block.text
    else if (block.type === 'tool_use') tools.push({ name: block.name, input: block.input })
    else if (block.type === 'thinking' || block.type === 'redacted_thinking') thinking = true
  }
  const chatLine = postProcessSay(text)
  const messages = splitChatMessages(chatLine)
  const hasDash = /[—–]/.test(text)
  const ev = evaluate(s, text, tools, messages)

  console.log(`  raw text   : ${JSON.stringify(text)}`)
  if (messages.length === 0) {
    console.log('  → messages : (silence — filtered/empty)')
  } else {
    messages.forEach((m, i) => console.log(`  → msg ${i + 1}     : ${JSON.stringify(m)}`))
  }
  if (hasDash) console.log('  ⚠ raw text contained an em/en-dash (split breaks on it; prompt should prevent it)')
  console.log(`  tool calls : ${tools.length ? tools.map((t) => `${t.name}(${JSON.stringify(t.input)})`).join('  ') : '(none)'}`)
  console.log(`  thinking   : ${thinking ? 'yes (private)' : 'no'}`)
  console.log(`  VERDICT    : ${ev.verdict}${ev.notes.length ? ' — ' + ev.notes.join('; ') : ''}`)
  return { id: s.id, verdict: ev.verdict }
}

async function main() {
  if (!LIVE) {
    console.log('▶ probe-brain MATRIX (OFFLINE mode — no ANTHROPIC_API_KEY)')
    console.log('  Validates prompt assembly only. To run the live model:')
    console.log('  ANTHROPIC_API_KEY=<key> node scripts/probe-brain.mjs            # full matrix')
    console.log('  ANTHROPIC_API_KEY=<key> node scripts/probe-brain.mjs --only NOTOOL\n')
  }
  const dir = await mkdtemp(join(tmpdir(), 'sei-probe-'))
  const results = []
  try {
    for (const s of SCENARIOS) {
      if (ONLY && s.id !== ONLY) continue
      results.push(await runScenario(s, dir))
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
  // Summary roll-up
  console.log(`\n${'═'.repeat(78)}\nSUMMARY (${results.length} scenarios)`)
  const counts = results.reduce((a, r) => (a[r.verdict] = (a[r.verdict] ?? 0) + 1, a), {})
  console.log('  ' + Object.entries(counts).map(([k, v]) => `${k}=${v}`).join('  '))
  const fails = results.filter(r => r.verdict === 'FAIL' || r.verdict === 'OFFLINE-FAIL')
  if (fails.length) console.log('  FAILED: ' + fails.map(r => r.id).join(', '))
  console.log('done.')
}
main().catch((e) => { console.error(e); process.exit(1) })
