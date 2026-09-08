// src/bot/adapter/stardew/registry.js — the closed, Zod-typed verb set the
// brain may call. Every handler sends ONE `cmd` frame to the mod and returns
// the mod's `detail` string verbatim (types.js: executeAction always returns a
// string; failures say why). Names mirror native/stardew-mod/SeiCompanion/
// Actions/Verbs.cs exactly.

import { z } from 'zod'
import { createRegistry } from '../../registry.js'
import { ACTION_DESCRIPTIONS } from './prompts.js'

const Handle = z.string().regex(/^#?\d+$/, 'a #N handle from the snapshot')
const Tile = { x: z.number().int(), y: z.number().int() }

/** Arg schemas per verb, exported for tests and for the schema audit below. */
export const VERB_SCHEMAS = {
  goTo: z.object({
    ...Object.fromEntries(Object.entries(Tile).map(([k, v]) => [k, v.optional()])),
    target: Handle.optional(),
    location: z.string().min(1).max(64).optional(),
  }).refine((a) => a.target || a.location || (a.x != null && a.y != null), { message: 'give x and y, a #N target, or a location' }),
  come: z.object({ player: z.string().max(32).optional() }),
  follow: z.object({ player: z.string().max(32).optional() }),
  unfollow: z.object({}),
  till: z.object(Tile),
  water: z.object({
    x: Tile.x.optional(),
    y: Tile.y.optional(),
    target: Handle.optional(),
    count: z.number().int().min(1).max(60).optional(),
  }),
  plant: z.object({
    seed: z.string().min(1).max(64),
    x: Tile.x.optional(),
    y: Tile.y.optional(),
    count: z.number().int().min(1).max(20).optional(),
  }),
  harvest: z.object({
    x: Tile.x.optional(),
    y: Tile.y.optional(),
    target: Handle.optional(),
    count: z.number().int().min(1).max(60).optional(),
  }),
  chop: z.object({ x: Tile.x.optional(), y: Tile.y.optional(), target: Handle.optional() })
    .refine((a) => a.target || (a.x != null && a.y != null), { message: 'give x and y or a #N target' }),
  mine: z.object({ x: Tile.x.optional(), y: Tile.y.optional(), target: Handle.optional() })
    .refine((a) => a.target || (a.x != null && a.y != null), { message: 'give x and y or a #N target' }),
  gather: z.object({
    kind: z.enum(['forage', 'wood', 'stone', 'fiber', 'debris']),
    count: z.number().int().min(1).max(40).default(5),
  }),
  attack: z.object({
    target: Handle.optional(),
    times: z.number().int().min(1).max(12).default(5),
  }),
  fish: z.object({
    x: Tile.x.optional(),
    y: Tile.y.optional(),
    casts: z.number().int().min(1).max(5).default(1),
  }),
  eat: z.object({ item: z.string().max(64).optional() }),
  equip: z.object({ item: z.string().min(1).max(64) }),
  place: z.object({ item: z.string().min(1).max(64), ...Tile }),
  chest: z.object({
    action: z.enum(['put', 'take']),
    item: z.string().max(64).optional(),
    count: z.number().int().min(1).max(999).optional(),
    x: Tile.x.optional(),
    y: Tile.y.optional(),
    target: Handle.optional(),
  }),
  buy: z.object({
    item: z.string().min(1).max(64),
    qty: z.number().int().min(1).max(99).default(1),
    shop: z.string().max(32).optional(),
  }),
  interact: z.object({ x: Tile.x.optional(), y: Tile.y.optional(), target: Handle.optional() })
    .refine((a) => a.target || (a.x != null && a.y != null), { message: 'give x and y or a #N target' }),
  sleep: z.object({}),
}

export const VERB_NAMES = Object.keys(VERB_SCHEMAS)

/**
 * @param {{ send: (name: string, args: any, opts: {signal?: AbortSignal}) => Promise<string> }} deps
 */
export function createStardewRegistry({ send }) {
  const registry = createRegistry()
  for (const name of VERB_NAMES) {
    registry.register(
      name,
      VERB_SCHEMAS[name],
      async (args, _bot, config) => {
        // Normalise "#3" / "3" to "#3" for the mod.
        const clean = { ...args }
        if (typeof clean.target === 'string' && !clean.target.startsWith('#')) clean.target = `#${clean.target}`
        return send(name, clean, { signal: config?.signal })
      },
      ACTION_DESCRIPTIONS[name] ?? '',
    )
  }
  return registry
}
