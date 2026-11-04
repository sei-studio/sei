// src/bot/adapter/minecraft/observers/ownWork.js
//
// 261104 (quality pass 41): what one of her own actions made or did, read
// from the success line the behavior wrote, for the transcript's "who did
// what" line (brain/sessionEvents.js createHandOverLedger). In the 11-03
// scorecard and the pass-38 compare, "thanks for the help" got "you're the
// one who got the wood and the table" after she gathered, crafted and placed
// all of it herself.
//
// Only lines these behaviors write are read: gather (mineVein.js), craft
// (craft.js), takeSmelted (furnace.js), placeBlock, a single-block dig
// (dig.js) and a kill (attack.js goneResult). Anything else is null, so a
// line that cannot be read adds nothing rather than a wrong count.

const ITEM = '([a-z0-9_]+)'
const RULES = {
  // "gathered 8/8 oak_log", "gathered 8/8 cobblestone (mined from stone)",
  // "aborted after 6/8 oak_log" (stopped part way: those 6 are still hers).
  gather: [new RegExp(`^(?:gathered|aborted after) (\\d+)/\\d+ ${ITEM}`), 'gathered'],
  // "crafted 1 crafting_table, made 4 oak_planks for it first", "crafted 2
  // stick, not 4: the server undid the rest". The parts made on the way are
  // not listed.
  craft: [new RegExp(`^crafted (\\d+) ${ITEM}`), 'crafted'],
  // "took 3 iron_ingot", "took 1 iron_ingot before stopping".
  takeSmelted: [new RegExp(`^took (\\d+) ${ITEM}`), 'smelted'],
  // "placed crafting_table on grass_block @185,70,-3".
  placeBlock: [new RegExp(`^placed ${ITEM}`), 'placed'],
  // "dug stone", "dug coal_ore (pickup walk did not reach)". A cuboid dig
  // ("dug 5/9") names no block and is skipped.
  dig: [new RegExp(`^dug ${ITEM}(?:$|[ ;(])`), 'dug'],
  // "killed zombie (4 hits)".
  attackEntity: [new RegExp(`^killed ${ITEM} \\(`), 'killed'],
}

/**
 * @param {string} name  the action
 * @param {string} resultText  its result line
 * @returns {{verb: string, item: string, n: number}|null}
 */
export function ownWorkDetail(name, resultText) {
  const rule = RULES[name]
  if (!rule) return null
  const m = rule[0].exec(String(resultText ?? ''))
  if (!m) return null
  if (m.length === 2) return { verb: rule[1], item: m[1], n: 1 }
  const n = Number(m[1])
  return Number.isFinite(n) && n > 0 ? { verb: rule[1], item: m[2], n } : null
}
