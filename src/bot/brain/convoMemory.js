/**
 * Short-term conversation memory — player-said / self-said ring buffers.
 *
 * Two split sub-buffers, capacity 10 each, 240-char per-line truncation.
 * Rendered into two seed user-turn blocks so the model sees what the other
 * player said separately from what it itself said. Splitting prevents the
 * model from treating its own prior lines as conversational input from the
 * other player.
 *
 * Cross-loop continuity / long-term memory lives in MEMORY.md (written via
 * the remember() tool, read in the seed turn each loop). This module is
 * intra-session only.
 */

import { SEED_HEADERS } from './prompts.js'

const RECENT_CHAT_CAPACITY = 10
const RECENT_CHAT_LINE_TRUNC = 240

function pushRing(arr, item, cap) {
  arr.push(item)
  while (arr.length > cap) arr.shift()
}

function fmtAgo(now, at) {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  return `${h}h ago`
}

export function createConvoMemory() {
  const playerLines = []
  const selfLines = []

  function pushPlayer(who, text) {
    if (!text) return
    const line = String(text).trim()
    if (!line) return
    pushRing(playerLines, { at: Date.now(), who: String(who || '?'), text: line.slice(0, RECENT_CHAT_LINE_TRUNC) }, RECENT_CHAT_CAPACITY)
  }

  function pushSelf(who, text) {
    if (!text) return
    const line = String(text).trim()
    if (!line) return
    pushRing(selfLines, { at: Date.now(), who: String(who), text: line.slice(0, RECENT_CHAT_LINE_TRUNC) }, RECENT_CHAT_CAPACITY)
  }

  function formatPlayerBlock() {
    if (playerLines.length === 0) return null
    const now = Date.now()
    const body = playerLines.map(({ at, who, text }) => `[${fmtAgo(now, at)}] ${who}: ${text}`).join('\n')
    return `${SEED_HEADERS.playerRecent}\n${body}`
  }

  function formatSelfBlock() {
    if (selfLines.length === 0) return null
    const now = Date.now()
    const body = selfLines.map(({ at, text }) => `[${fmtAgo(now, at)}] you: ${text}`).join('\n')
    return `${SEED_HEADERS.selfRecent}\n${body}`
  }

  return {
    recentChat: {
      pushPlayer,
      pushSelf,
      formatPlayerBlock,
      formatSelfBlock,
      lastSelf: () => selfLines.length > 0 ? selfLines[selfLines.length - 1] : null,
      get playerSize() { return playerLines.length },
      get selfSize() { return selfLines.length },
      _internal: { playerLines, selfLines },
    },
  }
}
