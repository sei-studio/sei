#!/usr/bin/env node
// scripts/terraria-bench.mjs — per-verb and combat numbers for the Sei
// Terraria companion, measured on a REAL tModLoader server running the
// SeiCompanion mod with `devCommands` (and, headless, `headlessTick`) on in
// its link.json. No LLM: every verb is sent as the brain would send it, so
// this measures the mod's side of the contract.
//
//   node scripts/terraria-bench.mjs --link <tModLoader save>/SeiCompanion/link.json
//        [--n 10] [--only come,goTo] [--combat-n 4] [--json out.json]
//
// Reports, per scenario: completion rate over n runs, failure classes
// (src/bot/adapter/terraria/stats.js classifyTerrariaResult), median time.
// Combat scenarios report deaths (knock-outs), survival, kills, lowest
// health and heal-reflex uses. The body scenario compares the NPC body with
// a Player in an empty slot (the rejected alternative).

import { readFileSync, writeFileSync } from 'node:fs'
import { classifyTerrariaResult } from '../src/bot/adapter/terraria/stats.js'

const argv = process.argv.slice(2)
const opt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt }
const LINK = opt('--link', null)
if (!LINK) { console.error('usage: terraria-bench.mjs --link <path to SeiCompanion/link.json> [--n 10]'); process.exit(2) }
const N = Number(opt('--n', 10))
const COMBAT_N = Number(opt('--combat-n', 4))
const ONLY = opt('--only', null)?.split(',') ?? null
const JSON_OUT = opt('--json', null)
const VERBOSE = argv.includes('--verbose')
const link = JSON.parse(readFileSync(LINK, 'utf8'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ── link ── */
function connect(port) {
  const ws = new WebSocket(`ws://localhost:${port}/ws?token=${encodeURIComponent(link.token)}`)
  const pending = new Map()
  const events = []
  let seq = 0
  ws.onmessage = (ev) => {
    for (const line of String(ev.data).split('\n')) {
      if (!line.trim()) continue
      let f
      try { f = JSON.parse(line) } catch { continue }
      if (f.t === 'result' && pending.has(f.id)) { pending.get(f.id)(f); pending.delete(f.id); continue }
      if (f.t !== 'obs') events.push({ at: Date.now(), ...f })
    }
  }
  const send = (frame, timeoutMs = 90_000) => new Promise((resolve) => {
    const id = `b${++seq}`
    pending.set(id, resolve)
    ws.send(JSON.stringify({ ...frame, id }) + '\n')
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ ok: false, detail: 'timeout', timeout: true }) } }, timeoutMs)
  })
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve({ ws, send, events })
    ws.onerror = (e) => reject(new Error(`link: ${e.message ?? 'error'}`))
  })
}

const L = await connect(link.port)
const cmd = (name, args = {}, timeoutMs) => L.send({ t: 'cmd', name, args }, timeoutMs)
const dev = (type, args = {}) => L.send({ t: type, ...args })
const observe = async () => (await L.send({ t: 'observe' })).obs
const resultText = (r) => (r.ok ? String(r.detail ?? 'ok') : (r.timeout ? 'failed: timeout' : (/^aborted/.test(r.detail ?? '') ? 'aborted' : `failed: ${r.detail ?? 'error'}`)))

const spawned = await L.send({ t: 'spawn', name: 'Bench' })
if (!spawned.ok) { console.error(`spawn refused: ${spawned.detail}`); process.exit(1) }
const state = await dev('devState')
const SPAWN = { x: state.spawn[0], y: state.spawn[1] }
if (!state.headless && !state.hasClients) console.warn('warning: no client and headlessTick off; the world will not tick')

async function reset({ night = false } = {}) {
  for (let i = 0; i < 30 && (await observe())?.self?.knockedOut > 0; i++) await sleep(500)
  await cmd('unfollow').catch(() => {})
  // Empty her bag: it has few slots and is kept by name between runs.
  for (const entry of (await observe())?.bag ?? []) await dev('devTake', { item: String(entry).replace(/ x\d+$/, '') })
  await dev('devStrip')
  // Undo earlier runs: no hostiles left over, and the ground near spawn is
  // whole again (mine digs pits she cannot climb out of).
  await dev('devClear')
  await dev('devFill', { x0: SPAWN.x - 30, x1: SPAWN.x + 30, y0: SPAWN.y + 1, y1: SPAWN.y + 12 })
  await dev('devKillTile', { x: SPAWN.x - 12, x1: SPAWN.x + 12, y: SPAWN.y - 8, y1: SPAWN.y - 1, keep: 'trees' })
  await dev('devAnchor', { x: SPAWN.x })
  await dev('devTeleport', { x: SPAWN.x - 3 })
  await dev('devHp', { hp: 9999, clearCooldown: true })
  await dev('devTime', night ? { day: false, time: 0 } : { day: true, time: 9000 })
  await sleep(300)
}

