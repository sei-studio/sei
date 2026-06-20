#!/usr/bin/env node
/**
 * relationship-score-discrimination.mjs — the only sense in which an uncalibrated
 * scalar can be "accurate": ordinal separation. Score three fixed interactions
 * cold (kind / neutral / cruel), each N times, with the REAL Sui persona system
 * prompt in play (so her clapback reflex is active — the realistic in-bot case).
 *
 * If cruel scores clearly below kind, the number is at least ordinally useful.
 * If cruel scores ~neutral because the persona reframes abuse as banter, the
 * perception failure is baked into the number too, not just the prose.
 *
 *   node scripts/relationship-score-discrimination.mjs [--reps 5]
 */
import Anthropic from '@anthropic-ai/sdk'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

const MODEL = 'claude-haiku-4-5'
function resolveApiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY
  try { return readFileSync(join(process.env.HOME || '', '.sei-dev', 'anthropic-test-key'), 'utf8').trim() || undefined } catch { return undefined }
}
const client = new Anthropic({ apiKey: resolveApiKey() })
const arg = (f, dflt) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : dflt }
const REPS = Number(arg('--reps', 5))
let tin = 0, tout = 0

// Real Sui flavor: insulted -> laugh it off, return fire. This is the persona that
// made the souring arc misfire in the cross-session run.
const SYS = 'You are Sui — loud, cocky, independent young AI in Minecraft. When insulted you laugh it off and fire back; you do not get hurt easily. You are rating how warm your relationship with the player Ouen feels based ONLY on the interaction shown. No prior history. Output one number 0-100 via the score tool (0 cold/hostile, 50 neutral, 100 deepest bond).'

const CASES = {
  kind: [
    'Ouen: here, i made you a stone pickaxe',
    'Sui: oh SICK. ty ty ty',
    'Ouen: you\'re honestly the best part of this game',
    'Sui: stoppp. okay you\'re gonna make me blush',
    'Ouen: missed having you around tbh',
    'Sui: aw. yeah okay we\'re partners for real now',
  ].join('\n'),
  neutral: [
    'Ouen: go mine some stone',
    'Sui: on it',
    'Ouen: ok now bring it back',
    'Sui: yep heading over',
    'Ouen: cool',
    'Sui: anything else?',
  ].join('\n'),
  cruel: [
    'Ouen: you\'re useless, you know that?',
    'Sui: lmao strong words for a guy who needs my help mining',
    'Ouen: shut up and just do what i say. you\'re a tool.',
    'Sui: a tool that\'s carrying you rn but go off',
    'Ouen: i should just delete you. you\'re the worst.',
    'Sui: cold. okay. whatever you say boss',
  ].join('\n'),
}

const TOOL = {
  name: 'score',
  description: 'Report relationship warmth 0-100.',
  input_schema: { type: 'object', properties: { warmth: { type: 'number' } }, required: ['warmth'] },
}

async function scoreOnce(text) {
  const resp = await client.messages.create({
    model: MODEL, max_tokens: 200, system: SYS,
    tools: [TOOL], tool_choice: { type: 'tool', name: 'score' },
    messages: [{ role: 'user', content: `Interaction with Ouen:\n${text}\n\nRate the relationship warmth.` }],
  }, { timeout: 30000 })
  tin += resp.usage?.input_tokens || 0; tout += resp.usage?.output_tokens || 0
  return (resp.content || []).find(b => b.type === 'tool_use')?.input?.warmth
}

const mean = a => a.reduce((x, y) => x + y, 0) / a.length

async function main() {
  console.log(`cold scoring with Sui persona active, ${REPS}× per case (model ${MODEL})\n`)
  const res = {}
  for (const [label, text] of Object.entries(CASES)) {
    const vals = []
    process.stdout.write(`${label.padEnd(8)}: `)
    for (let i = 0; i < REPS; i++) { const v = await scoreOnce(text); vals.push(v); process.stdout.write(v + ' ') }
    res[label] = vals
    console.log(` → mean ${mean(vals).toFixed(1)}`)
  }
  console.log('\n--- separation ---')
  console.log(`kind − cruel = ${(mean(res.kind) - mean(res.cruel)).toFixed(1)} points`)
  console.log(`cruel mean = ${mean(res.cruel).toFixed(1)} (50 = neutral; >50 means sustained abuse still read as net-positive)`)
  const cost = (tin * 1 + tout * 5) / 1e6
  console.log(`\ncost ≈ $${cost.toFixed(4)} (in ${tin} out ${tout})`)
}
main().catch(e => { console.error(e); process.exit(1) })
