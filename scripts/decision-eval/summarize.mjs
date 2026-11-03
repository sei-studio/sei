#!/usr/bin/env node
// scripts/decision-eval/summarize.mjs: trials.jsonl -> markdown table per
// level x decider x task (latency pooled over every decision in the cell).
//   node scripts/decision-eval/summarize.mjs <OUT dir> [--json cells.json]
import fs from 'node:fs'
import path from 'node:path'
import { TASKS } from './tasks.mjs'

const OUT = process.argv[2]
const jsonOut = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null
const rows = fs.readFileSync(path.join(OUT, 'trials.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const pct = (a, q) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))]) }
const med = (a) => pct(a, 0.5)
const safe = (s) => s.replace(/[^\w.@-]+/g, '_')
const short = (d) => d.replace('openai:gpt-6-luna@none', 'openai').replace(/^sei$/, 'sei-brain')

const cells = new Map()
for (const r of rows) {
  const k = `${r.level}|${r.decider}|${r.task}`
  if (!cells.has(k)) cells.set(k, [])
  cells.get(k).push(r)
}
const LEVEL_ORDER = ['L1', 'L2', 'L3', 'base']
const TASK_ORDER = Object.keys(TASKS)
const keys = [...cells.keys()].sort((a, b) => {
  const [la, da, ta] = a.split('|'), [lb, db, tb] = b.split('|')
  return TASK_ORDER.indexOf(ta) - TASK_ORDER.indexOf(tb) || LEVEL_ORDER.indexOf(la) - LEVEL_ORDER.indexOf(lb) || da.localeCompare(db)
})
const out = []
const lines = ['| task | level | decider | n | success | furthest milestone (per rep) | med time s | med steps | dec/s | p50 / p95 ms | invalid | false done | died | $ total | $/h |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|']
for (const k of keys) {
  const rs = cells.get(k)
  const [level, decider, task] = k.split('|')
  const lat = []
  for (const r of rs) {
    const f = path.join(OUT, `${level}-${safe(decider)}-${task}`, `r${r.rep}`, 'steps.jsonl')
    if (!fs.existsSync(f)) continue
    for (const l of fs.readFileSync(f, 'utf8').split('\n')) { if (!l) continue; const s = JSON.parse(l); if (typeof s.ms === 'number') lat.push(s.ms) }
  }
  const ok = rs.filter((r) => r.success).length
  const ms = rs.map((r) => `${r.milestone}/${r.milestones}`).join(', ')
  const best = Math.max(...rs.map((r) => r.milestone))
  const bestLabel = best ? TASKS[task].milestones[Math.min(best, TASKS[task].milestones.length) - 1] : 'none'
  const cost = rs.reduce((a, r) => a + (r.costUsd || 0), 0)
  const timeS = rs.reduce((a, r) => a + r.timeMs, 0) / 1000
  const steps = rs.reduce((a, r) => a + r.steps, 0)
  const cell = {
    task, level, decider: short(decider), n: rs.length, success: ok,
    milestones: ms, best: bestLabel,
    medTimeS: Math.round(med(rs.map((r) => r.timeMs)) / 1000), medSteps: med(rs.map((r) => r.steps)),
    dps: steps ? Number((steps / timeS).toFixed(2)) : 0, p50: pct(lat, 0.5), p95: pct(lat, 0.95),
    invalid: rs.reduce((a, r) => a + r.invalid, 0), falseDone: rs.filter((r) => r.falseComplete).length, died: rs.filter((r) => r.died).length,
    cost: Number(cost.toFixed(4)), perHour: Number((cost / (timeS / 3600)).toFixed(3)),
    smelted: rs.filter((r) => r.extra?.smelted).length,
    layaCpu: med(rs.map((r) => r.layaCpuPct).filter((x) => x != null)), layaRss: med(rs.map((r) => r.layaRssMb).filter((x) => x != null)),
    stop: rs.map((r) => r.stopReason?.slice(0, 20)).join('; '),
  }
  out.push(cell)
  lines.push(`| ${task} | ${level} | ${cell.decider} | ${cell.n} | ${ok}/${rs.length} | ${ms} (best: ${bestLabel}) | ${cell.medTimeS} | ${cell.medSteps} | ${cell.dps} | ${cell.p50 ?? '-'} / ${cell.p95 ?? '-'} | ${cell.invalid} | ${cell.falseDone} | ${cell.died} | ${cell.cost} | ${cell.perHour} |`)
}
console.log(lines.join('\n'))
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(out, null, 1))
