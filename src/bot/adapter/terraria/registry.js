// src/bot/adapter/terraria/registry.js — the closed, Zod-typed verb set the
// brain may call. Every handler sends ONE `cmd` frame to the mod and returns
// the mod's `detail` string (types.js: executeAction always returns a string;
// failures say why). Names and args mirror
// native/terraria-mod/SeiCompanion/Actions/Verbs.cs.

import { z } from 'zod'
import { createRegistry } from '../../registry.js'
import { ACTION_DESCRIPTIONS } from './prompts.js'

const Handle = z.string().regex(/^#?\d+$/, 'a #N handle from the snapshot')
const Item = z.string().min(1).max(64)
const Player = z.string().min(1).max(32)
const X = z.number().int()
const Y = z.number().int()

/** The largest area one mine() digs and one place() fills (the mod enforces the same). */
export const MAX_MINE_TILES = 40
export const MAX_PLACE_TILES = 30

/** Arg schemas per verb, exported for tests. */
export const VERB_SCHEMAS = {
  follow: z.object({ player: Player.optional() }),
  unfollow: z.object({}),
  come: z.object({ player: Player.optional() }),
  goTo: z.object({ x: X.optional(), y: Y.optional(), target: Handle.optional(), player: Player.optional() })
    .refine((a) => a.target || a.player || (a.x != null && a.y != null), { message: 'give x and y, a #N target, or a player' }),
  stance: z.object({ mode: z.enum(['aggressive', 'defensive', 'passive']) }),
  attack: z.object({ target: Handle.optional() }),
  give: z.object({ item: Item, count: z.number().int().min(1).max(9999).optional(), player: Player.optional() }),
  take: z.object({ item: Item.optional(), count: z.number().int().min(1).max(9999).optional() }),
  mine: z.object({
    block: z.string().min(1).max(64).optional(),
    count: z.number().int().min(1).max(30).optional(),
    x: X.optional(),
    y: Y.optional(),
    width: z.number().int().min(1).max(12).optional(),
    height: z.number().int().min(1).max(12).optional(),
  })
    .refine((a) => a.block || (a.x != null && a.y != null), { message: 'give a block name, or x and y (and width/height for an area)' })
    .refine((a) => (a.width ?? 1) * (a.height ?? 1) <= MAX_MINE_TILES, { message: `an area is at most ${MAX_MINE_TILES} tiles` }),
  place: z.object({
    item: Item,
    x: X,
    y: Y,
    width: z.number().int().min(1).max(30).optional(),
    height: z.number().int().min(1).max(30).optional(),
  }).refine((a) => (a.width ?? 1) * (a.height ?? 1) <= MAX_PLACE_TILES, { message: `at most ${MAX_PLACE_TILES} tiles per call` }),
  chop: z.object({ x: X.optional(), y: Y.optional(), count: z.number().int().min(1).max(10).optional() }),
  use: z.object({ item: Item }),
  equip: z.object({ item: Item }),
  craft: z.object({ item: Item, count: z.number().int().min(1).max(250).optional() }),
}

export const VERB_NAMES = Object.keys(VERB_SCHEMAS)

/**
 * @param {{ send: (name: string, args: any, opts: {signal?: AbortSignal, onProgress?: Function}) => Promise<string> }} deps
 */
export function createTerrariaRegistry({ send }) {
  const registry = createRegistry()
  for (const name of VERB_NAMES) {
    registry.register(
      name,
      VERB_SCHEMAS[name],
      async (args, _bot, config) => {
        const clean = { ...args }
        // "#3" and "3" both reach the mod as "#3".
        if (typeof clean.target === 'string' && !clean.target.startsWith('#')) clean.target = `#${clean.target}`
        return send(name, clean, { signal: config?.signal, onProgress: config?.onProgress })
      },
      ACTION_DESCRIPTIONS[name] ?? '',
    )
  }
  return registry
}
