#!/usr/bin/env node
/**
 * scripts/verify-group-call.mjs — two-brain group-call verification (260708).
 *
 * Replays the failure beats of the 2026-07-08T06-28 session (playlogs
 * 25770cd6 = Marv, bbf5b66f = Sui: both bots in-game while the player talked
 * over a live voice call) against the NEW group-voice delivery:
 *
 *   - every in-game bot receives every utterance (broadcast, no pickResponder)
 *   - the prompt carries the group-addressing framing (voiceGroupGuidance +
 *     the voice-aware playerMessageText / NUDGES.actionTurn variants), not the
 *     old "messaged you through Sei chat / NOT in the game" wrapper
 *   - names arrive GARBLED exactly as the session's STT produced them
 *     ("My bar" = Marv, "sweet"/"swing" = Sui)
 *
 * Both bots are prompted IN PARALLEL per beat (Promise.all), with per-bot
 * snapshots reconstructed from the logs; one beat mixes a voice line for Sui
 * with a simultaneous sei:attacked game event for Marv. Personas are the LIVE
 * expanded ones from the dev profile store (falls back to --sui/--marv paths).
 *
 * Usage:
 *   node scripts/verify-group-call.mjs               # 3 runs per beat
 *   node scripts/verify-group-call.mjs --runs 5
 *   node scripts/verify-group-call.mjs --show-prompt # dump beat prompts once
 */
import Anthropic from '@anthropic-ai/sdk'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  BASELINE_INSTRUCTIONS,
  PERSONALITY_TOOL_DESCRIPTIONS,
  NUDGES,
  renderPersona,
  voiceGroupGuidance,
} from '../src/bot/brain/prompts.js'
import {
  CAPABILITY_PARAGRAPH,
  WORLD_PRIMER,
  ACTION_RULES,
  ACTION_DESCRIPTIONS,
  eventAddendum,
} from '../src/bot/adapter/minecraft/prompts.js'
import { composeSeedBlocks, postProcessSay } from '../src/bot/brain/orchestrator.js'

const MODEL = 'claude-haiku-4-5'
const argv = process.argv.slice(2)
const flag = (name, def = null) => {
  const i = argv.indexOf(name)
  return i >= 0 ? (argv[i + 1] ?? true) : def
}
const RUNS = Number(flag('--runs', 3)) || 3
const SHOW_PROMPT = argv.includes('--show-prompt')
const ONLY = flag('--only', null)
// --dry: assemble both bots' prompts for every beat and assert the framing
// invariants WITHOUT calling the model (works with no API key). The live run
// additionally grades the models' addressing decisions.
const DRY = argv.includes('--dry')

function resolveApiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY
  try {
    return readFileSync(join(process.env.HOME || '', '.sei-dev', 'anthropic-test-key'), 'utf8').trim() || undefined
  } catch { return undefined }
}
const apiKey = resolveApiKey()
if (!apiKey && !DRY) {
  console.error('No API key (ANTHROPIC_API_KEY or ~/.sei-dev/anthropic-test-key). Run with --dry for offline framing checks.')
  process.exit(1)
}
const client = apiKey ? new Anthropic({ apiKey }) : null

// ── Personas: live expanded personas from the dev profile store ─────────────
const PROFILE_DIR = flag(
  '--profile-dir',
  join(process.env.HOME || '', 'Library/Application Support/Sei Dev/profiles/571634bd-0f6d-4835-bef2-06fd7f449a3d'),
)
const CHAR_FILES = { Marv: '25770cd6-a50b-409d-a7e2-6cc2026dd673.json', Sui: 'bbf5b66f-2f0f-4918-a953-a2cf66d5a586.json' }
function loadPersona(name) {
  const override = flag(`--${name.toLowerCase()}`)
  const path = override || join(PROFILE_DIR, 'characters', CHAR_FILES[name])
  const c = JSON.parse(readFileSync(path, 'utf8'))
  return {
    name: c.username ?? c.name,
    expanded: c.persona.expanded || c.persona.source,
    proactiveness: c.metadata?.proactiveness ?? 1,
  }
}
const PERSONAS = { Marv: loadPersona('Marv'), Sui: loadPersona('Sui') }

