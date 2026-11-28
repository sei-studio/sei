/**
 * In-flight action tracker.
 *
 * Snapshot of "what is the bot doing right now" — populated when an action
 * starts, cleared when it ends. composeSnapshot renders an `in_flight:` line
 * so the LLM knows not to fire duplicate or competing actions.
 *
 * Single-flight is enforced inside individual action handlers (e.g. dig's
 * `bot.targetDigBlock` guard). This tracker only captures the most recent
 * action so the snapshot reflects ground truth.
 */

let _nextId = 1

export function createInflightTracker() {
  /** @type {{ id:number, name:string, args:any, startedAt:number, progress:any } | null} */
  let entry = null
  // 261014: the last few finished actions, so the snapshot can tell her own
  // haul (a gather's logs, a craft's output) apart from a gift. An action that
  // starts and ends between two snapshots never shows up in current().
  /** @type {Array<{ name:string, args:any, startedAt:number, endedAt:number, progress:any, result:string|null, aborted:boolean }>} */
  const history = []
  const HISTORY_CAP = 8

  function start({ name, args }) {
    const handle = { id: _nextId++, name, args, startedAt: Date.now(), progress: null }
    entry = handle
    return handle
  }

  // 261015: `outcome` ({ result, aborted }) is how it ended, so the idle
  // snapshot line can say that the last action finished or was stopped.
  function end(handle, outcome = null) {
    if (!handle) return
    if (!history.some(h => h.id === handle.id)) {
      history.push({
        id: handle.id, name: handle.name, args: handle.args, startedAt: handle.startedAt, endedAt: Date.now(), progress: handle.progress,
        result: typeof outcome?.result === 'string' ? outcome.result : null,
        aborted: !!outcome?.aborted,
      })
      if (history.length > HISTORY_CAP) history.shift()
    }
    if (entry && entry.id === handle.id) entry = null
  }

  // Finished actions (newest last) plus the running one, if any. Running
  // entries carry endedAt null.
  function recent() {
    const out = history.map(h => ({ ...h }))
    if (entry) out.push({ id: entry.id, name: entry.name, args: entry.args, startedAt: entry.startedAt, endedAt: null, progress: entry.progress })
    return out
  }

  function current() {
    return entry
  }

  // Cuboid actions push progress ticks via this
  // setter so the next snapshot's `in_flight:` line includes a `placed/total`
  // (or `dug/total`) suffix. Stale handles (different id) are ignored to
  // avoid late ticks from a previous action overwriting fresh state.
  function updateProgress(handle, progress) {
    if (entry && handle && entry.id === handle.id) {
      entry.progress = progress
    }
  }

  return { start, end, current, updateProgress, recent }
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
  // gather({name}) rendered as a bare "gather()" in the in_flight line.
  else if (typeof args.name === 'string') parts.push(args.name)

  if (typeof args.x === 'number' && typeof args.y === 'number' && typeof args.z === 'number') {
    parts.push(`@${args.x},${args.y},${args.z}`)
  }
  return parts.join(' ').slice(0, 64)
}

/**
 * 260513-wkd: render the snapshot's `in_flight:` line from a tracker entry.
 *
 * Format: `in_flight: <name>(<argblurb>) started=<X.X>s ago[ — <completed>/<total>[, y=<currentY>]]`
 *
 * Preserves the em-dash separator AND the `y=<currentY>` channel
 * exactly as snapshot.js rendered them; the ONLY visible delta vs the prior
 * `(Xs)` trailer is the new `started=Xs ago` form (locked in CONTEXT.md
 * "Snapshot mid-flight enrichment").
 *
 * When `entry.progress` carries either `placed/total` (cuboid build) or
 * `dug/total` (cuboid dig + gather, both via the same onProgress channel),
 * a suffix is appended. `y=<currentY>` is preserved when present on the
 * progress payload (cuboid build/dig emit it; gather does not).
 *
 * 261014: a gather that reports its drop items (`items` + `before`) is
 * rendered from the CURRENT inventory when the caller passes it: how many it
 * has picked up, how many are left, and what she holds now. The progress tick
 * itself lags one pickup behind, and she quoted the requested number ("already
 * at 6") or the stale tick instead of what she held.
 *
 * @param {{ id:number, name:string, args:any, startedAt:number, progress:any } | null} entry
 * @param {number} [now=Date.now()] — injected for deterministic tests.
 * @param {{ inventory?: Record<string, number> | null, giveWalking?: boolean | null }} [opts]
 *   inventory: the item counts the same snapshot shows on its inventory line.
 *   giveWalking: true while a running give() is still walking to the player.
 * @returns {string} empty string when entry is null/undefined; otherwise the
 *   formatted line.
 */
