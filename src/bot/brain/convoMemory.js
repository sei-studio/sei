/**
 * Short-term conversation memory — player-said / self-said ring buffers.
 *
 * Two split sub-buffers, capacity 10 each, 240-char per-line truncation.
 * They are STORED split (the say() gates ask "what did I last say" and "has
 * the player spoken since" separately) and, since 260921, RENDERED as one
 * chronological exchange (formatConversationBlock). The two-list rendering
 * (formatPlayerBlock / formatSelfBlock, kept for callers that want one side)
 * hid the ORDER, and the order is the information: measured on a Stardew
 * session, the player asked a question, the companion's next line was about
 * something else, and when told "answer my question" she asked "what
 * question" twice, with the question sitting in her prompt the whole time.
 * In two lists a question with no answer looks the same as an answered one.
 * Own lines stay marked "you:" and the header says they are not new input,
 * which is what the split was protecting.
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

// 260925: a player line is labelled by ROLE first and name second. The
// player's name is whatever they typed as their preferred name, and on the
// v0.6.5-beta.2 playtest it was "Sei": the app's name, which the companion's
// own persona is built around. The transcript read "Sei: hey sui, ask me a
// question..." and, 20 s after asking that question herself, she answered it
// herself, her scratchpad attributing her own line to "them". A role tag no
// name can collide with ("player (Sei)") keeps who spoke unambiguous.
const GENERIC_PLAYER_NAMES = new Set(['', '?', 'player', 'the player', 'someone'])

/** "player (name)", or bare "player" when there is no real name. */
export function playerLabel(who) {
  const name = String(who ?? '').trim()
  return GENERIC_PLAYER_NAMES.has(name.toLowerCase()) ? 'player' : `player (${name})`
}

function speakerLabel({ who, companion }) {
  return companion ? String(who || '?') : playerLabel(who)
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

  /**
   * @param {string} who
   * @param {string} text
   * @param {{ companion?: boolean }} [opts]  companion: a sibling AI's line
   *   (labelled with its own name); anything else is the human player's.
   */
  function pushPlayer(who, text, opts = {}) {
    if (!text) return
    const line = String(text).trim()
    if (!line) return
    pushRing(playerLines, {
      at: Date.now(),
      who: String(who || '?'),
      companion: opts?.companion === true,
      text: line.slice(0, RECENT_CHAT_LINE_TRUNC),
    }, RECENT_CHAT_CAPACITY)
  }

  // Called when the line is DECIDED, not when the paced chat send fires: with
  // realistic typing a line reaches the socket 1-6s after the turn that wrote
  // it, and a turn composed inside that gap did not know the line existed
  // (260921: a question answered twice, two different answers, 8s apart).
  function pushSelf(who, text) {
    if (!text) return
    const line = String(text).trim()
    if (!line) return
    pushRing(selfLines, { at: Date.now(), who: String(who), text: line.slice(0, RECENT_CHAT_LINE_TRUNC) }, RECENT_CHAT_CAPACITY)
  }

  function formatPlayerBlock() {
    if (playerLines.length === 0) return null
    const now = Date.now()
    const body = playerLines.map((l) => `[${fmtAgo(now, l.at)}] ${speakerLabel(l)}: ${l.text}`).join('\n')
    return `${SEED_HEADERS.playerRecent}\n${body}`
  }

  function formatSelfBlock() {
    if (selfLines.length === 0) return null
    const now = Date.now()
    const body = selfLines.map(({ at, text }) => `[${fmtAgo(now, at)}] you: ${text}`).join('\n')
    return `${SEED_HEADERS.selfRecent}\n${body}`
  }

  /** Both sides as ONE exchange, oldest first. null when nobody has spoken. */
  function formatConversationBlock() {
    if (playerLines.length === 0 && selfLines.length === 0) return null
    const now = Date.now()
    // Stable merge: equal timestamps keep the player's line first, since a
    // reply recorded in the same millisecond still came after what it answers.
    const merged = [
      ...playerLines.map((l, i) => ({ ...l, self: false, i })),
      ...selfLines.map((l, i) => ({ ...l, self: true, i })),
    ].sort((a, b) => (a.at - b.at) || (Number(a.self) - Number(b.self)) || (a.i - b.i))
    const body = merged
      .map((l) => `[${fmtAgo(now, l.at)}] ${l.self ? 'you' : speakerLabel(l)}: ${l.text}`)
      .join('\n')
    return `${SEED_HEADERS.conversation}\n${body}`
  }

  return {
    recentChat: {
      pushPlayer,
      pushSelf,
      formatPlayerBlock,
      formatSelfBlock,
      formatConversationBlock,
      lastSelf: () => selfLines.length > 0 ? selfLines[selfLines.length - 1] : null,
      // 260730: the pair of these two answers "has the player said anything
      // since I last spoke?", which is what separates a reply from talking to
      // yourself. See shouldSuppressIdleSay in orchestrator.js.
      lastPlayer: () => playerLines.length > 0 ? playerLines[playerLines.length - 1] : null,
      get playerSize() { return playerLines.length },
      get selfSize() { return selfLines.length },
      _internal: { playerLines, selfLines },
    },
  }
}
