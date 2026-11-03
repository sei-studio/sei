#!/usr/bin/env node
// scripts/decision-eval/laya-bench.mjs: Laya latency/throughput on this CPU.
// Single calls per level (real L1/L2/L3-sized states) and /batch at several
// batch sizes for the L1 reflex question. Run with nothing else on the box.
//   node scripts/decision-eval/laya-bench.mjs [--reps 10] > laya-bench.json
import { L1_OPTIONS, L1_INSTRUCTIONS, formatL1, optionsL2, formatL2, L2_INSTRUCTIONS, optionsL3, formatL3, L3_INSTRUCTIONS } from './state.mjs'

const URL_ = process.env.LAYA_URL || 'http://127.0.0.1:8765'
const reps = Number(process.argv[process.argv.indexOf('--reps') + 1]) || 10
const me = { pos: { x: 176, y: 71, z: 0 }, yaw: 0, pitch: 0, hp: 14, food: 18, held: 'stone_sword', inv: { stone_sword: 1, bread: 3 }, hotbar: ['stone_sword', 'bread', null, null, null, null, null, null, null], selected: 0 }
const ent = (name, kind, dist, bearing) => ({ name, kind, dist, bearing, pos: { x: 176 + dist, y: 71, z: 0 } })
const blk = (name, dist, bearing, pitchTo = 0) => ({ name, dist, bearing, pitchTo, reach: dist <= 4.5, pos: { x: 180, y: 71, z: 2 }, count: 3 })
const o1 = { task: 'It is night and zombies are coming. Survive for 60 seconds.', self: me, entities: [ent('zombie', 'hostile', 2.4, 10), ent('zombie', 'hostile', 5.1, -60)], blocks: [], below: ['grass_block', 'stone'], reflex: 'attack', reflexForS: 1.2, timeLeftS: 41 }
const o2 = { ...o1, task: 'Get iron: find and mine iron ore (it is underground nearby), then smelt it into an iron ingot in the furnace.', step: 4, maxSteps: 30, last: 'goto_furnace -> goTo: reached', self: { ...me, inv: { stone_pickaxe: 1, coal: 3, raw_iron: 1 } }, entities: [], blocks: [blk('furnace', 1.8, 0), blk('stone', 3, 0, -60), blk('iron_ore', 20.8, 40, -10), blk('cobblestone', 15, -30)] }
const o3 = { ...o2, crosshair: { block: { name: 'grass_block', dist: 4 } } }

async function post(p, body) {
  const t = performance.now()
  const r = await fetch(URL_ + p, { method: 'POST', body: JSON.stringify(body) })
  const j = await r.json()
  return { wall: performance.now() - t, j }
}
const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))]) }
const res = { single: {}, batch: {} }
const L2O = Object.fromEntries(Object.entries(optionsL2(o2)).map(([k, v]) => [k, v.desc]))
const qs = {
  L1: { state: formatL1(o1), instructions: L1_INSTRUCTIONS, options: L1_OPTIONS },
  L2: { state: formatL2(o2), instructions: L2_INSTRUCTIONS, options: L2O, max_len: 1024, head_max_len: 384 },
  L3: { state: formatL3(o3), instructions: L3_INSTRUCTIONS, options: optionsL3(o3), max_len: 1024, head_max_len: 448 },
}
await post('/choose', qs.L1) // warm
for (const [lv, q] of Object.entries(qs)) {
  const ms = []
  for (let i = 0; i < reps; i++) { const { j } = await post('/choose', q); ms.push(j.ms ?? j.modelMs ?? 0) }
  res.single[lv] = { p50: pct(ms, 0.5), p95: pct(ms, 0.95), options: Object.keys(q.options).length, stateChars: q.state.length }
  console.error(lv, res.single[lv])
}
for (const bs of [1, 4, 8, 16, 32]) {
  const states = Array.from({ length: bs }, () => qs.L1.state)
  const ms = []
  for (let i = 0; i < Math.max(3, Math.round(reps / 2)); i++) { const { j } = await post('/batch', { states, instructions: L1_INSTRUCTIONS, options: L1_OPTIONS, batch_size: bs }); ms.push(j.ms) }
  res.batch[bs] = { p50Ms: pct(ms, 0.5), perDecisionMs: Math.round(pct(ms, 0.5) / bs), decisionsPerSec: Number((bs / (pct(ms, 0.5) / 1000)).toFixed(1)) }
  console.error('batch', bs, res.batch[bs])
}
console.log(JSON.stringify(res, null, 1))
