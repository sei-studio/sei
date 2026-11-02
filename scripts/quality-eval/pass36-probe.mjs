#!/usr/bin/env node
// Pass 36 probe: shelter and build failures, direct mode (no LLM). Boots a
// companion from --repo on the eval server and runs one action per case,
// then reads the world from the scripted player's view.
//
//   node scripts/quality-eval/pass36-probe.mjs --repo <sei checkout> [--reps 3] [--cases a,b] [--out rows.jsonl]
//
// Cases (from the free-play shelter/build results since 10-20):
//   shelter_noblocks   no building blocks at all (combat_night gives none):
//                      shelter({size:3}) must end enclosed
//   shelter_offcenter  64 dirt, center one block east of her, so she stands
//                      where the west wall goes (the model always passes
//                      center): enclosed, no cell failed on her own body
//   shelter_walkin     64 dirt, the player is put in an unbuilt wall cell
//                      1s into the build and taken out 3s later
//   shelter_control    64 cobblestone at her feet (both arms should build)
//   table_into_ground  build a 1-cell crafting_table at the ground block's y
//   wall_floating      a 2-high cobblestone wall one layer above the ground
//   pillar_self        a 2-high dirt column in the cell she stands in
//
// Owns the server for its run (reset, start, stop): book it in
// ~/suisei/eval/QUEUE.md first.
import fs from 'node:fs'
import path from 'node:path'
import { serverCtl, cmds } from './lib/server.mjs'
import { connectPlayer } from './lib/player.mjs'
import { startCompanion, companionName, PLAYER } from './lib/companionProc.mjs'
import { Vec3 } from 'vec3'
import { WORLD_RULES, arenaReset, playersReset, tp, S, P, Y } from './bench/arena.mjs'

const argv = process.argv.slice(2)
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d }
const REPO = path.resolve(opt('repo', process.cwd()))
const REPS = Number(opt('reps', 3))
const OUT = opt('out', null)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(`[p36 ${new Date().toISOString().slice(11, 19)}]`, ...a)

const AIR = /^(air|cave_air|void_air)$/
function solid(pbot, x, y, z) {
  const b = pbot.blockAt(new Vec3(x, y, z))
  return !!b && !AIR.test(b.name) && b.boundingBox === 'block'
}
function nameAt(pbot, x, y, z) {
  return pbot.blockAt(new Vec3(x, y, z))?.name ?? null
}

/**
 * Enclosed 3x3 around (cx, cz) on the arena floor: every wall cell at Y and
 * Y+1 solid except the doorway column (cx, minZ), and a full roof right over
 * the walls (at Y+2, or at Y+3 with a third wall layer under it).
 */
function shelterState(pbot, cx, cz) {
  const minX = cx - 1, maxX = cx + 1, minZ = cz - 1, maxZ = cz + 1
  const ring = []
  for (let x = minX; x <= maxX; x++) for (let z = minZ; z <= maxZ; z++) {
    if (x === cx && z === cz) continue
    ring.push({ x, z })
  }
  const wallMissing = (ys) => ring.filter(({ x, z }) => !(x === cx && z === minZ)).flatMap(({ x, z }) => ys.filter((y) => !solid(pbot, x, y, z)).map((y) => `${x},${y},${z}`))
  const roofAt = (y) => { let n = 0; for (let x = minX; x <= maxX; x++) for (let z = minZ; z <= maxZ; z++) if (solid(pbot, x, y, z)) n++; return n }
  const low = wallMissing([Y, Y + 1])
  const roof2 = roofAt(Y + 2)
  const roof3 = roofAt(Y + 3)
  const roofOk = roof2 === 9 || (roof3 === 9 && wallMissing([Y + 2]).length === 0)
  return { enclosed: low.length === 0 && roofOk, wallMissing: low.length, roof: Math.max(roof2, roof3) }
}

function insideOf(pos, cx, cz) {
  return !!pos && Math.floor(pos.x) === cx && Math.floor(pos.z) === cz
}

const BODY_FAIL = /standing in them|standing where a wall goes/

