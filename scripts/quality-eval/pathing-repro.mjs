#!/usr/bin/env node
// scripts/quality-eval/pathing-repro.mjs: direct-mode (no LLM) pathing
// reproductions on the eval server, for the self-dug-hole and unreachable-
// target failures (quality pass 10, 261015). Each trial rebuilds the arena,
// boots a fresh companion in direct mode from --repo, sets up the case, calls
// the actions straight and records the result plus server/probe ground truth.
//
//   node scripts/quality-eval/pathing-repro.mjs --repo <bot repo> [--cases a,b] [--reps N] [--out file.jsonl]
//
// Cases:
//   shaft4_goto     dig own 1x1 shaft 4 deep, then goTo the player on the surface
//   shaft8_goto     same, 8 deep (keeps only the dug blocks as scaffolding)
//   shaft8_noblocks 8 deep, then the dug blocks are cleared: no scaffolding at all
//   shaft6_follow   6 deep, then follow the player for 30s
//   shaft8_bare     8 deep, then no blocks and no pickaxe: wants a quick,
//                   honest "stuck in a hole" answer, not a 12s timeout
//   pocket_goto     7-deep shaft with an ore pocket off its bottom, she stands
//                   in the pocket (not a 1x1 shaft), goTo the player
//   pocket_nopick   same, no blocks, wooden pickaxe only (staircase)
//   buried_coal     a coal ore buried 7 down is nearer than one on the
//                   surface (the errands-02 trap): find + goTo + dig, then
//                   back to the player
//   cliff_log_find  a tree on a sheer 6-high mesa (nearest) plus one on the
//                   ground: find oak_log + goTo it, twice, the way the brain did
//   cliff_log_gather gather 3 oak_log with the same layout
//   errands03_goto  261017: 15-deep shaft with a dead-end 2-high pocket in its
//                   wall 2 above the bottom (the errands-03 hole), goTo the player
//   errands03_offcenter standing on the edge of a block over the open shaft,
//                   build below 1 (base: "no solid floor below")
//   errands03_headroom a block right over her head, build below 1: wants a
//                   quick answer naming that block
//   buried_vein_find a 48-ore buried coal vein nearer than surface coal:
//                   find must return the surface coal
//   plank_room      she stands in a corner of a closed 3x3x3 oak-plank room
//                   (2-thick shell), axe + pickaxe, the player on its roof:
//                   goTo the player must NOT break a single plank, and must
//                   say it could not get there (261016 review)
//   hit_walk_goto   261019: a zombie next to her, the player 20 blocks east on
//                   open ground: goTo the player must get there through the
//                   hits (base: "cant_reach" when the 1s retaliation exit
//                   stopped the pathfinder)
//   follow_hit      follow the player, a zombie hits her, then the player
//                   moves 20 blocks: is she still trailing them?
//   death_recover   she dies 15 blocks from spawn with a sword and bread,
//                   respawns, then goTo the death spot + pickup
//   dig_name_6m     261025: dig({block:"granite"}) 6 blocks off, one call
//   dig_raised_5m   dig a granite on a 3-high pillar 5 blocks off, one call
//   craft_second_pickaxe craft a wooden pickaxe with one already in the bag
//                   and the parts only as planks and logs
//   beach_hole_a/b/c the combat_night holes on the natural beach: goTo from
//                   where she was stuck. natural: no arena, so run these
//                   alone right after the reset (--cases beach_hole_a,...)
//
// Shaft and follow cases only count as success on the SURFACE next to the
// player: tunnelling along under the player's feet is not "reached".
//
// Owns the server for its run (reset, start, stop), like scorecard.mjs: book
// it in ~/suisei/eval/QUEUE.md first.
import fs from 'node:fs'
import path from 'node:path'
import { serverCtl, cmds, itemCount } from './lib/server.mjs'
import { connectPlayer, distTo, entityOf } from './lib/player.mjs'
import { startCompanion, companionName, PLAYER } from './lib/companionProc.mjs'
import { Vec3 } from 'vec3'
import { WORLD_RULES, arenaReset, playersReset, tp, tree, zombie, S, P, Y, A } from './bench/arena.mjs'
const A_FLOOR = A.floor

