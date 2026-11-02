// scripts/decision-eval/tasks.mjs: the decision-eval tasks, built in the
// quality-eval arena (scripts/quality-eval/bench/arena.mjs: x144..207,
// z-16..15, floor y70, stand y71, 8 layers of stone under the grass).
//
// Each task:
//   text         the plain-language task every arm is given
//   world        console commands after the arena reset (blocks)
//   start(name)  commands once the actor is in (tp, items, time)
//   atStart()    commands at the moment the clock starts (mobs)
//   timeMs       wall-clock cap per arm kind {L1, L2, L3, base}
//   steps        decision cap per level {L2, L3}
//   milestones   ordered labels; progress(obs, mem) returns how many are reached
//   final(ctx)   server truth at the end: {success, value, detail}
//
// Success is read from the SERVER (/clear <p> <item> 0 counts, entity counts)
// or the actor's own block view, never from the decider's own claim.
import { S, P, Y, tree, tp, zombie } from '../quality-eval/bench/arena.mjs'

export const MARKER = { x: 196, y: Y, z: -6 } // ~21 blocks from S, behind her back
const TREES = [...tree(184, -4), ...tree(186, 4), ...tree(191, 0)]
// Iron: four ore blocks two below the grass (grass y70, stone y69, ore y68), ~19 m east of S.
const ORE = { x: 194, y: Y - 3, z: 7 }
const ORE_CMDS = [`fill ${ORE.x} ${ORE.y} ${ORE.z} ${ORE.x + 1} ${ORE.y} ${ORE.z + 1} iron_ore`]
const FURNACE = { x: S.x - 2, y: Y, z: S.z + 2 }
// Cow: 48+ blocks from the start, behind a 4-high wall with a gap at the south end.
const COW_START = { x: 150, y: Y, z: 0 }
const COW_AT = { x: 199, z: -8 }
const WALL_X = 190

const inv = (o) => o?.self?.inv || {}
const n = (o, k) => inv(o)[k] || 0
const hdist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
const T = (L1, L2, L3, base) => ({ L1, L2, L3, base })

