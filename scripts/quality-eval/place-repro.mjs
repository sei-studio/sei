#!/usr/bin/env node
// scripts/quality-eval/place-repro.mjs: direct-mode (no LLM) placement
// reproductions on the eval server, for the "no open spot in reach" table and
// furnace failures of quality pass 45 (261108, pass 46). Each trial rebuilds
// the arena, boots a fresh companion in direct mode from --repo, sets up the
// ground, calls placeBlock (or craft) straight and checks the world.
//
//   node scripts/quality-eval/place-repro.mjs --repo <bot repo> [--cases a,b] [--reps N] [--out file.jsonl]
//
// Cases (arena: flat grass at y=70, she stands at y=71):
//   bare_table       plain arena, placeBlock crafting_table (control)
//   grass_table      short_grass on every cell around her (open plains)
//   tallgrass_furnace tall_grass (two-high) around her, placeBlock furnace
//   edge_table       she stands 0.85 into her block, so her hitbox pokes into
//                    the +x cell (the first cell the old search tried)
//   pond_table       she stands in the middle of an 11x11, 1-deep pond:
//                    every cell in reach is water, dry bank 5 blocks off
//   pit_table        she stands in a 1x1 pit 2 deep
//   craft_far_table  a crafting table on an 8-high pillar 12 blocks off (out
//                    of reach from the ground, the 03-B hill table), one in
//                    her bag: craft wooden_pickaxe
//   nat_02b_river    natural: the gather_craft-02-B riverbank spot (in water)
//   nat_01b_meadow   natural: the gather_craft-01-B tall-grass spot, furnace
//
// A trial succeeds when the block stands within 6 blocks of her in the world,
// is gone from her bag, and the result says it was placed (the base reported
// "no open spot" for a table the server had in fact put into a grass tuft or
// water). craft_far_table: the pickaxe is in her bag.
//
// Owns the server for its run (reset, start, stop): book it in
// ~/suisei/eval/QUEUE.md first. natural cases play on the seed terrain and the
// 01-B meadow lies inside the arena box, so run the nat_* cases in their own
// run, right after the reset (--cases nat_02b_river,nat_01b_meadow).
import fs from 'node:fs'
import path from 'node:path'
import { serverCtl, cmds, itemCount } from './lib/server.mjs'
import { connectPlayer, countBlocks } from './lib/player.mjs'
import { startCompanion, companionName, PLAYER } from './lib/companionProc.mjs'
import { WORLD_RULES, arenaReset, playersReset, tp, S, P, Y } from './bench/arena.mjs'

const argv = process.argv.slice(2)
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d }
const REPO = path.resolve(opt('repo', process.cwd()))
const REPS = Number(opt('reps', 3))
const OUT = opt('out', null)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(`[place ${new Date().toISOString().slice(11, 19)}]`, ...a)

const around = (r) => ({ x0: S.x - r, x1: S.x + r, z0: S.z - r, z1: S.z + r })

async function placeAndCheck(ctx, block) {
  const before = await itemCount(ctx.bot, block)
  const t0 = Date.now()
  const r = await ctx.exec('placeBlock', { block }, { timeoutMs: 60000 })
  const ms = Date.now() - t0
  await sleep(800)
  const pr = await ctx.comp.probe()
  const p = pr?.pos ?? S
  const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z)
  const near = countBlocks(ctx.pbot, { x0: bx - 6, x1: bx + 6, y0: by - 3, y1: by + 3, z0: bz - 6, z1: bz + 6 }, (n) => n === block)
  const after = await itemCount(ctx.bot, block)
  return { result: String(r.result), ms, pos: pr?.pos, near, bag: `${before}->${after}`, success: near >= 1 && after < before && /^placed /.test(String(r.result)) }
}

