// 261008: the "next time" hook a companion can attach to its goodbye
// (retention fix 2(c), ~/suisei/reports/retention-2026-10-05.md).
//
// Every goodbye tool (game quit_game / end_call, chat-surface quit_game /
// end_call) takes an optional `next_time` field: a few words naming something
// real to pick up next session ("finish the roof"). The model writes its own
// goodbye around it; nothing here touches what it says. This module only
// turns the FIELD into the MEMORY.md line the next greeting reads back, and
// tells the host whether one was given (analytics counts the field, never the
// spoken text).
//
// Import-free on purpose: the bot (raw ESM) and main (bundled TS) both use it.

/** A stored note, not speech: bounded so one runaway field cannot bloat MEMORY.md. */
export const NEXT_STEP_MAX_CHARS = 200

/**
 * The tool's `next_time` input as a clean single line, or null when the model
 * left it out (missing, not a string, or only whitespace).
 */
export function normalizeNextStep(raw) {
  if (typeof raw !== 'string') return null
  const s = raw.replace(/\s+/g, ' ').trim()
  if (!s) return null
  if (s.length <= NEXT_STEP_MAX_CHARS) return s
  const cut = s.slice(0, NEXT_STEP_MAX_CHARS)
  const space = cut.lastIndexOf(' ')
  return (space > NEXT_STEP_MAX_CHARS / 2 ? cut.slice(0, space) : cut).trim()
}

/**
 * The MEMORY.md entry for a saved hook. The prefix is what the greeting
 * prompts point at (promptLibrary NEXT_TIME_GREETING), so keep them in sync.
 *
 * 261020: `gameName` (a display name, "Stardew Valley") names the game the
 * plan is for: "Plan for next time in Minecraft: ...". MEMORY.md is shared
 * by every surface and every game, so an unlabeled Minecraft plan read like
 * a task inside a Stardew session (live 261020: a copper bulb lighthouse
 * became her Stardew goal). Omit it for a plan that is not about a game.
 */
export function nextStepMemoryLine(step, gameName) {
  const game = typeof gameName === 'string' ? gameName.replace(/[\s:]+/g, ' ').trim() : ''
  return game ? `Plan for next time in ${game}: ${step}` : `Plan for next time: ${step}`
}

/** "Plan for next time:" or "Plan for next time in <game>:" at the start of an entry. */
export const PLAN_LINE_RE = /^plan for next time(?:\s+in\s+([^:]{1,60}?))?\s*:\s*/i

/**
 * An entry's text as a plan, or null when it is not one: the step without
 * the prefix, and the game display name when the line names one.
 * @param {string} text
 * @returns {{ step: string, gameName: string | null } | null}
 */
export function parsePlanLine(text) {
  const s = String(text ?? '').trim()
  const m = PLAN_LINE_RE.exec(s)
  if (!m) return null
  const step = s.slice(m[0].length).trim()
  if (!step) return null
  return { step, gameName: m[1] ? m[1].trim() : null }
}

// 261020 (review): the game a goodbye's plan is for, from the goodbye
// tools' optional `next_time_game` field. The model decides it from the step
// (a Minecraft build talked about while playing Stardew is a Minecraft plan),
// the same way the player-end check's `game:` line does. Display names match
// src/shared/games.ts GAME_CATALOG (a test checks); kept here because this
// module is import-free.
/** Bot game id -> display name. */
export const PLAN_GAMES = Object.freeze({
  minecraft: 'Minecraft',
  stardew: 'Stardew Valley',
  dontstarve: "Don't Starve Together",
})

// Whole answers that name one game: its id, its name, a leading part of the
// name, or its short name. Compared as whole words, so "craft" or "Minecraft
// Dungeons" names no game (review 261020).
const PLAN_GAME_ALIASES = Object.freeze({
  minecraft: ['minecraft', 'mc'],
  stardew: ['stardew valley', 'stardew', 'sdv'],
  dontstarve: ['dont starve together', 'dont starve', 'dontstarve', 'dst'],
})