const argv = process.argv.slice(2)
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d }
const REPO = path.resolve(opt('repo', process.cwd()))
const REPS = Number(opt('reps', 3))
const OUT = opt('out', null)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(`[repro ${new Date().toISOString().slice(11, 19)}]`, ...a)

// A sheer stone mesa with a tree on top, nearer to S than the ground tree.
const MESA = { x0: 182, x1: 186, z0: 4, z1: 8, top: Y + 5 }
// tree() is built at Y; rebuild the same shape on the mesa top by hand.
function treeAt(x, y, z, h = 5) {
  const top = y + h - 1
  return [
    `fill ${x - 2} ${top - 2} ${z - 2} ${x + 2} ${top - 1} ${z + 2} oak_leaves[persistent=true]`,
    `fill ${x - 1} ${top} ${z - 1} ${x + 1} ${top + 1} ${z + 1} oak_leaves[persistent=true]`,
    `fill ${x} ${y} ${z} ${x} ${top} ${z} oak_log`,
  ]
}
const CLIFF_WORLD = [
  `fill ${MESA.x0} ${Y} ${MESA.z0} ${MESA.x1} ${MESA.top} ${MESA.z1} stone`,
  ...treeAt(184, MESA.top + 1, 6),
  ...tree(166, -10),
]

async function digShaft(ctx, depth) {
  // Stand on the column at S and dig straight down (Y-1 .. Y-depth).
  return ctx.exec('dig', { x: S.x, y: Y - 1, z: S.z, to: { x: S.x, y: Y - depth, z: S.z } }, { timeoutMs: 90000 })
}

// Out of the hole and next to the player. Distance alone is not enough: a
// bot that tunnels under the player's feet is "4.5m away" four blocks down.
const onSurfaceNear = (pos, d) => d <= 4.5 && Number(pos?.y) >= Y - 0.5

async function gotoPlayer(ctx) {
  const t0 = Date.now()
  const r = await ctx.exec('goTo', { x: P.x, y: Y, z: P.z, range: 2 }, { timeoutMs: 60000 })
  const pr = await ctx.comp.probe()
  const d = distTo(ctx.pbot, ctx.bot)
  return { result: r.result, ms: Date.now() - t0, pos: pr?.pos, dist: Number(d.toFixed(1)), success: onSurfaceNear(pr?.pos, d) }
}