const CASES = {
  bare_table: {
    give: ['crafting_table'],
    run: (ctx) => placeAndCheck(ctx, 'crafting_table'),
  },
  grass_table: {
    world: (() => { const b = around(5); return [`fill ${b.x0} ${Y} ${b.z0} ${b.x1} ${Y} ${b.z1} short_grass`] })(),
    give: ['crafting_table'],
    run: (ctx) => placeAndCheck(ctx, 'crafting_table'),
  },
  tallgrass_furnace: {
    world: (() => {
      const b = around(5)
      return [
        `fill ${b.x0} ${Y} ${b.z0} ${b.x1} ${Y} ${b.z1} tall_grass[half=lower]`,
        `fill ${b.x0} ${Y + 1} ${b.z0} ${b.x1} ${Y + 1} ${b.z1} tall_grass[half=upper]`,
      ]
    })(),
    give: ['furnace'],
    run: (ctx) => placeAndCheck(ctx, 'furnace'),
  },
  edge_table: {
    give: ['crafting_table'],
    async run(ctx) {
      await cmds([`tp ${ctx.bot} ${S.x + 0.85} ${Y} ${S.z + 0.5}`])
      await sleep(1200)
      return placeAndCheck(ctx, 'crafting_table')
    },
  },
  pond_table: {
    world: (() => { const b = around(5); return [`fill ${b.x0} ${Y - 1} ${b.z0} ${b.x1} ${Y - 1} ${b.z1} water`] })(),
    give: ['crafting_table'],
    async run(ctx) {
      await cmds([`tp ${ctx.bot} ${S.x + 0.5} ${Y - 1} ${S.z + 0.5}`])
      await sleep(1500)
      return placeAndCheck(ctx, 'crafting_table')
    },
  },
  pit_table: {
    world: [`fill ${S.x} ${Y - 2} ${S.z} ${S.x} ${Y - 1} ${S.z} air`],
    give: ['crafting_table'],
    async run(ctx) {
      await cmds([`tp ${ctx.bot} ${S.x + 0.5} ${Y - 2} ${S.z + 0.5}`])
      await sleep(1500)
      return placeAndCheck(ctx, 'crafting_table')
    },
  },
  craft_far_table: {
    world: [`fill ${S.x + 12} ${Y} ${S.z} ${S.x + 12} ${Y + 7} ${S.z} stone`, `setblock ${S.x + 12} ${Y + 8} ${S.z} crafting_table`],
    give: ['crafting_table', 'oak_planks 3', 'stick 2'],
    async run(ctx) {
      const t0 = Date.now()
      const r = await ctx.exec('craft', { item: 'wooden_pickaxe', count: 1 }, { timeoutMs: 60000 })
      const ms = Date.now() - t0
      await sleep(800)
      const pick = await itemCount(ctx.bot, 'wooden_pickaxe')
      return { result: String(r.result), ms, success: pick >= 1 }
    },
  },
}

function natural(at, block) {
  return {
    natural: true,
    give: [block],
    async run(ctx) {
      await cmds([`tp ${ctx.bot} ${at.x + 0.5} ${at.y} ${at.z + 0.5}`, `tp ${PLAYER} ${at.x + 3.5} ${at.y + 2} ${at.z + 3.5}`])
      await sleep(2500)
      const row = await placeAndCheck(ctx, block)
      // The next rep starts on the same untouched ground.
      await cmds([`fill ${at.x - 8} ${at.y - 6} ${at.z - 8} ${at.x + 8} ${at.y + 4} ${at.z + 8} air replace ${block}`])
      return row
    },
  }
}
CASES.nat_02b_river = natural({ x: 187, y: 62, z: 27 }, 'crafting_table')
CASES.nat_01b_meadow = natural({ x: 185, y: 66, z: -4 }, 'furnace')

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
        await cmds([...(c.natural ? ['kill @e[type=!player]', 'time set 1000', 'weather clear'] : arenaReset()), ...(c.world || [])])
        const sessDir = path.join('/tmp', `qe-place-${id}-${rep}`)
        let comp
        try {
          comp = await startCompanion({ sessDir, mode: 'direct', botRepo: REPO, tag: `qe-place-${id}` })
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
  for (const [id, rs] of Object.entries(by)) {
    const ok = rs.filter((r) => r.success).length
    const ms = rs.filter((r) => r.success).map((r) => r.ms).sort((a, b) => a - b)
    log(`${id}: ${ok}/${rs.length} success${ms.length ? `, median ${Math.round(ms[Math.floor(ms.length / 2)] / 100) / 10}s` : ''}`)
  }
  process.exit(0)
}

main().catch((e) => { console.error(e); try { serverCtl('stop') } catch {}; process.exit(1) })
