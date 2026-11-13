/**
 * The bond (261113, v0.7 character consistency D3): how things stand between
 * a companion and the player, one small record per character in
 * `<memoryDir>/bond.json`. The schema is src/shared/bondSchema.ts (this
 * process cannot import shared TS, so the caps are repeated here and a test
 * checks that every record this file writes passes the schema).
 *
 * Lifecycle:
 *   - written only when time together is consolidated: the chat fold
 *     (main continuity.ts, covers chat, calls and every transcript surface)
 *     and the game session-end call (main playerEndNextStep.ts, covers the
 *     game sessions whose lines never reach the transcript). Both return a
 *     `<bond>` block of labelled lines (BOND_UPDATE_INSTRUCTIONS), parsed by
 *     parseBondBlock and merged by mergeBond;
 *   - read when a session's prompt is built (the bot once at session start,
 *     the chat surfaces per turn; a write only ever lands at a fold or a
 *     session end), and rendered by promptLibrary.js renderBond right after
 *     the persona, the same text on every surface.
 *
 * Rules mergeBond keeps (product call 261113):
 *   - the stage never goes down, and goes up at most one step per update,
 *     and only when the companion judged the stretch as warm (treated: warm,
 *     the perception step, 260616 relationship experiment: Sui's card reads
 *     put-downs as banter, so the question is asked with the reflex set aside);
 *   - feelings change only after a warm stretch (or when there are none yet
 *     and the stretch was not bad), so the bond never sours;
 *   - names, jokes and rules are facts and update either way.
 * Plans and open threads are memory's, not the bond's (see bondSchema.ts).
 *
 * Nothing here imports electron, so main, the bot and the consistency eval
 * (scripts/quality-eval/consistency) all run the same code.
 */
import { readFileSync } from 'node:fs'
import { readFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { atomicWrite } from '../storage/atomicWrite.js'

export const BOND_FILE = 'bond.json'
/** Mirrors BOND_STAGES in src/shared/bondSchema.ts. */
export const BOND_STAGES = ['new', 'acquainted', 'familiar', 'close', 'bonded']
export const BOND_TREATED = ['warm', 'neutral', 'badly']
export const BOND_MAX_ITEMS = 3
export const BOND_LINE_CHARS = 160
/** The highest stage a first write may start at; past it the bond is earned one step at a time. */
export const BOND_FIRST_MAX_STAGE = 'close'

/** The bond file inside a memory dir. */
export function bondPath(memoryDir) {
  return path.join(memoryDir, BOND_FILE)
}

const clip = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, BOND_LINE_CHARS).trim()
const list = (xs) => (Array.isArray(xs) ? xs.map(clip).filter(Boolean).slice(0, BOND_MAX_ITEMS) : [])

/**
 * A stored record, checked and clipped, or null when it is not a bond.
 * Lenient on purpose: a hand-edited or older file loses the bad parts, not
 * the whole record.
 */
export function normalizeBond(raw) {
  if (!raw || typeof raw !== 'object') return null
  const stage = BOND_STAGES.includes(raw.stage) ? raw.stage : null
  if (!stage) return null
  return {
    v: 1,
    stage,
    how_i_feel: list(raw.how_i_feel),
    names: list(raw.names),
    running_jokes: list(raw.running_jokes),
    standing_rules: list(raw.standing_rules),
    updates: Number.isInteger(raw.updates) && raw.updates >= 0 ? raw.updates : 0,
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : new Date(0).toISOString(),
  }
}

/** The bond in a memory dir, or null (none yet, unreadable). Sync: the bot reads it once while it builds its prompt. */
export function readBondSync(memoryDir) {
  try {
    return normalizeBond(JSON.parse(readFileSync(bondPath(memoryDir), 'utf8')))
  } catch {
    return null
  }
}

export async function readBond(memoryDir) {
  try {
    return normalizeBond(JSON.parse(await readFile(bondPath(memoryDir), 'utf8')))
  } catch {
    return null
  }
}

export async function writeBond(memoryDir, bond) {
  await mkdir(memoryDir, { recursive: true })
  await atomicWrite(bondPath(memoryDir), JSON.stringify(bond, null, 1) + '\n')
}

