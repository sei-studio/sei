// src/bot/adapter/dontstarve/registry.js — the closed, Zod-typed DST verb set
// (game-adapters M2, 260908). Every verb becomes ONE command on the link
// (PROTOCOL.md) and resolves to the mod's result string ("gathered 4 twigs",
// "cant_reach: ..."), so the model always reads why something failed. The
// LLM never writes coordinates it did not see: `#N` handles come from the
// snapshot, names resolve against the latest observation here.

import { z } from 'zod'
import { createRegistry } from '../../registry.js'
import { normalizeName } from './protocol.js'

/** Loose item names -> DST prefab ids. */
const ITEM_ALIASES = {
  wood: 'log', logs: 'log', twig: 'twigs', stick: 'twigs', sticks: 'twigs', grass: 'cutgrass', cut_grass: 'cutgrass',
  rock: 'rocks', stone: 'rocks', stones: 'rocks', gold: 'goldnugget', gold_nugget: 'goldnugget', berry: 'berries',
  carrots: 'carrot', seed: 'seeds', reed: 'cutreeds', reeds: 'cutreeds', pinecone: 'pinecone', pine_cone: 'pinecone',
  meat: 'meat', monster_meat: 'monstermeat', small_meat: 'smallmeat', morsel: 'smallmeat', cooked_meat: 'cookedmeat',
  charcoal: 'charcoal', flint: 'flint', nitre: 'nitre', spider_silk: 'silk', silk: 'silk', honey: 'honey',
  petal: 'petals', flower: 'petals', science_machine: 'researchlab', torch: 'torch',
  egg: 'bird_egg', eggs: 'bird_egg', frog_legs: 'froglegs', frog_leg: 'froglegs', butterfly_wings: 'butterflywings',
  butterfly_wing: 'butterflywings', jerky: 'meat_dried', small_jerky: 'smallmeat_dried', drumsticks: 'drumstick',
  pine_cones: 'pinecone', birch_nut: 'acorn', birchnut: 'acorn', crock_pot: 'cookpot', crockpot: 'cookpot',
  drying_rack: 'meatrack', bug_net: 'bugnet',
}

/** What a gather() of a product should work on when none lies around. */
const GATHER_SOURCE = {
  log: 'CHOP', pinecone: 'CHOP', rocks: 'MINE', flint: 'MINE', goldnugget: 'MINE', nitre: 'MINE',
  twigs: 'sapling', cutgrass: 'grass', berries: 'berrybush', carrot: 'carrot_planted', cutreeds: 'reeds',
  petals: 'flower', seeds: 'seeds',
}

/** Loose recipe names -> DST recipe ids. */
const RECIPE_ALIASES = {
  science_machine: 'researchlab', alchemy_engine: 'researchlab2', chest: 'treasurechest', wooden_chest: 'treasurechest',
  crock_pot: 'cookpot', crockpot: 'cookpot', fire_pit: 'firepit', straw_roll: 'bedroll_straw', sleeping_bag: 'bedroll_straw',
  log_suit: 'armorwood', wood_armor: 'armorwood', grass_suit: 'armorgrass', football_helmet: 'footballhat',
  pig_house: 'pighouse', bird_trap: 'birdtrap', fishing_rod: 'fishingrod', bug_net: 'bugnet', drying_rack: 'meatrack',
  lightning_rod: 'lightning_rod', ice_box: 'icebox', garland: 'flowerhat', straw_hat: 'strawhat', top_hat: 'tophat',
  rain_coat: 'raincoat', cut_stone: 'cutstone', walking_cane: 'cane', campfire: 'campfire', torch: 'torch',
  wall: 'wall_hay_item', hay_wall: 'wall_hay_item', wood_wall: 'wall_wood_item', stone_wall: 'wall_stone_item',
}

export function itemPrefab(name) {
  const n = normalizeName(name)
  return ITEM_ALIASES[n] ?? n
}

export function recipeId(name) {
  const n = normalizeName(name)
  return RECIPE_ALIASES[n] ?? n
}

export function gatherSource(prefab) {
  return GATHER_SOURCE[prefab] ?? null
}

/** The helper gives a crock pot 150 s (walk, fill, cook, take); wait a bit longer. */
export const COOKPOT_TIMEOUT_MS = 165_000

