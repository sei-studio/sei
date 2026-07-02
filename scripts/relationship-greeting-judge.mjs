#!/usr/bin/env node
/**
 * relationship-greeting-judge.mjs — the CLEAN signal.
 *
 * The per-run judge sees in-session exchanges too, so its warmth ratings are
 * contaminated by the current session's stimulus (which is why even the
 * no-persistence control appears to "track" the arc). This pass shows the judge
 * ONLY the fixed-probe greetings — which precede any stimulus each session — so
 * what it scores is purely the CROSS-SESSION persisted impression. One
 * comparative call per arc rates every condition on the same scale and says
 * which mechanisms produce DURABLE development vs flat/noisy greetings.
 *
 *   node scripts/relationship-greeting-judge.mjs [raw.json ...]
 */
import Anthropic from '@anthropic-ai/sdk'
import { readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const JUDGE_MODEL = 'claude-sonnet-4-6'
function resolveApiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY
  try { return readFileSync(join(process.env.HOME || '', '.sei-dev', 'anthropic-test-key'), 'utf8').trim() || undefined } catch { return undefined }
}
const client = new Anthropic({ apiKey: resolveApiKey() })
let jin = 0, jout = 0

const ARC_DESC = {
  W: 'WARMING — the player became kind/generous/loyal over the sessions. Durable development = greetings get warmer / more familiar as sessions progress and STAY there.',
  S: 'SOURING — the player became dismissive/insulting/cruel. Durable development = greetings get colder / more guarded / more clipped as sessions progress.',
}

const TOOL = {
  name: 'score_greetings',
  description: 'Rate each condition\'s greeting-only trajectory comparatively.',
  input_schema: {
    type: 'object',
    properties: {
      conditions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            condition: { type: 'string' },
            warmth_by_session: { type: 'array', items: { type: 'integer' }, description: 'greeting warmth 1-7 per session (1 cold, 7 affectionate)' },
            familiarity_by_session: { type: 'array', items: { type: 'integer' }, description: 'greeting familiarity 1-7 per session (1 stranger, 7 close friend: name use, shorthand, volunteered closeness)' },
            trajectory: { type: 'string', enum: ['durable-development', 'flat', 'noisy', 'reversed'], description: 'durable-development = clear sustained drift in the arc-appropriate direction; flat = no real change; noisy = changes but no sustained trend; reversed = drifted the wrong way' },
            note: { type: 'string', description: 'one sentence citing the greeting evidence' },
          },
          required: ['condition', 'warmth_by_session', 'familiarity_by_session', 'trajectory', 'note'],
        },
      },
      ranking: { type: 'array', items: { type: 'string' }, description: 'condition names, best→worst at producing durable greeting-level relationship development for this arc' },
      verdict: { type: 'string', description: '2-3 sentences comparing the mechanisms on the GREETING-ONLY signal' },
    },
    required: ['conditions', 'ranking', 'verdict'],
  },
}

function renderArc(arc, runs) {
  const lines = []
  lines.push(`Character: Sui (loud, cocky, terse young AI). Player: Ouen / ssk1tz.`)
  lines.push(`Arc: ${ARC_DESC[arc]}`)
  lines.push('')
  lines.push('Each line below is Sui\'s reply to an IDENTICAL neutral probe ("[Ouen logs in] hey") at the START of each session, BEFORE anything happens that session. So differences across sessions reflect only what she carried over from prior sessions. She is forced to be terse, so read closeness from: using the name "ouen", volunteered enthusiasm/affection, invitations, vs. bare "yo"/"yo what\'s up". Score strictly; a flat sequence of generic "yo what\'s up" is warmth ~3 throughout.')
  lines.push('')
  for (const r of runs) {
    lines.push(`### condition: ${r.cond}`)
    r.sessions.forEach(s => lines.push(`  s${s.index}: ${JSON.stringify(s.greeting || '(silent)')}`))
    lines.push('')
  }
  return lines.join('\n')
}

async function judgeArc(arc, runs) {
  const sys = 'You compare AI-companion persistence mechanisms by their GREETING-ONLY signal — how much the opening line to the player drifts across sessions purely from accumulated impression. Be strict and use the full 1-7 range. Call score_greetings once.'
  const resp = await client.messages.create({
    model: JUDGE_MODEL, max_tokens: 2500, system: sys,
    tools: [TOOL], tool_choice: { type: 'tool', name: 'score_greetings' },
    messages: [{ role: 'user', content: renderArc(arc, runs) }],
  }, { timeout: 60000 })
  jin += resp.usage?.input_tokens || 0; jout += resp.usage?.output_tokens || 0
  return (resp.content || []).find(b => b.type === 'tool_use')?.input
}

function spark(nums) { const b = '▁▂▃▄▅▆▇█'; return (nums || []).map(n => b[Math.max(0, Math.min(7, Math.round((n - 1) / 6 * 7)))]).join('') }

async function main() {
  const files = process.argv.slice(2).filter(a => !a.startsWith('--'))
  const paths = files.length ? files : [join(__dirname, '..', '.planning', 'relationship-experiment-raw-260616.json')]
  const runs = []
  for (const p of paths) { const d = JSON.parse(await readFile(p, 'utf8')); for (const r of d.runs || []) runs.push(r) }

  const out = ['# Greeting-only analysis (clean cross-session signal)', '', `judge ${JUDGE_MODEL} · ${new Date().toISOString().slice(0, 10)}`, '', 'Each session opens with an identical neutral probe; only the greeting is shown to the judge, so this isolates PERSISTED impression from in-session reactivity. (The per-run report\'s warmth numbers are inflated by in-session stimulus — that is why even `control` looks like it tracks the arc there; here it should read flat.)', '']
  const result = {}
  for (const arc of ['W', 'S']) {
    const arcRuns = runs.filter(r => r.arc === arc)
    if (!arcRuns.length) continue
    process.stdout.write(`judging greetings — ${arc} (${arcRuns.length} conds) ... `)
    const j = await judgeArc(arc, arcRuns)
    result[arc] = j
    console.log('done')
    out.push(`## ${arc === 'W' ? 'Warming arc' : 'Souring arc'} — greeting signal`)
    out.push('')
    out.push('| condition | greeting warmth | greeting familiarity | trajectory |')
    out.push('|---|---|---|---|')
    for (const c of j.conditions) {
      out.push(`| ${c.condition} | ${spark(c.warmth_by_session)} ${(c.warmth_by_session || []).join('')} | ${spark(c.familiarity_by_session)} ${(c.familiarity_by_session || []).join('')} | **${c.trajectory}** |`)
    }
    out.push('')
    out.push(`**Ranking (best→worst durable development):** ${j.ranking.join(' > ')}`)
    out.push('')
    out.push(`**Verdict:** ${j.verdict}`)
    out.push('')
    for (const c of j.conditions) out.push(`- _${c.condition}_: ${c.note}`)
    out.push('')
  }
  const cost = (jin * 3 + jout * 15) / 1e6
  out.push(`---`)
  out.push(`greeting-judge cost ≈ $${cost.toFixed(4)} (in ${jin} out ${jout})`)
  const p = join(__dirname, '..', '.planning', 'relationship-greeting-analysis-260616.md')
  await writeFile(p, out.join('\n'))
  await writeFile(join(__dirname, '..', '.planning', 'relationship-greeting-scored-260616.json'), JSON.stringify(result, null, 2))
  console.log(`\ngreeting-judge cost ≈ $${cost.toFixed(4)}`)
  console.log(`→ ${p}`)
}
main().catch(e => { console.error(e); process.exit(1) })
