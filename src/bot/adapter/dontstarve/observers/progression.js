// src/bot/adapter/dontstarve/observers/progression.js: the Don't Starve
// Together progression frontier (260926), the counterpart of the Minecraft
// spine and the Stardew first fortnight for the brain's heartbeat.
//
// Without it the agentic heartbeat's "reachable next" list was EMPTY for DST
// (index.js had no getProgression), so on a quiet tick the companion had
// nothing to commit to beyond "survive". The spine is the first autumn and
// the run-up to winter as an experienced player plays it: tools, light,
// science, camp, food, fighting gear, backpack, crock pot, alchemy, then
// winter prep. Each label leaves a part for the player.
//
// Node shape matches the other spines: { id, label, key, needs[], goal,
// unlock?, procedure? }. `key` is the phrase matchFrontierNode looks for in
// a setGoal text. Goal predicates:
//   { have, count? }      the body holds >= count (inventory + equipped)
//   { anyOf: [prefabs] }  holds at least one of them
//   { food }              at least this many edible items in the bag
//   { built }             a structure the body built or has seen standing
//   { all: [...] } / { any: [...] }
// `unlock` holds a node back: { seasonDaysAtMost, season } (winter prep
// shows once autumn is nearly over, or in winter itself).
// Monotonic closure: a done successor implies its needs.

export const SPINE = Object.freeze([
  {
    id: 'tools', key: 'pickaxe', needs: [],
    label: 'Craft an axe and a pickaxe (gather flint with the player)',
    goal: { all: [{ have: 'axe' }, { have: 'pickaxe' }] },
    procedure: 'gather twigs + flint; craft axe (1 twig + 1 flint), pickaxe (2 twigs + 2 flint)',
  },
  {
    id: 'light', key: 'torch', needs: [],
    label: 'Carry a torch and campfire material before the first night',
    goal: { all: [{ have: 'torch' }, { have: 'log', count: 2 }, { have: 'cutgrass', count: 3 }] },
    procedure: 'torch = 2 cutgrass + 2 twigs; campfire = 3 cutgrass + 2 log',
  },
  {
    id: 'food', key: 'food', needs: [],
    label: 'Build a food stock with the player (berries, carrots, cooked meat)',
    goal: { food: 10 },
  },
  {
    id: 'science', key: 'science machine', needs: ['tools'],
    label: 'Build a science machine near camp (the player can look for gold in the rocky biome)',
    goal: { built: 'researchlab' },
    procedure: 'researchlab = 1 goldnugget + 4 log + 4 rocks; mine gold veins in the rocky biome',
  },
  {
    id: 'camp', key: 'camp', needs: ['light'],
    label: 'Set up a camp with the player: a fire pit and a chest',
    goal: { all: [{ built: 'firepit' }, { built: 'treasurechest' }] },
    procedure: 'firepit = 2 log + 12 rocks; treasurechest = 3 boards (boards need the science machine)',
  },
  {
    id: 'armed', key: 'spear', needs: ['science'],
    label: 'Get fight-ready: a spear and a log suit for you, and one for the player',
    goal: { all: [{ have: 'spear' }, { have: 'armorwood' }] },
    procedure: 'spear = 1 rope + 1 flint + 2 twigs; armorwood = 8 log + 2 rope; rope = 3 cutgrass',
  },
  {
    id: 'backpack', key: 'backpack', needs: ['science'],
    label: 'Craft a backpack so you can carry more for the camp',
    goal: { have: 'backpack' },
    procedure: 'backpack = 4 cutgrass + 4 twigs',
  },
  {
    id: 'crockpot', key: 'crock pot', needs: ['science', 'camp'],
    label: 'Build a crock pot at camp and cook real meals together',
    goal: { built: 'cookpot' },
    procedure: 'cookpot = 3 cutstone + 6 charcoal + 6 twigs; charcoal from burnt trees',
  },
  {
    id: 'alchemy', key: 'alchemy engine', needs: ['science'],
    label: 'Upgrade to an alchemy engine with the player (boards, cut stone, gold)',
    goal: { built: 'researchlab2' },
    procedure: 'researchlab2 = 4 boards + 2 cutstone + 6 goldnugget',
  },
  {
    id: 'winter', key: 'winter', needs: ['armed', 'crockpot'],
    unlock: { seasonDaysAtMost: 8, season: 'autumn' },
    label: 'Get ready for winter together: a warm hat, a thermal stone, and food put away',
    goal: { all: [{ anyOf: ['winterhat', 'earmuffshat', 'beefalohat'] }, { have: 'heatrock' }] },
    procedure: 'earmuffshat = 2 rabbit fur + 1 twigs; winterhat and heatrock need the alchemy engine or science machine',
  },
])

