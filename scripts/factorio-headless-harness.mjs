#!/usr/bin/env node
// scripts/factorio-headless-harness.mjs: drive the REAL Sei Companion Factorio mod
// (native/factorio-mod/sei-companion) inside a headless Factorio 2.1 server, over
// the same localhost UDP link the app uses (src/bot/adapter/factorio/client.js).
// No Electron, no LLM: each check calls one verb the way the brain would and
// asserts the world state afterwards.
//
// The "player" is a stand-in character entity the harness creates and moves
// over RCON (a headless server has no player); the mod's remote interface
// `sei_companion.set_test_owner` makes it her owner. Biters, items and ghosts
// are spawned over RCON too. RCON is test tooling only; the app talks UDP.
//
// Usage:
//   node scripts/factorio-headless-harness.mjs [--factorio <bin>] [--keep]
//     [--only name,name] [--speed 4] [--registry]
//   (default bin: ~/.cache/sei-factorio/<ver>/factorio/bin/x64/factorio, the
//   free headless build from factorio.com/get-download/<ver>/headless/linux64)
//
// --registry runs each check through the adapter's tool registry and prints the
// snapshot the model would read, instead of calling the mod directly.

import { createFactorioClient } from '../src/bot/adapter/factorio/client.js'
import { startFactorioServer, defaultBin, sleep } from './lib/factorioServer.mjs'
import { existsSync } from 'node:fs'

const args = process.argv.slice(2)
const opt = (name, d = null) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : d
}
const flag = (name) => args.includes(`--${name}`)

const BIN = opt('factorio', defaultBin())
const ONLY = opt('only') ? new Set(opt('only').split(',')) : null
const SPEED = Number(opt('speed', '4'))
const KEEP = flag('keep')
const USE_REGISTRY = flag('registry')
if (!BIN || !existsSync(BIN)) {
  console.error('no Factorio headless binary; pass --factorio <path>')
  process.exit(2)
}

// ---------------------------------------------------------------- server
const srv = await startFactorioServer({ bin: BIN, speed: SPEED, keep: KEEP })
const { udpPort, rc, lua, J, L } = srv
const hardStop = setTimeout(() => { console.error('harness timed out'); srv.stop(); process.exit(3) }, 20 * 60_000)

const client = createFactorioClient({ gamePort: udpPort, logger: console })
await client.open()

// ---------------------------------------------------------------- helpers
const CID = '0:sui'
const events = []
client.on('event', (ev) => events.push(ev))
async function state() {
  const s = await lua(`rcon.print(remote.call('sei_companion', 'state', '${CID}') or 'null')`)
  return s
}
async function waitFor(pred, ms = 20_000, every = 250) {
  const end = Date.now() + ms
  let last
  while (Date.now() < end) {
    last = await pred()
    if (last) return last
    await sleep(every)
  }
  return null
}
const unitOf = async () => (await state())?.unit
const companionLua = (code) => `local ch = remote.call('sei_companion', 'body', '${CID}') ${code}`
const herPos = async () => L(companionLua(''), 'ch.position')
const tester = async (code) => L(`local t = storage.tester ${code}`, 'nil')
const testerAt = (x, y) => tester(`t.teleport({${x}, ${y}})`)
const give = (item, n) => L(companionLua(`ch.insert{name='${item}', count=${n}}`), 'ch.get_item_count("' + item + '")')
const count = (item) => L(companionLua(''), `ch.get_item_count("${item}")`)
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)
const sinceEv = (n) => events.slice(n)

let adapter = null
let composer = null
let toolOf = null
async function verb(name, a = {}, opts = {}) {
  // --registry: the check goes through the real adapter (Zod schema, the
  // tool name the brain sees, the result string the brain reads). Verbs the
  // brain reaches some other way (say, stop) stay on the raw client.
  const tool = toolOf?.[name] ?? name
  if (adapter && adapter.listActions().includes(tool)) {
    const text = await adapter.executeAction(tool, a, { signal: opts.signal ?? null })
    const failed = /^failed:|^aborted$|^paused:/.test(String(text))
    return { success: !failed, msg: failed ? String(text).replace(/^failed:\s*/, '') : String(text) }
  }
  return client.command(CID, name, a, opts)
}

