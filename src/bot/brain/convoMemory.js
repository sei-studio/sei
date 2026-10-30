/**
 * Short-term conversation memory — player-said / self-said ring buffers.
 *
 * Two split sub-buffers, capacity 40 each, 240-char per-line truncation.
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
 * 261014: a third ring holds what HAPPENED in the game (sessionEvents.js),
 * rendered in the same transcript as "game:" lines so a recall answer has a
 * record of who did what, not only her own lines about it.
 *
 * Cross-loop continuity / long-term memory lives in MEMORY.md (written via
 * the remember() tool, read in the seed turn each loop). This module is
 * intra-session only.
 */

import { SEED_HEADERS } from './prompts.js'
import { createSessionEventLog, createHandOverLedger } from './sessionEvents.js'

const RECENT_CHAT_CAPACITY = 40
const RECENT_CHAT_LINE_TRUNC = 240
// 261012: the merged transcript shows the newest CONVERSATION_TURNS turns of
// the combined exchange, where a player message is one turn and a run of her
// lines with nothing from them in between is one turn. Each ring used to
// hold 10 and both were rendered in full, but her lines are stored per
// sentence (a turn is 2-4 entries) and the player's per message, so her 10
// covered the last three or four turns while the player's 10 reached back a
// minute or more. The transcript then showed a run of older player lines
// with none of her answers between them (questions that read as unanswered)
// and dropped the lines she was about to repeat ("still getting you that
// cobble", said four times in the scripted-convo eval). Counting turns keeps
// both sides over the same stretch of time, and 24 reaches about twelve
// player lines back ("what was i scared of earlier?" asked ten lines on).
const CONVERSATION_TURNS = 24

/** The newest `turns` turns of a merged, oldest-first transcript. */
export function lastTurns(merged, turns = CONVERSATION_TURNS) {
  let n = 0
  let i = merged.length
  while (i > 0) {
    const l = merged[i - 1]
    const startsTurn = !l.self || !(merged[i]?.self)
    if (startsTurn) {
      if (n === turns) break
      n += 1
    }
    i -= 1
  }
  return merged.slice(i)
}

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

/**
 * @param {{ onLine?: (who: 'player'|'you'|'other', text: string) => void, trackHandOvers?: boolean }} [opts]
 *   onLine (261011): every recorded line is also handed here, for the
 *   session digest main reads after a player-ended session (sessionDigest.js).
 *   trackHandOvers (261026): the game reports its hand-overs (the adapter's
 *   handOverDetail), so the transcript ends on the session's hand-over line.
 *   Off for a game that does not, where "you have not given anything" could
 *   be false.
 */