export function getInFlightLineForSnapshot(entry, now = Date.now(), opts = {}) {
  if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string') return ''
  const elapsed = Math.max(0, (now - (entry.startedAt ?? now)) / 1000).toFixed(1)
  const argblurb = describeArgs(entry.name, entry.args)
  let suffix = ''
  const p = entry.progress
  const gatherLine = p ? heldGatherSuffix(p, opts?.inventory) : null
  if (p && p.shelter === true) {
    suffix = shelterSuffix(p)
  } else if (gatherLine) {
    suffix = gatherLine
  } else if (p && typeof p.total === 'number') {
    const completed = (typeof p.placed === 'number') ? p.placed
                    : (typeof p.dug === 'number') ? p.dug
                    : null
    if (completed != null) {
      const yPart = (typeof p.currentY === 'number') ? `, y=${p.currentY}` : ''
      // 261012: a dug count is blocks broken, not items held. Drops can still
      // be on the ground, and in the scripted-convo eval she told the player
      // "6 logs done" off a 5/6 here while her inventory held 4.
      // 261012 (pass 4a): "1/6 dug" was read as "the 6th log" in a later
      // line, so the progress is spelled out.
      suffix = (typeof p.placed !== 'number' && typeof p.dug === 'number')
        ? ` — broke ${completed} of the ${p.total} blocks asked for so far (what you hold is on your inventory line)${yPart}`
        : ` — placed ${completed} of ${p.total} so far${yPart}`
    }
  }
  // 261018 (pass 17): a hand-over still running. work_session-05 (pass 15
  // eval) composed a turn 1.8s into give(oak_log), read oak_log x6 in her
  // inventory and the crafting table recipe on the next: line, and called
  // craft; the logs were already on their way to the player.
  // 261021 (pass 21): it said "Those are theirs now", and to "actually forget
  // the logs, just meet me over here" mid-give she let the toss finish ("the
  // logs are already flying your way"): 7 of 8 kept the give running in the
  // probe. Now it says the hand-over has not happened and stopping keeps them.
  if (!suffix && entry.name === 'give' && typeof entry.args?.item === 'string') {
    const n = Number.isFinite(entry.args.count) ? `${entry.args.count} ` : 'all your '
    const to = typeof entry.args.player === 'string' && entry.args.player.trim() ? entry.args.player.trim() : 'the player'
    // 261120 (pass 59): while the give is still walking over, say that.
    // "handing" read as the toss itself and she told them it had landed.
    // opts.giveWalking comes from the adapter (true while out of toss range).
    const walking = opts?.giveWalking === true
      ? `, still walking over to ${to} to hand them ${n}${entry.args.item}. Nothing is tossed until you get there`
      : `, handing ${n}${entry.args.item} to ${to}. Nothing is handed over until the toss lands`
    suffix = `${walking}, so stopping it keeps them with you. They are meant for ${to}, so do not count them toward anything of yours`
  }
  return `in_flight: ${entry.name}(${argblurb}) started=${elapsed}s ago${suffix}`
}