const CASES = {
  shaft4_goto: {
    give: ['stone_pickaxe'],
    async run(ctx) {
      const dug = await digShaft(ctx, 4)
      await sleep(800)
      const g = await gotoPlayer(ctx)
      return { dug: dug.result, ...g }
    },
  },
  shaft8_goto: {
    give: ['stone_pickaxe'],
    async run(ctx) {
      const dug = await digShaft(ctx, 8)
      await sleep(800)
      const g = await gotoPlayer(ctx)
      return { dug: dug.result, ...g }
    },
  },
  shaft8_noblocks: {
    give: ['stone_pickaxe'],
    async run(ctx) {
      const dug = await digShaft(ctx, 8)
      await cmds([`clear ${ctx.bot} cobblestone`, `clear ${ctx.bot} dirt`])
      await sleep(800)
      const g = await gotoPlayer(ctx)
      return { dug: dug.result, ...g }
    },
  },
  shaft6_follow: {
    give: ['stone_pickaxe'],
    async run(ctx) {
      const dug = await digShaft(ctx, 6)
      await sleep(800)
      const t0 = Date.now()
      const h = ctx.comp.execStart('follow', { player: PLAYER })
      let reachedMs = null
      while (Date.now() - t0 < 30000) {
        await sleep(500)
        const e = entityOf(ctx.pbot, ctx.bot)
        if (e && onSurfaceNear(e.position, distTo(ctx.pbot, ctx.bot))) { reachedMs = Date.now() - t0; break }
      }
      ctx.comp.abort(h.id)
      await h.done
      const d = distTo(ctx.pbot, ctx.bot)
      const pr = await ctx.comp.probe()
      return { dug: dug.result, result: reachedMs != null ? 'reached' : 'not reached in 30s', ms: reachedMs ?? 30000, pos: pr?.pos, dist: Number(d.toFixed(1)), success: reachedMs != null }
    },
  },
  shaft8_bare: {
    // No blocks and no pickaxe in a stone shaft: there is no way out in a
    // reasonable time. Success is an honest, quick answer that says so.
    give: ['stone_pickaxe'],
    async run(ctx) {
      const dug = await digShaft(ctx, 8)
      await cmds([`clear ${ctx.bot}`])
      await sleep(800)
      const g = await gotoPlayer(ctx)
      return { dug: dug.result, ...g, success: /^stuck in a hole/.test(g.result) && g.ms < 30000 }
    },
  },
  pocket_goto: {
    // The errands-02-B / 04-B hole: a 7-deep shaft with an ore pocket mined
    // out of the bottom wall, she stands in the pocket under solid rock (not
    // a clean 1x1 shaft), then goTo the player on the surface.
    give: ['stone_pickaxe', 'cobblestone 8'],
    async run(ctx) {
      await cmds([
        `fill ${S.x} ${Y - 7} ${S.z} ${S.x} ${Y - 1} ${S.z} air`,
        `fill ${S.x + 1} ${Y - 7} ${S.z} ${S.x + 2} ${Y - 6} ${S.z} air`,
        `tp ${ctx.bot} ${S.x + 2.5} ${Y - 7} ${S.z + 0.5}`,
      ])
      await sleep(1500)
      const g = await gotoPlayer(ctx)
      return g
    },
  },
  pocket_nopick: {
    // Same pocket, no blocks and only a wooden pickaxe: the staircase.
    give: ['wooden_pickaxe'],
    async run(ctx) {
      await cmds([
        `fill ${S.x} ${Y - 7} ${S.z} ${S.x} ${Y - 1} ${S.z} air`,
        `fill ${S.x + 1} ${Y - 7} ${S.z} ${S.x + 2} ${Y - 6} ${S.z} air`,
        `tp ${ctx.bot} ${S.x + 2.5} ${Y - 7} ${S.z + 0.5}`,
      ])
      await sleep(1500)
      const g = await gotoPlayer(ctx)
      return g
    },
  },
  buried_coal: {
    // A coal ore buried in the arena's stone 7 blocks down and nearer than an
    // exposed one on the surface (the errands-02 setup). find + goTo + dig,
    // up to twice; success = coal in hand and back on the surface.
    world: [`setblock ${S.x} ${Y - 7} ${S.z + 3} coal_ore`, `setblock 190 ${Y} 6 coal_ore`],
    give: ['stone_pickaxe'],
    async run(ctx) {
      const steps = []
      const t0 = Date.now()
      let got = false
      for (let i = 0; i < 2 && !got; i++) {
        const f = await ctx.exec('find', { name: 'coal_ore' })
        let pos = null
        try { pos = JSON.parse(f.result).pos } catch {}
        if (!pos) { steps.push({ find: f.result }); break }
        const g = await ctx.exec('goTo', { x: pos.x, y: pos.y, z: pos.z, range: 2 }, { timeoutMs: 60000 })
        const d = await ctx.exec('dig', { x: pos.x, y: pos.y, z: pos.z }, { timeoutMs: 30000 })
        steps.push({ find: `${pos.x},${pos.y},${pos.z}`, goTo: g.result, dig: d.result })
        await sleep(1500)
        got = (await itemCount(ctx.bot, 'coal')) > 0
      }
      // Then come back to the player, as the errands script asks.
      const back = await gotoPlayer(ctx)
      steps.push({ back: back.result })
      return { steps, result: got ? 'got coal' : 'no coal', ms: Date.now() - t0, pos: back.pos, success: got && back.success }
    },
  },
  cliff_log_find: {
    world: CLIFF_WORLD,
    give: [],
    async run(ctx) {
      const steps = []
      let got = false
      const t0 = Date.now()
      for (let i = 0; i < 3 && !got; i++) {
        const f = await ctx.exec('find', { name: 'oak_log' })
        let pos = null
        try { pos = JSON.parse(f.result).pos } catch {}
        if (!pos) { steps.push({ find: f.result }); break }
        const g = await ctx.exec('goTo', { x: pos.x, y: pos.y, z: pos.z, range: 2 }, { timeoutMs: 60000 })
        const d = await ctx.exec('dig', { x: pos.x, y: pos.y, z: pos.z }, { timeoutMs: 30000 })
        steps.push({ find: `${pos.x},${pos.y},${pos.z}`, goTo: g.result, dig: d.result })
        await sleep(1500)
        got = (await itemCount(ctx.bot, '#minecraft:logs')) > 0
      }
      return { steps, result: got ? 'got a log' : 'no log', ms: Date.now() - t0, success: got }
    },
  },
  cliff_log_gather: {
    world: CLIFF_WORLD,
    give: [],
    async run(ctx) {
      const t0 = Date.now()
      const r = await ctx.exec('gather', { name: 'oak_log', count: 3 }, { timeoutMs: 150000 })
      await sleep(1500)
      const n = await itemCount(ctx.bot, '#minecraft:logs')
      return { result: r.result, ms: Date.now() - t0, logs: n, success: n >= 3 }
    },
  },
  // 261025 (pass 27): one model-style dig({block}) of a block out of reach.
  // Base: "out of range" (dig never walked). Head: walks, digs, says what
  // reached the inventory. success = the drop is in her inventory after ONE
  // call, with no goTo or pickup.
  dig_name_6m: {
    world: [`setblock ${S.x + 6} ${Y} ${S.z + 1} granite`],
    give: ['stone_pickaxe'],
    async run(ctx) {
      const t0 = Date.now()
      const d = await ctx.exec('dig', { block: 'granite' }, { timeoutMs: 40000 })
      const ms = Date.now() - t0
      await sleep(1000)
      const n = await itemCount(ctx.bot, 'granite')
      return { result: d.result, ms, granite: n, success: n >= 1 }
    },
  },
  dig_raised_5m: {
    // On top of a 3-high stone pillar, 5 east: reachable from beside the
    // pillar (eyes to block), not from where she stands.
    world: [`fill ${S.x + 5} ${Y} ${S.z} ${S.x + 5} ${Y + 2} ${S.z} stone`, `setblock ${S.x + 5} ${Y + 3} ${S.z} granite`],
    give: ['stone_pickaxe'],
    async run(ctx) {
      const t0 = Date.now()
      const d = await ctx.exec('dig', { x: S.x + 5, y: Y + 3, z: S.z }, { timeoutMs: 40000 })
      const ms = Date.now() - t0
      await sleep(1000)
      const n = await itemCount(ctx.bot, 'granite')
      return { result: d.result, ms, granite: n, success: n >= 1 }
    },
  },
  craft_second_pickaxe: {
    // The pass26 gather_craft-01-A bag: 3 planks, 3 logs, one wooden pickaxe
    // already. Base: "need 2 more stick". success = two pickaxes.
    world: [`setblock ${S.x + 1} ${Y} ${S.z + 1} crafting_table`],
    give: ['oak_planks 3', 'oak_log 3', 'wooden_pickaxe 1'],
    async run(ctx) {
      const t0 = Date.now()
      const c = await ctx.exec('craft', { item: 'wooden_pickaxe', count: 1 }, { timeoutMs: 30000 })
      const ms = Date.now() - t0
      await sleep(800)
      const n = await itemCount(ctx.bot, 'wooden_pickaxe')
      return { result: c.result, ms, pickaxes: n, success: n >= 2 }
    },
  },
}

