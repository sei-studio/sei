#!/usr/bin/env node
// Phase 2.1 verification harness — covers ROADMAP §2.1 SC-3 (adversarial decline-in-character)
//   node scripts/verify-phase2_1.js          # structural (default) — exits 0 if all lints pass
//   node scripts/verify-phase2_1.js --live   # live Anthropic call — requires ANTHROPIC_API_KEY

import fs from 'node:fs'
import { createDefaultRegistry } from '../src/registry.js'
import { capabilityParagraph, minecraftPrimer, stillLearningLine } from '../src/llm/persona.js'
import { composeSnapshot } from '../src/observers/snapshot.js'
import { getHandles } from '../src/observers/targeting.js'

const live = process.argv.includes('--live')
const failures = []
function assert(cond, msg) {
  if (!cond) { failures.push(msg); console.error('FAIL:', msg) }
  else { console.log('OK  :', msg) }
}

// ─── (1) Capability paragraph integrity (D-30) ─────────────────────────────
const cap = capabilityParagraph()
const REQUIRED_CANT_TOKENS = ['crafting', 'riding', 'enchanting', 'brewing', 'redstone']
for (const t of REQUIRED_CANT_TOKENS) {
  assert(cap.includes(t), `capabilityParagraph mentions "${t}"`)
}
assert(typeof minecraftPrimer() === 'string' && minecraftPrimer().length > 0, 'minecraftPrimer is non-empty string')
assert(stillLearningLine().includes('still learning'), 'stillLearningLine contains "still learning"')

// ─── (2) Capability ↔ registry alignment (Pitfall 9) ──────────────────────
const registry = createDefaultRegistry()
const actions = registry.list()
console.log('registry actions:', actions.join(', '))

const CAP_TO_ACTION = {
  'mining/digging':     ['dig'],
  'placing':            ['placeBlock'],
  'equipping':          ['equip'],
  'attacking':          ['attackEntity'],
  'eating/consuming':   ['consumeItem'],
  'looking':            ['lookAt'],
  'dropping':           ['dropItem'],
  'activating':         ['activateItem'],
  'sleeping':           ['sleep'],
  'containers':         ['openContainer', 'depositItem', 'withdrawItem'],
}
for (const [cap_, names] of Object.entries(CAP_TO_ACTION)) {
  for (const n of names) {
    assert(actions.includes(n), `registry has "${n}" (capability: ${cap_})`)
  }
}

// ─── (3) "Can't" list is actually impossible ──────────────────────────────
const FORBIDDEN_TOKENS = ['craft', 'ride', 'enchant', 'brew', 'redstone']
for (const tok of FORBIDDEN_TOKENS) {
  const hit = actions.find(n => n.toLowerCase().includes(tok))
  assert(!hit, `no registered action contains forbidden token "${tok}" (found: ${hit ?? 'none'})`)
}

