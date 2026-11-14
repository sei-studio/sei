// src/bot/adapter/sts2/observers/snapshot.js: the per-turn snapshot text for
// the Slay the Spire 2 seat. Budget: a few hundred tokens with the Sei mod's
// structured state; the upstream mod's markdown is clipped
// (state.js UPSTREAM_STATE_MAX). It rides every turn, so it stays compact.

import { renderSeiState, clipUpstreamState, actionSignature } from '../state.js'

/** With the structured state already shown, the context only adds the choices. */
export const CONTEXT_WITH_STATE_MAX = 1_200
const arr = (v) => (Array.isArray(v) ? v : [])

/** A context older than this before the force belongs to an earlier screen. */
export const CONTEXT_FRESH_MS = 10_000

/**
 * The context that came with the open force (the mod's ActionWindow sends
 * context, register, force back to back): the newest one not older than
 * CONTEXT_FRESH_MS before it, non-silent first.
 */
function lastContext(seat) {
  const forceAt = Number(seat?.force?.at)
  const list = arr(seat?.contexts).filter((c) => c?.message && (!Number.isFinite(forceAt) || !Number.isFinite(Number(c.at)) || Number(c.at) >= forceAt - CONTEXT_FRESH_MS))
  for (let i = list.length - 1; i >= 0; i--) if (!list[i].silent) return list[i].message
  return list.length ? list[list.length - 1].message : ''
}

/**
 * Pure: the session view as snapshot text.
 * @param {{ seat: object|null, paused?: boolean, recent?: string[] }} view
 *   seat = { seiState, force, actions: Map, open, contexts?: {message, silent}[] }
 * @param {{ lastActionResult?: string|null }} [opts]
 */
export function composeSnapshot(view, opts = {}) {
  const { lastActionResult = null } = opts
  const seat = view?.seat
  if (!seat || seat.open === false) {
    return 'your game window is not connected right now (it may be starting or reconnecting); there is nothing to play until it is back'
  }
  const lines = []
  if (view.paused) lines.push('the player paused you in the app: do not act until they resume')
  const st = renderSeiState(seat.seiState)
  if (st.length) lines.push(...st)
  const force = seat.force
  if (!st.length && force?.state) lines.push(clipUpstreamState(force.state))
  else if (force) {
    // The game's own words for the screen: upstream neuro-sts2 sends no
    // force.state, only `context` messages; the Sei fork fills `options` for
    // character select and the map only, so rewards, events, shop, rest and
    // card picks are described in the latest context too.
    const ctx = lastContext(seat)
    const needs = !st.length || (!arr(seat.seiState?.options).length && !arr(seat.seiState?.hand).length)
    if (ctx && needs) lines.push(clipUpstreamState(ctx, st.length ? CONTEXT_WITH_STATE_MAX : undefined))
  }
  const recent = Array.isArray(view.recent) ? view.recent.filter(Boolean).slice(-4) : []
  if (recent.length) lines.push(`recent: ${recent.join(' | ')}`)

  if (force && !view.paused) {
    const names = force.actionNames.filter((n) => seat.actions.has(n))
    lines.push('YOUR MOVE:')
    if (force.query) lines.push(`  ${force.query.replace(/\s+/g, ' ').trim().slice(0, 300)}`)
    for (const n of names) {
      const a = seat.actions.get(n)
      const desc = a.description ? `: ${a.description.replace(/\s+/g, ' ').slice(0, 140)}` : ''
      lines.push(`  ${actionSignature(a)}${desc}`)
    }
    if (!names.length) lines.push('  (the game asked for a move but listed none it accepts yet; wait a moment)')
    // Without the structured state there is no hand to look names up in.
    if (!st.length && names.includes('play_card')) lines.push('  this game window only gives the text above: use card_index and enemy_index numbers, one play_card per response, since the numbers shift after each play')
  } else if (!view.paused) {
    const always = [...(seat.actions?.values?.() ?? [])].filter((a) => /^query|info$/.test(a.name))
    lines.push(`no move needed from you right now (waiting on the player or the game)${always.length ? `; you may still use ${always.map((a) => a.name).join(', ')}` : ''}`)
  }
  if (lastActionResult) lines.push(`last_action_result: ${String(lastActionResult).slice(0, 300)}`)
  return lines.join('\n')
}

/** @param {{ getView: () => object }} deps */
export function createSnapshotComposer({ getView }) {
  return {
    next(opts = {}) { return composeSnapshot(getView(), opts) },
    reset() {},
  }
}
