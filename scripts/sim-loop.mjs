#!/usr/bin/env node
/**
 * scripts/sim-loop.mjs — multi-turn loop simulator (the real orchestrator's
 * chain, mocked world). Replays the beats of play log bbf5b66f ...03-37:
 *   Sui (driven) spawns in plains, EMPTY inventory, NO trees nearby, player
 *   ~19 blocks off; searches for wood; player walks over ("im here"); nearest
 *   tree turns out to be ~40m away.
 *
 * Unlike probe-brain (one iteration), this chains iterations: it feeds each
 * turn's tool_use back as a tool_result, advances a tiny world model, injects
 * the player's chat at the same point the log did, and prints the chat exactly
 * as the player would see it (postProcessSay -> splitChatMessages). The point is
 * to watch the WHOLE loop read naturally and non-spammy, not just one turn.
 *
 *   node scripts/sim-loop.mjs            # one run
 *   node scripts/sim-loop.mjs --runs 3   # a few runs (Haiku is stochastic)
 */
import Anthropic from '@anthropic-ai/sdk'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

import { BASELINE_INSTRUCTIONS, PERSONALITY_TOOL_DESCRIPTIONS, NUDGES, renderPersona } from '../src/bot/brain/prompts.js'
import { CAPABILITY_PARAGRAPH, WORLD_PRIMER, ACTION_RULES, CUBOID_GRAMMAR, ACTION_DESCRIPTIONS, eventAddendum } from '../src/bot/adapter/minecraft/prompts.js'
import { composeSeedBlocks, postProcessSay, splitChatMessages } from '../src/bot/brain/orchestrator.js'

const MODEL = 'claude-haiku-4-5'
const RUNS = Number((process.argv.indexOf('--runs') >= 0 && process.argv[process.argv.indexOf('--runs') + 1]) || 1)

function resolveApiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY
  try { return readFileSync(join(process.env.HOME || '', '.sei-dev', 'anthropic-test-key'), 'utf8').trim() || undefined } catch { return undefined }
}
const client = new Anthropic({ apiKey: resolveApiKey() })

// Tools (mirrors probe-brain) ────────────────────────────────────────────────
const personalityTools = ['remember', 'forget', 'setGoal', 'clearGoal', 'end_loop'].map((name) => ({
  name, description: PERSONALITY_TOOL_DESCRIPTIONS[name],
  input_schema: name === 'end_loop' ? { type: 'object', properties: {}, additionalProperties: false } : { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
}))
const MOVEMENT = ['goTo', 'dig', 'find', 'explore', 'gather', 'placeBlock', 'build', 'equip', 'attackEntity', 'follow', 'unfollow', 'consumeItem', 'lookAt', 'look', 'dropItem', 'activateItem', 'sleep', 'openContainer', 'depositItem', 'withdrawItem']
const movementTools = MOVEMENT.map((name) => ({ name, description: ACTION_DESCRIPTIONS[name] ?? `Action: ${name}`, input_schema: { type: 'object', properties: {}, additionalProperties: true } }))
const TOOLS = [...personalityTools, ...movementTools]

function loadPersona(slug) {
  const c = JSON.parse(readFileSync(new URL(`../resources/default-characters/${slug}.json`, import.meta.url), 'utf8'))
  return { name: c.username ?? c.name, expanded: c.persona.expanded, proactiveness: c.metadata?.proactiveness ?? 1 }
}
const SUI = loadPersona('sui')
function systemBlocks(p) {
  return [BASELINE_INSTRUCTIONS, renderPersona(p), CAPABILITY_PARAGRAPH, WORLD_PRIMER, ACTION_RULES].map((text) => ({ type: 'text', text }))
}

// Tiny world model ────────────────────────────────────────────────────────────
// Faithful to the 04-27 freeze: the ONLY wood is a cherry tree ~43m away, past
// the loaded-chunk edge and up higher ground, so a one-shot goTo to it TIMES OUT
// as unreachable (exactly what the log showed). `explore` walks ~16m toward it,
// loading terrain and closing the gap; after a couple of hops the tree comes
// within reach and gather works. This is the loop we want to watch recover.
const TREE = { x: 41, y: 111, z: -4 }
const REACHABLE = 22 // goTo succeeds only within this horizontal range
function hdist(a, b) { return Math.round(Math.hypot(a.x - b.x, a.z - b.z)) }
function compass(dx, dz) {
  const a = Math.atan2(dx, -dz) * 180 / Math.PI
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round((((a % 360) + 360) % 360) / 45) % 8]
}
function makeWorld() {
  return { pos: { x: -2, y: 109, z: 2 }, player: { x: 31, y: 112, z: 9 }, logs: 0, goal: null }
}
function atTree(w) { return hdist(w.pos, TREE) <= 4 }
function snapshot(w, { inFlight = null, lastResult = null } = {}) {
  const near = atTree(w)
  const nearbyTrees = near
    ? '  #1 cherry_log x14 @41,111,-4\n  #2 grass_block x261 @40,110,-4'
    : '  #1 grass_block x264 @-2,109,1\n  #2 dirt x112 @-3,109,0\n  #3 short_grass x27 @-1,111,1\n  #4 stone x16 @-8,101,1'
  const inv = w.logs > 0 ? `inventory (1/36 slots): cherry_log×${w.logs}` : 'inventory (0/36 slots): empty'
  return [
    `snapshot: pos: ${w.pos.x},${w.pos.y},${w.pos.z}`,
    'biome: plains  surroundings: outside  time: night (15539)',
    'hp: 20/20  food: 20/20  xp: lvl 0',
    `holding: ${w.logs > 0 ? 'cherry_log' : 'nothing'}`,
    inFlight ? `in_flight: ${inFlight}` : null,
    inv,
    'terrain at feet: 20 dirt, 15 grass_block, 6 stone',
    'nearby blocks:',
    nearbyTrees,
    'nearby entities:',
    '  #6 sheep @16,113,5',
    '  #7 cow @29,110,15',
    `  #11 SSk1tz @${w.player.x},${w.player.y},${w.player.z}`,
    'follow_target: (none)',
    `owner SSk1tz: @${w.player.x},${w.player.y},${w.player.z} (${hdist(w.pos, w.player)} blocks away)`,
    lastResult ? `last_action_result: ${lastResult}` : null,
  ].filter(Boolean).join('\n')
}
// Step the bot ~`dist` blocks toward a point (clamped so it doesn't overshoot).
function stepToward(w, target, dist) {
  const dx = target.x - w.pos.x, dz = target.z - w.pos.z
  const m = Math.hypot(dx, dz) || 1
  const step = Math.min(dist, m)
  w.pos = { x: Math.round(w.pos.x + (dx / m) * step), y: w.pos.y, z: Math.round(w.pos.z + (dz / m) * step) }
}

