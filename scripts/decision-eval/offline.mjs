#!/usr/bin/env node
// scripts/decision-eval/offline.mjs: a quick no-server check of each decider
// on hand-written states with known good answers, per integration level.
// Answers the "is this arm at chance?" question before any live trial.
//
//   node scripts/decision-eval/offline.mjs --deciders laya,openai:gpt-6-luna@none [--levels L1,L2,L3] [--out file.jsonl]
//
// Laya budgets per level come from LAYA_BUDGET (see run.mjs) unless --laya-default.
import fs from 'node:fs'
import { makeDecider } from './deciders.mjs'
import { L1_OPTIONS, L1_OPTIONS_COND, L1_INSTRUCTIONS, formatL1, optionsL2, formatL2, L2_INSTRUCTIONS, optionsL3, formatL3, L3_INSTRUCTIONS } from './state.mjs'

const argv = process.argv.slice(2)
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d }
const DECIDERS = opt('deciders', 'laya').split(',')
const LEVELS = opt('levels', 'L1,L2,L3').split(',')
const OUT = opt('out', null)
export const LAYA_BUDGET = { L1: {}, L2: { maxLen: 1024, headMaxLen: 384 }, L3: { maxLen: 1024, headMaxLen: 448 } }

const me = (o = {}) => ({ pos: { x: 176.5, y: 71, z: 0.5 }, yaw: Math.PI / 2, pitch: 0, hp: 20, food: 20, held: null, inv: {}, hotbar: Array(9).fill(null), selected: 0, ...o })
const blk = (name, dist, bearing = 0, pitchTo = 0, x = {}) => ({ name, pos: { x: 180, y: 71, z: 0 }, dist, bearing, pitchTo, reach: dist <= 4.5, count: 1, ...x })
const ent = (name, kind, dist, bearing = 0) => ({ name, kind, pos: { x: 180, y: 71, z: 0 }, dist, bearing })
const base = (task, o) => ({ task, step: 5, maxSteps: 60, last: null, blocks: [], entities: [], below: ['grass_block', 'stone'], crosshair: { block: null, entity: null }, ui: null, ...o })

const T = { nav: 'Walk to the gold block.', logs: 'Collect 4 oak logs from the trees nearby.', craft: 'Craft oak planks from your logs, then craft a crafting table.', stone: 'Mine 3 stone (the stone is under the grass). You have a wooden pickaxe.', fight: 'It is night and zombies are coming. Survive for 60 seconds.', cow: 'Find a cow and kill it to get beef.', iron: 'Get iron: mine iron ore and smelt it into an iron ingot.' }