/** First air tile with solid ground under it, 2..7 tiles right of her (devTiles map, her column at 2r). */
async function placeSpot() {
  const R = 8
  const r = await dev('devTiles', { r: R })
  const me = await observe()
  const rows = (r.map ?? []).map((line) => ({ y: Number(line.slice(0, 5)), cells: line.slice(6) }))
  for (let dx = 2; dx <= 7; dx++) {
    for (let i = 0; i < rows.length - 1; i++) {
      const col = 2 * R + dx
      const here = rows[i].cells[col], below = rows[i + 1].cells[col]
      if ((here === '.' || here === '@') && below === '#') return { x: me.self.x + dx, y: rows[i].y }
    }
  }
  return { x: me.self.x + 3, y: me.self.y }
}

const dist = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y))

/* ── scenarios: each returns { text, ok? } (ok overrides the result's own) ── */
const SCENARIOS = {
  async come() {
    await dev('devTeleport', { x: SPAWN.x + 40 })
    const r = await cmd('come')
    const me = (await observe()).self
    return { text: resultText(r), ok: r.ok && dist(me, SPAWN) <= 5 }
  },
  async follow() {
    const p = cmd('follow', {}, 60_000)
    await sleep(500)
    const dx = Math.random() < 0.5 ? -25 : 25
    await dev('devAnchor', { x: SPAWN.x + dx })
    const t0 = Date.now()
    let me
    do { await sleep(500); me = (await observe()).self } while (Math.abs(me.x - (SPAWN.x + dx)) > 6 && Date.now() - t0 < 15_000)
    const ok = Math.abs(me.x - (SPAWN.x + dx)) <= 6
    await cmd('unfollow'); await p
    return { text: ok ? 'kept up' : 'failed: no_path (fell behind)', ok }
  },
  async stay() {
    const r = await cmd('unfollow')
    const before = (await observe()).self
    await dev('devAnchor', { x: SPAWN.x + 20 })
    await sleep(4000)
    const after = (await observe()).self
    return { text: resultText(r), ok: r.ok && Math.abs(after.x - before.x) <= 1 }
  },
  async goTo() {
    const dx = (Math.random() < 0.5 ? -1 : 1) * (10 + Math.floor(Math.random() * 30))
    const r = await cmd('goTo', { x: SPAWN.x + dx, y: SPAWN.y })
    return { text: resultText(r) }
  },
  async attack() {
    await dev('devGive', { item: 'Copper Shortsword', count: 1 })
    await cmd('equip', { item: 'Copper Shortsword' })
    await dev('devSpawn', { npc: 'Blue Slime', dx: 8 })
    await sleep(300)
    const h = (await observe()).hostiles?.[0]
    const r = await cmd('attack', h ? { target: `#${h.id}` } : {}, 40_000)
    return { text: resultText(r) }
  },
  async give() {
    await dev('devGive', { item: 'Gel', count: 5 })
    const r = await cmd('give', { item: 'Gel', count: 3 })
    await dev('devTake', { item: 'Gel' })
    return { text: resultText(r) }
  },
  async take() {
    await dev('devDrop', { item: 'Wood', count: 4, dx: 4 })
    const r = await cmd('take', { item: 'Wood' })
    await dev('devTake', { item: 'Wood' })
    return { text: resultText(r) }
  },
  async mine() {
    await dev('devGive', { item: 'Copper Pickaxe', count: 1 })
    const r = await cmd('mine', { block: 'Dirt Block', count: 3 }, 60_000)
    return { text: resultText(r) }
  },
  async place() {
    await dev('devGive', { item: 'Dirt Block', count: 3 })
    const at = await placeSpot()
    const r = await cmd('place', { item: 'Dirt Block', x: at.x, y: at.y })
    if (r.ok) await dev('devKillTile', at) // the next run starts on the same ground
    return { text: resultText(r) }
  },
  async chop() {
    await dev('devGive', { item: 'Copper Axe', count: 1 })
    await dev('devTree', { x: SPAWN.x + 5 }) // earlier runs chopped the near ones
    const r = await cmd('chop', {}, 60_000)
    return { text: resultText(r) }
  },
  async use() {
    for (let i = 0; i < 70; i++) { if (!((await observe()).self.potionCooldown > 0)) break; await sleep(1000) }
    await dev('devHp', { hp: 40 })
    await dev('devGive', { item: 'Lesser Healing Potion', count: 1 })
    const r = await cmd('use', { item: 'Lesser Healing Potion' })
    const me = (await observe()).self
    return { text: resultText(r), ok: r.ok && me.hp > 40 }
  },
  async equip() {
    const item = ['Copper Helmet', 'Wood Breastplate', 'Copper Shortsword'][Math.floor(Math.random() * 3)]
    await dev('devTake', { item })
    await dev('devGive', { item, count: 1 })
    const r = await cmd('equip', { item })
    return { text: resultText(r) }
  },
  async craft() {
    const [item, mats] = Math.random() < 0.5 ? ['Work Bench', [['Wood', 10]]] : ['Torch', [['Wood', 1], ['Gel', 1]]]
    for (const [m, n] of mats) await dev('devGive', { item: m, count: n })
    const r = await cmd('craft', { item })
    await dev('devTake', { item })
    return { text: resultText(r) }
  },
  async alert() {
    const from = L.events.length
    await dev('devSpawn', { npc: 'Eye of Cthulhu', dx: 30, dy: -20 })
    const t0 = Date.now()
    let got = false
    while (Date.now() - t0 < 6000 && !got) { await sleep(250); got = L.events.slice(from).some((e) => e.t === 'event' && e.kind === 'boss_spawn') }
    await dev('devTime', { day: true, time: 9000 })
    await sleep(8000)
    return { text: got ? 'alerted' : 'failed: no boss_spawn event', ok: got }
  },
}