// Resolve a tool call against the world; return { result, terminal }.
function applyTool(w, name, input) {
  switch (name) {
    case 'setGoal': w.goal = input.text; return { result: `goal recorded: ${input.text}` }
    case 'clearGoal': w.goal = null; return { result: 'goal cleared' }
    case 'find': {
      if (/log|wood|tree|cherry|oak/i.test(input.name ?? input.block ?? '')) {
        return { result: `{"found":true,"id":"cherry_log","pos":{"x":41,"y":111,"z":-4},"distance":${hdist(w.pos, TREE)}}` }
      }
      return { result: '{"found":false,"reason":"not in loaded chunks within 64m"}' }
    }
    case 'look': return { result: 'rendered view attached' }
    case 'explore': {
      // Relative-direction scout. In this world the only thing worth reaching is
      // the tree, so any explore simulates progress toward it.
      const before = hdist(w.pos, TREE)
      stepToward(w, TREE, input.blocks ?? 16) // model is heading for wood; simulate progress
      const after = hdist(w.pos, TREE)
      const label = input.orientation ?? (typeof input.angle === 'number' ? `${input.angle}°` : 'forward')
      return { result: `explored ${before - after} blocks ${label}, now at ${w.pos.x},${w.pos.y},${w.pos.z} — new terrain loaded` }
    }
    case 'goTo': {
      const tgt = { x: input.x ?? w.pos.x, y: input.y ?? w.pos.y, z: input.z ?? w.pos.z }
      // A far target past the loaded edge / up higher ground can't be reached in
      // one shot — exactly the log's failure.
      if (hdist(w.pos, tgt) > REACHABLE) return { result: 'timeout — unreachable — try build to Y=111' }
      w.pos = { x: tgt.x, y: tgt.y, z: tgt.z }
      return { result: 'arrived' }
    }
    case 'gather': {
      if (atTree(w) || /cherry|log|wood/i.test(input.name ?? '')) {
        if (!atTree(w)) return { result: 'no wood in loaded chunks' }
        w.logs += 6; return { result: `gathered 6/6 cherry_log, now ${w.logs}` }
      }
      return { result: 'no wood in loaded chunks' }
    }
    case 'dig': {
      if (atTree(w)) { w.logs += 1; return { result: `dug 1 cherry_log (${w.logs} total)` } }
      return { result: 'dug 1 block' }
    }
    case 'follow': return { result: 'following SSk1tz' }
    case 'unfollow': return { result: 'unfollowed' }
    case 'end_loop': return { result: 'loop ended', terminal: true }
    default: return { result: 'ok' }
  }
}

