/**
 * In-flight action tracker.
 *
 * Snapshot of "what is the bot doing right now" — populated when an action
 * starts, cleared when it ends. Used by:
 *   - composeSnapshot (renders an `in_flight:` line so the LLM knows
 *     not to fire duplicate or competing actions)
 *   - follow.js (yields its 1s tick while a *movement* action is in flight)
 *
 * Single-flight is enforced inside individual action handlers (e.g. dig's
 * `bot.targetDigBlock` guard). This tracker only captures the most recent
 * non-personality action so the snapshot reflects ground truth.
 */

// Personality actions don't physically pause follow; the LLM still wants
// follow to keep working while it manipulates goals.
const PERSONALITY_ACTIONS = new Set(['setGoals', 'say', 'look'])

let _nextId = 1

export function createInflightTracker() {
  /** @type {{ id:number, name:string, args:any, startedAt:number } | null} */
  let entry = null

  function start({ name, args }) {
    const handle = { id: _nextId++, name, args, startedAt: Date.now() }
    entry = handle
    return handle
  }

  function end(handle) {
    if (entry && handle && entry.id === handle.id) entry = null
  }

  function current() {
    return entry
  }

  // Same as current() but returns null for personality-only actions, so
  // callers (follow tick) can distinguish "blocking the body" from "thinking".
  function currentBlocking() {
    if (!entry) return null
    if (PERSONALITY_ACTIONS.has(entry.name)) return null
    return entry
  }

  return { start, end, current, currentBlocking }
}

/**
 * Compact human-readable arg blurb for the in_flight: snapshot line.
 * Picks the most identifying fields and truncates the rest so a long
 * arg blob doesn't blow context.
 */
export function describeArgs(name, args) {
  if (!args || typeof args !== 'object') return ''
  const parts = []
  if (typeof args.block === 'string') parts.push(args.block)
  else if (typeof args.target === 'string') parts.push(args.target)
  else if (typeof args.item === 'string') parts.push(args.item)
  else if (typeof args.entity === 'string') parts.push(args.entity)

  if (typeof args.x === 'number' && typeof args.y === 'number' && typeof args.z === 'number') {
    parts.push(`@${args.x},${args.y},${args.z}`)
  }
  return parts.join(' ').slice(0, 64)
}
