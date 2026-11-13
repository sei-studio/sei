// src/bot/adapter/factorio/registry.js: the closed, Zod-typed verb set the
// brain may call. Every handler runs ONE verb in the mod
// (native/factorio-mod/sei-companion/scripts/verbs.lua and api.lua) and
// returns the mod's result text (types.js: executeAction returns a string;
// failures start with "failed:" and say why).

import { z } from 'zod'
import { createRegistry } from '../../registry.js'
import { ACTION_DESCRIPTIONS } from './prompts.js'

// Factorio internal names: lowercase words joined by dashes (iron-plate, small-electric-pole).
const ItemName = z.string().min(1).max(64).transform((s) => s.trim().toLowerCase().replace(/\s+/g, '-'))
const Handle = z.union([z.number().int().positive(), z.string().regex(/^#?\d+$/, 'a #N handle from the snapshot')])
const Coord = z.number().finite().min(-2_000_000).max(2_000_000)
const Direction = z.enum(['north', 'east', 'south', 'west'])
const Target = { target: Handle.optional(), x: Coord.optional(), y: Coord.optional() }
const needsTarget = (a) => a.target != null || (a.x != null && a.y != null)
const TARGET_MSG = { message: 'give a #N target or x and y' }

/** Arg schemas per tool, exported for tests. */
export const VERB_SCHEMAS = {
  goTo: z.object({ x: Coord, y: Coord }),
  come: z.object({}),
  follow: z.object({}),
  stay: z.object({}),
  gather: z.object({ resource: ItemName, count: z.number().int().min(1).max(500).default(20) }),
  craft: z.object({ item: ItemName, count: z.number().int().min(1).max(200).default(1) }),
  give: z.object({ item: ItemName, count: z.number().int().min(1).max(10_000).optional() }),
  take: z.object({ ...Target, item: ItemName.optional(), count: z.number().int().min(1).max(10_000).optional() }).refine(needsTarget, TARGET_MSG),
  deposit: z.object({ ...Target, item: ItemName, count: z.number().int().min(1).max(10_000).optional() }).refine(needsTarget, TARGET_MSG),
  tend: z.object({ radius: z.number().int().min(5).max(60).optional() }),
  build: z.object({ item: ItemName, x: Coord, y: Coord, direction: Direction.optional() }),
  buildGhosts: z.object({ radius: z.number().int().min(5).max(96).optional() }),
  pickUp: z.object({ ...Target }).refine(needsTarget, TARGET_MSG),
  inspect: z.object({ ...Target }).refine(needsTarget, TARGET_MSG),
  research: z.object({ tech: ItemName }),
  defend: z.object({ stance: z.enum(['passive', 'defensive', 'aggressive']) }),
}

export const VERB_NAMES = Object.keys(VERB_SCHEMAS)

/** Tool name -> the mod's verb name. */
export const MOD_VERB = {
  goTo: 'goto',
  buildGhosts: 'build_ghosts',
  pickUp: 'pickup',
  inspect: 'look',
}

/** The mod's args for one tool call: handles as bare numbers. */
export function modArgs(args) {
  const out = { ...args }
  if (out.target != null) out.target = Number(String(out.target).replace(/^#/, ''))
  return out
}

/**
 * @param {{ run: (verb: string, args: object, opts: { signal?: AbortSignal|null }) => Promise<{success: boolean, msg: string}> }} deps
 *   `run` sends one verb to the mod and resolves its result.
 */
export function createFactorioRegistry({ run }) {
  const registry = createRegistry()
  for (const name of VERB_NAMES) {
    registry.register(
      name,
      VERB_SCHEMAS[name],
      async (args, _bot, config) => {
        const signal = config?.signal ?? null
        let r
        try {
          r = await run(MOD_VERB[name] ?? name, modArgs(args), { signal })
        } catch (err) {
          if (signal?.aborted || /aborted/.test(String(err?.message))) return 'aborted'
          return `failed: ${err?.message ?? err}`
        }
        const msg = String(r?.msg ?? '').trim()
        return r?.success ? (msg || 'done') : `failed: ${msg || 'the game refused that'}`
      },
      ACTION_DESCRIPTIONS[name] ?? '',
    )
  }
  return registry
}
