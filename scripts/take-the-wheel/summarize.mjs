#!/usr/bin/env node
// Aggregates <out>/runs.jsonl (+ each run's steps.jsonl) into the results
// table: one row per task x arm x model. Seconds per action are pooled over
// every step of every run in the group (step wall time / actions in it).
//   node summarize.mjs [--out dir] [--md]
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]] : a), []));
const OUT = args.out || `${process.env.HOME}/suisei/reports/take-the-wheel-2026-11-03/runs`;
const runs = readFileSync(join(OUT, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const pct = (xs, q) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))]; };
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const f = (v, d = 2) => (v == null ? '-' : Number(v).toFixed(d));

const groups = new Map();
for (const r of runs) {
  if (r.error) continue;
  const key = `${r.task}|${r.arm}|${r.model || 'none'}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}
const rows = [];
for (const [key, rs] of groups) {
  const [task, arm, model] = key.split('|');
  const perAct = [];
  for (const r of rs) {
    const p = join(OUT, r.runId, 'steps.jsonl');
    if (!existsSync(p)) continue;
    for (const l of readFileSync(p, 'utf8').split('\n').filter(Boolean)) {
      const s = JSON.parse(l);
      if (s.wallMs && s.actions?.length) perAct.push(s.wallMs / s.actions.length / 1000);
    }
  }
  rows.push({
    task, arm, model: model.replace('claude-', ''), pass: rs.filter((r) => r.pass).length, reps: rs.length,
    actP50: pct(perAct, 0.5), actP95: pct(perAct, 0.95),
    cost: mean(rs.map((r) => r.cost)), perHour: mean(rs.map((r) => r.costPerHour)),
    wall: mean(rs.map((r) => r.wallS)), metric: rs.map((r) => r.metric).join('/'), falseDone: rs.filter((r) => r.falseDone).length,
  });
}
const order = ['mc-walk', 'mc-blocks', 'mc-find', '2048', 'cookie'];
rows.sort((a, b) => order.indexOf(a.task) - order.indexOf(b.task) || a.arm.localeCompare(b.arm) || a.model.localeCompare(b.model));
const errors = runs.filter((r) => r.error).length;
if (args.md) {
  console.log('| Task | Arm | Model | Pass | s/action p50 | s/action p95 | $/run | $/hour | mean wall s | metric per rep | false done |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) console.log(`| ${r.task} | ${r.arm} | ${r.model} | ${r.pass}/${r.reps} | ${f(r.actP50)} | ${f(r.actP95)} | ${f(r.cost, 4)} | ${f(r.perHour, 3)} | ${f(r.wall, 0)} | ${r.metric} | ${r.falseDone} |`);
} else {
  for (const r of rows) console.log(`${r.task.padEnd(9)} ${r.arm.padEnd(6)} ${r.model.padEnd(10)} ${r.pass}/${r.reps}  act ${f(r.actP50)}/${f(r.actP95)}s  $${f(r.cost, 4)}/run  $${f(r.perHour, 3)}/h  wall ${f(r.wall, 0)}s  metric ${r.metric}  falseDone ${r.falseDone}`);
}
if (errors) console.log(`(${errors} runs errored and are excluded)`);
let spend = 0; try { spend = JSON.parse(readFileSync(join(OUT, 'spend.json'), 'utf8')).total; } catch {}
console.log(`total spend $${f(spend, 4)}`);