const SUCCESSORS = new Map()
for (const n of SPINE) for (const p of n.needs) SUCCESSORS.set(p, [...(SUCCESSORS.get(p) ?? []), n.id])

/** Structures the frontier tracks as one-way latches. */
export const TRACKED_STRUCTURES = Object.freeze(['researchlab', 'researchlab2', 'firepit', 'treasurechest', 'cookpot'])

function holds(pred, st) {
  if (!pred || typeof pred !== 'object') return false
  if (Array.isArray(pred.all)) return pred.all.every((p) => holds(p, st))
  if (Array.isArray(pred.any)) return pred.any.some((p) => holds(p, st))
  if (pred.have) return (st.items?.[pred.have] ?? 0) >= (pred.count ?? 1)
  if (Array.isArray(pred.anyOf)) return pred.anyOf.some((p) => (st.items?.[p] ?? 0) > 0)
  if (pred.food != null) return (st.food ?? 0) >= pred.food
  if (pred.built) return st.built?.has?.(pred.built) === true
  return false
}

function unlocked(node, st) {
  const u = node.unlock
  if (!u) return true
  if (st.season === 'winter') return true
  if (u.season && st.season !== u.season) return false
  if (u.seasonDaysAtMost != null) return typeof st.seasonDays === 'number' && st.seasonDays <= u.seasonDaysAtMost
  return true
}

/**
 * @param {{ items?: Record<string, number>, food?: number, built?: Set<string>, season?: string, seasonDays?: number|null }} st
 */
export function computeProgression(st = {}) {
  const raw = new Set(SPINE.filter((n) => holds(n.goal, st)).map((n) => n.id))
  const done = new Set(raw)
  let changed = true
  while (changed) {
    changed = false
    for (const n of SPINE) {
      if (done.has(n.id)) continue
      if ((SUCCESSORS.get(n.id) ?? []).some((s) => done.has(s))) { done.add(n.id); changed = true }
    }
  }
  const frontier = SPINE.filter((n) => !done.has(n.id) && n.needs.every((p) => done.has(p)) && unlocked(n, st))
  let furthest = null
  for (const n of SPINE) if (done.has(n.id)) furthest = n
  return { done, raw, frontier, currentMilestone: frontier[0] ?? null, furthest, complete: done.has('winter') }
}

/**
 * One-way latches the live observation cannot re-derive: a structure that
 * was built (a "built X" result) or seen standing nearby stays built after
 * the body walks away from it. Lives on the adapter instance.
 */
export function createProgressionLatches() {
  const built = new Set()
  return {
    built,
    /** Read the observation's nearby entities. */
    observe(state) {
      try {
        for (const e of state?.ents?.values?.() ?? []) {
          if (TRACKED_STRUCTURES.includes(e.prefab)) built.add(e.prefab)
        }
      } catch { /* ignore */ }
    },
    /** Read a verb result ("built firepit"). */
    result(name, text) {
      try {
        const m = /^built (\w+)/.exec(String(text ?? ''))
        if (m && TRACKED_STRUCTURES.includes(m[1])) built.add(m[1])
      } catch { /* ignore */ }
    },
  }
}

/** The normalized state from the observation + latches. Never throws. */
export function readProgressionState(state, latches) {
  const items = {}
  let food = 0
  try {
    const self = state?.self
    const all = [...(self?.inv ?? []), ...Object.values(self?.equip ?? {})]
    for (const it of all) {
      items[it.prefab] = (items[it.prefab] ?? 0) + (it.qty ?? 1)
      if (it.flags?.includes('eat')) food += it.qty ?? 1
    }
  } catch { /* ignore */ }
  const world = state?.world ?? {}
  return { items, food, built: latches?.built ?? new Set(), season: world.season ?? '', seasonDays: world.seasonDays ?? null }
}

export function getProgression(state, latches) {
  latches?.observe?.(state)
  return computeProgression(readProgressionState(state, latches))
}