export function createConvoMemory({ onLine = null, trackHandOvers = false } = {}) {
  const playerLines = []
  const selfLines = []
  // 261014: what happened in the game, rendered into the same transcript as
  // "game:" lines (sessionEvents.js). Never a speaker: the say() gates and
  // "has the player spoken since" read only the two rings above.
  const events = createSessionEventLog()
  // 261026 (pass 28): what changed hands this session (sessionEvents.js).
  const handOvers = createHandOverLedger()
  const tap = (who, text) => {
    if (typeof onLine !== 'function') return
    try { onLine(who, text) } catch {}
  }

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
    tap(opts?.companion === true ? 'other' : 'player', line)
  }

  // Called when the line is DECIDED, not when the paced chat send fires: with
  // realistic typing a line reaches the socket 1-6s after the turn that wrote
  // it, and a turn composed inside that gap did not know the line existed
  // (260921: a question answered twice, two different answers, 8s apart).
  //
  // 261017 (quality pass 11): `sentAt` is when the line reaches the player
  // (the paced send). `at` stays the decision time, which the say() gates,
  // the greeting check and ownRepeats' turn grouping key on; the transcript
  // is ordered by sentAt. Ordered by decision time, a line the player typed
  // while hers was still being typed sat AFTER it, so their "hey" read as a
  // reply to her hello. Her scratchpad said "Alex just said hi back" and she
  // greeted again ("yo alex" then "hey alex", about 20 of the 178 repetitive
  // labels in the 261015-16 compares).
  function pushSelf(who, text, opts = {}) {
    if (!text) return
    const line = String(text).trim()
    if (!line) return
    const at = Date.now()
    const sentAt = Number.isFinite(opts?.sentAt) && opts.sentAt > at ? opts.sentAt : at
    pushRing(selfLines, { at, sentAt, who: String(who), text: line.slice(0, RECENT_CHAT_LINE_TRUNC) }, RECENT_CHAT_CAPACITY)
    tap('you', line)
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

  /**
   * Both sides as ONE exchange, oldest first, with the session's game events
   * (sessionEvents.js) in time order between the lines. The turn window counts
   * spoken lines only; every kept event is shown, so one that happened before
   * the oldest line still shown sits at the top. null when nobody has spoken.
   */
  function formatConversationBlock() {
    if (playerLines.length === 0 && selfLines.length === 0) return null
    const now = Date.now()
    // Stable merge: equal timestamps keep the player's line first, since a
    // reply recorded in the same millisecond still came after what it answers.
    // Her lines go where the player saw them, at sentAt (see pushSelf).
    const merged = [
      ...playerLines.map((l, i) => ({ ...l, self: false, i, t: l.at })),
      ...selfLines.map((l, i) => ({ ...l, self: true, i, t: l.sentAt ?? l.at })),
    ].sort((a, b) => (a.t - b.t) || (Number(a.self) - Number(b.self)) || (a.i - b.i))
    const spoken = lastTurns(merged).map((l) => ({
      at: l.t, line: `[${fmtAgo(now, l.t)}] ${l.self ? 'you' : speakerLabel(l)}: ${l.text}`,
    }))
    // An event recorded in the same millisecond as a line goes after it: the
    // line was decided first (say() is emitted before the action runs).
    const happened = events.list().map((e) => ({ at: e.at, line: `[${fmtAgo(now, e.at)}] game: ${e.text}` }))
    const all = [...spoken.map((x, i) => ({ ...x, o: 0, i })), ...happened.map((x, i) => ({ ...x, o: 1, i }))]
      .sort((a, b) => (a.at - b.at) || (a.o - b.o) || (a.i - b.i))
    // 261026 (pass 28): the hand-over line closes the record. It covers the
    // whole session, so it is not placed in time order.
    const tail = trackHandOvers ? `\n${handOvers.describe({ label: playerLabel })}` : ''
    return `${SEED_HEADERS.conversation}\n${all.map((x) => x.line).join('\n')}${tail}`
  }

  /**
   * Record something that happened in the game (not a line anyone said).
   * @param {string} text  e.g. "you used attackEntity: killed zombie (4 hits)"
   * @param {{key?: string, windowMs?: number}} [opts]  fold repeats (hits)
   */
  function pushEvent(text, opts) {
    return events.record(text, opts)
  }

  return {
    recentChat: {
      pushPlayer,
      pushSelf,
      formatPlayerBlock,
      formatSelfBlock,
      formatConversationBlock,
      pushEvent,
      // 261026 (pass 28): a give that went through, and items that came in
      // without an action of hers.
      noteGiven: (h) => handOvers.gave(h),
      noteReceived: (gains) => handOvers.received(gains),
      lastSelf: () => selfLines.length > 0 ? selfLines[selfLines.length - 1] : null,
      // 260730: the pair of these two answers "has the player said anything
      // since I last spoke?", which is what separates a reply from talking to
      // yourself. See shouldSuppressIdleSay in orchestrator.js.
      lastPlayer: () => playerLines.length > 0 ? playerLines[playerLines.length - 1] : null,
      // 261018: did anyone say a line that the transcript places after
      // `fromMs` and no later than `toMs`? (Her lines go at sentAt.)
      spokeBetween: (fromMs, toMs) =>
        playerLines.some((l) => l.at > fromMs && l.at <= toMs) ||
        selfLines.some((l) => { const t = l.sentAt ?? l.at; return t > fromMs && t <= toMs }),
      get playerSize() { return playerLines.length },
      get selfSize() { return selfLines.length },
      get eventSize() { return events.size },
      _internal: { playerLines, selfLines, events, handOvers },
    },
  }
}