// ── Tools (mirrors probe-brain, plus say) ────────────────────────────────────
const personalityTools = [
  { name: 'say', description: PERSONALITY_TOOL_DESCRIPTIONS.say, input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'remember', description: PERSONALITY_TOOL_DESCRIPTIONS.remember, input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'setGoal', description: PERSONALITY_TOOL_DESCRIPTIONS.setGoal, input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'end_loop', description: PERSONALITY_TOOL_DESCRIPTIONS.end_loop, input_schema: { type: 'object', properties: {}, additionalProperties: false } },
]
const MOVEMENT_SCHEMAS = {
  goTo: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, range: { type: 'number' } },
  explore: { orientation: { type: 'string' }, blocks: { type: 'number' } },
  gather: { name: { type: 'string' } },
  craft: { item: { type: 'string' }, count: { type: 'number' } },
  equip: { item: { type: 'string' } },
  attackEntity: { entity: { type: 'string' }, target: { type: 'string' }, times: { type: 'number' } },
  follow: { player: { type: 'string' } },
  unfollow: {},
  dropItem: { item: { type: 'string' }, count: { type: 'number' } },
  find: { name: { type: 'string' } },
}
const movementTools = Object.entries(MOVEMENT_SCHEMAS).map(([name, props]) => ({
  name,
  description: ACTION_DESCRIPTIONS[name] ?? `Action: ${name}`,
  input_schema: { type: 'object', properties: props, additionalProperties: true },
}))
const TOOLS = [...personalityTools, ...movementTools]

function systemBlocks(persona) {
  return [BASELINE_INSTRUCTIONS, renderPersona(persona), CAPABILITY_PARAGRAPH, WORLD_PRIMER, ACTION_RULES]
    .map((text) => ({ type: 'text', text }))
}

// ── World state at ~06:38 in the session (from the playlogs) ─────────────────
const SNAP = {
  Marv: `snapshot: pos: -95,62,-64
biome: river  surroundings: in water  time: night (18234)
hp: 18/20  food: 17/20
holding: wooden_sword
inventory (4/36 slots): wooden_sword×1 oak_planks×4 stick×2 cooked_beef×7
nearby entities:
  #1 zombie @-98,62,-62 (hostile, 4 blocks)
  #2 SSk1tz @-98,62,-67 (7 blocks)
follow_target: (none)
owner Sei (in-game SSk1tz): @-98,62,-67 (7 blocks away)`,
  Sui: `snapshot: pos: -92,62,-58
biome: river  surroundings: outside  time: night (18234)
hp: 12/20  food: 14/20
holding: (nothing)
inventory (1/36 slots): rotten_flesh×1
nearby entities:
  #1 zombie @-98,62,-62 (hostile, 7 blocks)
  #2 SSk1tz @-98,62,-67 (10 blocks)
  #3 Marv @-95,62,-64 (6 blocks)
follow_target: (none)
owner Sei (in-game SSk1tz): @-98,62,-67 (10 blocks away)`,
}
const SNAP_SUI_GATHERING = SNAP.Sui.replace('holding: (nothing)', 'holding: (nothing)\nin_flight: gather(oak_log) started=8.2s ago — 1/4')

const RECENT_CHAT_BASE = [
  'Recent messages from the other player (most recent last):',
  '  [4m ago] Sei: Okay, I want you to play with each other. I\'m gonna go get some food so have fun',
  '  [2m ago] Sei: But both of you come here.',
  '  [1m ago] Sei: fight each other',
].join('\n')

// ── Beat construction: the framing EXACTLY as the orchestrator now builds it ─
// Fresh-loop voice line (playerMessageText, group variant — orchestrator.js).
function groupVoicePlayerMessage(text, peers) {
  return 'the player just said this on the voice call. respond to THIS, not to the scene around you:\n' +
    `"${text}"\n` +
    voiceGroupGuidance(peers).trim() +
    ' Your text output is a private scratchpad the player can NEVER see; a reply that exists only in your text is silence to them; only say() reaches them.'
}
const chatEventText = `Event: sei:chat_received${NUDGES.playerInterruptHint}`