// ---------------------------------------------------------------- checks
const results = []
const checks = []
const check = (name, fn) => checks.push({ name, fn })

check('udp_hello', async () => {
  const t0 = Date.now()
  const r = await client.request({ op: 'hello' })
  const ms = Date.now() - t0
  if (!r.ok || r.protocol !== 1) throw new Error(JSON.stringify(r))
  return `round trip ${ms} ms, mod ${r.mod}, game ${r.game}`
})

check('spawn', async () => {
  await lua(`local e = game.surfaces.nauvis.create_entity{name='character', position={0, 0}, force='player'} storage.tester = e remote.call('sei_companion', 'set_test_owner', '${CID}', e.unit_number) ${J('e.unit_number')}`)
  const r = await client.request({ op: 'spawn', name: 'Sui' })
  if (!r.ok) throw new Error(r.error)
  client.startPolling(CID)
  const p = await herPos()
  if (dist(p, { x: 0, y: 0 }) > 6) throw new Error(`spawned far from the owner at ${JSON.stringify(p)}`)
  const again = await client.request({ op: 'spawn', name: 'Sui' })
  if (again.fresh) throw new Error('a second spawn made a new body')
  return `body at (${p.x.toFixed(1)}, ${p.y.toFixed(1)}), owner (0, 0); respawn of the same name reuses her`
})

check('follow', async () => {
  await verb('follow')
  await testerAt(30, 4)
  const ok = await waitFor(async () => { const p = await herPos(); return dist(p, { x: 30, y: 4 }) < 6.5 && p }, 30_000)
  if (!ok) throw new Error(`still at ${JSON.stringify(await herPos())}`)
  return `walked to within ${dist(ok, { x: 30, y: 4 }).toFixed(1)} tiles of the owner`
})

check('stay', async () => {
  const r = await verb('stay')
  if (!r.success) throw new Error(r.msg)
  const before = await herPos()
  await testerAt(0, 0)
  await sleep(3000)
  const after = await herPos()
  if (dist(before, after) > 1) throw new Error('she followed after stay')
  await verb('follow')
  return 'stayed while the owner walked 30 tiles away'
})

check('come', async () => {
  await verb('stay')
  await testerAt(-20, 0)
  const r = await verb('come')
  if (!r.success) throw new Error(r.msg)
  return r.msg
})

check('say', async () => {
  const r = await verb('say', { text: 'hello from the harness' })
  if (!r.success) throw new Error(r.msg)
  return r.msg
})

check('gather_wood', async () => {
  const before = await count('wood')
  const r = await verb('gather', { resource: 'wood', count: 8 })
  const after = await count('wood')
  if (!r.success || after - before < 8) throw new Error(`${r.msg} (wood ${before} -> ${after})`)
  return r.msg
})

check('gather_stone', async () => {
  const r = await verb('gather', { resource: 'stone', count: 10 })
  if (!r.success) throw new Error(r.msg)
  return r.msg
})

check('gather_iron', async () => {
  const r = await verb('gather', { resource: 'iron-ore', count: 10 })
  if (!r.success) throw new Error(r.msg)
  return r.msg
})

check('gather_missing', async () => {
  const r = await verb('gather', { resource: 'uranium-ore', count: 5 })
  if (r.success) throw new Error('claimed success for ore that is not there')
  return `honest failure: ${r.msg}`
})

check('craft_simple', async () => {
  await give('iron-plate', 20)
  const before = await count('iron-gear-wheel')
  const r = await verb('craft', { item: 'iron-gear-wheel', count: 3 })
  const after = await count('iron-gear-wheel')
  if (!r.success || after - before < 3) throw new Error(`${r.msg} (${before} -> ${after})`)
  return r.msg
})

check('craft_intermediates', async () => {
  await give('iron-plate', 20)
  await give('stone', 10)
  const r = await verb('craft', { item: 'burner-mining-drill', count: 1 })
  if (!r.success) throw new Error(r.msg)
  return r.msg
})

check('craft_missing', async () => {
  const r = await verb('craft', { item: 'electronic-circuit', count: 50 })
  if (r.success && /only/.test(r.msg)) return `partial, honest: ${r.msg}`
  if (r.success) throw new Error(`claimed success: ${r.msg}`)
  return `honest failure: ${r.msg}`
})