// 261017 (pass 12): the errands-03 hole (scorecard 2026-10-16). Below the
// arena's 8 stone layers is seed terrain, which arenaReset does not restore
// and which differs from spot to spot (dirt, ore, water), so these cases
// first fill a stone block under S and carve their hole into it.
const DEEP = { x0: S.x - 4, x1: S.x + 4, y0: Y - 18, y1: A_FLOOR - 9, z0: S.z - 4, z1: S.z + 4 }
const deepStone = () => `fill ${DEEP.x0} ${DEEP.y0} ${DEEP.z0} ${DEEP.x1} ${DEEP.y1} ${DEEP.z1} stone`
const SHAFT_BOTTOM = Y - 15
const shaftAir = () => `fill ${S.x} ${SHAFT_BOTTOM} ${S.z} ${S.x} ${Y - 1} ${S.z} air`

CASES.errands03_goto = {
  // A 15-deep 1x1 shaft with a 2-high pocket mined out of its wall two
  // blocks above the bottom (the two coal ores she dug in errands-03). The
  // pocket is the shaft's first side opening and a dead end. goTo the player.
  give: ['stone_pickaxe', 'cobblestone 16'],
  async run(ctx) {
    await cmds([
      deepStone(),
      shaftAir(),
      `fill ${S.x + 1} ${SHAFT_BOTTOM + 2} ${S.z} ${S.x + 1} ${SHAFT_BOTTOM + 3} ${S.z} air`,
      `tp ${ctx.bot} ${S.x + 0.5} ${SHAFT_BOTTOM} ${S.z + 0.5}`,
    ])
    await sleep(1500)
    return gotoPlayer(ctx)
  },
}