const CASES = {
  L1: [
    ['zombie close, full hp', base(T.fight, { self: me({ held: 'stone_sword', hp: 18 }), entities: [ent('zombie', 'hostile', 2.0)] }), ['attack']],
    ['two zombies close, hp 4', base(T.fight, { self: me({ held: 'stone_sword', hp: 4, food: 18, inv: { bread: 3 } }), entities: [ent('zombie', 'hostile', 2.5), ent('zombie', 'hostile', 3.1, 40)] }), ['flee', 'back_off']],
    ['no hostiles, food 8', base(T.fight, { self: me({ held: 'stone_sword', hp: 14, food: 8, inv: { bread: 3 } }) }), ['eat']],
    ['nothing to do', base(T.fight, { self: me({ held: 'stone_sword' }) }), ['none']],
    ['zombie far, full hp', base(T.fight, { self: me({ held: 'stone_sword' }), entities: [ent('zombie', 'hostile', 14)] }), ['none', 'attack']],
    ['three zombies on you, hp 6', base(T.fight, { self: me({ held: 'stone_sword', hp: 6 }), entities: [ent('zombie', 'hostile', 1.5), ent('zombie', 'hostile', 2), ent('zombie', 'hostile', 2.4, -30)] }), ['flee']],
    ['mid-attack zombie close', base(T.fight, { self: me({ held: 'stone_sword', hp: 15 }), entities: [ent('zombie', 'hostile', 1.5)], reflex: 'attack', reflexForS: 2.1 }), ['attack']],
    ['hostiles far, food 10, hp 12', base(T.fight, { self: me({ held: 'stone_sword', hp: 12, food: 10, inv: { bread: 2 } }), entities: [ent('zombie', 'hostile', 20)] }), ['eat']],
    ['creeper close', base(T.fight, { self: me({ held: 'stone_sword' }), entities: [ent('creeper', 'hostile', 3)] }), ['back_off', 'flee']],
    ['zombie 3 m, sword in bag', base(T.fight, { self: me({ held: null, inv: { stone_sword: 1 } }), entities: [ent('zombie', 'hostile', 3)] }), ['attack']],
  ],
  L2: [
    ['logs: tree 6 m', base(T.logs, { self: me(), blocks: [blk('oak_log', 6, 0, 0, { count: 15 })] }), ['gather_log']],
    ['logs: have 4', base(T.logs, { self: me({ inv: { oak_log: 4 } }), blocks: [blk('oak_log', 3)] }), ['complete']],
    ['craft: have logs', base(T.craft, { self: me({ inv: { oak_log: 4 } }) }), ['craft_planks']],
    ['craft: have planks', base(T.craft, { self: me({ inv: { oak_planks: 16 } }) }), ['craft_crafting_table']],
    ['craft: have table', base(T.craft, { self: me({ inv: { oak_planks: 12, crafting_table: 1 } }) }), ['complete', 'place_table']],
    ['stone: pickaxe in bag', base(T.stone, { self: me({ inv: { wooden_pickaxe: 1 } }), blocks: [blk('stone', 1.6, 0, -70, { count: 200 })] }), ['gather_stone', 'equip_wooden_pickaxe']],
    ['stone: have 3', base(T.stone, { self: me({ held: 'wooden_pickaxe', inv: { wooden_pickaxe: 1, cobblestone: 3 } }), blocks: [blk('stone', 1.6)] }), ['complete']],
    ['nav: gold 21 m', base(T.nav, { self: me(), blocks: [blk('gold_block', 21, 180)] }), ['goto_gold']],
    ['cow: nothing in view', base(T.cow, { self: me(), blocks: [blk('stone', 1.6, 0, -70)] }), ['explore_forward', 'explore_left', 'explore_right', 'explore_back']],
    ['cow: cow 14 m', base(T.cow, { self: me(), entities: [ent('cow', 'animal', 14)] }), ['attack_cow']],
    ['fight: zombie 3 m', base(T.fight, { self: me({ held: 'stone_sword', hp: 14, inv: { stone_sword: 1, bread: 3 } }), entities: [ent('zombie', 'hostile', 3)] }), ['attack_zombie']],
    ['fight: hp 5 food 12 zombie far', base(T.fight, { self: me({ held: 'stone_sword', hp: 5, food: 12, inv: { stone_sword: 1, bread: 3 } }), entities: [ent('zombie', 'hostile', 12)] }), ['eat_bread']],
    ['iron: planks+sticks, table 2 m', base(T.iron, { self: me({ inv: { oak_planks: 7, stick: 4 } }), blocks: [blk('crafting_table', 2), blk('oak_log', 8)] }), ['craft_wood_pickaxe']],
    ['iron: ore 12 m, stone pick', base(T.iron, { self: me({ held: 'stone_pickaxe', inv: { stone_pickaxe: 1, coal: 4 } }), blocks: [blk('iron_ore', 12, 30, -20)] }), ['gather_iron_ore']],
    ['iron: raw iron by furnace', base(T.iron, { self: me({ inv: { raw_iron: 1, coal: 3, stone_pickaxe: 1 } }), blocks: [blk('furnace', 3)] }), ['smelt_iron']],
    ['iron: cobble+sticks, table', base(T.iron, { self: me({ held: 'wooden_pickaxe', inv: { cobblestone: 3, stick: 2, wooden_pickaxe: 1 } }), blocks: [blk('crafting_table', 3), blk('stone', 1.6)] }), ['craft_stone_pickaxe']],
  ],
  L3: [
    ['nav: gold behind', base(T.nav, { self: me(), blocks: [blk('gold_block', 20, 175)], crosshair: { block: { name: 'grass_block', dist: 5.5 } } }), ['turn_left_45', 'turn_right_45']],
    ['nav: gold ahead 18 m', base(T.nav, { self: me(), blocks: [blk('gold_block', 18, 2)], crosshair: { block: { name: 'grass_block', dist: 5.5 } } }), ['forward', 'sprint']],
    ['logs: log in crosshair', base(T.logs, { self: me(), blocks: [blk('oak_log', 2, 0, 0)], crosshair: { block: { name: 'oak_log', dist: 2 } } }), ['attack']],
    ['logs: log 40° right', base(T.logs, { self: me(), blocks: [blk('oak_log', 3, -40, 0)], crosshair: { block: { name: 'grass_block', dist: 5.5 } } }), ['turn_right_45', 'turn_right_15']],
    ['logs: dropped log ahead', base(T.logs, { self: me({ inv: { oak_log: 2 } }), blocks: [blk('oak_log', 4, 60)], entities: [ent('oak_log', 'item', 1.8, 0)] }), ['forward']],
    ['stone: pickaxe on hotbar 1', base(T.stone, { self: me({ pitch: -1.2, inv: { wooden_pickaxe: 1 }, hotbar: ['wooden_pickaxe', null, null, null, null, null, null, null, null], selected: 2 }), blocks: [blk('stone', 1.6, 0, -70)], crosshair: { block: { name: 'grass_block', dist: 1.5 } } }), ['hotbar_1', 'attack']],
    ['stone: stone in crosshair', base(T.stone, { self: me({ pitch: -1.2, held: 'wooden_pickaxe', inv: { wooden_pickaxe: 1 }, hotbar: ['wooden_pickaxe', null, null, null, null, null, null, null, null] }), blocks: [blk('stone', 1.6, 0, -70)], crosshair: { block: { name: 'stone', dist: 1.6 } } }), ['attack']],
    ['stone: stone below view', base(T.stone, { self: me({ held: 'wooden_pickaxe', inv: { wooden_pickaxe: 1 }, hotbar: ['wooden_pickaxe', null, null, null, null, null, null, null, null] }), blocks: [blk('stone', 1.8, 0, -60)], crosshair: { block: { name: 'grass_block', dist: 5 } } }), ['look_down_45']],
    ['fight: zombie in crosshair', base(T.fight, { self: me({ held: 'stone_sword', hp: 16 }), entities: [ent('zombie', 'hostile', 2.0, 0)], crosshair: { entity: { name: 'zombie', dist: 2 } } }), ['attack']],
    ['cow: wall ahead, nothing seen', base(T.cow, { self: me(), crosshair: { block: { name: 'stone_bricks', dist: 2.5 } } }), ['turn_left_45', 'turn_right_45', 'turn_left_15', 'turn_right_15', 'back', 'left', 'right']],
    ['logs: have 4', base(T.logs, { self: me({ inv: { oak_log: 4 } }), blocks: [blk('oak_log', 3, 10)] }), ['complete']],
    ['craft UI: logs on hotbar', base(T.craft, { self: me({ inv: { oak_log: 4 } }), ui: { title: 'inventory (2x2 crafting grid)', cursor: null, slots: [{ slot: 0, role: 'craft output', name: null, count: 0 }, { slot: 1, role: 'craft grid 1', name: null, count: 0 }, { slot: 2, role: 'craft grid 2', name: null, count: 0 }, { slot: 3, role: 'craft grid 3', name: null, count: 0 }, { slot: 4, role: 'craft grid 4', name: null, count: 0 }, { slot: 36, role: 'hotbar 1', name: 'oak_log', count: 4 }] } }), ['click_36', 'rclick_36', 'shift_36']],
    ['craft UI: logs on cursor', base(T.craft, { self: me({ inv: { oak_log: 4 } }), ui: { title: 'inventory (2x2 crafting grid)', cursor: { name: 'oak_log', count: 4 }, slots: [{ slot: 0, role: 'craft output', name: null, count: 0 }, { slot: 1, role: 'craft grid 1', name: null, count: 0 }, { slot: 2, role: 'craft grid 2', name: null, count: 0 }, { slot: 3, role: 'craft grid 3', name: null, count: 0 }, { slot: 4, role: 'craft grid 4', name: null, count: 0 }] } }), ['click_1', 'click_2', 'click_3', 'click_4', 'rclick_1', 'rclick_2', 'rclick_3', 'rclick_4']],
    ['craft UI: planks in output', base(T.craft, { self: me({ inv: { oak_log: 3 } }), ui: { title: 'inventory (2x2 crafting grid)', cursor: null, slots: [{ slot: 0, role: 'craft output', name: 'oak_planks', count: 4 }, { slot: 1, role: 'craft grid 1', name: 'oak_log', count: 1 }, { slot: 2, role: 'craft grid 2', name: null, count: 0 }, { slot: 3, role: 'craft grid 3', name: null, count: 0 }, { slot: 4, role: 'craft grid 4', name: null, count: 0 }, { slot: 36, role: 'hotbar 1', name: 'oak_log', count: 3 }] } }), ['click_0', 'shift_0']],
    ['iron: ore in crosshair', base(T.iron, { self: me({ pitch: -0.9, held: 'stone_pickaxe', inv: { stone_pickaxe: 1 }, hotbar: ['stone_pickaxe', null, null, null, null, null, null, null, null] }), blocks: [blk('iron_ore', 2.1, 0, -50)], crosshair: { block: { name: 'iron_ore', dist: 2.1 } } }), ['attack']],
  ],
}