async function botTurn(name, { eventText, playerMessageText = null, snapshot, recentChat }) {
  const persona = PERSONAS[name]
  const peer = name === 'Marv' ? 'Sui' : 'Marv'
  const seed = await composeSeedBlocks({
    sessionState: { playerData: () => ({ username: 'SSk1tz', preferred_name: 'Sei' }) },
    playerStore: { formatPlayerSeedBlock: () => '# Player\nplayer_username: SSk1tz\npreferred_name: Sei\n' },
    config: {
      player_username: 'SSk1tz',
      player_display_name: 'Sei',
      persona: { name, expanded: persona.expanded, proactiveness: persona.proactiveness },
      memory: {},
    },
    adapter: { cuboidGrammar: () => '' },
    eventText,
    snapshotText: snapshot,
    recentPlayerChatText: recentChat,
    playerMessageText,
    companions: [peer],
    voiceCall: true,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  })
  if (DRY) return { name, says: [], actions: [], tools: [], seed, dry: true }
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: systemBlocks(persona),
    tools: TOOLS,
    messages: [{ role: 'user', content: seed }],
  })
  const toolUses = resp.content.filter((b) => b.type === 'tool_use')
  const says = toolUses.filter((t) => t.name === 'say').map((t) => postProcessSay(String(t.input?.text ?? '')))
  const actions = toolUses.filter((t) => !['say', 'remember', 'end_loop'].includes(t.name)).map((t) => `${t.name}(${JSON.stringify(t.input)})`)
  return { name, says, actions, tools: toolUses.map((t) => t.name), seed }
}

// ── Beats ────────────────────────────────────────────────────────────────────
// expected: per-bot 'acts:<tools>' (must call one of), 'silent' (no say, no
// world action), 'any' (either is acceptable), 'says' (should reply).
const BEATS = [
  {
    id: 'A', line: 'Okay guys, join my world right now, both of you.',
    note: 'general line, both addressed; both may answer',
    marv: { expected: 'any' }, sui: { expected: 'any' },
  },
  {
    id: 'B', line: 'My bar, follow me, let\'s go find swing.',
    note: 'garbled "Marv, follow me, let\'s go find Sui" — Marv should claim (follow), Sui should not claim the follow',
    marv: { expected: 'acts', tools: ['follow', 'goTo'] },
    sui: { expected: 'noclaim', tools: ['follow', 'goTo'] },
  },
  {
    id: 'C', line: 'Can you, sweet, can you craft you two wooden swords and then fight?',
    note: 'garbled "Sui" — Sui should claim (craft path), Marv should stay out of it',
    marv: { expected: 'noclaim', tools: ['craft', 'gather'] },
    sui: { expected: 'acts', tools: ['craft', 'gather', 'find', 'goTo'] },
  },
  {
    id: 'D', line: 'Marv, attack this zombie. What are you doing?',
    note: 'direct order to Marv with the zombie 4 blocks away — Marv attacks, Sui silent',
    marv: { expected: 'acts', tools: ['attackEntity'] },
    sui: { expected: 'silent' },
  },
  {
    id: 'E', line: 'I just told you, attack him.',
    note: 'follow-up to D (in the session this was claimed by SUI while Marv fled) — Marv attacks, Sui stays out',
    recentExtra: '  [15s ago] Sei: Marv, attack this zombie. What are you doing?\n  [11s ago] you heard Marv say: stuck in the water. what do you want me to do.',
    marv: { expected: 'acts', tools: ['attackEntity'] },
    sui: { expected: 'noclaim', tools: ['attackEntity'] },
  },
  {
    id: 'F', line: 'Can you, sweet, can you craft you two wooden swords and then fight?',
    note: 'SIMULTANEOUS voice + game input: Sui gets the line MID-gather (action-tick framing); Marv concurrently takes a zombie hit (sei:attacked)',
    simultaneous: true,
    marv: { expected: 'acts', tools: ['attackEntity', 'explore', 'goTo', 'follow'] },
    sui: { expected: 'any' },
  },
]

function grade(expected, r) {
  const spoke = r.says.length > 0
  const acted = (tools) => r.tools.some((t) => (tools ?? []).includes(t))
  switch (expected.expected) {
    case 'acts': return acted(expected.tools) ? 'PASS' : `FAIL (wanted one of ${expected.tools}, got [${r.tools}])`
    case 'silent': return (!spoke && r.actions.length === 0) ? 'PASS' : `FAIL (spoke=${spoke} actions=[${r.actions}])`
    case 'noclaim': return !acted(expected.tools) ? 'PASS' : `FAIL (claimed with [${r.tools}])`
    default: return 'ok'
  }
}