/** Lowercase words, apostrophes dropped ("Don't" -> "dont"), no leading "the". */
function gameWords(s) {
  return s
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^the\s+/, '')
}

/**
 * The tool field as a game id, 'none' (not about playing a game), or null
 * when it is missing or names no known game.
 * @param {unknown} raw
 * @returns {'minecraft' | 'stardew' | 'dontstarve' | 'none' | null}
 */
export function parsePlanGameField(raw) {
  if (typeof raw !== 'string') return null
  const v = raw.replace(/^[\s*_"'`“”‘’]+|[\s*_"'`“”‘’.。]+$/g, '').trim()
  if (!v) return null
  // "None of them", "none (just talk)": a short answer that starts with none,
  // as the player-end check reads its note (cleanNote).
  if (/^(none|nothing|no|n\/a)(?![a-z])/i.test(v) && v.split(/\s+/).length <= 3) return 'none'
  if (/^(无|没有|なし|없음)$/.test(v)) return 'none'
  // A trailing aside does not change the game: "Minecraft (the lighthouse)".
  const words = gameWords(v.replace(/\s*\([^)]*\)\s*$/, ''))
  for (const [id, aliases] of Object.entries(PLAN_GAME_ALIASES)) {
    if (aliases.includes(words)) return /** @type {any} */ (id)
  }
  return null
}

// 261014: the player-facing line for the Home "up next" strip.
//
// The plan above is the companion's private note ("ask Alex what the vet says
// about Pepper's leg on Thursday"): good for her memory and her greeting, wrong
// on the player's own screen. So the plan can carry a second line written TO
// the player ("Tell Roger what the vet said about Pepper"). It never goes into
// MEMORY.md (the model would read it as a second plan); main keeps it in the
// NEXT_STEP.json sidecar next to the plan's tag (src/main/homeNextStep.ts). A
// plan without one shows the note, as before.

/** About one clause. Longer lines are cut at a clause break when one fits. */
export const PLAYER_LINE_MAX_CHARS = 60
/** Past this the line is cut at a word and marked with an ellipsis. */
export const PLAYER_LINE_HARD_MAX_CHARS = 90

// Read on a later day, a relative day goes stale ("raid the village tomorrow"
// shown the next evening). "tomorrow"/"tonight" are dropped wherever they
// stand (adverbs, so the rest still reads); the softer ones only at the end
// or the start, where removing them cannot break the clause.
// A possessive ("tonight's stream", "Tonight's the Night") is left alone:
// dropping the day there leaves "'s stream".
const RELATIVE_ANYWHERE = /(?:\s*,)?\s*\b(?:(?:by|for|until|on)\s+)?(?:tomorrow|tonight|tmrw?)\b(?!['’]s)(?:\s+(?:morning|night|evening))?/gi
const RELATIVE_EDGE_END = /(?:\s*,)?\s+(?:(?:later\s+)?today|later|next time|this (?:morning|afternoon|evening|weekend))\s*$/i
const RELATIVE_EDGE_START = /^(?:next time|later|today|this (?:morning|afternoon|evening|weekend))\s*[,:]?\s+/i

/** A head shorter than this is not worth cutting to ("Go - then ..."). */
const MIN_CLAUSE_HEAD = 8

/**
 * Cut at the first clause break ("; ", ", then ", " - ") that leaves a
 * readable head. A plain comma is not a break: it is usually a list
 * ("blaze powder, pufferfish and a brewing stand").
 */
function firstClause(s) {
  const re = /(?:\s*;\s+|,?\s+(?:and then|then)\s+|\s+[-–—]\s+)/g
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const head = s.slice(0, m.index).replace(/[\s,]+$/, '').trim()
    if (head.length >= MIN_CLAUSE_HEAD) return head
  }
  return s
}

/** One cleanup pass: quotes, relative days, edge punctuation. */
function cleanPlayerLine(s) {
  return s
    .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '')
    .trim()
    .replace(RELATIVE_ANYWHERE, '')
    .replace(RELATIVE_EDGE_END, '')
    .replace(RELATIVE_EDGE_START, '')
    .replace(/\s+([,.!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .replace(/[\s,;:.。-]+$/, '')
    .replace(/^[\s,;:-]+/, '')
    .trim()
}

/**
 * The model's player-facing line as strip text, or null when it gave none.
 * One line, no wrapping quotes, no trailing period, no relative day, first
 * letter up, about PLAYER_LINE_MAX_CHARS long.
 */
export function normalizePlayerLine(raw) {
  if (typeof raw !== 'string') return null
  // Main runs this again on lines the bot already normalized (tagLatestPlan,
  // pickNextStep), so it must not change its own output: clean until stable.
  let s = raw.replace(/\s+/g, ' ').trim()
  for (let i = 0; i < 4; i++) {
    const next = cleanPlayerLine(s)
    if (next === s) break
    s = next
  }
  if (!s) return null
  if (s.length > PLAYER_LINE_MAX_CHARS) s = firstClause(s)
  if (s.length > PLAYER_LINE_HARD_MAX_CHARS) {
    // One under the cap, so the line with its ellipsis still fits it.
    const max = PLAYER_LINE_HARD_MAX_CHARS - 1
    const cut = s.slice(0, max)
    const space = cut.lastIndexOf(' ')
    s = (space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:-]+$/, '').replace(/\s+(?:and|or|with|to|the|a|an|of|for)$/i, '').trim() + '…'
  }
  if (/^[a-z]/.test(s)) s = s[0].toUpperCase() + s.slice(1)
  return s || null
}

// 261014 (review): a light check that the player line really is written to
// the player. The model sometimes hands back its own note instead ("ask how
// the move went", "remember to ask Alex about the vet"), which on the
// player's screen reads as a chore for them. Such a line is not stored, and
// the card shows the note as it did before player lines existed
// (homeNextStep.ts pickNextStep).

// Openers of a note to self. "Ask Lyra ..." / "Check in with Roger ..." are
// fine: they name the companion near the start, so they are aimed at it.
const SELF_NOTE_OPENER = /^(?:ask|remember|remind|find out|follow up|don'?t forget|check (?:in|if|whether|how)|see (?:how|if|whether))\b/i
const FIRST_PERSON = /\bI\b|\b(?:me|my|myself|we|us|our|ours)\b/i

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Whether `name` appears as a whole word in `text` (any case, possessive ok). */
function hasName(text, name) {
  const n = typeof name === 'string' ? name.trim() : ''
  if (!n) return false
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escapeRe(n)}(?![\\p{L}\\p{N}_])`, 'iu').test(text)
}

/**
 * Why a normalized player line is not one, or null when it is fine.
 * `character` is the companion's name, `players` the player's names
 * (preferred name, Minecraft username); either may be missing.
 * @param {string} line
 * @param {{ character?: string | null, players?: Array<string | null | undefined> }} [names]
 * @returns {null | 'self_note' | 'first_person' | 'names_player'}
 */
export function playerLineProblem(line, names = {}) {
  const s = String(line ?? '')
  if (/\bthe player\b/i.test(s)) return 'names_player'
  for (const p of names.players ?? []) {
    // The companion's name can match a username ("sui"); that one is fine.
    if (p && !(names.character && p.trim().toLowerCase() === names.character.trim().toLowerCase()) && hasName(s, p)) {
      return 'names_player'
    }
  }
  if (FIRST_PERSON.test(s)) return 'first_person'
  if (SELF_NOTE_OPENER.test(s)) {
    const head = s.split(/\s+/).slice(0, 5).join(' ')
    if (!(names.character && hasName(head, names.character))) return 'self_note'
  }
  return null
}

/**
 * The model's player line as stored strip text: normalized, and null when it
 * is missing or fails playerLineProblem (the card then shows the note).
 * @param {unknown} raw
 * @param {{ character?: string | null, players?: Array<string | null | undefined> }} [names]
 */
export function acceptPlayerLine(raw, names = {}) {
  const line = normalizePlayerLine(raw)
  if (!line) return null
  return playerLineProblem(line, names) ? null : line
}