/* ── combat: zombies at night, aggressive stance, 40 s ── */
// Starter = a fresh character's sword, no armor. First night = what a player
// usually has by the first night (an iron sword and copper armor).
const KITS = {
  starter: ['Copper Shortsword'],
  firstNight: ['Iron Broadsword', 'Copper Helmet', 'Copper Chainmail', 'Copper Greaves'],
}

async function combatRun({ potions, reflex, kit }) {
  await reset({ night: true })
  await dev('devReflex', reflex)
  await dev('devTake', { item: 'Lesser Healing Potion' })
  if (potions) await dev('devGive', { item: 'Lesser Healing Potion', count: potions })
  for (const item of KITS[kit]) { await dev('devGive', { item, count: 1 }); await cmd('equip', { item }) }
  await cmd('stance', { mode: 'aggressive' })
  if (VERBOSE) { const o = await observe(); console.log(`  start hp=${o.self.hp} cd=${o.self.potionCooldown} bag=${JSON.stringify(o.bag)}`) }
  const from = L.events.length
  for (const dx of [-12, 12, 16]) await dev('devSpawn', { npc: 'Zombie', dx })
  const t0 = Date.now()
  let minHp = 9999
  let spawnedIds = null
  let alive = 0
  while (Date.now() - t0 < 40_000) {
    await sleep(500)
    const o = await observe()
    if (!o) continue
    minHp = Math.min(minHp, o.self.hp)
    const zs = (o.hostiles ?? []).filter((h) => h.name === 'Zombie')
    if (!spawnedIds) spawnedIds = new Set(zs.map((z) => z.id))
    alive = zs.filter((z) => spawnedIds.has(z.id)).length
    if (alive === 0 && Date.now() - t0 > 3000) break
    if (L.events.slice(from).some((e) => e.t === 'death')) break
  }
  const ev = L.events.slice(from)
  const deaths = ev.filter((e) => e.t === 'death').length
  const heals = ev.filter((e) => e.t === 'survival' && e.kind === 'healed').length
  // Zombies still in the world when the fight ends (alive or not in her view).
  const left = Number(/cleared (\d+)/.exec((await dev('devClear')).detail ?? '')?.[1] ?? 0)
  const kills = 3 - left
  await cmd('stance', { mode: 'defensive' })
  await dev('devTime', { day: true, time: 9000 })
  await dev('devHp', { hp: 9999 })
  const run = { deaths, survived: deaths === 0, kills, minHp, heals, secs: Math.round((Date.now() - t0) / 1000) }
  if (VERBOSE) console.log(`  combat ${kit} potions=${potions} ${reflex.label} ${JSON.stringify(run)} ${ev.filter((e) => ['damaged', 'survival', 'death'].includes(e.t)).map((e) => `${e.t}:${e.kind ?? e.by ?? ''}:${e.hp ?? ''}`).join(' ')}`)
  return run
}