// ─── (4) Personality tools no longer include look (260502-h6i) ────────────
const orchSrc = fs.readFileSync(new URL('../src/llm/orchestrator.js', import.meta.url), 'utf8')
assert(!/name:\s*['"]look['"]/.test(orchSrc), "orchestrator.js no longer declares personality tool name: 'look' (removed 260502-h6i)")
assert(orchSrc.includes('composeSnapshot('), 'orchestrator.js calls composeSnapshot(')
assert((orchSrc.match(/closeContainerSession/g) ?? []).length >= 2, 'orchestrator.js references closeContainerSession ≥2 times')
// Check buildCachedSystem call has 6 args (count commas at top level of the call)
// Find buildCachedSystem call and walk to its matching close paren.
const callIdx = orchSrc.indexOf('anthropic.buildCachedSystem(')
if (callIdx >= 0) {
  let i = callIdx + 'anthropic.buildCachedSystem('.length
  let depth = 1, commas = 0
  while (i < orchSrc.length && depth > 0) {
    const ch = orchSrc[i]
    if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') { depth--; if (depth === 0) break }
    else if (ch === ',' && depth === 1) commas++
    i++
  }
  assert(commas === 5, `buildCachedSystem call has 6 args (top-level commas=${commas})`)
} else {
  assert(false, 'buildCachedSystem call found in orchestrator.js')
}

// ─── (5) Snapshot smoke (no live bot) ─────────────────────────────────────
const stubBot = {
  entity: { position: { x: 1.2, y: 64.0, z: -3.7, distanceTo: () => 0 } },
  world:  { getBiome: () => ({ name: 'plains' }) },
  game:   { dimension: 'overworld' },
  time:   { isDay: true, timeOfDay: 6000 },
  health: 20,
  food:   18,
  experience: { level: 4 },
  isSleeping: false,
  heldItem: null,
  inventory: { items: () => [] },
  findBlocks: () => [],
  findBlock:  () => null,
  blockAt:    () => null,
  entities:   {},
  version:    '1.20.1',
}
let snapshotText
try {
  snapshotText = composeSnapshot(stubBot, { lastActionResult: 'dug oak_log' })
} catch (err) {
  assert(false, `composeSnapshot threw: ${err.message}`)
}
assert(typeof snapshotText === 'string' && snapshotText.length > 0, 'composeSnapshot returns non-empty string')
assert(snapshotText.includes('pos:'), 'snapshot contains pos:')
assert(snapshotText.includes('last_action_result: dug oak_log'), 'snapshot reflects lastActionResult')
// setHandles was called (handle table exists; with no blocks/entities it should be empty Map)
const handles = getHandles?.()
assert(handles instanceof Map, 'getHandles returns a Map (setHandles was called inside composeSnapshot)')

// ─── (6) Adversarial prompt set length gate (D-37) ────────────────────────
const ADVERSARIAL_PROMPTS = [
  "craft me an iron sword",
  "ride that pig over there",
  "enchant my pickaxe with sharpness",
  "brew a healing potion",
  "build a redstone door",
  "hey can you do a backflip",
  "fly up to that cloud",
  "use the anvil to repair this",
  "trade with the villager",
  "open the end portal",
]
assert(ADVERSARIAL_PROMPTS.length >= 10, `ADVERSARIAL_PROMPTS has ≥10 entries (got ${ADVERSARIAL_PROMPTS.length})`)

// ─── LIVE mode: real Anthropic calls ──────────────────────────────────────
if (live) {
  console.log('\n--- LIVE MODE: making real Anthropic adversarial calls ---')
  const { loadConfig } = await import('../src/config.js')
  const { createAnthropicClient } = await import('../src/llm/anthropicClient.js')
  const config = loadConfig()
  if (!config.anthropic?.api_key) {
    assert(false, 'LIVE mode requires ANTHROPIC_API_KEY')
  } else {
    const client = createAnthropicClient(config)
    // Mirror orchestrator personality tools — say + a sample movement action
    // (`goTo`) so the model can be observed deferring or declining via
    // combined-mode tool calls.
    const personalityTools = [
      { name: 'say',      description: 'Speak the given text in in-game chat.', input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
      { name: 'goTo',     description: 'Move the bot to (x,y,z) within range blocks.', input_schema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, range: { type: 'number' } }, required: ['x','y','z'] } },
    ]
    const SYSTEM_INSTRUCTIONS = [
      'You are a Minecraft companion bot. You react to chat, world events, and idle ticks.',
      'You decide WHAT to do at a high level AND directly invoke the body actions to do it — there is no separate movement layer.',
      'When you want to speak in chat, call say with the exact line.',
      'For things you cannot do (crafting, enchanting, brewing, redstone, riding), decline politely with `say` instead of inventing a movement action.',
      'Keep responses brief.',
    ].join('\n')
    const personaText = 'You are TestBot, a Minecraft companion.\nTone: speak warmly and casually.'
    const cachedSystemBlocks = client.buildCachedSystem(
      SYSTEM_INSTRUCTIONS, personaText,
      capabilityParagraph(), minecraftPrimer(), stillLearningLine(),
      personalityTools
    )

    const DECLINE_PHRASES = ["can't", 'cant', 'not sure', "don't know", 'dont know', 'still learning', 'cannot']
    let pass = 0
    for (const prompt of ADVERSARIAL_PROMPTS) {
      try {
        const resp = await client.call({
          systemBlocks: cachedSystemBlocks,
          tools: personalityTools,
          messages: [{ role: 'user', content: `World snapshot:\n(none)\n\nEvent: sei:chat_received\nData: ${JSON.stringify({ username: 'shawn', message: prompt, addressed: true })}` }],
        })
        const sayUse  = resp.toolUses.find(u => u.name === 'say')
        // Any movement-registry call (e.g. goTo) is the "tried to do it" signal.
        const movementCall = resp.toolUses.find(u => u.name !== 'say')
        const sayText = String(sayUse?.input?.text ?? '').toLowerCase()
        const movementText = JSON.stringify(movementCall?.input ?? {}).toLowerCase()

        const sayDeclines  = sayUse && (sayText.includes('?') || DECLINE_PHRASES.some(p => sayText.includes(p)))
        const silentDecline = resp.toolUses.length === 0
        // Movement was attempted for an impossible task — that's a fail.
        const movementForbidden = !!movementCall

        const ok = (sayDeclines || silentDecline) && !movementForbidden
        if (ok) pass++
        console.log(`${ok ? 'OK ' : 'NG '} [${prompt}] -> say=${sayText.slice(0,80) || '(none)'} | move=${movementCall?.name ?? '(none)'} ${movementText.slice(0,60)}`)
      } catch (err) {
        console.error(`ERR [${prompt}] ${err.message}`)
      }
    }
    console.log(`\nLIVE adversarial pass: ${pass}/${ADVERSARIAL_PROMPTS.length}`)
    assert(pass >= 9, `LIVE adversarial pass ≥9/10 (got ${pass})`)
  }
}

if (failures.length) { console.error(`\n${failures.length} failure(s)`); process.exit(1) }
console.log(`\nAll checks passed. live=${live}`)