function build(level, o) {
  if (level === 'L1') return { state: formatL1(o), instructions: L1_INSTRUCTIONS, options: argv.includes('--l1-cond') ? L1_OPTIONS_COND : L1_OPTIONS }
  if (level === 'L2') {
    const opts = optionsL2(o)
    return { state: formatL2(o), instructions: L2_INSTRUCTIONS, options: Object.fromEntries(Object.entries(opts).map(([k, v]) => [k, v.desc])) }
  }
  return { state: formatL3(o), instructions: L3_INSTRUCTIONS, options: optionsL3(o) }
}

const rows = []
for (const spec of DECIDERS) {
  const d = makeDecider(spec)
  for (const level of LEVELS) {
    let ok = 0, n = 0
    const ms = []
    for (const [name, o, good] of CASES[level]) {
      const q = build(level, o)
      for (const g of good) if (!(g in q.options)) console.log(`  !! ${level} "${name}": expected key ${g} not offered`)
      const budget = spec.startsWith('laya') && !argv.includes('--laya-default') ? LAYA_BUDGET[level] : {}
      let r
      try { r = await d.choose({ ...q, ...budget }) } catch (e) { r = { choice: `ERR ${String(e.message).slice(0, 80)}`, ms: 0 } }
      const hit = good.includes(r.choice)
      ok += hit; n++; ms.push(r.modelMs ?? r.ms)
      const top = r.probs ? Object.entries(r.probs).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, p]) => `${k}=${p.toFixed(2)}`).join(' ') : ''
      rows.push({ decider: spec, level, case: name, choice: r.choice, good, hit, ms: Math.round(r.ms), modelMs: r.modelMs ? Math.round(r.modelMs) : null, nOptions: Object.keys(q.options).length, stateChars: q.state.length, top })
      console.log(`${hit ? 'ok ' : 'BAD'} ${spec.padEnd(22)} ${level} ${name.padEnd(30)} -> ${String(r.choice).padEnd(18)} ${Math.round(r.ms)}ms ${top}`)
    }
    ms.sort((a, b) => a - b)
    const chance = CASES[level].reduce((a, [, o, good]) => a + good.length / Object.keys(build(level, o).options).length, 0) / CASES[level].length
    console.log(`== ${spec} ${level}: ${ok}/${n} (chance ~${(chance * n).toFixed(1)}/${n}), p50 ${Math.round(ms[Math.floor(n / 2)])} ms, max ${Math.round(ms[n - 1])} ms`)
  }
}
if (OUT) fs.writeFileSync(OUT, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
