// src/bot/adapter/stardew/registry.js — the closed, Zod-typed verb set the
// brain may call. Every handler sends ONE `cmd` frame to the mod and returns
// the mod's `detail` string verbatim (types.js: executeAction always returns a
// string; failures say why). Names mirror native/stardew-mod/SeiCompanion/
// Actions/Verbs.cs exactly.

import { z } from 'zod'
import { createRegistry } from '../../registry.js'
import { ACTION_DESCRIPTIONS } from './prompts.js'
import { modHasChores, CHORES_VERBS } from './modVersion.js'

const Handle = z.string().regex(/^#?\d+$/, 'a #N handle from the snapshot')
const Tile = { x: z.number().int(), y: z.number().int() }
/** water / harvest reach: `near` (20 tiles, the default) or `farm` (mod 0.1.3: the whole Farm map). */
const Scope = z.enum(['near', 'farm'])

/** The largest patch one till() call hoes (composed from single tills below). */
export const MAX_TILL_TILES = 40

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
  till: z.object({
    ...Tile,
    width: z.number().int().min(1).max(8).optional(),
    height: z.number().int().min(1).max(8).optional(),
  }).refine((a) => (a.width ?? 1) * (a.height ?? 1) <= MAX_TILL_TILES, { message: `a patch is at most ${MAX_TILL_TILES} tiles` }),
  water: z.object({
    x: Tile.x.optional(),
    y: Tile.y.optional(),
    target: Handle.optional(),
    count: z.number().int().min(1).max(200).optional(),
    scope: Scope.optional(),
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
    count: z.number().int().min(1).max(200).optional(),
    scope: Scope.optional(),
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
  // Mod 0.1.3 (CHORES_VERBS): hidden from the tool list for an older mod.
  ship: z.object({
    item: z.string().min(1).max(64).optional(),
    count: z.number().int().min(1).max(999).optional(),
  }),
  give: z.object({
    item: z.string().min(1).max(64),
    count: z.number().int().min(1).max(999).optional(),
    player: z.string().max(32).optional(),
  }),
}

export const VERB_NAMES = Object.keys(VERB_SCHEMAS)

/**
 * The tiles of a width x height patch whose top-left corner is (x, y), in
 * serpentine rows (left to right, then right to left) so the body walks one
 * short step between tiles instead of back across the patch.
 */
export function patchTiles(x, y, width = 1, height = 1) {
  const out = []
  for (let row = 0; row < height; row++) {
    const cols = [...Array(width).keys()]
    if (row % 2 === 1) cols.reverse()
    for (const col of cols) out.push({ x: x + col, y: y + row })
  }
  return out
}

// A single till that failed for a reason the next tile shares: stop the patch.
const TILL_FATAL = /energy|exhausted|no hoe|day is ending|paused|unknown action/i
// Walk failures in a row before the patch is called blocked.
const TILL_MAX_WALK_FAILS = 4
const WALK_FAIL = /^(stuck|no walkable|no path|gave up walking|ended at)/i

/**
 * till({x, y, width, height}): hoe a patch with one tool call, composed here
 * from the mod's single-tile till so it works with every mod version. Before
 * this a 15-tile field for the chest parsnips was 15 model turns. Tiles that
 * cannot be tilled (a stone, grass, a path) are skipped and named; energy,
 * a missing hoe or an abort stop the patch and say how far it got.
 *
 * @param {{x:number,y:number,width?:number,height?:number}} args
 * @param {(name: string, args: any, opts: {signal?: AbortSignal}) => Promise<string>} send
 * @param {{ signal?: AbortSignal|null, onProgress?: (p: {dug: number, total: number}) => void }} [opts]
 *   `onProgress` feeds the snapshot's in_flight line ("— 6/15").
 */
export async function tillPatch(args, send, { signal = null, onProgress = null } = {}) {
  const width = args.width ?? 1
  const height = args.height ?? 1
  const tiles = patchTiles(args.x, args.y, width, height)
  let tilled = 0
  let already = 0
  let walkFailsInARow = 0
  const skipped = new Map() // reason -> [tiles]
  let stop = null
  for (const t of tiles) {
    if (signal?.aborted) { stop = 'aborted'; break }
    const res = String(await send('till', { x: t.x, y: t.y }, { signal }))
    if (res === 'aborted') { stop = 'aborted'; break }
    const failed = /^failed:/.test(res)
    const detail = failed ? res.replace(/^failed:\s*/, '') : res
    if (!failed) {
      walkFailsInARow = 0
      if (/already tilled/i.test(detail)) already++
      else tilled++
      try { onProgress?.({ dug: tilled + already, total: tiles.length }) } catch { /* telemetry only */ }
      continue
    }
    if (TILL_FATAL.test(detail)) { stop = detail; break }
    walkFailsInARow = WALK_FAIL.test(detail) ? walkFailsInARow + 1 : 0
    // The reason without the tile, so one line covers every stone in the patch.
    const reason = detail.replace(/^\(\d+,\d+\)\s*/, '').replace(/\(\d+,\d+\)/g, 'it').slice(0, 90)
    const list = skipped.get(reason) ?? []
    list.push(`(${t.x},${t.y})`)
    skipped.set(reason, list)
    if (walkFailsInARow >= TILL_MAX_WALK_FAILS) { stop = `${TILL_MAX_WALK_FAILS} tiles in a row could not be reached (${detail})`; break }
  }
  const area = width * height > 1 ? `the ${width}x${height} patch from (${args.x},${args.y}) to (${args.x + width - 1},${args.y + height - 1})` : `(${args.x},${args.y})`
  const parts = []
  if (tilled > 0) parts.push(`tilled ${tilled} tile${tilled === 1 ? '' : 's'} of ${area}`)
  if (already > 0) parts.push(`${already} ${already === 1 ? 'was' : 'were'} already soil`)
  const skippedCount = [...skipped.values()].reduce((n, l) => n + l.length, 0)
  if (skippedCount > 0) {
    const why = [...skipped.entries()].slice(0, 3).map(([reason, l]) => `${l.slice(0, 4).join(' ')}${l.length > 4 ? ` +${l.length - 4}` : ''}: ${reason}`).join('; ')
    parts.push(`skipped ${skippedCount} (${why})`)
  }
  if (stop === 'aborted') return tilled + already > 0 ? `aborted after ${parts.join(', ')}` : 'aborted'
  if (stop) parts.push(`stopped: ${stop}`)
  const summary = parts.join('; ')
  if (tilled + already === 0) return `failed: tilled nothing in ${area}${summary ? `; ${summary}` : ''}`
  return summary
}

/**
 * @param {{
 *   send: (name: string, args: any, opts: {signal?: AbortSignal}) => Promise<string>,
 *   getModVersion?: () => string|null,
 * }} deps
 */
export function createStardewRegistry({ send, getModVersion = () => null }) {
  const registry = createRegistry()
  for (const name of VERB_NAMES) {
    registry.register(
      name,
      VERB_SCHEMAS[name],
      async (args, _bot, config) => {
        const signal = config?.signal
        const chores = modHasChores(getModVersion())
        // ship / give do not exist before mod 0.1.3; they are hidden from the
        // tool list then, so this only answers a stale or invented call.
        if (!chores && CHORES_VERBS.includes(name)) {
          return `failed: ${name} needs a newer Sei helper mod in the game; use a chest for now`
        }
        // Normalise "#3" / "3" to "#3" for the mod.
        const clean = { ...args }
        if (typeof clean.target === 'string' && !clean.target.startsWith('#')) clean.target = `#${clean.target}`
        // An older mod ignores scope; drop it so the frame says what runs.
        if (!chores) delete clean.scope
        if (name === 'till' && (clean.width ?? 1) * (clean.height ?? 1) > 1) {
          return tillPatch(clean, send, { signal, onProgress: config?.onProgress })
        }
        if (name === 'till') { delete clean.width; delete clean.height }
        return send(name, clean, { signal })
      },
      ACTION_DESCRIPTIONS[name] ?? '',
    )
  }
  return registry
}
