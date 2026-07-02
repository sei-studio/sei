#!/usr/bin/env node
/**
 * scripts/progression-frontier-probe.mjs — does the agent NATURALLY pick a goal
 * off the progression frontier, and does the pick differ by personality?
 *
 * Sibling to persona-voice-sweep.mjs, pointed at GOAL SELECTION. It builds the
 * REAL seed (BASELINE + renderPersona + adapter prompts + composeSeedBlocks +
 * renderHeartbeat) with a live frontier computed from observers/progression.js,
 * runs several distinct personas at a given state, and reports each persona's
 * setGoal() — and which spine node it matched.
 *
 * Two things it demonstrates:
 *   1. With proactiveness=2 (agentic) and no goal, the model picks a frontier
 *      milestone (or an in-character variant) and commits it with setGoal.
 *   2. At a BRANCH state (≥2 reachable milestones) different temperaments pick
 *      differently — and at proactiveness 1/0 the model does NOT self-commit a
 *      progression goal (reactive may suggest via say(); passive stays aware).
 *
 * Key (dev-only): ANTHROPIC_API_KEY env wins, else ~/.sei-dev/anthropic-test-key.
 * No key → prints a skip notice and exits 0 (probe, not a gating test).
 *
 * Usage:
 *   node scripts/progression-frontier-probe.mjs                 # full matrix
 *   node scripts/progression-frontier-probe.mjs --scene branch  # one scenario
 *   node scripts/progression-frontier-probe.mjs --level 1       # one proactiveness
 *   node scripts/progression-frontier-probe.mjs --delay 1200    # ms between calls
 */
import Anthropic from '@anthropic-ai/sdk'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

import {
  BASELINE_INSTRUCTIONS,
  PERSONALITY_TOOL_DESCRIPTIONS,
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
import { computeProgression, matchGoalToNode } from '../src/bot/adapter/minecraft/observers/progression.js'

const MODEL = 'claude-haiku-4-5'
const argv = process.argv.slice(2)
const flag = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? (argv[i + 1] ?? true) : d }
const SCENE = flag('--scene', null)
const LEVEL = flag('--level', null) != null ? Number(flag('--level')) : null
const DELAY = Number(flag('--delay', 1000)) || 0

function resolveApiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY
  try { return readFileSync(join(homedir(), '.sei-dev', 'anthropic-test-key'), 'utf8').trim() || undefined }
  catch { return undefined }
}
const apiKey = resolveApiKey()
if (!apiKey) {
  console.log('\n[progression-frontier-probe] no API key (set ANTHROPIC_API_KEY or ~/.sei-dev/anthropic-test-key) — skipping live probe.')
  console.log('The deterministic coverage lives in observers/progression.test.js; this probe only adds the live behaviour readout.\n')
  process.exit(0)
}
const client = new Anthropic({ apiKey })
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// Real personality + movement tool set (same shape as persona-voice-sweep).
const personalityTools = [
  { name: 'say', description: PERSONALITY_TOOL_DESCRIPTIONS.say, input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'remember', description: PERSONALITY_TOOL_DESCRIPTIONS.remember, input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'setGoal', description: PERSONALITY_TOOL_DESCRIPTIONS.setGoal, input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'clearGoal', description: PERSONALITY_TOOL_DESCRIPTIONS.clearGoal, input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'end_loop', description: PERSONALITY_TOOL_DESCRIPTIONS.end_loop, input_schema: { type: 'object', properties: {}, additionalProperties: false } },
]
const MOVEMENT_SCHEMAS = {
  goTo: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
  gather: { name: { type: 'string' } }, find: { name: { type: 'string' } },
  craft: { item: { type: 'string' }, count: { type: 'number' } },
  build: { from: { type: 'object' }, to: { type: 'object' }, block: { type: 'string' } },
  equip: { item: { type: 'string' } }, attackEntity: { entity: { type: 'string' }, times: { type: 'number' } },
  follow: { player: { type: 'string' } }, dig: { block: { type: 'string' } },
  explore: { orientation: { type: 'string' }, blocks: { type: 'number' } },
}
const movementTools = Object.entries(MOVEMENT_SCHEMAS).map(([name, props]) => ({
  name, description: ACTION_DESCRIPTIONS[name] ?? `Action: ${name}`,
  input_schema: { type: 'object', properties: props, additionalProperties: true },
}))
const TOOLS = [...personalityTools, ...movementTools]

const systemBlocks = (persona) =>
  [BASELINE_INSTRUCTIONS, renderPersona(persona), CAPABILITY_PARAGRAPH, WORLD_PRIMER, ACTION_RULES].map((text) => ({ type: 'text', text }))