CASES.errands03_offcenter = {
  // She stands on the edge of a block with her feet column over the open
  // shaft (errands-03 at 01:05), then pillars 1: "no solid floor below" on
  // the base. Success = she rose a block.
  give: ['stone_pickaxe', 'cobblestone 4'],
  async run(ctx) {
    const feet = SHAFT_BOTTOM + 4
    await cmds([
      deepStone(),
      shaftAir(),
      `fill ${S.x + 1} ${feet} ${S.z} ${S.x + 1} ${feet + 2} ${S.z} air`,
      `tp ${ctx.bot} ${S.x + 0.8} ${feet} ${S.z + 0.5}`,
    ])
    await sleep(1500)
    const before = (await ctx.comp.probe())?.pos
    const t0 = Date.now()
    const r = await ctx.exec('build', { direction: 'below', count: 1, block: 'cobblestone' }, { timeoutMs: 30000 })
    const ms = Date.now() - t0
    await sleep(500)
    const pos = (await ctx.comp.probe())?.pos
    return { result: r.result, ms, before, pos, success: /^pillared up 1/.test(String(r.result)) && Number(pos?.y) >= feet + 0.9 }
  },
}

CASES.errands03_headroom = {
  // A block right over her head (errands-03 at 01:16), pillar 1. Nothing can
  // work; success = a quick answer that names the block over her head.
  give: ['stone_pickaxe', 'cobblestone 4'],
  async run(ctx) {
    const feet = SHAFT_BOTTOM + 4
    await cmds([
      deepStone(),
      shaftAir(),
      `fill ${S.x + 1} ${feet} ${S.z} ${S.x + 1} ${feet + 1} ${S.z} air`,
      `tp ${ctx.bot} ${S.x + 1.5} ${feet} ${S.z + 0.5}`,
    ])
    await sleep(1500)
    const t0 = Date.now()
    const r = await ctx.exec('build', { direction: 'below', count: 1, block: 'cobblestone' }, { timeoutMs: 30000 })
    const ms = Date.now() - t0
    const pos = (await ctx.comp.probe())?.pos
    return { result: r.result, ms, pos, success: /no head room/.test(String(r.result)) && String(r.result).includes(`${S.x + 1},${feet + 2},${S.z}`) && ms < 5000 }
  },
}

CASES.buried_vein_find = {
  // A buried coal vein (48 ores, 13-16 blocks down) nearer than the
  // exposed coal the errands script places on the surface. errands-03's find
  // returned the vein: the nearest 24 hits were all buried.
  give: [],
  async run(ctx) {
    await cmds([
      deepStone(),
      `fill ${S.x + 1} ${Y - 16} ${S.z - 2} ${S.x + 3} ${Y - 13} ${S.z + 1} coal_ore`,
      `fill 198 ${Y} 10 199 ${Y + 1} 11 coal_ore`,
    ])
    await sleep(800)
    const t0 = Date.now()
    const f = await ctx.exec('find', { name: 'coal_ore' })
    const ms = Date.now() - t0
    let pos = null
    try { pos = JSON.parse(f.result).pos } catch {}
    // Leave no vein behind for the cases after this one.
    await cmds([deepStone()])
    return { result: f.result, ms, success: !!pos && pos.y >= Y - 1 }
  },
}

