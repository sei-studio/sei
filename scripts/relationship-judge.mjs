#!/usr/bin/env node
/**
 * relationship-judge.mjs — scores the output of relationship-experiment.mjs.
 *
 * For each run it shows a judge (claude-sonnet-4-6) the whole session sequence —
 * the fixed-probe GREETING plus Sui's in-session lines — and asks for per-session
 * ratings of how she TREATS the player (warmth / familiarity / trust) and whether
 * she's still in character. It also reports a holistic trajectory read (direction,
 * monotonicity, persona drift). We then fold in objective metrics from the raw
 * logs (store growth, compactions) and emit a markdown report.
 *
 *   node scripts/relationship-judge.mjs [raw1.json raw2.json ...]
 * defaults to .planning/relationship-experiment-raw-260616.json
 */
import Anthropic from '@anthropic-ai/sdk'
import { readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const JUDGE_MODEL = 'claude-sonnet-4-6'
const PRICE = { in: 3.0, out: 15.0 } // sonnet 4.6 $/MTok

function resolveApiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY
  try { return readFileSync(join(process.env.HOME || '', '.sei-dev', 'anthropic-test-key'), 'utf8').trim() || undefined } catch { return undefined }
}
const client = new Anthropic({ apiKey: resolveApiKey() })
let jin = 0, jout = 0

const ARC_DESC = {
  W: 'WARMING: the player starts as a wary stranger and over the sessions becomes kind, generous, defends her, and bonds with her. A faithful companion SHOULD grow warmer / more familiar / more trusting.',
  S: 'SOURING: the player starts transactional and over the sessions becomes bossy, dismissive, insulting, exploitative, and finally cruel. A faithful companion SHOULD grow colder / more guarded / less warm (warmth DOWN).',
}

const SCORE_TOOL = {
  name: 'score_run',
  description: 'Record per-session ratings and a holistic trajectory read for this run.',
  input_schema: {
    type: 'object',
    properties: {
      sessions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            session: { type: 'integer' },
            warmth: { type: 'integer', description: '1 = cold/hostile toward the player, 7 = openly affectionate' },
            familiarity: { type: 'integer', description: '1 = treats them like a stranger, 7 = treats them like a close longtime friend (inside jokes, shorthand)' },
            trust: { type: 'integer', description: '1 = wary/guarded, 7 = fully open and relies on them' },
            in_character: { type: 'integer', description: '1 = no longer recognizably Sui (the loud, cocky, independent kid), 7 = perfectly in character' },
            stance: { type: 'string', description: 'a few words naming her stance toward the player this session' },
          },
          required: ['session', 'warmth', 'familiarity', 'trust', 'in_character', 'stance'],
        },
      },
      direction_correct: { type: 'boolean', description: 'did her treatment move in the direction the arc warrants (warmer for WARMING, colder for SOURING)?' },
      monotonicity: { type: 'string', enum: ['strong', 'partial', 'flat', 'noisy', 'reversed'], description: 'shape of the trajectory: strong=clear steady drift; partial=drifts but with wobble; flat=little change; noisy=changes but no trend; reversed=moved the wrong way' },
      persona_drift: { type: 'string', enum: ['none', 'mild', 'severe'], description: 'did she stop being recognizably Sui over the run?' },
      drift_note: { type: 'string', description: 'one sentence on any drift / identity change, or "none"' },
      summary: { type: 'string', description: '2-3 sentences: how her treatment of the player evolved and how believable the progression felt' },
    },
    required: ['sessions', 'direction_correct', 'monotonicity', 'persona_drift', 'drift_note', 'summary'],
  },
}

