// scripts/quality-eval/pass63-judge.mjs: blind Opus labels for pass63-probe
// runs (quality pass 63: her re-promise to a line that only acknowledges
// hers). Same shape as pass60b-judge.mjs: one Opus call per case, the
// replies of every arm shuffled and unlabelled, read the way the scorecard
// judge reads a line, against her earlier lines and the facts her snapshot
// showed. A turn with no say() is "quiet": right on an acknowledgement, a
// miss on a guard case (a line that needs an answer or an action).
//
//   node scripts/quality-eval/pass63-judge.mjs --out DIR ARM_DIR...
//
// Key: ~/.sei-dev/anthropic-test-key (or QE_KEY_FILE), never printed.
// Output: DIR/judged.jsonl, DIR/summary.md.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Anthropic from '@anthropic-ai/sdk'
import { PRICES } from './report.mjs'

const argv = process.argv.slice(2)
const oi = argv.indexOf('--out')
const OUT = oi >= 0 ? argv[oi + 1] : null
const ARMS = argv.filter((a, i) => i !== oi && i !== oi + 1)
if (!OUT || !ARMS.length) { console.error('usage: --out DIR ARM_DIR...'); process.exit(2) }
fs.mkdirSync(OUT, { recursive: true })
const JUDGE = 'claude-opus-5-5'
const keyFile = process.env.QE_KEY_FILE || path.join(os.homedir(), '.sei-dev', 'anthropic-test-key')
const anthropic = new Anthropic({ apiKey: fs.readFileSync(keyFile, 'utf8').trim(), maxRetries: 3 })
const P = PRICES[JUDGE]

const rows = []
for (const dir of ARMS) {
  const arm = path.basename(dir)
  for (const l of fs.readFileSync(path.join(dir, 'runs.jsonl'), 'utf8').split('\n')) {
    if (!l.trim()) continue
    const r = JSON.parse(l)
    if (r.error) continue
    rows.push({ ...r, arm })
  }
}
const SKIP = new Set(['remember', 'forget', 'setGoal', 'clearGoal', 'end_loop'])
const replyOf = (r) => {
  const parts = []
  for (const c of r.calls ?? []) {
    for (const t of c.tools) {
      if (t.name === 'say') parts.push(`say: "${String(t.input?.text ?? '')}"`)
      else if (!SKIP.has(t.name)) parts.push(`calls ${t.name}(${JSON.stringify(t.input ?? {})})`)
    }
  }
  return parts.length ? parts.join(' + ') : '(nothing: no line, no action)'
}

function shuffle(a, seed = 7) {
  let x = seed
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648)
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] }
  return a
}

const RUBRIC = `You label one turn of Sui, an AI companion playing Minecraft with a player, the way a careful quality reviewer would. The player is nervous at night; she is with them.

Labels (pick the first that applies):
- invented: the turn states something about the world that the facts below do not support (a mob, where a mob is, an item count, health, a structure), or says she is doing or starting a concrete action right now without calling that action in this turn. A conditional ("if one comes close i'll hit it") is not invented.
- repeat: the turn gives again, in any words, a reassurance, promise, plan or piece of advice she already gave in her earlier lines (I'm here, not going anywhere, not leaving, staying close, you're safe, I got you, eat up, stay put, wood at daylight), and adds nothing true and new. A very short plain reaction of a few words ("np", "ehe", "anytime") is not a repeat on its own.
- quiet: no say() line at all (with or without an action).
- ignored: a line that does not respond to what the player said, or the player asked for something and the turn neither does it nor answers.
- ok: anything else: a short natural reaction, a true and new remark, a real action that fits, a fitting joke, a new question.

Answer with JSON only: [{"id": <number>, "label": "...", "why": "<at most 6 words>"}, ...], one entry per turn.`

const out = []
let cost = 0
const cases = [...new Set(rows.map((r) => r.case))].filter((c) => !process.env.JUDGE_CASES || process.env.JUDGE_CASES.split(',').includes(c))
for (const cid of cases) {
  const rs = shuffle(rows.filter((r) => r.case === cid))
  const ex = rs[0]
  for (let k = 0; k < rs.length; k += 40) {
    const chunk = rs.slice(k, k + 40)
    const ctx = [
      `Facts her snapshot showed at this moment: ${ex.facts ?? 'not given'}.`,
      '',
      'The conversation before, oldest first:',
      ...ex.history,
      '',
      ...(ex.case.startsWith('idle')
        ? [`She left the player's last line ("${ex.priorPlayer.at(-1)}") without a reply. Nothing new has happened for about 6 seconds; this is a quiet tick where she may speak or not.`]
        : [`The player's newest line: "${ex.priorPlayer.at(-1)}"`]),
      '',
      'Turns to label (each is one independent try at this moment):',
      ...chunk.map((r, i) => `${i + 1}. ${replyOf(r)}`),
    ].join('\n')
    const msg = await anthropic.messages.create({
      model: JUDGE, max_tokens: 4000, system: RUBRIC, messages: [{ role: 'user', content: ctx }],
    })
    const u = msg.usage
    cost += ((u.input_tokens ?? 0) * P.in + (u.output_tokens ?? 0) * P.out + (u.cache_creation_input_tokens ?? 0) * P.cw + (u.cache_read_input_tokens ?? 0) * P.cr) / 1e6
    const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
    let labels = []
    try { labels = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1)) } catch { console.error(`bad judge output for ${cid}`) }
    chunk.forEach((r, i) => {
      const l = labels.find((x) => x.id === i + 1) ?? { label: 'unjudged', why: '' }
      out.push({ arm: r.arm, case: cid, rep: r.rep, noteFired: r.noteFired, reply: replyOf(r), label: l.label, why: l.why })
    })
  }
}

fs.writeFileSync(path.join(OUT, 'judged.jsonl'), out.map((o) => JSON.stringify(o)).join('\n') + '\n')
const arms = [...new Set(out.map((o) => o.arm))]
const LABELS = ['ok', 'repeat', 'invented', 'ignored', 'quiet']
const md = ['# pass63 judge', '', `judge ${JUDGE}, cost $${cost.toFixed(3)}`, '']
md.push(`| case | ${arms.map((a) => `${a} ok/rep/inv/ign/quiet`).join(' | ')} |`, `|---|${arms.map(() => '---:').join('|')}|`)
for (const cid of cases) {
  md.push(`| ${cid} | ${arms.map((a) => { const xs = out.filter((o) => o.case === cid && o.arm === a); return xs.length ? LABELS.map((L) => xs.filter((o) => o.label === L).length).join('/') + ` of ${xs.length}` : '-' }).join(' | ')} |`)
}
md.push('', '## Replies', '')
for (const o of [...out].sort((a, b) => a.case.localeCompare(b.case) || a.arm.localeCompare(b.arm))) md.push(`- ${o.case} ${o.arm} ${o.label}${o.noteFired ? '' : ' (no note)'}: ${o.reply.slice(0, 220)} [${o.why}]`)
fs.writeFileSync(path.join(OUT, 'summary.md'), md.join('\n') + '\n')
console.log(md.slice(0, cases.length + 6).join('\n'))