// A closed oak-plank room around S: shell x/z ±2, y Y..Y+4, hollow ±1 and
// Y..Y+2, so the roof is two planks thick and its top is at Y+4.
const ROOM = { x0: S.x - 2, x1: S.x + 2, y0: Y, y1: Y + 4, z0: S.z - 2, z1: S.z + 2 }
function roomPlanks(pbot) {
  let n = 0
  for (let x = ROOM.x0; x <= ROOM.x1; x++) {
    for (let y = ROOM.y0; y <= ROOM.y1; y++) {
      for (let z = ROOM.z0; z <= ROOM.z1; z++) {
        if (pbot.blockAt(new Vec3(x, y, z))?.name === 'oak_planks') n++
      }
    }
  }
  return n
}
CASES.plank_room = {
  world: [
    `fill ${ROOM.x0} ${ROOM.y0} ${ROOM.z0} ${ROOM.x1} ${ROOM.y1} ${ROOM.z1} oak_planks`,
    `fill ${S.x - 1} ${Y} ${S.z - 1} ${S.x + 1} ${Y + 2} ${S.z + 1} air`,
  ],
  give: ['iron_axe', 'stone_pickaxe'],
  async run(ctx) {
    await cmds([
      `tp ${PLAYER} ${S.x + 0.5} ${ROOM.y1 + 1} ${S.z + 0.5}`,
      `tp ${ctx.bot} ${S.x - 0.5} ${Y} ${S.z - 0.5}`,
    ])
    await sleep(2000)
    const before = roomPlanks(ctx.pbot)
    const t0 = Date.now()
    const r = await ctx.exec('goTo', { x: S.x, y: ROOM.y1 + 1, z: S.z, range: 2 }, { timeoutMs: 90000 })
    const ms = Date.now() - t0
    await sleep(1000)
    const after = roomPlanks(ctx.pbot)
    const pr = await ctx.comp.probe()
    const honest = !/^reached/.test(String(r.result))
    return { result: r.result, ms, pos: pr?.pos, planks: `${before}->${after}`, success: before === 98 && after === before && honest }
  },
}

// 261019 (quality pass 19). A mob hit used to stop whatever walk was running.
const FAR = { x: S.x + 20, y: Y, z: S.z }
CASES.hit_walk_goto = {
  give: [],
  async run(ctx) {
    await cmds([tp(PLAYER, FAR, S), zombie(S.x + 1, S.z + 1)])
    await sleep(2500) // the zombie closes in and lands a hit or two
    const t0 = Date.now()
    const r = await ctx.exec('goTo', { x: FAR.x, y: Y, z: FAR.z, range: 2 }, { timeoutMs: 60000 })
    const ms = Date.now() - t0
    const pr = await ctx.comp.probe()
    const d = distTo(ctx.pbot, ctx.bot)
    return { result: r.result, ms, pos: pr?.pos, hp: pr?.hp, dist: Number(d.toFixed(1)), success: /^reached/.test(String(r.result)) && onSurfaceNear(pr?.pos, d) }
  },
}
CASES.follow_hit = {
  give: [],
  async run(ctx) {
    const h = ctx.comp.execStart('follow', { player: PLAYER })
    await sleep(1500)
    await cmds([zombie(S.x + 1, S.z + 1)])
    await sleep(5000) // hit, retaliation, its exit
    await cmds(['kill @e[type=zombie]', tp(PLAYER, FAR, S)])
    const t0 = Date.now()
    let reachedMs = null
    while (Date.now() - t0 < 20000) {
      await sleep(500)
      if (distTo(ctx.pbot, ctx.bot) <= 5) { reachedMs = Date.now() - t0; break }
    }
    ctx.comp.abort(h.id)
    const done = await h.done
    const d = distTo(ctx.pbot, ctx.bot)
    return { result: done?.result ?? (reachedMs != null ? 'trailing' : 'not trailing'), ms: reachedMs ?? 20000, dist: Number(d.toFixed(1)), success: reachedMs != null }
  },
}
CASES.death_recover = {
  give: ['stone_sword', 'bread 5', 'oak_planks 12'],
  async run(ctx) {
    const spot = { x: S.x + 15, y: Y, z: S.z + 3 }
    await cmds([tp(ctx.bot, spot)])
    await sleep(1500)
    await cmds([`kill ${ctx.bot}`])
    await sleep(4000) // respawn at the world spawn (S) and settle
    const t0 = Date.now()
    const g = await ctx.exec('goTo', { x: spot.x, y: Y, z: spot.z, range: 2 }, { timeoutMs: 60000 })
    const p = await ctx.exec('pickup', {}, { timeoutMs: 60000 })
    const ms = Date.now() - t0
    const pr = await ctx.comp.probe()
    const inv = JSON.stringify(pr?.inv ?? '')
    const ok = /stone_sword/.test(inv) && /bread/.test(inv)
    return { result: `${g.result} | ${p.result}`, ms, inv: pr?.inv, success: ok }
  },
}

