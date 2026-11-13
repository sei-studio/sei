#!/usr/bin/env node
// A/B table for two arms of row files (DST run.ts <arm>.jsonl, or
// stardew-goal-ab.mjs <arm>.jsonl): per group, pass k/n with a Wilson 95%
// interval per arm and the branch minus dev difference with Newcombe's
// hybrid-score interval; pooled over all groups at the end.
//
// DST rows add: early deaths (deaths > 0), input and output tokens per LLM
// turn, and verb failure classes (a coarse bucket of each action result).
// Stardew rows add: stale rate (already done or out of season).
//
// Usage: node scripts/quality-eval/ab-stats.mjs <dev.jsonl> <branch.jsonl> [--key scenario|scene]
import { readFileSync } from 'node:fs'

const [devPath, brPath] = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const keyArg = process.argv.indexOf('--key')
const load = (p) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => !r.error)
const dev = load(devPath)
const br = load(brPath)
const KEY = keyArg > 0 ? process.argv[keyArg + 1] : (dev[0]?.scene != null ? 'scene' : 'scenario')

const Z = 1.959964
function wilson(k, n) {
  if (!n) return [0, 1]
  const p = k / n
  const d = 1 + Z * Z / n
  const c = (p + Z * Z / (2 * n)) / d
  const h = (Z * Math.sqrt(p * (1 - p) / n + Z * Z / (4 * n * n))) / d
  return [Math.max(0, c - h), Math.min(1, c + h)]
}
/** Newcombe (1998) method 10: difference p2 - p1 of independent proportions. */
function newcombe(k1, n1, k2, n2) {
  const p1 = k1 / n1, p2 = k2 / n2
  const [l1, u1] = wilson(k1, n1), [l2, u2] = wilson(k2, n2)
  const d = p2 - p1
  return [d - Math.sqrt((p2 - l2) ** 2 + (u1 - p1) ** 2), d + Math.sqrt((u2 - p2) ** 2 + (p1 - l1) ** 2)]
}
const pct = (x) => `${Math.round(x * 100)}%`
const ci = ([a, b]) => `[${pct(a)}, ${pct(b)}]`
const sci = ([a, b]) => `[${a >= 0 ? '+' : ''}${Math.round(a * 100)}, ${b >= 0 ? '+' : ''}${Math.round(b * 100)}]`