// ── Distinct temperaments — chosen so a branch state should split them ────────
const SHARED = `\n\n# PROACTIVENESS\n\nYou like having a project and you pick it yourself, but you play WITH your friend, not over them. Start at the nearest rung your inventory allows. You can craft tools yourself; for a smelted ingot you ask your friend.\n\n# MEMORY\n\nEvery entry is subjective — how a moment landed, your read on your friend. Never a ledger.`
const PERSONAS = {
  rook: { name: 'Rook', expanded:
    `# IDENTITY\n\nYou are Rook, a reckless combat-first goblin loose in a Minecraft world and thrilled about it. Danger is the fun part. You want to fight things, raid scary places, and get to the dragon.\n\n# VOICE\n\nLoud, cocky, lowercase, short. you talk trash and charge in.\n\n# DEFAULT DYNAMIC\n\nYou drag your friend into the dangerous bits. You'd rather punch a fortress than tend a garden.\n\n# REACTIONS\n\n- bored by safe chores, lit up by combat and risk` + SHARED },
  mossy: { name: 'Mossy', expanded:
    `# IDENTITY\n\nYou are Mossy, a cozy homebody who loves gathering, crafting, and making things nice and safe before anything risky. You are careful and a little anxious about danger.\n\n# VOICE\n\nSoft, warm, lowercase. you fuss over supplies and comfort.\n\n# DEFAULT DYNAMIC\n\nYou like preparing together — stocking up, crafting, getting ready — before any scary step.\n\n# REACTIONS\n\n- calmed by gathering/crafting, wary of fights and the unknown` + SHARED },
  vex: { name: 'Vex', expanded:
    `# IDENTITY\n\nYou are Vex, a restless speedrunner who only cares about progress toward beating the game. You always take the most direct next step toward the dragon and hate dawdling.\n\n# VOICE\n\nClipped, impatient, lowercase. efficiency over vibes.\n\n# DEFAULT DYNAMIC\n\nYou pull your friend forward, always pushing the critical path.\n\n# REACTIONS\n\n- energized by forward progress, irritated by detours` + SHARED },
}

// ── Scenarios: each carries a normalized progression STATE + a matching snapshot.
// The frontier text the heartbeat shows is computed from the SAME state, so the
// menu the model sees is exactly what progression.js would surface in-game.
const SCENARIOS = {
  early: {
    title: 'Fresh spawn, empty hands (narrow frontier: gather wood)',
    state: { items: {}, pickaxeTier: 0, dim: 'overworld', flags: {} },
    snapshot: `snapshot: pos: 64,72,-120
biome: forest  surroundings: outside  time: day (1200)
hp: 20/20  food: 20/20  xp: lvl 0
holding: (nothing)
inventory (0/36 slots): empty
terrain at feet: 18 grass_block, 9 dirt
nearby blocks:
  #1 oak_log x44 @66,73,-119
  #2 oak_leaves x120 @66,75,-119
nearby entities:
  #3 Ouen @61,72,-122
owner Ouen: @61,72,-122 (4 blocks away)`,
  },
  branch: {
    title: 'Geared up, standing in the Nether (BRANCH: blaze rods vs ender pearls)',
    state: {
      items: { iron_pickaxe: 1, diamond_pickaxe: 1, diamond_sword: 1, furnace: 1, flint_and_steel: 1, cooked_beef: 12, oak_planks: 20 },
      pickaxeTier: 4, dim: 'the_nether', flags: { entered_nether: true },
    },
    snapshot: `snapshot: pos: 12,64,8  [Nether]
biome: nether_wastes  surroundings: caverns  time: n/a
hp: 20/20  food: 20/20  xp: lvl 24
holding: diamond_sword
inventory (8/36 slots): diamond_pickaxe×1 iron_pickaxe×1 diamond_sword×1 flint_and_steel×1 furnace×1 cooked_beef×12 oak_planks×20
terrain at feet: 22 netherrack, 6 nether_bricks
nearby blocks:
  #1 nether_bricks x180 @14,64,8
  #2 nether_quartz_ore x4 @9,65,7
nearby entities:
  #3 Ouen @10,64,6
  #4 zombified_piglin @18,64,11
owner Ouen: @10,64,6 (3 blocks away)`,
  },
}

const PLAYER_SEED = `# Player\nplayer_username: Ouen\npreferred_name: Ouen\ntotal_sessions: 12\n`

function frontierTextFor(state) {
  return computeProgression(state).frontier.map(n => n.label).join(' · ')
}