/* ── body: NPC (shipped) vs a Player in an empty slot (rejected) ── */
async function bodyCompare(n) {
  const out = { npc: { n, alive: 0 }, fakePlayer: { n, alive: 0 } }
  for (let i = 0; i < n; i++) {
    await dev('devFakePlayer')
    await sleep(1500)
    const fp = await dev('devFakePlayerCheck', { cleanup: true })
    if (fp.ok && fp.active === true) out.fakePlayer.alive++
    const me = await observe()
    if (me?.self && me.self.knockedOut === 0) out.npc.alive++
  }
  return out
}

/* ── run ── */
const results = {}
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0 }
for (const [name, fn] of Object.entries(SCENARIOS)) {
  if (ONLY && !ONLY.includes(name)) continue
  const n = name === 'use' || name === 'alert' ? Math.min(N, 3) : N
  const row = { n, ok: 0, fails: {}, ms: [], samples: [] }
  for (let i = 0; i < n; i++) {
    await reset()
    const t0 = Date.now()
    let r
    try { r = await fn() } catch (err) { r = { text: `failed: ${err.message}` } }
    row.ms.push(Date.now() - t0)
    const cls = classifyTerrariaResult(r.text)
    const ok = r.ok ?? cls == null
    if (ok) row.ok++
    else { const k = cls ?? 'error'; row.fails[k] = (row.fails[k] ?? 0) + 1; if (row.samples.length < 2) row.samples.push(r.text.slice(0, 90)) }
  }
  results[name] = { n: row.n, ok: row.ok, rate: row.ok / row.n, fails: row.fails, medianMs: median(row.ms), samples: row.samples }
  console.log(`${name.padEnd(8)} ${row.ok}/${row.n}  ${JSON.stringify(row.fails)}  median ${median(row.ms)}ms  ${row.samples.join(' | ')}`)
}

// Retreat-reflex arms: the shipped setting first, then the candidates.
const REFLEXES = [
  { label: 'shipped', retreatAt: 25, retreatEvery: 600, retreatTicks: 150 },
  ...(argv.includes('--reflex-ab') ? [{ label: 'early', retreatAt: 50, retreatEvery: 240, retreatTicks: 240 }] : []),
]
// Arms: each kit with the shipped reflex; with --reflex-ab, the candidate too
// (first-night kit only: the starter kit loses every fight either way).
const ARMS = [
  ...['starter', 'firstNight'].map((kit) => ({ kit, reflex: REFLEXES[0] })),
  ...REFLEXES.slice(1).map((reflex) => ({ kit: 'firstNight', reflex })),
]
if (!ONLY || ONLY.includes('combat')) {
  for (const { kit, reflex } of ARMS) {
    for (const potions of [0, 3]) {
      const runs = []
      for (let i = 0; i < COMBAT_N; i++) runs.push(await combatRun({ potions, reflex, kit }))
      const key = `combat_${kit}_${reflex.label}_${potions ? 'potions' : 'nopotions'}`
      results[key] = {
        n: runs.length,
        survived: runs.filter((r) => r.survived).length,
        deaths: runs.reduce((a, r) => a + r.deaths, 0),
        kills: runs.reduce((a, r) => a + r.kills, 0),
        heals: runs.reduce((a, r) => a + r.heals, 0),
        medianMinHp: median(runs.map((r) => r.minHp)),
        medianSecs: median(runs.map((r) => r.secs)),
      }
      console.log(`${key} ${JSON.stringify(results[key])}`)
    }
  }
  await dev('devReflex', REFLEXES[0])
}
if (!ONLY || ONLY.includes('body')) {
  results.body = await bodyCompare(Math.min(N, 5))
  console.log(`body ${JSON.stringify(results.body)}`)
}

if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(results, null, 2))
await dev('devClear')
await L.send({ t: 'despawn' })
L.ws.close()
setTimeout(() => process.exit(0), 200)