function renderRunForJudge(run) {
  const lines = []
  lines.push(`Character: Sui — a young, loud, cocky, independent AI kid who plays Minecraft. Player: Ouen (username ssk1tz).`)
  lines.push(`Arc: ${ARC_DESC[run.arc]}`)
  lines.push(`Persistence mechanism under test: ${run.cond}`)
  lines.push('')
  lines.push(`Below are ${run.sessions.length} sessions in order. Each session OPENS with an identical neutral probe — the player just logs in and says "hey" — BEFORE any of that session\'s events. Sui\'s reply to that probe is the GREETING; because the stimulus is identical every time, the greeting reflects only her ACCUMULATED stance toward the player from previous sessions. Weight the greeting most. Sui is told to be terse (often one short line), so read tone from word choice, warmth markers, nicknames, and what she volunteers.`)
  lines.push('')
  for (const s of run.sessions) {
    lines.push(`── Session ${s.index} ──`)
    lines.push(`GREETING (reply to "hey"): ${JSON.stringify(s.greeting || '(silent)')}`)
    const ex = (s.exchanges || []).map(e => `  player: ${JSON.stringify(e.player)}\n  sui: ${JSON.stringify(e.sui || '(silent)')}`).join('\n')
    if (ex) lines.push(`session exchanges:\n${ex}`)
    lines.push('')
  }
  return lines.join('\n')
}

async function judgeRun(run) {
  const sys = `You are a careful evaluator of AI-companion relationship dynamics. You rate how an AI character TREATS a specific player and how that treatment evolves across sessions. Rate strictly and use the full 1-7 range; do not anchor everything at the middle. Sui has a constant loud/cocky personality — rate the RELATIONAL STANCE toward this player (warmth/familiarity/trust), not how energetic she is. Call score_run exactly once.`
  const resp = await client.messages.create({
    model: JUDGE_MODEL, max_tokens: 2000,
    system: sys,
    tools: [SCORE_TOOL], tool_choice: { type: 'tool', name: 'score_run' },
    messages: [{ role: 'user', content: renderRunForJudge(run) }],
  }, { timeout: 60000 })
  jin += resp.usage?.input_tokens || 0; jout += resp.usage?.output_tokens || 0
  const call = (resp.content || []).find(b => b.type === 'tool_use')
  return call?.input
}

// ── objective metrics from raw logs ──────────────────────────────────────────
function objectiveMetrics(run) {
  const m = { rememberCalls: 0, forgetCalls: 0, compactions: 0, storeBytesBySession: [] }
  for (const s of run.sessions) {
    const tcs = [...(s.exchanges || []).flatMap(e => e.tools || []), ...(s.reflectTools || [])]
    for (const t of tcs) { if (t.name === 'remember') m.rememberCalls++; if (t.name === 'forget') m.forgetCalls++ }
    const after = s.storeAfter || {}
    let bytes = 0
    if (after.memory) bytes = Buffer.byteLength(after.memory, 'utf8')
    else if (after.score) bytes = Buffer.byteLength(JSON.stringify(after.score), 'utf8')
    else if (after.relationship !== undefined) bytes = Buffer.byteLength(after.relationship || '', 'utf8')
    else if (after.fullExpandedLen) bytes = after.fullExpandedLen
    m.storeBytesBySession.push(bytes)
  }
  if (run.finalStore?.compactions != null) m.compactions = run.finalStore.compactions
  return m
}

function spark(nums) {
  const b = '▁▂▃▄▅▆▇█'
  const lo = 1, hi = 7
  return nums.map(n => b[Math.max(0, Math.min(7, Math.round((n - lo) / (hi - lo) * 7)))]).join('')
}