async function runOnce(runIdx, dir) {
  const w = makeWorld()
  const memPath = join(dir, `mem-${runIdx}.md`), hbPath = join(dir, `hb-${runIdx}.md`)
  await writeFile(memPath, ''); await writeFile(hbPath, '')

  const config = { persona: { proactiveness: SUI.proactiveness }, memory: { memory_md_path: memPath, heartbeat_md_path: hbPath, seed_memory_budget_bytes: 8192, seed_heartbeat_budget_bytes: 2048 } }
  const sys = systemBlocks(SUI)
  const messages = []
  const transcript = [] // {who, line}
  let pendingPlayerLine = null

  // Build the user content for an iteration: seed blocks (persona memory/heartbeat
  // + event + snapshot) assembled exactly like the orchestrator.
  async function seedContent(eventText, snap) {
    // refresh heartbeat file to reflect current goal so renderHeartbeat shows it
    await writeFile(hbPath, w.goal ? `# Heartbeat\n\n- ${w.goal}\n` : '')
    const blocks = await composeSeedBlocks({
      sessionState: { playerData: () => ({ username: 'SSk1tz', preferred_name: 'Ouen' }) },
      playerStore: { formatPlayerSeedBlock: () => '# Player\nplayer_username: SSk1tz\npreferred_name: Ouen\n' },
      config, eventText, snapshotText: snap, adapter: { cuboidGrammar: () => CUBOID_GRAMMAR }, logger: { debug() {}, info() {}, warn() {}, error() {} },
    })
    return blocks.map((b) => ({ type: 'text', text: b.text }))
  }

  const MAX_ITERS = 16
  let lastResult = null, inFlight = null, lastAction = null
  const path = [`${w.pos.x},${w.pos.y},${w.pos.z}`]
  for (let i = 0; i < MAX_ITERS; i++) {
    // Decide the event for this iteration.
    let eventText
    if (i === 0) eventText = eventAddendum('sei:idle')
    else if (pendingPlayerLine) eventText = NUDGES.actionTurn({ action: lastAction || 'your action', stopTool: lastAction === 'follow' ? 'unfollow' : 'end_loop', playerLine: pendingPlayerLine, who: 'Ouen' })
    else if (inFlight) eventText = NUDGES.actionTurn({ action: lastAction || 'your action', stopTool: lastAction === 'follow' ? 'unfollow' : 'end_loop', elapsedSec: 10 })
    else eventText = eventAddendum('sei:loop_end')

    const snap = snapshot(w, { inFlight, lastResult })
    const content = await seedContent(eventText, snap)
    messages.push({ role: 'user', content })

    const resp = await client.messages.create({ model: MODEL, max_tokens: 1024, system: sys, tools: TOOLS, messages })
    let text = ''
    const calls = []
    const assistantContent = []
    for (const block of resp.content ?? []) {
      if (block.type === 'text') { text += block.text; assistantContent.push(block) }
      else if (block.type === 'tool_use') { calls.push(block); assistantContent.push(block) }
    }
    messages.push({ role: 'assistant', content: assistantContent })

    // Emit chat exactly as the player sees it.
    const chatLine = postProcessSay(text)
    const said = splitChatMessages(chatLine)
    for (const m of said) transcript.push({ who: 'Sui', line: m })

    // consume the player line (it was injected for this turn)
    if (pendingPlayerLine) pendingPlayerLine = null

    // Resolve tool calls; feed tool_result back.
    const toolResults = []
    let terminal = false
    for (const c of calls) {
      const before = `${w.pos.x},${w.pos.y},${w.pos.z}`
      const { result, terminal: t } = applyTool(w, c.name, c.input || {})
      if (t) terminal = true
      lastAction = c.name
      lastResult = typeof result === 'string' ? result : JSON.stringify(result)
      inFlight = ['goTo', 'gather', 'dig', 'follow', 'build', 'explore'].includes(c.name) ? `${c.name}() started=0s ago` : null
      const after = `${w.pos.x},${w.pos.y},${w.pos.z}`
      if (after !== before) path.push(after)
      toolResults.push({ type: 'tool_result', tool_use_id: c.id, content: String(result) })
    }
    if (toolResults.length) messages.push({ role: 'user', content: toolResults })

    // Inject the player's "im here" after the bot's 3rd action, like the log.
    if (i === 2) pendingPlayerLine = 'im here'

    if (terminal && !pendingPlayerLine) break
    if (calls.length === 0 && !pendingPlayerLine) break
  }

  return { transcript, goal: w.goal, logs: w.logs, path, reachedWood: w.logs > 0 }
}

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'sei-sim-'))
  try {
    for (let r = 1; r <= RUNS; r++) {
      console.log(`\n${'═'.repeat(72)}\nSIM RUN ${r} — Sui (driven) night spawn, wood ~43m away & unreachable in one goTo`)
      console.log('─'.repeat(72))
      const { transcript, goal, logs, path, reachedWood } = await runOnce(r, dir)
      console.log('CHAT (as the player sees it):')
      if (transcript.length === 0) console.log('  (Sui said nothing — pure action)')
      for (const t of transcript) console.log(`  <${t.who}> ${t.line}`)
      console.log(`\n  movement: ${path.join(' -> ')}`)
      console.log(`  reached the wood: ${reachedWood ? `YES (${logs} logs)` : 'no'}`)
      console.log(`  goal set: ${goal ? JSON.stringify(goal) : '(none)'}`)
      console.log(`  total chat lines: ${transcript.length}`)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
main().catch((e) => { console.error(e); process.exit(1) })
