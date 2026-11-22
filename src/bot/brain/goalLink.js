// src/bot/brain/goalLink.js: link a free-text setGoal to the progression spine
// so JS can clear it when it is really finished (261012).
//
// The first version (260618) linked a goal to ONE node: the longest spine key
// found anywhere in the text, among the CURRENT FRONTIER only. Goals are
// written as a direction plus a finish condition ("Get from wood to iron with
// Alex. Finish when I hold an iron pickaxe"), and the only frontier node such
// a text names is its FIRST rung, so finishing that rung deleted the whole
// goal. Measured over the Minecraft eval transcripts: 124 of 125 auto-clears
// fired before the goal's own finish condition, and the bot re-set the goal a
// turn later, over and over.
//
// Now a goal links to EVERY spine node its finish condition names (the text
// after "finish when", "done when", "until", ...), or, when there is no
// recognizable finish clause, every node the whole text names. It is cleared
// only once ALL of them are done. Nodes that are already done when the goal is
// set are dropped, and a goal whose named nodes are all done already is not
// linked at all (it would otherwise be deleted on the very next turn). A
// finish clause that names no spine node ("finish when the hut has a roof")
// means no link: the model clears that goal itself.
//
// Matching is whole-word ("wood" does not match "wooden"), case-insensitive,
// treats "_" and "-" as spaces (models echo item ids like "iron_pickaxe"), and
// tolerates a plural on any key word ("diamonds", "ender pearls", "eye of
// ender"). A missed word inside a conjunction is the dangerous case: "finish
// when we have an iron pickaxe and 3 diamonds" linked to the pickaxe alone and
// cleared the goal early, the very bug this module exists to fix.
//
// A goal that asks for MORE of a node than the node's own predicate counts
// ("gather 64 wood" against a node done at 1 log, "12 ender pearls" is fine)
// is not linked at all: JS cannot tell when it is finished, so the model
// clears it.

// An explicit finish cue wins over "until", which also turns up in ordinary
// steps ("follow Alex until the end of the day").
const FINISH_CUE = /\b(?:finish(?:ed)?|done|complete(?:d)?|success)\s*(?:when|once|if|after|:|=)/i
const UNTIL_CUE = /\buntil\b/i

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Lowercase, "_"/"-" to spaces, whitespace collapsed.
function norm(s) {
  return String(s ?? '').toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ')
}

// One key word, singular or plural: "diamond" also matches "diamonds",
// "eyes" also matches "eye", "crock" "crocks". Words ending in "ss" keep it.
function wordRe(w) {
  const stem = w.length > 3 && /[^s]s$/.test(w) ? w.slice(0, -1) : w
  return `${escapeRe(stem)}(?:s|es)?`
}

function keyRe(key) {
  return norm(key).trim().split(' ').map(wordRe).join(' ')
}

/** The finish clause of a goal text, or null when it has none. */
export function finishClause(text) {
  const t = String(text ?? '')
  const m = FINISH_CUE.exec(t) ?? UNTIL_CUE.exec(t)
  if (!m) return null
  // The clause is its own sentence: a trailing "Start: gather wood." or
  // "Invite Alex along the way." is a step, not part of the finish condition
  // (live eval 261012: a goal finished by an iron ingot cleared at the first
  // log because its clause ran on into "Start: gather wood").
  const rest = t.slice(m.index + m[0].length).trim().split(/(?<=[.!?;])\s+|\n/)[0].trim()
  return rest || null
}

/** Spine nodes whose key appears as a whole word in `text`, in spine order. */
export function nodesNamedIn(text, spine) {
  const t = norm(text)
  if (!t.trim()) return []
  const out = []
  for (const n of spine ?? []) {
    const k = norm(n?.key).trim()
    if (!k) continue
    if (new RegExp(`(^|[^a-z0-9])${keyRe(k)}(?=$|[^a-z0-9])`).test(t)) out.push(n)
  }
  return out
}

// The largest quantity a node's own predicate checks (1 when it counts none).
function nodeCount(goal) {
  if (!goal || typeof goal !== 'object') return 1
  let c = 1
  for (const f of ['count', 'food']) if (Number.isFinite(goal[f])) c = Math.max(c, goal[f])
  for (const f of ['any', 'all']) for (const g of Array.isArray(goal[f]) ? goal[f] : []) c = Math.max(c, nodeCount(g))
  return c
}

// True when the text asks for more of `node` than its predicate checks:
// a number up to two words before the key ("64 oak wood", "3 more diamonds").
function asksForMore(text, node) {
  const re = new RegExp(`(\\d+)\\s+(?:[a-z]+\\s+){0,2}${keyRe(node.key)}(?=$|[^a-z0-9])`, 'g')
  const need = nodeCount(node.goal)
  for (const m of norm(text).matchAll(re)) if (Number(m[1]) > need) return true
  return false
}

/**
 * Link a goal text to the spine nodes it is finished by.
 *
 * @param {string} text  the setGoal text
 * @param {{ spine?: object[], frontier?: object[], done?: Set<string> }} prog
 *        an adapter.getProgression() result; `spine` is the full node list
 *        (falls back to the frontier for an adapter that does not expose it)
 * @returns {{ ids: string[], primary: object }|null} the unfinished nodes that
 *          must all be done for the goal to count as finished, plus the
 *          deepest of them (its label and procedure feed the progress note)
 */
export function linkGoalToSpine(text, prog) {
  const spine = Array.isArray(prog?.spine) && prog.spine.length ? prog.spine : (prog?.frontier ?? [])
  if (!spine.length) return null
  const scope = finishClause(text) ?? text
  const named = nodesNamedIn(scope, spine)
  if (named.some((n) => asksForMore(scope, n))) return null
  const done = prog?.done instanceof Set ? prog.done : new Set()
  const open = named.filter((n) => !done.has(n.id))
  if (!open.length) return null
  return { ids: open.map((n) => n.id), primary: open[open.length - 1] }
}

/** True once every linked node is done. */
export function linkFinished(link, prog) {
  const done = prog?.done
  if (!link?.ids?.length || !(done instanceof Set)) return false
  return link.ids.every((id) => done.has(id))
}