const Target = z.string().min(1).describe('an entity handle like "#4" from the snapshot, or a name like "evergreen"')

/**
 * @param {object} args
 * @param {import('./runtime.js').Link} args.link
 */
export function createDefaultRegistry({ link }) {
  const registry = createRegistry()
  const { state, handles } = link

  const execOpts = (cfg) => ({ signal: cfg?.signal, timeoutMs: cfg?.timeoutMs })

  function resolveEntity(spec, requireFlag = null) {
    if (spec == null) return null
    const s = String(spec).trim()
    if (handles.isHandle(s)) {
      const guid = handles.guidFor(s)
      return guid != null && state.ents.has(guid) ? guid : null
    }
    const raw = normalizeName(s)
    const wants = [...new Set([itemPrefab(s), raw])].filter(Boolean)
    const cands = state.nearby((e) => {
      if (requireFlag && !e.flags.includes(requireFlag)) return false
      const p = e.prefab.toLowerCase()
      const n = (e.name ?? '').toLowerCase()
      if (n === s.toLowerCase()) return true
      return wants.some((w) => p === w || n === w || p.startsWith(w) || (w.length >= 4 && p.includes(w)))
    })
    return cands[0]?.guid ?? null
  }

  function resolveInventory(name) {
    const it = state.findInventory(itemPrefab(name))
    return it ?? null
  }

  function resolvePlayer(name) {
    const players = state.nearby((e) => e.flags.includes('player') && !e.flags.includes('companion'))
    if (name) {
      const n = String(name).toLowerCase()
      const hit = players.find((e) => (e.name ?? '').toLowerCase() === n) ?? players.find((e) => (e.name ?? '').toLowerCase().includes(n))
      if (hit) return hit
    }
    const pinned = link.playerName?.()
    if (pinned) {
      const hit = players.find((e) => (e.name ?? '').toLowerCase() === String(pinned).toLowerCase())
      if (hit) return hit
    }
    return players[0] ?? null
  }

  // give() hands items away, so it never guesses: a name must match a player
  // exactly (case-insensitive), and only an empty name means the host (the
  // player this companion was summoned for). Anything else is an error that
  // lists who can receive.
  function resolveGiveTarget(name) {
    const players = state.nearby((e) => e.flags.includes('player') && !e.flags.includes('companion'))
    const host = { name: link.playerName?.() ?? null, userid: link.playerUserid?.() ?? '' }
    const known = [...new Set([...players.map((e) => e.name).filter(Boolean), ...(host.name ? [host.name] : [])])]
    const list = known.length ? known.join(', ') : 'nobody in sight'
    const wanted = String(name ?? '').trim()
    if (wanted) {
      const n = wanted.toLowerCase()
      const hit = players.find((e) => (e.name ?? '').toLowerCase() === n)
      if (hit) return { guid: hit.guid }
      if (host.name && host.name.toLowerCase() === n && host.userid) return { userid: host.userid }
      return { error: `no player named "${wanted}". You can give to: ${list}.` }
    }
    if (host.name || host.userid) {
      const near = host.name ? players.find((e) => (e.name ?? '').toLowerCase() === host.name.toLowerCase()) : null
      if (near) return { guid: near.guid }
      if (host.userid) return { userid: host.userid }
    }
    if (players.length === 1) return { guid: players[0].guid }
    return { error: `say who to give it to (player). You can give to: ${list}.` }
  }

  const notFound = (spec, what = 'thing') => `no ${what} matching "${spec}" nearby. Use a #N handle from the snapshot or move closer.`

  registry.register('goTo', z.object({
    target: Target.optional(),
    x: z.number().optional(),
    z: z.number().optional(),
    range: z.number().min(1).max(12).default(2.5),
  }).refine((a) => a.target != null || (a.x != null && a.z != null), { message: 'give a target handle/name or x and z' }),
  async (args, _bot, cfg) => {
    if (args.target != null) {
      const guid = resolveEntity(args.target)
      if (guid == null) return notFound(args.target)
      return link.send({ kind: 'goto', guid, range: args.range }, execOpts(cfg))
    }
    return link.send({ kind: 'goto', x: args.x, z: args.z, range: args.range }, execOpts(cfg))
  })

  // The perception sweep is 24 units, and "come here" is asked most often
  // once the body has wandered out of it (measured on the first live DST
  // session: 75 units away, "no player nearby to come to"). So when no player
  // is in view, come/follow address the world by USERID instead of guid: the
  // pinned player's when there is one, else "" for the nearest player. The
  // mod resolves either against AllPlayers, whatever the distance.
  const playerByUserid = () => ({ userid: link.playerUserid?.() ?? '', name: link.playerName?.() ?? null })

  registry.register('come', z.object({ player: z.string().optional() }), async (args, _bot, cfg) => {
    const p = resolvePlayer(args.player)
    if (p) return link.send({ kind: 'goto', guid: p.guid, range: 3 }, execOpts(cfg))
    const far = playerByUserid()
    return link.send({ kind: 'goto', userid: far.userid, range: 3 }, execOpts(cfg))
  })

  // help (helper 0.4.0): work the next tree or boulder while they chop or mine.
  const followSchema = z.object({ player: z.string().optional(), distance: z.number().min(2).max(10).default(4) })
  registry.register('follow', link.hasChores ? followSchema.extend({ help: z.boolean().optional() }) : followSchema, async (args, _bot, cfg) => {
    const p = resolvePlayer(args.player)
    if (p) {
      const r = await link.send({ kind: 'follow', guid: p.guid, dist: args.distance, ...(args.help ? { help: true } : {}) }, execOpts(cfg))
      link.body.followLabel = p.name ?? p.prefab
      return r
    }
    const far = playerByUserid()
    const r = await link.send({ kind: 'follow', userid: far.userid, dist: args.distance, ...(args.help ? { help: true } : {}) }, execOpts(cfg))
    link.body.followLabel = far.name ?? 'the player'
    return r
  })

  registry.register('unfollow', z.object({}), async (_args, _bot, cfg) => {
    link.body.followLabel = null
    return link.send({ kind: 'unfollow' }, execOpts(cfg))
  })

  registry.register('gather', z.object({ item: z.string().min(1), count: z.number().int().min(1).max(40).default(4) }), async (args, _bot, cfg) => {
    const prefab = itemPrefab(args.item)
    return link.send({ kind: 'gather', prefab, count: args.count, source: gatherSource(prefab) }, execOpts(cfg))
  })

  // pickDefault: which entity a call with no target means (dig: a stump or a
  // grave, not the nearest grass tuft).
  const work = (name, action, flag, what, pickDefault = (e) => e.flags.includes(flag)) => {
    registry.register(name, z.object({ target: Target.optional() }), async (args, _bot, cfg) => {
      const spec = args.target ?? what
      const guid = resolveEntity(spec, flag) ?? (args.target == null ? state.nearby(pickDefault)[0]?.guid ?? null : null)
      if (guid == null) return notFound(spec, what)
      return link.send({ kind: 'action', name: action, target: guid }, execOpts(cfg))
    })
  }
  work('chop', 'CHOP', 'chop', 'tree')
  work('mine', 'MINE', 'mine', 'boulder')
  work('pick', 'PICK', 'pick', 'plant')
  work('pickup', 'PICKUP', 'pickup', 'item on the ground')
  // dig (helper 0.3.0+, which equips the shovel itself). The prompt has told
  // the model its tools work when it digs since 0.3.0; this is the verb.
  if (link.hasCaps) work('dig', 'DIG', 'dig', 'stump', (e) => e.flags.includes('dig') && (e.flags.includes('stump') || e.flags.includes('grave')))

  registry.register('craft', z.object({ recipe: z.string().min(1) }), async (args, _bot, cfg) =>
    link.send({ kind: 'build', recipe: recipeId(args.recipe) }, execOpts(cfg)))

  registry.register('build', z.object({ recipe: z.string().min(1), x: z.number().optional(), z: z.number().optional() }), async (args, _bot, cfg) =>
    link.send({ kind: 'build', recipe: recipeId(args.recipe), pos: args.x != null && args.z != null ? { x: args.x, z: args.z } : undefined }, execOpts(cfg)))

  registry.register('eat', z.object({ item: z.string().min(1) }), async (args, _bot, cfg) => {
    const it = resolveInventory(args.item)
    if (!it) return `no "${args.item}" in your inventory`
    if (!it.flags.includes('eat')) return `${it.prefab} is not something you can eat`
    return link.send({ kind: 'action', name: 'EAT', target: it.guid }, execOpts(cfg))
  })

  registry.register('equip', z.object({ item: z.string().min(1) }), async (args, _bot, cfg) => {
    const it = resolveInventory(args.item)
    if (!it) return `no "${args.item}" in your inventory`
    return link.send({ kind: 'equip', guid: it.guid }, execOpts(cfg))
  })

  registry.register('drop', z.object({ item: z.string().min(1) }), async (args, _bot, cfg) => {
    const it = resolveInventory(args.item)
    if (!it) return `no "${args.item}" in your inventory`
    return link.send({ kind: 'drop', guid: it.guid }, execOpts(cfg))
  })

  registry.register('attack', z.object({ target: Target }), async (args, _bot, cfg) => {
    const guid = resolveEntity(args.target, 'combat')
    if (guid == null) return notFound(args.target, 'creature')
    const e = state.ents.get(guid)
    if (e?.flags.includes('player')) return 'you never attack players'
    return link.send({ kind: 'attack', guid, label: e?.prefab }, execOpts(cfg))
  })

  registry.register('flee', z.object({ seconds: z.number().min(2).max(15).default(6) }), async (args, _bot, cfg) =>
    link.send({ kind: 'flee', seconds: args.seconds }, execOpts(cfg)))

  registry.register('lightFire', z.object({}), async (_args, _bot, cfg) =>
    link.send({ kind: 'lightfire' }, execOpts(cfg)))

  registry.register('cook', z.object({ item: z.string().min(1), cooker: Target.optional() }), async (args, _bot, cfg) => {
    const it = resolveInventory(args.item)
    if (!it) return `no "${args.item}" in your inventory`
    const cooker = args.cooker != null ? resolveEntity(args.cooker) : (state.nearby((e) => e.flags.includes('cooker') || e.flags.includes('fire'))[0]?.guid ?? null)
    if (cooker == null) return 'no fire or cooker nearby; lightFire() first'
    return link.send({ kind: 'action', name: 'COOK', target: cooker, invobject: it.guid }, execOpts(cfg))
  })

  const containerVerb = (name, op) => {
    registry.register(name, z.object({ container: Target, item: z.string().min(1), count: z.number().int().min(1).max(40).default(1) }), async (args, _bot, cfg) => {
      const guid = resolveEntity(args.container, 'container') ?? resolveEntity(args.container)
      if (guid == null) return notFound(args.container, 'chest')
      return link.send({ kind: 'container', op, container: guid, item: itemPrefab(args.item), count: args.count }, execOpts(cfg))
    })
  }
  containerVerb('store', 'store')
  containerVerb('take', 'take')

  // give (helper mod 0.3.0+). Registered only when the connected helper can
  // run it: an older helper answers "unknown command", and a world keeps the
  // helper it started with until it restarts (modVersion.js).
  if (link.hasCaps) {
    registry.register('give', z.object({
      item: z.string().min(1),
      count: z.number().int().min(1).max(40).default(1),
      player: z.string().optional(),
    }), async (args, _bot, cfg) => {
      const prefab = itemPrefab(args.item)
      const it = resolveInventory(args.item)
      const worn = Object.values(state.self?.equip ?? {}).find((e) => e.prefab === prefab)
      if (!it && !worn) return `no "${args.item}" in your inventory`
      const item = it?.prefab ?? worn.prefab
      const to = resolveGiveTarget(args.player)
      if (to.error) return to.error
      if (to.guid != null) return link.send({ kind: 'give', item, count: args.count, guid: to.guid }, execOpts(cfg))
      return link.send({ kind: 'give', item, count: args.count, userid: to.userid }, execOpts(cfg))
    })
  }

  // Camp chores (helper 0.4.0, sei/chores.lua). Registered only for a helper
  // that runs them, like give.
  if (link.hasChores) registerChores()

  registry.register('sleep', z.object({ target: Target.optional() }), async (args, _bot, cfg) => {
    const guid = args.target != null ? resolveEntity(args.target) : (state.nearby((e) => e.flags.includes('sleep'))[0]?.guid ?? null)
    if (guid == null) return 'no tent or bedroll nearby'
    return link.send({ kind: 'action', name: 'SLEEPIN', target: guid }, execOpts(cfg))
  })

  function registerChores() {
    // hammer knocks a structure down for part of its materials, so it never
    // picks a target on its own.
    registry.register('hammer', z.object({ target: Target }), async (args, _bot, cfg) => {
      const guid = resolveEntity(args.target, 'hammer')
      if (guid == null) return notFound(args.target, 'structure')
      return link.send({ kind: 'action', name: 'HAMMER', target: guid }, execOpts(cfg))
    })
    work('net', 'NET', 'net', 'butterfly')

    registry.register('harvest', z.object({ target: Target.optional() }), async (args, _bot, cfg) => {
      const ready = (e) => e.flags.includes('harvest') || e.flags.includes('dried')
      const guid = args.target != null ? resolveEntity(args.target) : (state.nearby(ready)[0]?.guid ?? null)
      if (guid == null) return args.target != null ? notFound(args.target) : 'nothing ready to harvest nearby'
      return link.send({ kind: 'harvest', target: guid }, execOpts(cfg))
    })

    registry.register('plant', z.object({
      item: z.string().min(1),
      count: z.number().int().min(1).max(10).default(1),
      x: z.number().optional(),
      z: z.number().optional(),
    }), async (args, _bot, cfg) => {
      const it = resolveInventory(args.item)
      if (!it) return `no "${args.item}" in your inventory`
      const pos = args.x != null && args.z != null ? { x: args.x, z: args.z } : undefined
      return link.send({ kind: 'plant', item: it.prefab, count: args.count, pos }, execOpts(cfg))
    })

    registry.register('trap', z.object({
      collect: z.boolean().optional(),
      target: Target.optional(),
      x: z.number().optional(),
      z: z.number().optional(),
    }), async (args, _bot, cfg) => {
      if (args.collect || args.target != null) {
        const guid = args.target != null ? resolveEntity(args.target, 'trap') : null
        if (args.target != null && guid == null) return notFound(args.target, 'trap')
        return link.send({ kind: 'trap', op: 'collect', ...(guid != null ? { target: guid } : {}) }, execOpts(cfg))
      }
      const pos = args.x != null && args.z != null ? { x: args.x, z: args.z } : undefined
      return link.send({ kind: 'trap', op: 'set', pos }, execOpts(cfg))
    })

    registry.register('dry', z.object({ item: z.string().min(1).optional(), rack: Target.optional() }), async (args, _bot, cfg) => {
      const guid = args.rack != null ? resolveEntity(args.rack, 'rack') : (state.nearby((e) => e.flags.includes('rack'))[0]?.guid ?? null)
      if (guid == null) return args.rack != null ? notFound(args.rack, 'drying rack') : 'no drying rack nearby; build(meatrack) makes one'
      return link.send({ kind: 'dry', rack: guid, ...(args.item ? { items: [itemPrefab(args.item)] } : {}) }, execOpts(cfg))
    })

    registry.register('cookpot', z.object({
      ingredients: z.array(z.string().min(1)).length(4).optional(),
      pot: Target.optional(),
      preview: z.boolean().optional(),
    }), async (args, _bot, cfg) => {
      const guid = args.pot != null ? resolveEntity(args.pot, 'stewer') : (state.nearby((e) => e.flags.includes('stewer'))[0]?.guid ?? null)
      if (guid == null) return args.pot != null ? notFound(args.pot, 'crock pot') : 'no crock pot nearby; build(cookpot) makes one'
      const items = (args.ingredients ?? []).map((n) => itemPrefab(n))
      return link.send({ kind: 'cookpot', pot: guid, items, ...(args.preview ? { preview: true } : {}) },
        { signal: cfg?.signal, timeoutMs: Math.max(cfg?.timeoutMs ?? 0, COOKPOT_TIMEOUT_MS) })
    })

    registry.register('stash', z.object({ item: z.string().min(1).optional(), pickup: z.boolean().optional() }), async (args, _bot, cfg) =>
      link.send({ kind: 'stash', ...(args.item ? { item: itemPrefab(args.item) } : {}), pickup: args.pickup !== false }, execOpts(cfg)))
  }

  return registry
}