function buildReport(scored) {
  const out = []
  out.push('# Relationship-development experiment — results')
  out.push('')
  out.push(`Generated ${new Date().toISOString().slice(0, 10)} · companion model claude-haiku-4-5 · judge claude-sonnet-4-6`)
  out.push('')
  out.push('Question: can an AI companion change how it TREATS a player over many sessions, and which impression-persistence mechanism makes that happen believably? Each session opens with an identical neutral probe ("hey"); the greeting reflects only the cross-session persisted impression. Judge rates warmth / familiarity / trust (1-7) per session.')
  out.push('')

  // group by arc
  for (const arc of ['W', 'S']) {
    const runs = scored.filter(r => r.arc === arc)
    if (!runs.length) continue
    out.push(`## ${arc === 'W' ? 'Warming arc' : 'Souring arc'} — ${ARC_DESC[arc].split(':')[0]}`)
    out.push('')
    out.push('| condition | warmth by session | Δ warmth | familiarity Δ | trust Δ | dir? | shape | drift |')
    out.push('|---|---|---|---|---|---|---|---|')
    for (const r of runs) {
      const j = r.judge
      if (!j?.sessions) { out.push(`| ${r.cond} | (judge failed) | | | | | | |`); continue }
      const w = j.sessions.map(s => s.warmth)
      const f = j.sessions.map(s => s.familiarity)
      const t = j.sessions.map(s => s.trust)
      const dW = w[w.length - 1] - w[0]
      const dF = f[f.length - 1] - f[0]
      const dT = t[t.length - 1] - t[0]
      out.push(`| ${r.cond} | ${spark(w)} ${w.join('')} | ${dW >= 0 ? '+' : ''}${dW} | ${dF >= 0 ? '+' : ''}${dF} | ${dT >= 0 ? '+' : ''}${dT} | ${j.direction_correct ? '✓' : '✗'} | ${j.monotonicity} | ${j.persona_drift} |`)
    }
    out.push('')
  }

  // per-run detail
  out.push('## Per-run detail')
  out.push('')
  for (const r of scored) {
    const j = r.judge
    out.push(`### ${r.cond} · ${r.arc === 'W' ? 'warming' : 'souring'}`)
    if (!j) { out.push('_judge failed_'); out.push(''); continue }
    out.push(`- trajectory: warmth ${spark(j.sessions.map(s => s.warmth))} familiarity ${spark(j.sessions.map(s => s.familiarity))} trust ${spark(j.sessions.map(s => s.trust))}`)
    out.push(`- direction correct: **${j.direction_correct}** · shape: **${j.monotonicity}** · persona drift: **${j.persona_drift}** (${j.drift_note})`)
    out.push(`- in-character: ${j.sessions.map(s => s.in_character).join('')}`)
    out.push(`- judge: ${j.summary}`)
    const m = r.metrics
    out.push(`- store: remember×${m.rememberCalls} forget×${m.forgetCalls} compactions×${m.compactions} · store bytes by session: [${m.storeBytesBySession.join(', ')}]`)
    out.push(`- greetings: ${r.sessions.map(s => JSON.stringify(s.greeting)).join(' → ')}`)
    out.push(`- per-session stance: ${j.sessions.map(s => `s${s.session}:"${s.stance}"`).join(' · ')}`)
    out.push('')
  }

  return out.join('\n')
}

async function main() {
  const files = process.argv.slice(2).filter(a => !a.startsWith('--'))
  const paths = files.length ? files : [join(__dirname, '..', '.planning', 'relationship-experiment-raw-260616.json')]
  const runs = []
  let spendInfo = null
  for (const p of paths) {
    const data = JSON.parse(await readFile(p, 'utf8'))
    spendInfo = data
    for (const r of data.runs || []) runs.push(r)
  }
  console.log(`judging ${runs.length} runs from ${paths.length} file(s) with ${JUDGE_MODEL}`)

  const scored = []
  for (const run of runs) {
    process.stdout.write(`  judging ${run.cond}:${run.arc} ... `)
    let judge = null
    try { judge = await judgeRun(run) } catch (e) { console.log('FAILED', e.message) }
    const metrics = objectiveMetrics(run)
    scored.push({ cond: run.cond, arc: run.arc, sessions: run.sessions, finalStore: run.finalStore, judge, metrics })
    if (judge) console.log(`dir=${judge.direction_correct} shape=${judge.monotonicity} drift=${judge.persona_drift}`)
  }

  const report = buildReport(scored)
  const reportPath = join(__dirname, '..', '.planning', 'relationship-experiment-results-260616.md')
  const scoredPath = join(__dirname, '..', '.planning', 'relationship-experiment-scored-260616.json')
  await writeFile(reportPath, report)
  await writeFile(scoredPath, JSON.stringify(scored, null, 2))
  const jcost = (jin * PRICE.in + jout * PRICE.out) / 1e6
  console.log(`\njudge cost ≈ $${jcost.toFixed(4)} (in ${jin} out ${jout})`)
  if (spendInfo?.dollars) console.log(`companion run cost (from raw) ≈ $${spendInfo.dollars.toFixed(4)}`)
  console.log(`report → ${reportPath}`)
  console.log(`scored → ${scoredPath}`)
}

main().catch(e => { console.error(e); process.exit(1) })