// 261019: the combat_night holes on the natural beach (free-play world, no
// arena). goTo from where she was stuck to where she was going.
function beachHole(from, to) {
  return {
    natural: true,
    give: [],
    async run(ctx) {
      await cmds([`tp ${ctx.bot} ${from.x + 0.5} ${from.y} ${from.z + 0.5}`, `tp ${PLAYER} ${to.x + 0.5} ${to.y} ${to.z + 0.5}`])
      await sleep(2500)
      const start = await ctx.comp.probe()
      const t0 = Date.now()
      const r = await ctx.exec('goTo', { x: to.x, y: to.y, z: to.z, range: 2 }, { timeoutMs: 90000 })
      const ms = Date.now() - t0
      const pr = await ctx.comp.probe()
      const d = distTo(ctx.pbot, ctx.bot)
      return { result: r.result, ms, start: start?.pos, pos: pr?.pos, dist: Number(d.toFixed(1)), success: d <= 4.5 && Number(pr?.pos?.y) >= to.y - 1.5 }
    },
  }
}
CASES.beach_hole_a = beachHole({ x: 169, y: 62, z: 12 }, { x: 184, y: 64, z: 10 })
CASES.beach_hole_b = beachHole({ x: 155, y: 61, z: 13 }, { x: 177, y: 64, z: 9 })
CASES.beach_hole_c = beachHole({ x: 153, y: 61, z: 12 }, { x: 168, y: 64, z: 3 })

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
        // The shaft cases dig below the 8-layer arena floor into seed
        // terrain; restore the whole column region each trial.
        // natural cases play on the seed terrain the free-play scenarios use
        // (the arena overwrites it): run them alone, right after the reset.
        await cmds([...(c.natural ? ['kill @e[type=!player]', 'time set 1000', 'weather clear'] : arenaReset()), ...(c.world || [])])
        const sessDir = path.join('/tmp', `qe-repro-${id}-${rep}`)
        let comp
        try {
          comp = await startCompanion({ sessDir, mode: 'direct', botRepo: REPO, tag: `qe-repro-${id}` })
        } catch (e) { rows.push({ id, rep, success: false, error: `boot: ${e.message}` }); continue }
        let row
        try {
          await cmds([...playersReset([PLAYER, bot]), tp(bot, S, P), tp(PLAYER, P, S), ...(c.give || []).map((g) => `give ${bot} ${g}`)])
          await sleep(1500)
          const ctx = {
            bot, pbot, comp,
            exec: (name, args, o) => comp.exec(name, args, o),
          }
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
    const ms = rs.filter((r) => r.success).map((r) => r.ms)
    log(`${id}: ${ok}/${rs.length} success${ms.length ? `, median ${Math.round(ms.sort((a, b) => a - b)[Math.floor(ms.length / 2)] / 100) / 10}s` : ''}`)
  }
  process.exit(0)
}

main().catch((e) => { console.error(e); try { serverCtl('stop') } catch {}; process.exit(1) })