export const TASKS = {
  nav: {
    text: 'Walk to the gold block.',
    world: [`setblock ${MARKER.x} ${MARKER.y} ${MARKER.z} gold_block`],
    // Facing the player (west); the gold block is east, so she must turn around.
    start: (b) => [tp(b, S, P)],
    timeMs: T(null, 120000, 240000, 120000), steps: { L2: 15, L3: 120 },
    milestones: ['moved 5+ blocks closer', 'within 10 m', 'reached (<= 2.5 m)'],
    progress(o, mem) {
      const d = hdist(o.self.pos, { x: MARKER.x + 0.5, z: MARKER.z + 0.5 })
      mem.d0 ??= d
      return d <= 2.5 ? 3 : d <= 10 ? 2 : mem.d0 - d >= 5 ? 1 : 0
    },
    done: (o) => hdist(o.self.pos, { x: MARKER.x + 0.5, z: MARKER.z + 0.5 }) <= 2.5,
    finalMilestone: (f) => (f.success ? 3 : null),
    final: async (ctx) => {
      const o = await ctx.obs()
      const d = o ? hdist(o.self.pos, { x: MARKER.x + 0.5, z: MARKER.z + 0.5 }) : Infinity
      return { success: d <= 2.5, value: Number(d.toFixed(1)), detail: `${d.toFixed(1)} m from the gold block` }
    },
  },
  logs: {
    text: 'Collect 4 oak logs from the trees nearby.',
    world: TREES,
    start: (b) => [tp(b, S, { x: 184, y: Y, z: 0 })],
    timeMs: T(null, 240000, 420000, 240000), steps: { L2: 20, L3: 220 },
    milestones: ['1 log', '2 logs', '3 logs', '4 logs'],
    progress: (o) => Math.min(4, n(o, 'oak_log')),
    done: (o) => n(o, 'oak_log') >= 4,
    finalMilestone: (f) => Math.min(4, f.value || 0),
    final: async (ctx) => { const k = await ctx.itemCount('oak_log'); return { success: k >= 4, value: k, detail: `${k} oak logs` } },
  },
  craft: {
    text: 'Craft oak planks from your logs, then craft a crafting table.',
    world: [],
    start: (b) => [tp(b, S, P), `give ${b} oak_log 4`],
    timeMs: T(null, 180000, 360000, 180000), steps: { L2: 15, L3: 150 },
    milestones: ['planks crafted', 'crafting table'],
    progress: (o) => (n(o, 'crafting_table') || o.blocks?.some((b) => b.name === 'crafting_table' && b.dist <= 6) ? 2 : n(o, 'oak_planks') ? 1 : 0),
    done: (o) => n(o, 'crafting_table') > 0 || !!o.blocks?.some((b) => b.name === 'crafting_table' && b.dist <= 6),
    finalMilestone: (f) => (f.success ? 2 : null),
    final: async (ctx) => {
      const t = await ctx.itemCount('crafting_table')
      const o = await ctx.obs()
      const placed = o?.blocks?.some((b) => b.name === 'crafting_table' && b.dist <= 8) ? 1 : 0
      const planks = await ctx.itemCount('oak_planks')
      return { success: t + placed >= 1, value: t + placed, detail: `table ${t} held + ${placed} placed, planks ${planks}` }
    },
  },
  stone: {
    text: 'Mine 3 stone (the stone is under the grass). You have a wooden pickaxe.',
    world: [],
    start: (b) => [tp(b, S, P), `give ${b} wooden_pickaxe`],
    timeMs: T(null, 180000, 360000, 180000), steps: { L2: 15, L3: 160 },
    milestones: ['dug below the grass', '1 cobblestone', '2 cobblestone', '3 cobblestone'],
    progress(o, mem) {
      if (o.self.pos.y < Y - 0.5) mem.dug = true
      const c = Math.min(3, n(o, 'cobblestone'))
      return c ? 1 + c : mem.dug ? 1 : 0
    },
    done: (o) => n(o, 'cobblestone') >= 3,
    finalMilestone: (f) => (f.value ? 1 + Math.min(3, f.value) : null),
    final: async (ctx) => { const k = await ctx.itemCount('cobblestone'); return { success: k >= 3, value: k, detail: `${k} cobblestone` } },
  },
  fight: {
    text: 'It is night and zombies are coming. Survive for 60 seconds.',
    world: [],
    start: (b) => ['time set 18000', tp(b, S, P), `give ${b} stone_sword`, `give ${b} bread 3`],
    atStart: () => [zombie(S.x + 7, S.z - 3), zombie(S.x + 6, S.z + 5)],
    timeMs: T(60000, 60000, 60000, 60000), steps: { L2: 40, L3: 200 },
    survival: true, zombies: 2,
    milestones: ['alive at 60 s', '1 zombie killed', '2 zombies killed'],
    final: async (ctx) => {
      const z = await ctx.entityCount('@e[type=zombie]')
      const alive = ctx.deaths() === 0
      return { success: alive, value: 2 - z, detail: `${alive ? 'alive' : 'died'}, killed ${2 - z}/2`, milestone: (alive ? 1 : 0) + (2 - z) }
    },
  },
  fight_hard: {
    text: 'It is night and four zombies are coming from all sides. Survive for 60 seconds.',
    world: [],
    start: (b) => ['time set 18000', tp(b, S, P), `give ${b} stone_sword`, `give ${b} bread 3`],
    atStart: () => [zombie(S.x + 6, S.z - 4), zombie(S.x + 5, S.z + 5), zombie(S.x - 6, S.z + 4), zombie(S.x - 5, S.z - 6)],
    timeMs: T(60000, 60000, 60000, 60000), steps: { L2: 40, L3: 200 },
    survival: true, zombies: 4,
    milestones: ['alive at 60 s', 'kills (of 4)'],
    final: async (ctx) => {
      const z = await ctx.entityCount('@e[type=zombie]')
      const alive = ctx.deaths() === 0
      return { success: alive, value: 4 - z, detail: `${alive ? 'alive' : 'died'}, killed ${4 - z}/4`, milestone: (alive ? 1 : 0) }
    },
  },
  // ── HARD ──────────────────────────────────────────────────────────────
  cow: {
    text: 'Find a cow and kill it to get beef.',
    world: [`fill ${WALL_X} ${Y} ${-16} ${WALL_X} ${Y + 3} 9 stone_bricks`],
    start: (b) => [tp(b, COW_START, { x: 144, y: Y, z: 0 }), `give ${b} stone_sword`],
    atStart: () => [`summon cow ${COW_AT.x + 0.5} ${Y} ${COW_AT.z + 0.5} {PersistenceRequired:1b}`],
    timeMs: T(null, 360000, 480000, 360000), steps: { L2: 30, L3: 320 },
    milestones: ['moved 15+ blocks from the start', 'cow in sight', 'within 4 m of the cow', 'cow killed'],
    progress(o, mem) {
      const moved = hdist(o.self.pos, { x: COW_START.x + 0.5, z: COW_START.z + 0.5 }) >= 15
      const cow = o.entities?.find((e) => e.name === 'cow')
      if (moved) mem.m1 = true
      if (cow) mem.m2 = true
      if (cow && cow.dist <= 4) mem.m3 = true
      if (n(o, 'beef')) mem.m4 = true
      return mem.m4 ? 4 : mem.m3 ? 3 : mem.m2 ? 2 : mem.m1 ? 1 : 0
    },
    done: (o) => n(o, 'beef') > 0,
    finalMilestone: (f) => (f.success ? 4 : null),
    final: async (ctx) => {
      const cows = await ctx.entityCount('@e[type=cow]')
      const beef = await ctx.itemCount('beef')
      return { success: cows === 0 || beef > 0, value: beef, detail: `cow ${cows ? 'alive' : 'dead'}, beef ${beef}`, killed: cows === 0 }
    },
  },
  iron: {
    // The "stone pickaxe + furnace + fuel, ore buried nearby" variant.
    text: 'Get iron: find and mine iron ore (it is underground nearby), then smelt it into an iron ingot in the furnace.',
    world: [...ORE_CMDS, `setblock ${FURNACE.x} ${FURNACE.y} ${FURNACE.z} furnace`],
    start: (b) => [tp(b, S, P), `give ${b} stone_pickaxe`, `give ${b} coal 3`],
    timeMs: T(null, 420000, 540000, 420000), steps: { L2: 30, L3: 360 },
    milestones: ['dug below the grass', 'within 4 m of iron ore', 'raw iron (iron obtained)', 'iron ingot (smelted)'],
    progress(o, mem) {
      if (o.self.pos.y < Y - 0.5) mem.dug = true
      const ore = o.blocks?.find((b) => b.name === 'iron_ore')
      if (ore && ore.dist <= 4) mem.near = true
      if (n(o, 'raw_iron')) mem.raw = true
      return n(o, 'iron_ingot') ? 4 : mem.raw ? 3 : mem.near ? 2 : mem.dug ? 1 : 0
    },
    done: (o) => n(o, 'iron_ingot') > 0,
    finalMilestone: (f) => (f.smelted ? 4 : f.success ? 3 : null),
    final: async (ctx) => {
      const raw = await ctx.itemCount('raw_iron')
      const ingot = await ctx.itemCount('iron_ingot')
      return { success: raw + ingot > 0, full: ingot > 0, value: raw + ingot, detail: `raw_iron ${raw}, iron_ingot ${ingot}`, smelted: ingot > 0 }
    },
  },
  iron_fresh: {
    // Fresh start: trees, stone under the grass, the same buried ore; nothing given.
    text: 'Get iron from scratch: chop logs, craft a wooden pickaxe, mine stone, craft a stone pickaxe, then find and mine the iron ore (it is underground nearby).',
    world: [...TREES, ...ORE_CMDS],
    start: (b) => [tp(b, S, { x: 184, y: Y, z: 0 })],
    timeMs: T(null, 720000, 720000, 720000), steps: { L2: 60, L3: 600 },
    milestones: ['log', 'planks', 'crafting table', 'wooden pickaxe', 'cobblestone', 'stone pickaxe', 'raw iron', 'iron ingot'],
    progress(o, mem) {
      const has = (k) => n(o, k) > 0
      const seen = (k) => o.blocks?.some((b) => b.name === k && b.dist <= 8)
      const flags = [has('oak_log'), has('oak_planks'), has('crafting_table') || seen('crafting_table'), has('wooden_pickaxe'), has('cobblestone'), has('stone_pickaxe'), has('raw_iron'), has('iron_ingot')]
      mem.f = (mem.f || flags.map(() => false)).map((v, i) => v || flags[i])
      let k = 0
      for (let i = mem.f.length - 1; i >= 0; i--) if (mem.f[i]) { k = i + 1; break }
      return k
    },
    done: (o) => n(o, 'raw_iron') > 0 || n(o, 'iron_ingot') > 0,
    finalMilestone: (f) => (f.smelted ? 8 : f.success ? 7 : null),
    final: async (ctx) => {
      const raw = await ctx.itemCount('raw_iron')
      const ingot = await ctx.itemCount('iron_ingot')
      return { success: raw + ingot > 0, full: raw + ingot > 0, value: raw + ingot, detail: `raw_iron ${raw}, iron_ingot ${ingot}`, smelted: ingot > 0 }
    },
  },
}

export const TASK_IDS = Object.keys(TASKS)