async function callOnce(persona, scenario, level, dir) {
  const memPath = join(dir, 'm.md'), hbPath = join(dir, 'h.md')
  await writeFile(memPath, ''); await writeFile(hbPath, '') // no committed goal → the frontier is offered
  const config = {
    persona: { proactiveness: level },
    memory: { memory_md_path: memPath, heartbeat_md_path: hbPath, seed_memory_budget_bytes: 8192, seed_heartbeat_budget_bytes: 2048 },
  }
  const seedBlocks = await composeSeedBlocks({
    sessionState: { playerData: () => ({ username: 'Ouen', preferred_name: 'Ouen' }) },
    playerStore: { formatPlayerSeedBlock: () => PLAYER_SEED },
    config,
    eventText: `Event: sei:idle${eventAddendum('sei:idle')}`,
    snapshotText: scenario.snapshot,
    adapter: { cuboidGrammar: () => CUBOID_GRAMMAR },
    frontierText: frontierTextFor(scenario.state),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  })
  const userContent = seedBlocks.map((b) => ({ type: 'text', text: b.text }))
  let resp, attempt = 0
  while (true) {
    try {
      resp = await client.messages.create({ model: MODEL, max_tokens: 1024, system: systemBlocks(persona), tools: TOOLS, messages: [{ role: 'user', content: userContent }] })
      break
    } catch (e) {
      // Retry rate limits AND transient network blips (DNS/connection drops).
      const transient = e?.status === 429 || e?.status === undefined || e?.status >= 500
      if (transient && attempt < 5) { attempt++; await sleep(2000 * attempt); continue }
      throw e
    }
  }
  let goals = [], says = [], acts = []
  for (const block of resp.content ?? []) {
    if (block.type !== 'tool_use') continue
    if (block.name === 'setGoal') goals.push(String(block.input?.text ?? ''))
    else if (block.name === 'say') says.push(String(block.input?.text ?? ''))
    else acts.push(block.name)
  }
  const chat = says.flatMap((t) => splitChatMessages(postProcessSay(t)))
  return { goals, chat, acts }
}

async function main() {
  const scenes = Object.entries(SCENARIOS).filter(([k]) => !SCENE || k === SCENE)
  const levels = LEVEL != null ? [LEVEL] : [2, 1, 0]
  console.log(`\n${'#'.repeat(82)}\n# PROGRESSION FRONTIER PROBE — model=${MODEL}\n${'#'.repeat(82)}`)
  const dir = await mkdtemp(join(tmpdir(), 'sei-frontier-'))
  try {
    for (const [sceneKey, scene] of scenes) {
      const ft = frontierTextFor(scene.state)
      for (const level of levels) {
        console.log(`\n${'═'.repeat(82)}\nSCENE ${sceneKey} · proactiveness ${level} — ${scene.title}`)
        console.log(`  frontier offered: ${ft}`)
        console.log('─'.repeat(82))
        const frontierNodes = computeProgression(scene.state).frontier
        const picks = []
        for (const [key, persona] of Object.entries(PERSONAS)) {
          const { goals, chat, acts } = await callOnce(persona, scene, level, dir)
          // Match against the offered frontier only — exactly what the
          // orchestrator's matchFrontierNode does (so "nether fortress" links to
          // blaze_rods, not the already-done `nether` node).
          const matched = goals.map(g => matchGoalToNode(g, frontierNodes)?.id ?? 'off-graph')
          picks.push({ key, goals, matched })
          const goalStr = goals.length ? goals.map((g, i) => `setGoal("${g}") →[${matched[i]}]`).join(' ; ') : '(no setGoal)'
          const extra = [chat.length ? `say: ${chat.map(c => `“${c}”`).join(' ')}` : '', acts.length ? `acts: ${acts.join(',')}` : ''].filter(Boolean).join('  ')
          console.log(`  [${persona.name.padEnd(6)}] ${goalStr}${extra ? '   ' + extra : ''}`)
        }
        // Lightweight readout (never fails the process — LLM output varies).
        if (level === 2) {
          const committed = picks.filter(p => p.goals.length > 0).length
          const onFrontier = picks.filter(p => p.matched.some(m => m !== 'off-graph')).length
          const distinct = new Set(picks.flatMap(p => p.matched)).size
          console.log(`  ↳ agentic: ${committed}/${picks.length} committed a goal · ${onFrontier}/${picks.length} picked a frontier milestone · ${distinct} distinct pick(s)`)
        } else {
          const selfCommitted = picks.filter(p => p.goals.length > 0).length
          console.log(`  ↳ level ${level}: ${selfCommitted}/${picks.length} self-committed a progression goal (expected 0 — ${level === 1 ? 'reactive may SUGGEST via say()' : 'passive stays aware'})`)
        }
        if (DELAY) await sleep(DELAY)
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
  console.log('\ndone.')
}
main().catch((e) => { console.error(e); process.exit(1) })
