// scripts/quality-eval/consistency/report.mjs: per-category scores for each
// arm, and the paired delta (B minus A) with a bootstrap 95% interval.
//
//   node scripts/quality-eval/consistency/report.mjs <outDir>
//
// Scores, each 0..1:
//   A, B, C  answer: correct 1, partial 0.5, anything else 0
//   D        abstention: abstained 1, partial 0.5, anything else 0
//   E        tone of the neutral opener: (tone - 1) / 4, 0 if it said something false
//   F        same question across surfaces: (same - 1) / 4 from the judge,
//            times the share of its three answers that were correct
// plus two cross-category rates: invented (share of answers that made
// something up) and tone (mean tone over every answer).
//
// The delta's interval is a stratified bootstrap: within each stratum
// (character, probe, surface; F: character, probe) the reps of each arm are
// resampled independently, so it covers the run-to-run noise of both arms.
import fs from 'node:fs'
import path from 'node:path'
import { rng } from '../lib/stats.mjs'
import { CATEGORIES } from './life.mjs'
import { costOf } from '../persona/report.mjs'

const ANSWER = { correct: 1, partial: 0.5 }
export function answerScore(a) {
  if (a.cat === 'D') return a.verdict === 'abstained' ? 1 : a.verdict === 'partial' ? 0.5 : 0
  if (a.cat === 'E') return a.verdict === 'invented' || a.verdict === 'wrong' || a.verdict === 'no_reply' ? 0 : (Number(a.tone) - 1) / 4
  return ANSWER[a.verdict] ?? 0
}

/** Units: {arm, cat, stratum, score}. */
export function units(graded) {
  const out = []
  for (const a of graded.answers) {
    if (a.cat === 'F') continue
    out.push({ arm: a.arm, cat: a.cat, stratum: `${a.char}/${a.probe}/${a.surface}`, score: answerScore(a) })
    if (a.cat !== 'D' && a.cat !== 'E') out.push({ arm: a.arm, cat: 'invented', stratum: `${a.char}/${a.probe}/${a.surface}`, score: a.verdict === 'invented' ? 1 : 0 })
    out.push({ arm: a.arm, cat: 'tone', stratum: `${a.char}/${a.probe}/${a.surface}`, score: (Number(a.tone) - 1) / 4 })
  }
  for (const a of graded.answers) if (a.cat === 'D') out.push({ arm: a.arm, cat: 'invented', stratum: `${a.char}/${a.probe}/${a.surface}`, score: a.verdict === 'invented' ? 1 : 0 })
  for (const q of graded.questions) {
    if (q.cat !== 'F') continue
    const mine = graded.answers.filter((a) => a.arm === q.arm && a.char === q.char && a.rep === q.rep && a.probe === q.probe)
    const acc = mine.length ? mine.reduce((s, a) => s + (ANSWER[a.verdict] ?? 0), 0) / mine.length : 0
    out.push({ arm: q.arm, cat: 'F', stratum: `${q.char}/${q.probe}`, score: ((Number(q.same) - 1) / 4) * acc })
  }
  return out
}