// 261128 (quality pass 68): the stage a running shelter() is at. With only
// "shelter() started=8.5s ago" to go on she told the player "im almost done
// with the walls" and "shelter's almost up, you're safe in here" while it was
// still digging dirt (11-28 scorecard night_social-02). Payload from
// behaviors/shelter.js: { shelter: true, stage, have/need | filled/cells }.
function shelterSuffix(p) {
  const n = (v) => (Number.isFinite(v) ? Math.max(0, Math.round(v)) : null)
  if (p.stage === 'supply' && n(p.have) != null && n(p.need) != null) {
    return `, still digging up blocks to build it with (${n(p.have)} of the ${n(p.need)} it needs so far). Nothing is built yet: no wall or roof is placed`
  }
  if (p.stage === 'walls' && n(p.filled) != null && n(p.cells) != null) {
    const left = Math.max(0, n(p.cells) - n(p.filled))
    return `, placing the walls (${n(p.filled)} of the ${n(p.cells)} wall blocks are in place, ${left} still to go, and the roof goes on after them). It is not finished and keeps nothing out yet`
  }
  if (p.stage === 'roof' && n(p.filled) != null && n(p.cells) != null) {
    return `, the walls are up and it is putting on the roof (${n(p.filled)} of ${n(p.cells)} roof blocks in place). It is not finished yet`
  }
  if (p.stage === 'door') return ', the walls and roof are up and it is cutting the doorway'
  return ''
}

// Gather progress from what is in the inventory right now. Returns null when
// the payload has no drop items or the caller has no inventory to read.
function heldGatherSuffix(p, inventory) {
  if (!inventory || typeof inventory !== 'object') return null
  if (!Array.isArray(p.items) || p.items.length === 0 || typeof p.total !== 'number') return null
  if (typeof p.before !== 'number') return null
  let held = 0
  for (const name of p.items) held += Number(inventory[name]) || 0
  const picked = Math.max(0, held - p.before)
  const left = Math.max(0, p.total - picked)
  const label = p.items.length === 1 ? p.items[0] : p.items.join(' or ')
  return ` — picked up ${picked} of the ${p.total} ${label} asked for so far, ${left} to go; you hold ${held} ${label} right now`
}

// Actions too brief or too passive to be "what she was doing". A look or an
// equip after a stopped gather must not hide the gather.
const IDLE_LINE_SKIP = new Set([
  'look', 'find', 'readSign', 'equip', 'setPvp', 'openContainer', 'openFurnace',
  'visualize', 'follow', 'unfollow', 'stop', 'activateItem',
])
const IDLE_RESULT_MAX = 140
const IDLE_LAST_ACTION_MAX_MS = 10 * 60_000

/**
 * 261015: the snapshot's line when no action is running. It names the last
 * real action and how it ended. The bare "idle: no action is running" left
 * her own earlier line ("still hauling your logs") as the newest word on the
 * subject after a gather was stopped, and she repeated it to the player.
 *
 * @param {{ recentActions?: Array<any>, following?: string|null, now?: number }} [opts]
 * @returns {string}
 */
export function idleLineForSnapshot({ recentActions = [], following = null, now = Date.now() } = {}) {
  const head = following
    ? `idle: no action is running, but you are still following ${following}`
    : 'idle: no action is running'
  const list = Array.isArray(recentActions) ? recentActions : []
  let last = null
  for (let i = list.length - 1; i >= 0; i--) {
    const a = list[i]
    if (!a || typeof a.name !== 'string' || a.endedAt == null) continue
    if (IDLE_LINE_SKIP.has(a.name)) continue
    last = a
    break
  }
  if (!last || now - last.endedAt > IDLE_LAST_ACTION_MAX_MS) return head
  const ago = Math.max(0, Math.round((now - last.endedAt) / 1000))
  const blurb = describeArgs(last.name, last.args)
  const label = blurb ? `${last.name} ${blurb}` : last.name
  let result = typeof last.result === 'string' ? last.result.replace(/\s+/g, ' ').trim() : ''
  if (result.length > IDLE_RESULT_MAX) result = result.slice(0, IDLE_RESULT_MAX - 3).trimEnd() + '...'
  const how = last.aborted ? 'was stopped' : 'ended'
  return `${head}. Your last action (${label}) ${how} ${ago}s ago${result ? `: ${result}` : ''}. It is not running now.`
}
