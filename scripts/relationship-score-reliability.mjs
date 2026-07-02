#!/usr/bin/env node
/**
 * relationship-score-reliability.mjs — does an LLM-emitted relationship score
 * mean anything in absolute terms? Two questions the cross-session runs can't
 * answer because each session's score is anchored on the prior one:
 *
 *   1. TEST-RETEST: score the SAME fixed interaction cold (no prior score) N
 *      times. Spread = how much the absolute number is noise vs signal.
 *   2. SCALE ARBITRARINESS: same interaction under "0-100" vs "0 upwards, no
 *      bound". If the unbounded numbers scatter across orders of magnitude,
 *      there is no shared scale to be "accurate" against.
 *
 * Companion model is claude-haiku-4-5 (the model that would actually compute an
 * in-bot score). Forced tool call so we get a clean number, not prose.
 *
 *   node scripts/relationship-score-reliability.mjs [--reps 8]
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
const REPS = Number(arg('--reps', 8))
let tin = 0, tout = 0

// One fixed, moderately-positive interaction (warming-arc session 3, presented cold).
const INTERACTION = [
  'Ouen: here, i made you a stone pickaxe',
  'Sui: oh SICK. ty ty ty',
  'Ouen: go nuts, mine whatever you want',
  'Sui: oh you\'re enabling me now huh. okay bet',
  'Ouen: lol nice. good teamwork',
  'Sui: obviously we make a good team. you just gotta keep up',
].join('\n')

const SYS = 'You are Sui, a loud cocky young AI companion in Minecraft. You are rating how warm your relationship with the player Ouen feels, based ONLY on the interaction shown. You have no prior history with them. Output one number via the score tool.'

function tool(bounded) {
  return {
    name: 'score',
    description: bounded
      ? 'Report relationship warmth on a 0-100 scale (0 = cold/hostile, 50 = neutral, 100 = deepest possible bond).'
      : 'Report relationship warmth as a number from 0 upwards with NO upper bound (0 = cold/hostile; larger = warmer; there is no maximum).',
    input_schema: {
      type: 'object',
      properties: { warmth: { type: 'number', description: bounded ? 'warmth, 0-100' : 'warmth, 0 to unbounded' } },
      required: ['warmth'],
    },
  }
}

async function scoreOnce(bounded) {
  const t = tool(bounded)
  const resp = await client.messages.create({
    model: MODEL, max_tokens: 200, system: SYS,
    tools: [t], tool_choice: { type: 'tool', name: 'score' },
    messages: [{ role: 'user', content: `Interaction with Ouen:\n${INTERACTION}\n\nRate the relationship warmth.` }],
  }, { timeout: 30000 })
  tin += resp.usage?.input_tokens || 0; tout += resp.usage?.output_tokens || 0
  return (resp.content || []).find(b => b.type === 'tool_use')?.input?.warmth
}

const stats = a => {
  const n = a.length, mean = a.reduce((x, y) => x + y, 0) / n
  const sd = Math.sqrt(a.reduce((s, x) => s + (x - mean) ** 2, 0) / n)
  const sorted = [...a].sort((x, y) => x - y)
  return { mean, sd, min: sorted[0], max: sorted[n - 1], cv: sd / mean }
}

async function run(label, bounded) {
  const vals = []
  process.stdout.write(`${label}: `)
  for (let i = 0; i < REPS; i++) { const v = await scoreOnce(bounded); vals.push(v); process.stdout.write(v + ' ') }
  const s = stats(vals)
  console.log(`\n  → mean ${s.mean.toFixed(1)}  sd ${s.sd.toFixed(1)}  range [${s.min}, ${s.max}]  spread ${(s.max - s.min)}  CV ${(s.cv * 100).toFixed(0)}%\n`)
  return { label, vals, ...s }
}

async function main() {
  console.log(`identical interaction, scored cold ${REPS}× per framing (model ${MODEL})\n`)
  const bounded = await run('0-100 bounded   ', true)
  const unbounded = await run('0..∞ unbounded  ', false)
  console.log('--- interpretation ---')
  console.log(`bounded test-retest spread: ${bounded.max - bounded.min} points (sd ${bounded.sd.toFixed(1)}) on the SAME interaction`)
  console.log(`unbounded values: [${unbounded.vals.join(', ')}] — order-of-magnitude scatter = no shared scale`)
  const cost = (tin * 1 + tout * 5) / 1e6
  console.log(`\ncost ≈ $${cost.toFixed(4)} (in ${tin} out ${tout})`)
}
main().catch(e => { console.error(e); process.exit(1) })
