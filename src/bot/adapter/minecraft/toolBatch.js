// src/bot/adapter/minecraft/toolBatch.js — Minecraft's per-batch tool rules
// (contract v2 prefilterToolBatch / postProcessToolBatch, M0 260908).
//
// These three rules used to live inline in the brain's runIterations, written
// against Minecraft action names (dig, attackEntity, follow, goTo). They are
// pure functions over the tool batch so the orchestrator stays game-agnostic
// and a test can exercise them without an orchestrator.

/**
 * Runs BEFORE any tool in the batch dispatches. Returns the tool_uses that
 * must NOT execute, each with the synthesized result the model reads.
 *
 * 1. Cap parallel dig calls at 1 per turn. The first dig executes; subsequent
 *    digs synthesize an abort result. Decided cap=1 over the
 *    chopping-2-block-tree regression (RESEARCH A2): the 5-identical-dig and
 *    7-way-dig storms outweigh the legit case; the LLM can re-issue dig next
 *    turn.
 * 2. Same-turn follow + attackEntity collapse. combat.js startAttacking
 *    already auto-pursues moving mobs, so an explicit follow paired with
 *    attackEntity in the SAME tool batch is redundant — and historically
 *    produced "target gone" because follow resolves the entity reference
 *    before attack lands the first swing.
 *
 * @param {Array<{id: string, name: string, input?: any}>} toolUses
 * @returns {Array<{id: string, content: string, is_error: boolean}>}
 */
export function prefilterToolBatch(toolUses) {
  const out = []
  let digSeen = false
  for (const u of toolUses) {
    if (u.name !== 'dig') continue
    if (digSeen) {
      out.push({
        id: u.id,
        content: 'aborted: only one dig per turn allowed; re-issue next turn or use {block:"<name>"} for repeat digs',
        is_error: false,
      })
    } else {
      digSeen = true
    }
  }
  const attackTargets = new Set(
    toolUses
      .filter(u => u.name === 'attackEntity')
      .map(u => u.input?.target ?? u.input?.entity)
      .filter(Boolean),
  )
  for (const u of toolUses) {
    if (u.name !== 'follow') continue
    if (!attackTargets.has(u.input?.entity ?? u.input?.target)) continue
    out.push({
      id: u.id,
      content: 'already pursuing: combat reflex auto-pursues moving mobs; attackEntity alone is enough',
      is_error: false,
    })
  }
  return out
}

/**
 * Runs AFTER the batch's results are collected (results[i] pairs with
 * toolUses[i]). Per-loop cant_reach dedup: if the same goTo destination
 * returned cant_reach twice in this loop and we have NOT already nudged for
 * that key, hand back a one-shot reminder for the next user turn so the LLM
 * follows the Pathfinder rule (ask for help via say()) instead of silently
 * retrying. `loopState` is the brain's per-loop scratch object; the counters
 * live on it so a fresh dispatch starts clean.
 *
 * @param {Array<{id: string, name: string, input?: any}>} toolUses
 * @param {Array<{content?: any}|undefined>} results
 * @param {Object<string, any>} loopState
 * @param {(args: {x:number,y:number,z:number,range:number}) => string} cantReachNudge
 * @returns {{ nudge: string|null }}
 */
export function postProcessToolBatch(toolUses, results, loopState, cantReachNudge) {
  if (!loopState.cantReachMap) loopState.cantReachMap = new Map()
  if (!loopState.cantReachNudgedKeys) loopState.cantReachNudgedKeys = new Set()
  for (let i = 0; i < toolUses.length; i++) {
    const u = toolUses[i]
    if (u.name !== 'goTo') continue
    const r = results[i]
    const content = typeof r?.content === 'string' ? r.content : ''
    if (!content.startsWith('cant_reach')) continue
    const x = u.input?.x, y = u.input?.y, z = u.input?.z, range = u.input?.range ?? 1
    if (![x, y, z].every(n => Number.isFinite(n))) continue
    const key = `${x}|${y}|${z}|${range}`
    const next = (loopState.cantReachMap.get(key) ?? 0) + 1
    loopState.cantReachMap.set(key, next)
    if (next >= 2 && !loopState.cantReachNudgedKeys.has(key)) {
      loopState.cantReachNudgedKeys.add(key)
      const nudge = typeof cantReachNudge === 'function' ? cantReachNudge({ x, y, z, range }) : null
      return { nudge: nudge ?? null }
    }
  }
  return { nudge: null }
}