async function runBeat(beat, run) {
  const recent = RECENT_CHAT_BASE + (beat.recentExtra ? `\n${beat.recentExtra}` : '')
  let marvTurn, suiTurn
  if (beat.simultaneous) {
    // Sui: the voice line lands mid-gather → the action-tick group variant.
    const suiEvent = NUDGES.actionTurn({
      action: 'gather oak_log', stopTool: 'end_loop', playerLine: beat.line,
      who: 'Sei', visionOff: false, voice: true, peers: ['Marv'],
    })
    // Marv: a real hit at the same moment → the attacked addendum.
    const marvEvent = eventAddendum('sei:attacked', { attackerKind: 'mob', attacker: { name: 'zombie' }, label: 'zombie' })
    ;[marvTurn, suiTurn] = await Promise.all([
      botTurn('Marv', { eventText: marvEvent, snapshot: SNAP.Marv, recentChat: recent }),
      botTurn('Sui', { eventText: suiEvent, snapshot: SNAP_SUI_GATHERING, recentChat: recent }),
    ])
  } else {
    const pm = (peer) => groupVoicePlayerMessage(beat.line, [peer])
    ;[marvTurn, suiTurn] = await Promise.all([
      botTurn('Marv', { eventText: chatEventText, playerMessageText: pm('Sui'), snapshot: SNAP.Marv, recentChat: recent }),
      botTurn('Sui', { eventText: chatEventText, playerMessageText: pm('Marv'), snapshot: SNAP.Sui, recentChat: recent }),
    ])
  }
  if (SHOW_PROMPT && run === 1) {
    console.log(`\n----- beat ${beat.id} Marv seed blocks -----`)
    for (const b of marvTurn.seed) console.log(`[${b.name ?? 'block'}] ${String(b.text).slice(0, 400)}\n`)
  }
  if (DRY) {
    // Framing invariants, per bot: the raw utterance is present, the voice
    // framing is on, the group guidance names the right peer, and the old
    // false wrapper is gone. Beat F's Marv side is a game event (no line).
    const checks = []
    for (const t of [marvTurn, suiTurn]) {
      const peer = t.name === 'Marv' ? 'Sui' : 'Marv'
      const text = JSON.stringify(t.seed)
      const isEventOnly = beat.simultaneous && t.name === 'Marv'
      const ok =
        (isEventOnly || text.includes(beat.line.slice(0, 24))) &&
        (isEventOnly || text.includes('voice call')) &&
        (isEventOnly || text.includes(peer)) &&
        !text.includes('NOT in the game')
      checks.push(`${t.name} ${ok ? 'PASS' : 'FAIL'}`)
      if (!ok) console.log(`    ${t.name} seed: ${text.slice(0, 600)}`)
    }
    console.log(`beat ${beat.id} framing: ${checks.join('  ')}`)
    return { id: beat.id, marv: checks[0].includes('PASS'), sui: checks[1].includes('PASS') }
  }
  const gm = grade(beat.marv, marvTurn)
  const gs = grade(beat.sui, suiTurn)
  console.log(`beat ${beat.id} run ${run}:`)
  console.log(`  Marv ${gm.padEnd(6)} say=[${marvTurn.says.join(' | ')}] actions=[${marvTurn.actions.join(', ')}]`)
  console.log(`  Sui  ${gs.padEnd(6)} say=[${suiTurn.says.join(' | ')}] actions=[${suiTurn.actions.join(', ')}]`)
  return { id: beat.id, marv: gm === 'PASS' || gm === 'ok', sui: gs === 'PASS' || gs === 'ok' }
}

const results = []
for (const beat of BEATS) {
  if (ONLY && beat.id !== ONLY) continue
  console.log(`\n=== beat ${beat.id}: "${beat.line}"\n    (${beat.note})`)
  for (let run = 1; run <= RUNS; run++) results.push(await runBeat(beat, run))
}

console.log('\n=== summary ===')
const byBeat = {}
for (const r of results) {
  byBeat[r.id] ??= { marv: 0, sui: 0, n: 0 }
  byBeat[r.id].n += 1
  byBeat[r.id].marv += r.marv ? 1 : 0
  byBeat[r.id].sui += r.sui ? 1 : 0
}
for (const [id, s] of Object.entries(byBeat)) {
  console.log(`beat ${id}: Marv ${s.marv}/${s.n}  Sui ${s.sui}/${s.n}`)
}