/** Coarse bucket of a DST action result (eval-side only). */
function failClass(r) {
  const s = String(r ?? '').toLowerCase()
  if (s === 'cancelled' || s.startsWith('replaced by')) return null // the brain moved on
  if (/^cant_reach|blocked by water|no path|still .* away/.test(s)) return 'cant_reach'
  if (/^timeout/.test(s)) return 'timeout'
  if (/without an? |need(s)? an? |no (axe|pickaxe|shovel|hammer|bug net)/.test(s)) return 'missing_tool'
  if (/^no "?[\w ]+"? in your inventory|not enough|you have no|missing/.test(s)) return 'missing_item'
  if (/^no .*(nearby|within|around|matching)|not found|target is gone|unknown (target|item)/.test(s)) return 'no_target'
  if (/could not|would not|failed|refuses|can't|cannot/.test(s)) return 'verb_failed'
  if (/^gathered 0 /.test(s)) return 'gathered_none'
  return null
}

const groups = [...new Set([...dev, ...br].map((r) => r[KEY]))]
const isDst = KEY === 'scenario'
const rows = []
let pk1 = 0, pn1 = 0, pk2 = 0, pn2 = 0
for (const g of groups) {
  const a = dev.filter((r) => r[KEY] === g), b = br.filter((r) => r[KEY] === g)
  const k1 = a.filter((r) => r.pass).length, k2 = b.filter((r) => r.pass).length
  pk1 += k1; pn1 += a.length; pk2 += k2; pn2 += b.length
  const extra = (rs) => {
    if (isDst) {
      const turns = rs.reduce((s, r) => s + (r.turns || 0), 0) || 1
      const deaths = rs.filter((r) => (r.deaths || 0) > 0).length
      return `${deaths}/${rs.length} | ${Math.round(rs.reduce((s, r) => s + (r.tok_in || 0), 0) / turns)} | ${Math.round(rs.reduce((s, r) => s + (r.tok_out || 0), 0) / turns)}`
    }
    const stale = rs.filter((r) => r.stale).length
    const committed = rs.filter((r) => r.committed).length
    return `${stale}/${rs.length} | ${committed}/${rs.length} | ${Math.round(rs.reduce((s, r) => s + (r.tok_in || 0), 0) / (rs.length || 1))}`
  }
  rows.push(`| ${g} | ${k1}/${a.length} ${ci(wilson(k1, a.length))} | ${k2}/${b.length} ${ci(wilson(k2, b.length))} | ${a.length && b.length ? sci(newcombe(k1, a.length, k2, b.length)) : '-'} | ${extra(a)} | ${extra(b)} |`)
}
const head = isDst
  ? '| scenario | dev pass [95% CI] | branch pass [95% CI] | branch - dev, pts [95% CI] | dev deaths | dev tok in/turn | dev tok out/turn | branch deaths | branch tok in/turn | branch tok out/turn |'
  : '| scene | dev pass [95% CI] | branch pass [95% CI] | branch - dev, pts [95% CI] | dev stale | dev committed | dev tok in | branch stale | branch committed | branch tok in |'
console.log(head)
console.log('|---|---|---|---|---|---|---|---|---|---|')
for (const r of rows) console.log(r)
console.log(`| **pooled** | ${pk1}/${pn1} ${ci(wilson(pk1, pn1))} | ${pk2}/${pn2} ${ci(wilson(pk2, pn2))} | ${sci(newcombe(pk1, pn1, pk2, pn2))} | | | | | | |`)
if (!isDst) {
  const s1 = dev.filter((r) => r.stale).length, s2 = br.filter((r) => r.stale).length
  console.log(`\nstale (already done or out of season), pooled: dev ${s1}/${dev.length} ${ci(wilson(s1, dev.length))}, branch ${s2}/${br.length} ${ci(wilson(s2, br.length))}, branch - dev ${sci(newcombe(s1, dev.length, s2, br.length))} pts`)
  for (const g of groups) {
    const a = dev.filter((r) => r[KEY] === g), b = br.filter((r) => r[KEY] === g)
    const x1 = a.filter((r) => r.stale).length, x2 = b.filter((r) => r.stale).length
    console.log(`  ${g}: dev ${x1}/${a.length}, branch ${x2}/${b.length}, branch - dev ${sci(newcombe(x1, a.length, x2, b.length))} pts`)
  }
}

if (isDst) {
  console.log('\nVerb failure classes (action results, all scenarios):')
  for (const [name, rs] of [['dev', dev], ['branch', br]]) {
    const counts = {}
    let calls = 0
    for (const r of rs) for (const x of r.results ?? []) { calls++; const c = failClass(x.r); if (c) counts[c] = (counts[c] || 0) + 1 }
    const fails = Object.values(counts).reduce((s, n) => s + n, 0)
    console.log(`  ${name}: ${fails}/${calls} results failed; ${Object.entries(counts).sort((p, q) => q[1] - p[1]).map(([c, n]) => `${c} ${n}`).join(', ') || 'none'}`)
  }
  console.log('\nVerbs called (dev / branch):')
  const verbs = (rs) => { const m = {}; for (const r of rs) for (const x of r.acts ?? []) m[x] = (m[x] || 0) + 1; return m }
  const vd = verbs(dev), vb = verbs(br)
  for (const v of [...new Set([...Object.keys(vd), ...Object.keys(vb)])].sort()) console.log(`  ${v}: ${vd[v] || 0} / ${vb[v] || 0}`)
}
const spend = (rs) => rs.reduce((s, r) => s + (r.usd || 0), 0)
console.log(`\nspend: dev $${spend(dev).toFixed(3)}, branch $${spend(br).toFixed(3)}`)
