// src/bot/adapter/minecraft/loose-terms.js
//
// Hand-curated natural-language → MC block ID resolver for the closed Zod
// action registry. Pure data + pure function — zero mineflayer / minecraft-data
// / vec3 dependencies — so Phase 7 (pillar-up) can import resolveTerm()
// directly without dragging in the world-observer stack.
//
// Why server-side resolution (per 06-CONTEXT.md L50):
//   - Haiku's training-data knowledge of MC IDs is fuzzy across versions
//     (mangrove/cherry/deepslate variants drift). A hand-curated table is
//     ground-truth for the running server.
//   - One call returning N variant IDs beats N find() calls under the
//     20-iteration loop cap.
//
// Phase 7 reuse (per 06-CONTEXT.md L61):
//   pillar-up wants NL→ID lookup ("place dirt") without a locator call.
//   Phase 7 imports { resolveTerm } directly; no observer/registry plumbing.
//
// Pitfall — loose-term collision (06-RESEARCH.md L461-463):
//   Loose-term keys ALWAYS expand. `resolveTerm('stone')` returns 7 stone
//   variants — `find('stone')` may return granite when the caller wanted
//   literal `stone`. To get a strict literal match, pass the exact MC ID
//   (e.g. `find('stone')` returns variants; `find('granite')` returns only
//   granite via the unknown-key fallthrough).

const WOODS = ['oak', 'birch', 'spruce', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry']
const ORE_BASES = ['coal', 'iron', 'gold', 'diamond', 'copper', 'redstone', 'lapis', 'emerald']

const TABLE = {
  wood:   WOODS.map(w => `${w}_log`),
  log:    WOODS.map(w => `${w}_log`),
  planks: WOODS.map(w => `${w}_planks`),
  leaves: WOODS.map(w => `${w}_leaves`),
  ore: [
    ...ORE_BASES.map(o => `${o}_ore`),
    ...ORE_BASES.map(o => `deepslate_${o}_ore`),
  ],
  stone: ['stone', 'cobblestone', 'andesite', 'diorite', 'granite', 'deepslate', 'tuff'],
  dirt:  ['dirt', 'coarse_dirt', 'grass_block', 'podzol', 'rooted_dirt', 'mycelium'],
  sand:  ['sand', 'red_sand'],
}

/**
 * Resolve a natural-language term to a list of vanilla MC block IDs.
 *
 * Known loose keys (see {@link LOOSE_TERMS}) expand to their variant list.
 * Unknown inputs are lowercased / trimmed and returned as a single-element
 * array — the caller treats this as a strict exact-ID lookup.
 *
 * @param {string} name  Loose term ("wood", "ore", ...) or exact MC ID
 *                       ("oak_log"). Coerced via String(...). Empty / nullish
 *                       inputs return `[]`.
 * @returns {string[]}   Array of MC block IDs. Always a fresh copy — safe
 *                       to mutate by the caller.
 */
export function resolveTerm(name) {
  const lower = String(name ?? '').toLowerCase().trim()
  if (!lower) return []
  if (TABLE[lower]) return [...TABLE[lower]]
  return [lower]
}

/**
 * All known loose-term keys (for diagnostics + capability primer wording).
 * @type {string[]}
 */
export const LOOSE_TERMS = Object.keys(TABLE)