let furnace = null
check('build', async () => {
  await give('stone-furnace', 2)
  const p = await herPos()
  const r = await verb('build', { item: 'stone-furnace', x: Math.round(p.x) + 4, y: Math.round(p.y) })
  if (!r.success) throw new Error(r.msg)
  furnace = Number(/#(\d+)/.exec(r.msg)?.[1])
  return r.msg
})

check('build_blocked', async () => {
  // On top of the furnace she just built: an honest reason and a spot that works.
  const at = await L(`local e = remote.call('sei_companion', 'entity', ${furnace})`, 'e and e.position')
  const r = await verb('build', { item: 'stone-furnace', x: at.x, y: at.y })
  if (r.success || !/stone-furnace is in the way; the nearest free spot is \(-?\d+,-?\d+\)/.test(r.msg)) throw new Error(r.msg)
  const [, fx, fy] = /free spot is \((-?\d+),(-?\d+)\)/.exec(r.msg)
  const r2 = await verb('build', { item: 'stone-furnace', x: Number(fx), y: Number(fy) })
  if (!r2.success) throw new Error(`the suggested spot failed: ${r2.msg}`)
  await L(`local e = remote.call('sei_companion', 'entity', ${Number(/#(\d+)/.exec(r2.msg)?.[1])}) if e then e.destroy() end`, '1')
  return `${r.msg}; building there worked`
})

check('look_diagnose', async () => {
  const r = await verb('look', { target: furnace })
  if (!r.success || !/fuel/.test(r.msg)) throw new Error(r.msg)
  return r.msg
})

check('tend', async () => {
  await give('coal', 30)
  await give('iron-ore', 30)
  const r = await verb('tend', { radius: 20 })
  if (!r.success) throw new Error(r.msg)
  const fuel = await L(`local f = remote.call('sei_companion', 'entity', ${furnace})`, 'f.get_fuel_inventory().get_item_count()')
  const ore = await L(`local f = remote.call('sei_companion', 'entity', ${furnace})`, 'f.get_inventory(defines.inventory.crafter_input).get_item_count()')
  if (!(fuel > 0 && ore > 0)) throw new Error(`furnace has fuel ${fuel}, ore ${ore}: ${r.msg}`)
  return r.msg
})

let chest = null
check('deposit_take', async () => {
  const p = await herPos()
  chest = await L(`local e = game.surfaces.nauvis.create_entity{name='wooden-chest', position={${Math.round(p.x) - 3}, ${Math.round(p.y) + 2}}, force='player'} storage.chest = e`, 'e.unit_number')
  await give('copper-plate', 12)
  const d = await verb('deposit', { item: 'copper-plate', count: 10, target: chest })
  if (!d.success) throw new Error(`deposit: ${d.msg}`)
  const inChest = await L(`local e = storage.chest`, "e.get_item_count('copper-plate')")
  if (inChest !== 10) throw new Error(`chest has ${inChest}`)
  const t = await verb('take', { item: 'copper-plate', count: 4, target: chest })
  if (!t.success) throw new Error(`take: ${t.msg}`)
  const left = await L(`local e = storage.chest`, "e.get_item_count('copper-plate')")
  if (left !== 6) throw new Error(`chest has ${left} after take`)
  return `${d.msg}; ${t.msg}`
})

check('give', async () => {
  await give('iron-gear-wheel', 5)
  const before = await L('local t = storage.tester', "t.get_item_count('iron-gear-wheel')")
  const r = await verb('give', { item: 'iron-gear-wheel', count: 5 })
  const after = await L('local t = storage.tester', "t.get_item_count('iron-gear-wheel')")
  if (!r.success || after - before !== 5) throw new Error(`${r.msg} (owner ${before} -> ${after})`)
  return r.msg
})

check('build_ghosts', async () => {
  const p = await herPos()
  const n = await L(`local s = game.surfaces.nauvis local n = 0 for i = 0, 2 do
      local g = s.create_entity{name='entity-ghost', inner_name='transport-belt', position={${Math.round(p.x)} + i + 0.5, ${Math.round(p.y) - 5} + 0.5}, force='player', direction=defines.direction.east}
      if g then n = n + 1 end end`, 'n')
  await give('transport-belt', 3)
  const r = await verb('build_ghosts', { radius: 20 })
  const left = await L(`local s = game.surfaces.nauvis`, `s.count_entities_filtered{type='entity-ghost', position={${p.x}, ${p.y}}, radius=20}`)
  if (!r.success || left !== 0) throw new Error(`${r.msg} (${n} ghosts, ${left} left)`)
  return r.msg
})

check('pickup', async () => {
  const r = await verb('pickup', { target: chest })
  if (!r.success) throw new Error(r.msg)
  const gone = await L(`local e = storage.chest`, '(e == nil or not e.valid)')
  if (!gone) throw new Error('the chest is still there')
  return r.msg
})

check('research', async () => {
  const first = await verb('research', { tech: 'automation' })
  if (first.success || !/craft/.test(first.msg)) throw new Error(`expected the trigger hint first: ${first.msg}`)
  await L('', "(function() game.forces.player.technologies['automation-science-pack'].researched = true return 1 end)()")
  const r = await verb('research', { tech: 'automation' })
  const cur = await L('', 'game.forces.player.current_research and game.forces.player.current_research.name')
  if (!r.success || cur !== 'automation') throw new Error(`${r.msg} (current ${cur})`)
  return `${first.msg}; then ${r.msg}`
})

check('defend_reflex', async () => {
  await verb('defend', { stance: 'defensive' })
  await give('firearm-magazine', 30)
  const n0 = events.length
  const p = await herPos()
  const kills0 = (await state()).kills ?? 0
  await L(`local s = game.surfaces.nauvis for i = 1, 3 do s.create_entity{name='small-biter', position={${p.x + 12} + i, ${p.y}}, force='enemy'} end`, '1')
  const done = await waitFor(async () => ((await state()).kills ?? 0) - kills0 >= 3, 40_000)
  const evs = sinceEv(n0).map((e) => e.t)
  if (!done) throw new Error(`kills ${(await state()).kills - kills0}; events ${evs.join(',')}`)
  const health = (await state()).obs.health
  return `killed 3 small biters, health ${health}%, events: ${[...new Set(evs)].join(', ')}`
})

check('passive_stance', async () => {
  await verb('defend', { stance: 'passive' })
  const p = await herPos()
  const kills0 = (await state()).kills ?? 0
  await L(`local s = game.surfaces.nauvis s.create_entity{name='small-biter', position={${p.x + 10}, ${p.y + 10}}, force='enemy'}`, '1')
  await sleep(2500)
  const k = ((await state()).kills ?? 0) - kills0
  await L(`for _, e in pairs(game.surfaces.nauvis.find_entities_filtered{name='small-biter'}) do e.destroy() end`, '1')
  await verb('defend', { stance: 'defensive' })
  if (k > 0) throw new Error('fought while passive')
  return 'held fire while passive'
})

check('retreat_reflex', async () => {
  const n0 = events.length
  const p = await herPos()
  await L(companionLua('ch.health = ch.max_health * 0.3 ch.get_inventory(defines.inventory.character_ammo).clear() ch.remove_item{name="firearm-magazine", count=1000}'), '1')
  await L(`local s = game.surfaces.nauvis for i = 1, 2 do s.create_entity{name='small-biter', position={${p.x + 6} + i, ${p.y}}, force='enemy'} end`, '1')
  const ev = await waitFor(async () => sinceEv(n0).find((e) => e.t === 'survival' && e.kind === 'retreat'), 15_000)
  await L(`for _, e in pairs(game.surfaces.nauvis.find_entities_filtered{name='small-biter'}) do e.destroy() end`, '1')
  if (!ev) throw new Error(`no retreat; events ${sinceEv(n0).map((e) => e.t).join(',')}`)
  return `retreated at ${ev.health}% health`
})

check('death_respawn', async () => {
  const n0 = events.length
  await L(companionLua('ch.die()'), '1')
  const died = await waitFor(async () => sinceEv(n0).find((e) => e.t === 'death'), 10_000)
  if (!died) throw new Error('no death event')
  const busy = await verb('gather', { resource: 'wood', count: 1 })
  if (busy.success) throw new Error('a dead body ran a verb')
  const back = await waitFor(async () => sinceEv(n0).find((e) => e.t === 'respawned'), 30_000)
  if (!back) throw new Error('no respawn')
  return `death event, verbs refused while dead (${busy.msg}), respawned by the owner`
})

check('owner_chat', async () => {
  // A headless server has no player to chat, so this checks the event path from the server console instead.
  const n0 = events.length
  await rc.cmd('hello sui') // console chat from <server> is not a player chat; expect no event
  await sleep(800)
  const leak = sinceEv(n0).find((e) => e.t === 'chat')
  if (leak) throw new Error('server console chat reached her feed')
  return 'console text from the server is ignored (player chat needs a live client)'
})

check('rcon_fallback', async () => {
  const out = await rc.cmd('/sei {"op":"hello"}')
  const r = JSON.parse(out)
  if (!r.ok) throw new Error(out)
  return 'the /sei console command answers the same protocol'
})

check('cancel', async () => {
  const p = new AbortController()
  const pr = verb('gather', { resource: 'stone', count: 200 }, { signal: p.signal })
  await sleep(1500)
  p.abort()
  await pr.catch(() => {})
  await sleep(600)
  const s = await state()
  if (s.job) throw new Error(`job still ${s.job}`)
  return 'aborting the call cancels the job in the mod'
})

check('observe_size', async () => {
  const r = await client.request({ op: 'observe', cid: CID })
  if (!r.ok) throw new Error(r.error)
  return `${JSON.stringify(r.obs).length} bytes of raw observation`
})

// ---------------------------------------------------------------- run
if (USE_REGISTRY) {
  const { createFactorioAdapter } = await import('../src/bot/adapter/factorio/index.js')
  const { MOD_VERB } = await import('../src/bot/adapter/factorio/registry.js')
  toolOf = Object.fromEntries(Object.entries(MOD_VERB).map(([tool, mod]) => [mod, tool]))
  const quiet = { info() {}, warn() {}, error() {}, debug() {} }
  const hello = await client.request({ op: 'hello' })
  adapter = createFactorioAdapter({ client, cid: CID, config: {}, botUsername: 'Sui', hello, logger: quiet })
  const inner = adapter.createSnapshotComposer()
  composer = { next: async (o) => { await adapter.refreshObservation(); return inner.next(o) } }
}

let pass = 0
for (const c of checks) {
  if (ONLY && !ONLY.has(c.name)) continue
  const t0 = Date.now()
  try {
    const detail = await c.fn()
    results.push({ name: c.name, ok: true, ms: Date.now() - t0, detail })
    pass += 1
    console.log(`PASS ${c.name} (${((Date.now() - t0) / 1000).toFixed(1)}s): ${detail}`)
  } catch (err) {
    results.push({ name: c.name, ok: false, ms: Date.now() - t0, detail: err.message })
    console.log(`FAIL ${c.name} (${((Date.now() - t0) / 1000).toFixed(1)}s): ${err.message}`)
  }
  if (composer && !ONLY) {
    const snap = await composer.next({})
    console.log(`  snapshot (${snap.length} chars)`)
    // FCT_DUMP_AFTER=<check> writes the raw observation after that check (test fixtures).
    if (process.env.FCT_DUMP_AFTER === c.name && process.env.FCT_DUMP_TO) {
      const { writeFileSync } = await import('node:fs')
      writeFileSync(process.env.FCT_DUMP_TO, JSON.stringify(adapter.getLatestObservation(), null, 2) + '\n')
      console.log(`  observation written to ${process.env.FCT_DUMP_TO}`)
    }
  }
}

if (composer) console.log('\n--- snapshot ---\n' + await composer.next({}))
console.log(`\n${pass}/${results.length} passed (game speed ${SPEED}x)`)
const errs = srv.log().split('\n').filter((l) => /Error|error/.test(l) && !/EOF on stdin/.test(l))
if (errs.length) console.log('server errors:\n' + errs.slice(0, 20).join('\n'))

client.close()
clearTimeout(hardStop)
srv.stop()
await sleep(500)
if (KEEP) console.log(`kept ${srv.run}`)
process.exit(pass === results.length ? 0 : 1)
