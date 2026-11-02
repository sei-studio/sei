// scripts/decision-eval/tasks.mjs: the five decision-eval tasks, built in the
// quality-eval arena (scripts/quality-eval/bench/arena.mjs: x144..207,
// z-16..15, floor y70, stand y71). Success is read from SERVER truth
// (/clear <p> <item> 0 counts, the observer's block view), never from the
// decider's own claim.
import { S, P, Y, tree, tp, zombie } from '../quality-eval/bench/arena.mjs'

export const MARKER = { x: 196, y: Y, z: -6 } // ~21 blocks from S, behind her back
const TREES = [...tree(184, -4), ...tree(186, 4), ...tree(191, 0)]

export const TASKS = {
  nav: {
    id: 'nav',
    text: 'Walk to the gold block.',
    world: [`setblock ${MARKER.x} ${MARKER.y} ${MARKER.z} gold_block`],
    // Facing the player (west); the gold block is east, so she must turn around.
    start: (b) => [tp(b, S, P)],
    timeMs: 90000,
    goal: async (ctx) => {
      const p = ctx.botPos()
      const d = p ? Math.hypot(p.x - (MARKER.x + 0.5), p.z - (MARKER.z + 0.5)) : Infinity
      return { done: d <= 2.5, value: Number(d.toFixed(1)) }
    },
  },
  logs: {
    id: 'logs',
    text: 'Collect 4 oak logs from the trees nearby.',
    world: TREES,
    start: (b) => [tp(b, S, { x: 184, y: Y, z: 0 })],
    timeMs: 240000,
    goal: async (ctx) => {
      const n = await ctx.itemCount('oak_log')
      return { done: n >= 4, value: n }
    },
  },
  craft: {
    id: 'craft',
    text: 'Craft oak planks from your logs, then craft a crafting table.',
    world: [],
    start: (b) => [tp(b, S, P), `give ${b} oak_log 4`],
    timeMs: 180000,
    goal: async (ctx) => {
      const t = await ctx.itemCount('crafting_table')
      const placed = ctx.countNear('crafting_table', 6)
      const planks = await ctx.itemCount('oak_planks')
      return { done: t + placed >= 1, value: t + placed, detail: `table ${t}+${placed} placed, planks ${planks}` }
    },
  },
  stone: {
    id: 'stone',
    text: 'Mine 3 stone (the stone is under the grass). You have a wooden pickaxe.',
    world: [],
    start: (b) => [tp(b, S, P), `give ${b} wooden_pickaxe`],
    timeMs: 180000,
    goal: async (ctx) => {
      const n = await ctx.itemCount('cobblestone')
      return { done: n >= 3, value: n }
    },
  },
  fight: {
    id: 'fight',
    text: 'It is night and zombies are coming. Survive for 60 seconds.',
    world: [],
    start: (b) => ['time set 18000', tp(b, S, P), `give ${b} stone_sword`, `give ${b} bread 3`],
    atStart: () => [zombie(S.x + 7, S.z - 3), zombie(S.x + 6, S.z + 5)],
    timeMs: 60000,
    survival: true,
    // Fight success = alive at 60 s. Value = zombies killed (2 - alive).
    goal: async (ctx) => {
      const z = await ctx.entityCount('@e[type=zombie]')
      return { done: false, value: 2 - z, zombiesLeft: z }
    },
  },
}

export const TASK_IDS = Object.keys(TASKS)
