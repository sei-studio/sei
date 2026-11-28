#!/usr/bin/env node
// scripts/quality-eval/shelter-repro.mjs: direct-mode (no LLM) shelter runs on
// the eval server for quality pass 67 (261128). Pass 66 combat_night-02-B:
// with an empty bag, shelter dug supply blocks one at a time for its walls,
// a mob cut it off every time and it placed nothing. Short of blocks it now
// digs a 3-deep pit and roofs it with the dug blocks. Each trial rebuilds the
// arena, boots a fresh companion in direct mode from --repo, calls shelter
// straight and checks the world, then calls goTo to the player to check she
// gets back out of the pit.
//
//   node scripts/quality-eval/shelter-repro.mjs --repo <bot repo> [--cases a,b] [--reps N] [--out file.jsonl]
//
// Cases (arena: grass at y=70 over stone, she stands at y=71):
//   dirt_empty    dirt at y=68..69 under a 7x7 around her, empty bag
//   stone_pick    plain arena (stone under the grass), a wooden pickaxe
//   stone_nopick  plain arena, empty bag: no pit possible (stone under the
//                 grass, no pickaxe), so the old path runs (control: no
//                 "dug in"; with no mobs it builds walls from grass dirt)
//
// pit = the result says "dug in", her feet end at y=68 and the cell above
// her head (y=70) is solid. out = after goTo Alex she stands at y>=71 within
// 4 blocks of him.
//
// Owns the server for its run (reset, start, stop): book it in
// ~/suisei/eval/QUEUE.md first.
import fs from 'node:fs'
import path from 'node:path'
import { serverCtl, cmds } from './lib/server.mjs'
import { connectPlayer, countBlocks } from './lib/player.mjs'
import { startCompanion, companionName, PLAYER } from './lib/companionProc.mjs'
import { WORLD_RULES, arenaReset, playersReset, tp, S, P, Y } from './bench/arena.mjs'

const argv = process.argv.slice(2)
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d }
const REPO = path.resolve(opt('repo', process.cwd()))
const REPS = Number(opt('reps', 2))
const OUT = opt('out', null)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(`[shelter ${new Date().toISOString().slice(11, 19)}]`, ...a)

async function shelterAndCheck(ctx, { wantPit }) {
  const t0 = Date.now()
  const r = await ctx.exec('shelter', { size: 3 }, { timeoutMs: 120000 })
  const ms = Date.now() - t0
  await sleep(1000)
  const pr = await ctx.comp.probe()
  const p = pr?.pos ?? S
  const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z)
  const roof = countBlocks(ctx.pbot, { x0: bx, x1: bx, y0: Y - 1, y1: Y - 1, z0: bz, z1: bz }, (n) => n !== 'air')
  const result = String(r.result)
  const pit = /^dug in/.test(result) && by === Y - 3 && roof === 1
  const row = { result: result.slice(0, 400), ms, pos: pr?.pos, roof, pit }
  if (!wantPit) return { ...row, success: !/^dug in/.test(result) }
  // Out again: Alex stands 4 blocks off on the surface.
  await cmds([tp(PLAYER, P, S)])
  await sleep(1000)
  const g = await ctx.exec('goTo', { player: PLAYER, range: 2 }, { timeoutMs: 60000 })
  await sleep(800)
  const pr2 = await ctx.comp.probe()
  const q = pr2?.pos ?? p
  const out = q.y >= Y - 0.1 && Math.hypot(q.x - (P.x + 0.5), q.z - (P.z + 0.5)) <= 4
  return { ...row, goTo: String(g.result).slice(0, 200), posAfter: q, out, success: pit && out }
}

const around = (r) => ({ x0: S.x - r, x1: S.x + r, z0: S.z - r, z1: S.z + r })
const CASES = {
  dirt_empty: {
    world: (() => { const b = around(3); return [`fill ${b.x0} ${Y - 3} ${b.z0} ${b.x1} ${Y - 2} ${b.z1} dirt`] })(),
    give: [],
    run: (ctx) => shelterAndCheck(ctx, { wantPit: true }),
  },
  stone_pick: {
    give: ['wooden_pickaxe'],
    run: (ctx) => shelterAndCheck(ctx, { wantPit: true }),
  },
  stone_nopick: {
    give: [],
    run: (ctx) => shelterAndCheck(ctx, { wantPit: false }),
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
        await cmds([...arenaReset(), ...(c.world || [])])
        const sessDir = path.join('/tmp', `qe-shelter-${id}-${rep}`)
        let comp
        try {
          comp = await startCompanion({ sessDir, mode: 'direct', botRepo: REPO, tag: `qe-shelter-${id}` })
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
  for (const [id, rs] of Object.entries(by)) log(`${id}: ${rs.filter((r) => r.success).length}/${rs.length} success`)
  process.exit(0)
}

main().catch((e) => { console.error(e); try { serverCtl('stop') } catch {}; process.exit(1) })