const BLOCK_RE = /<bond>([\s\S]*?)(?:<\/bond>|$)/i
const LABEL_RE = /^\s*[*_-]*\s*(treated|stage|feeling|name|joke|rule)\s*[*_]*\s*[:：]\s*[*_]*\s*(.*)$/i
const NONE_RE = /^[\s*_"'“”‘’`]*(none|nothing|n\/a)[\s*_"'“”‘’`.。]*$/i

/**
 * The `<bond>` block of a fold or session-end reply, and the reply without
 * it (so the summary, recap and plan parsers never read it). `update` is null
 * when the reply has no block. Labelled lines only; this reads the format the
 * prompt asks for, not speech. A list label that appears replaces that list
 * (`joke: none` empties it); a list label left out keeps the list.
 */
export function parseBondBlock(text) {
  const src = String(text ?? '')
  const m = BLOCK_RE.exec(src)
  if (!m) return { update: null, rest: src }
  const rest = (src.slice(0, m.index) + src.slice(m.index + m[0].length)).trim()
  const update = { treated: null, stage: null, lists: {} }
  const keyOf = { feeling: 'how_i_feel', name: 'names', joke: 'running_jokes', rule: 'standing_rules' }
  for (const raw of m[1].split('\n')) {
    const l = LABEL_RE.exec(raw)
    if (!l) continue
    const label = l[1].toLowerCase()
    const value = l[2].replace(/^[\s*_"'“”‘’`]+|[\s*_"'“”‘’`]+$/g, '').trim()
    if (label === 'treated') {
      const v = value.toLowerCase().replace(/[^a-z]/g, '')
      update.treated = BOND_TREATED.includes(v) ? v : v === 'bad' ? 'badly' : update.treated
    } else if (label === 'stage') {
      const v = value.toLowerCase().replace(/[^a-z]/g, '')
      if (BOND_STAGES.includes(v)) update.stage = v
    } else {
      const key = keyOf[label]
      const cur = update.lists[key] ?? (update.lists[key] = [])
      if (NONE_RE.test(value) || !value) continue
      if (cur.length < BOND_MAX_ITEMS) cur.push(clip(value))
    }
  }
  return { update, rest }
}

/**
 * The new record from the old one (or null) and a parsed update. Pure.
 * Returns null when there is nothing to write (no update, or a first write
 * with no stage).
 */
export function mergeBond(old, update, now = Date.now()) {
  if (!update) return null
  const prev = old ? normalizeBond(old) : null
  const treated = update.treated ?? 'neutral'
  let stage
  if (!prev) {
    if (!update.stage) return null
    const cap = BOND_STAGES.indexOf(BOND_FIRST_MAX_STAGE)
    stage = BOND_STAGES[Math.min(BOND_STAGES.indexOf(update.stage), cap)]
  } else {
    const from = BOND_STAGES.indexOf(prev.stage)
    const want = update.stage ? BOND_STAGES.indexOf(update.stage) : from
    stage = BOND_STAGES[treated === 'warm' && want > from ? from + 1 : from]
  }
  const base = prev ?? { how_i_feel: [], names: [], running_jokes: [], standing_rules: [] }
  const L = update.lists ?? {}
  const feelingsAllowed = treated === 'warm' || (base.how_i_feel.length === 0 && treated !== 'badly')
  const keepOrReplace = (key) => (key in L ? list(L[key]) : base[key])
  return {
    v: 1,
    stage,
    how_i_feel: feelingsAllowed && 'how_i_feel' in L ? list(L.how_i_feel) : base.how_i_feel,
    names: keepOrReplace('names'),
    running_jokes: keepOrReplace('running_jokes'),
    standing_rules: keepOrReplace('standing_rules'),
    updates: (prev?.updates ?? 0) + 1,
    updated_at: new Date(now).toISOString(),
  }
}

/**
 * Parse, merge and write one update. Never throws. `validate` (main passes
 * the Zod schema check) runs on the merged record before it is written.
 * Outcomes: 'saved', 'missing' (the reply had no block), 'unchanged' (nothing
 * to write), 'invalid' (failed validation), 'failed' (I/O).
 * @returns {Promise<{outcome: string, stage: string|null, prevStage: string|null, treated: string|null}>}
 */
export async function saveBondUpdate(memoryDir, update, opts = {}) {
  const now = opts.now ?? Date.now()
  if (!update) return { outcome: 'missing', stage: null, prevStage: null, treated: null }
  try {
    const old = await readBond(memoryDir)
    const next = mergeBond(old, update, now)
    const res = { stage: next?.stage ?? old?.stage ?? null, prevStage: old?.stage ?? null, treated: update.treated ?? null }
    if (!next) return { outcome: 'unchanged', ...res }
    if (opts.validate && !opts.validate(next)) return { outcome: 'invalid', ...res }
    if (opts.mayWrite && !opts.mayWrite()) return { outcome: 'unchanged', ...res }
    await writeBond(memoryDir, next)
    return { outcome: 'saved', ...res }
  } catch {
    return { outcome: 'failed', stage: null, prevStage: null, treated: update.treated ?? null }
  }
}