const CASES = {
  shelter_noblocks: {
    give: [],
    async run(ctx) {
      const t0 = Date.now()
      const r = await ctx.exec('shelter', { size: 3 }, { timeoutMs: 240000 })
      const ms = Date.now() - t0
      await sleep(800)
      const st = shelterState(ctx.pbot, S.x, S.z)
      const pr = await ctx.comp.probe()
      return { result: r.result, ms, ...st, inside: insideOf(pr?.pos, S.x, S.z), success: st.enclosed }
    },
  },
  shelter_offcenter: {
    give: ['dirt 64'],
    async run(ctx) {
      const cx = S.x + 1, cz = S.z
      const t0 = Date.now()
      const r = await ctx.exec('shelter', { size: 3, center: { x: cx, y: Y, z: cz } }, { timeoutMs: 240000 })
      const ms = Date.now() - t0
      await sleep(800)
      const st = shelterState(ctx.pbot, cx, cz)
      const pr = await ctx.comp.probe()
      return { result: r.result, ms, ...st, bodyFail: BODY_FAIL.test(String(r.result)), inside: insideOf(pr?.pos, cx, cz), success: st.enclosed }
    },
  },
  shelter_walkin: {
    give: ['dirt 64'],
    async run(ctx) {
      const t0 = Date.now()
      const job = ctx.comp.execStart('shelter', { size: 3 })
      // The far corner from the doorway, on the bottom layer.
      const cell = { x: S.x + 1, z: S.z + 1 }
      await sleep(1000)
      let walkedIn = false
      if (!solid(ctx.pbot, cell.x, Y, cell.z) && !solid(ctx.pbot, cell.x, Y + 1, cell.z)) {
        await cmds([`tp ${PLAYER} ${cell.x + 0.5} ${Y} ${cell.z + 0.5}`])
        walkedIn = true
      }
      await sleep(3000)
      await cmds([tp(PLAYER, P, S)])
      const done = await job.done
      const ms = Date.now() - t0
      await sleep(800)
      const st = shelterState(ctx.pbot, S.x, S.z)
      return { result: done?.result, ms, walkedIn, ...st, bodyFail: BODY_FAIL.test(String(done?.result)), success: st.enclosed }
    },
  },
  shelter_control: {
    give: ['cobblestone 64'],
    async run(ctx) {
      const t0 = Date.now()
      const r = await ctx.exec('shelter', { size: 3 }, { timeoutMs: 240000 })
      const ms = Date.now() - t0
      await sleep(800)
      const st = shelterState(ctx.pbot, S.x, S.z)
      return { result: r.result, ms, ...st, success: st.enclosed }
    },
  },
  table_into_ground: {
    give: ['crafting_table'],
    async run(ctx) {
      const at = { x: S.x + 2, y: Y - 1, z: S.z }
      const t0 = Date.now()
      const r = await ctx.exec('build', { from: at, to: at, block: 'crafting_table' }, { timeoutMs: 60000 })
      const ms = Date.now() - t0
      await sleep(500)
      const placed = nameAt(ctx.pbot, at.x, Y, at.z) === 'crafting_table'
      return { result: r.result, ms, success: placed }
    },
  },
  wall_floating: {
    give: ['cobblestone 64'],
    async run(ctx) {
      const x = S.x + 3
      const t0 = Date.now()
      const r = await ctx.exec('build', { from: { x, y: Y + 1, z: S.z - 2 }, to: { x, y: Y + 2, z: S.z + 2 }, block: 'cobblestone' }, { timeoutMs: 90000 })
      const ms = Date.now() - t0
      await sleep(500)
      let low = 0
      for (let z = S.z - 2; z <= S.z + 2; z++) for (const y of [Y, Y + 1]) if (solid(ctx.pbot, x, y, z)) low++
      return { result: r.result, ms, onGround: low, success: low === 10 }
    },
  },
  pillar_self: {
    give: ['dirt 16'],
    async run(ctx) {
      const t0 = Date.now()
      const r = await ctx.exec('build', { from: { x: S.x, y: Y, z: S.z }, to: { x: S.x, y: Y + 1, z: S.z }, block: 'dirt' }, { timeoutMs: 60000 })
      const ms = Date.now() - t0
      await sleep(500)
      const n = [Y, Y + 1].filter((y) => solid(ctx.pbot, S.x, y, S.z)).length
      return { result: r.result, ms, placed: n, success: n === 2 }
    },
  },
}

async function main() {
  const which = (opt('cases', null) || Object.keys(CASES).join(',')).split(',').filter(Boolean)
  const bot = companionName()
  log(`repo ${REPO}, cases ${which.join(',')}, reps ${REPS}`)
  serverCtl('reset')
  serverCtl('start')
  const rows = []
  let pbot
  try {
    pbot = await connectPlayer()
    await cmds(WORLD_RULES)
    for (let rep = 1; rep <= REPS; rep++) {
      for (const id of which) {
        const c = CASES[id]
        if (!c) throw new Error(`unknown case ${id}`)
        await cmds([...arenaReset(), 'time set 1000'])
        const sessDir = path.join('/tmp', `qe-p36-${id}-${rep}`)
        let comp
        try {
          comp = await startCompanion({ sessDir, mode: 'direct', botRepo: REPO, tag: `qe-p36-${id}` })
        } catch (e) { rows.push({ id, rep, success: false, error: `boot: ${e.message}` }); continue }
        let row
        try {
          await cmds([...playersReset([PLAYER, bot]), tp(bot, S, P), tp(PLAYER, P, S), ...(c.give || []).map((g) => `give ${bot} ${g}`)])
          await sleep(1500)
          const ctx = { bot, pbot, comp, exec: (name, args, o) => comp.exec(name, args, o) }
          row = { id, rep, ...(await c.run(ctx)) }
        } catch (e) {
          row = { id, rep, success: false, error: String(e?.message || e) }
        } finally {
          try { pbot.pathfinder.setGoal(null) } catch {}
          await comp.stop().catch(() => {})
        }
        rows.push(row)
        log(JSON.stringify(row))
        if (OUT) fs.appendFileSync(OUT, JSON.stringify({ repo: REPO, ...row }) + '\n')
      }
    }
  } finally {
    try { pbot?.quit() } catch {}
    try { serverCtl('stop') } catch {}
  }
  const by = {}
  for (const r of rows) { (by[r.id] ??= []).push(r) }
  for (const [id, rs] of Object.entries(by)) {
    const ok = rs.filter((r) => r.success).length
    const ms = rs.map((r) => r.ms).filter(Number.isFinite).sort((a, b) => a - b)
    log(`${id}: ${ok}/${rs.length} success${ms.length ? `, median ${Math.round(ms[Math.floor(ms.length / 2)] / 100) / 10}s` : ''}`)
  }
  process.exit(0)
}

main().catch((e) => { console.error(e); try { serverCtl('stop') } catch {}; process.exit(1) })