// 261113 (D3): tics, from the raw answers (answers/<arm>-<char>-<rep>.jsonl).
// A set is one surface's twelve answers to twelve different questions, so a
// word that keeps coming back in them is the character's tic, not the topic.
//   tic_opener: share of answers whose first word opens another answer too
//   tic_term:   share of answers holding a word (3+ letters, not a stop word
//               or a name) that at least a third of the set uses
const STOP = new Set('the and you your for that this what with are was but not just its it\'s have can all out about too get got like one some yeah yes okay kinda then them they their when how who why did does was were has had our ours his her she him from into will would could should there here been being very really also only still even more most much any many dont don\'t cant can\'t thats that\'s im i\'m ive i\'ve youre you\'re gonna wanna last time remember know think mean right well now day today ago again'.split(' '))
const words = (t) => String(t).toLowerCase().match(/[a-z][a-z']+/g) ?? []
export function ticUnits(dir, names = []) {
  const out = []
  const ad = path.join(dir, 'answers')
  if (!fs.existsSync(ad)) return out
  const skip = new Set(names.map((n) => String(n).toLowerCase()))
  for (const f of fs.readdirSync(ad).filter((f) => /^[AB]-.+-\d+\.jsonl$/.test(f))) {
    const [arm, char] = f.split('-')
    const rows = fs.readFileSync(path.join(ad, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    for (const surface of [...new Set(rows.map((r) => r.surface))]) {
      const set = rows.filter((r) => r.surface === surface).map((r) => r.says.join(' ')).filter((t) => t.trim())
      if (set.length < 4) continue
      const firsts = set.map((t) => words(t)[0] ?? '')
      const terms = set.map((t) => new Set(words(t).filter((w) => w.length >= 3 && !STOP.has(w) && !skip.has(w))))
      const df = new Map()
      for (const ts of terms) for (const w of ts) df.set(w, (df.get(w) ?? 0) + 1)
      const ticWords = new Set([...df].filter(([, n]) => n >= Math.max(3, Math.ceil(set.length / 3))).map(([w]) => w))
      set.forEach((_, i) => {
        const stratum = `${char}/${surface}`
        out.push({ arm, cat: 'tic_opener', stratum, score: firsts[i] && firsts.some((w, j) => j !== i && w === firsts[i]) ? 1 : 0 })
        out.push({ arm, cat: 'tic_term', stratum, score: [...terms[i]].some((w) => ticWords.has(w)) ? 1 : 0 })
      })
    }
  }
  return out
}

const meanOf = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN)

export function compare(us, cat, armA, armB, iters = 4000) {
  const strata = new Map()
  for (const u of us) {
    if (u.cat !== cat) continue
    if (!strata.has(u.stratum)) strata.set(u.stratum, { [armA]: [], [armB]: [] })
    strata.get(u.stratum)[u.arm]?.push(u.score)
  }
  const keys = [...strata.keys()].filter((k) => strata.get(k)[armA].length && strata.get(k)[armB].length)
  const point = (pick) => {
    let a = 0, b = 0
    for (const k of keys) { a += pick(strata.get(k)[armA]); b += pick(strata.get(k)[armB]) }
    return { a: a / keys.length, b: b / keys.length }
  }
  const p = point(meanOf)
  const r = rng(7)
  const resample = (xs) => { let s = 0; for (let i = 0; i < xs.length; i++) s += xs[Math.floor(r() * xs.length)]; return s / xs.length }
  const deltas = []
  for (let i = 0; i < iters; i++) { const q = point(resample); deltas.push(q.b - q.a) }
  deltas.sort((x, y) => x - y)
  const n = keys.reduce((s, k) => s + strata.get(k)[armA].length, 0)
  return { a: p.a, b: p.b, delta: p.b - p.a, lo: deltas[Math.floor(0.025 * iters)], hi: deltas[Math.floor(0.975 * iters)], strata: keys.length, n }
}

export function single(us, cat, arm) {
  const xs = us.filter((u) => u.cat === cat && u.arm === arm).map((u) => u.score)
  return { mean: meanOf(xs), n: xs.length }
}

const pct = (x) => (Number.isFinite(x) ? `${(100 * x).toFixed(0)}%` : '-')
const sgn = (x) => `${x >= 0 ? '+' : ''}${(100 * x).toFixed(0)}`

export function render(dir) {
  const graded = JSON.parse(fs.readFileSync(path.join(dir, 'graded.json'), 'utf8'))
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'))
  const us = [...units(graded), ...ticUnits(dir, ['alex', ...config.chars])]
  const arms = config.arms.map((a) => a.label)
  const lines = [`# Consistency eval: ${config.mode} mode, history-n ${config.historyN}, reps ${config.reps}, chars ${config.chars.join(',')}`]
  lines.push(`arms: ${config.arms.map((a) => `${a.label}=${a.ref}@${String(a.sha).slice(0, 9)}`).join('  ')}`)
  const cats = [...Object.keys(CATEGORIES), 'invented', 'tone', 'tic_opener', 'tic_term']
  const LABELS = {
    invented: 'invented (lower is better)',
    tone: 'tone over all answers',
    tic_opener: 'tic: repeated opener (lower is better)',
    tic_term: 'tic: recurring word (lower is better)',
  }
  const label = (c) => (CATEGORIES[c] ? `${c} ${CATEGORIES[c]}` : LABELS[c])
  if (arms.length === 2) {
    lines.push('', 'category | A | B | B-A [95% CI] | units')
    for (const c of cats) {
      const r = compare(us, c, arms[0], arms[1])
      lines.push(`${label(c)} | ${pct(r.a)} | ${pct(r.b)} | ${sgn(r.delta)} [${sgn(r.lo)}, ${sgn(r.hi)}] | ${r.n}`)
    }
    lines.push('', 'by surface (A, B, C, F answers correct):')
    for (const s of ['text', 'voice', 'mc']) {
      const sub = units({ answers: graded.answers.filter((a) => a.surface === s && 'ABC'.includes(a.cat)), questions: [] }).filter((u) => 'ABC'.includes(u.cat))
      const r = compare(sub.map((u) => ({ ...u, cat: 'x' })), 'x', arms[0], arms[1])
      lines.push(`${s}: ${pct(r.a)} -> ${pct(r.b)} (${sgn(r.delta)} [${sgn(r.lo)}, ${sgn(r.hi)}])`)
    }
  } else {
    lines.push('', 'category | score | units')
    for (const c of cats) { const r = single(us, c, arms[0]); lines.push(`${label(c)} | ${pct(r.mean)} | ${r.n}`) }
  }
  const usage = graded.usage ?? []
  const cost = usage.reduce((s, u) => s + costOf(u.model, u), 0)
  const by = {}
  for (const u of usage) by[u.model] = (by[u.model] ?? 0) + costOf(u.model, u)
  lines.push('', `spend: $${cost.toFixed(2)} (${Object.entries(by).map(([m, c]) => `${m} $${c.toFixed(2)}`).join(', ')})`)
  return lines.join('\n')
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(render(path.resolve(process.argv[2])))
