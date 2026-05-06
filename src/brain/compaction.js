/**
 * Compaction call dispatcher (Plan 3-03).
 *
 * Two entry points wired by sessionState (semantic-boundary triggered):
 *
 *   summarizeLoopBatch  — D-52 / MEM-02. Fired on Loop-terminal when D-51
 *                         cadence is satisfied (≥10 loops or ≥32 KB since
 *                         last DIARY write). Writes one diary entry.
 *
 *   consolidateOlderHalf — D-54 / MEM-04. Fired async on session-end (D-53)
 *                          when ≥4 sessions have passed OR diary file size
 *                          exceeds the cap. Rewrites the older 50% of
 *                          entries (min 5 newest kept untouched — Q5).
 *
 * Both calls reuse the orchestrator's `cachedSystemBlocks` reference (Pitfall
 * 4 / D-52: cache hit guarantee — ~zero marginal prefix cost). Both pass
 * `timeoutMs: config.anthropic.timeout_ms` (CLAUDE.md ADR #5: every external
 * call has a wall-clock timeout). Failures are non-fatal: summarize returns
 * null, consolidate returns false; counters are NOT reset on failure so the
 * next semantic boundary will retry.
 *
 * Q2 (chains.js) is irrelevant here — Loop owns its own lifecycle bounds.
 * Q5 split rule: keep = max(ceil(N/2), 5); when N ≤ 5, no-op.
 */

const SUMMARY_PROMPT_INTRO = 'You just finished a stretch of activity. In 2–4 sentences, write a diary entry summarizing what happened from your perspective — who you were with, what you did, how it felt.'
const SUMMARY_PROMPT_FORMAT = 'Plain markdown, no headings, no metadata.'
const CONSOLIDATE_PROMPT_INTRO = 'These are diary entries you wrote earlier. Compress them into a single denser narrative paragraph that preserves names, accomplishments, and any recurring themes. Drop minor day-to-day details.'
const CONSOLIDATE_PROMPT_FORMAT = 'Plain markdown, no headings.'

/**
 * Render a Loop._internal.messages-shaped batch as plain text for the
 * summary prompt. Rules (locked in plan <interfaces>):
 *   - assistant: text blocks joined; tool_use rendered as `(action: NAME)`.
 *   - user: text blocks where name='event' rendered as `[event] ...`;
 *           tool_result rendered as `[result] ...`.
 *           Snapshot blocks are skipped (too noisy).
 */
function serializeMessagesForPrompt(batch) {
  if (!Array.isArray(batch) || batch.length === 0) return '(no recent activity captured)'
  const lines = []
  for (const msg of batch) {
    if (!msg || !Array.isArray(msg.content)) continue
    if (msg.role === 'assistant') {
      const textParts = []
      for (const blk of msg.content) {
        if (!blk) continue
        if (blk.type === 'text' && typeof blk.text === 'string') {
          textParts.push(blk.text)
        } else if (blk.type === 'tool_use' && blk.name) {
          textParts.push(`(action: ${blk.name})`)
        }
      }
      const joined = textParts.join(' ').trim()
      if (joined) lines.push(`[sei] ${joined}`)
    } else if (msg.role === 'user') {
      for (const blk of msg.content) {
        if (!blk) continue
        if (blk.type === 'text') {
          const name = blk.name
          const text = typeof blk.text === 'string' ? blk.text : ''
          if (name === 'snapshot') continue // skip — too noisy
          if (name === 'event' && text) lines.push(`[event] ${text}`)
          else if (text) lines.push(text)
        } else if (blk.type === 'tool_result') {
          const c = blk.content
          const s = typeof c === 'string' ? c : (Array.isArray(c) ? c.map(b => (b && b.text) ?? '').join(' ') : '')
          if (s) lines.push(`[result] ${s}`)
        }
      }
    }
  }
  return lines.length ? lines.join('\n') : '(no recent activity captured)'
}

/**
 * Derive a topic line from the LLM's free-form summary text:
 *   - first ≤6 whitespace-separated words
 *   - lowercased
 *   - leading/trailing punctuation stripped
 *   - capped at 60 chars (defensive — DIARY heading further truncates to 6 words)
 */
function deriveTopic(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return 'untitled'
  const words = trimmed.split(/\s+/).slice(0, 6)
  let topic = words.join(' ').toLowerCase()
  // Strip leading punctuation
  topic = topic.replace(/^[\p{P}\s]+/u, '')
  // Strip trailing punctuation
  topic = topic.replace(/[\p{P}\s]+$/u, '')
  if (topic.length > 60) topic = topic.slice(0, 60)
  return topic || 'untitled'
}

/**
 * Extract YYYY-MM-DD from a diary heading line `## YYYY-MM-DD HH:MM — topic`.
 * Returns null if it does not match.
 */
function dateIsoFromHeading(headingLine) {
  if (typeof headingLine !== 'string') return null
  const m = /^##\s+(\d{4}-\d{2}-\d{2})\b/.exec(headingLine)
  return m ? m[1] : null
}

/**
 * @param {Object} opts
 * @param {{call: Function}} opts.anthropic
 * @param {Array} opts.cachedSystemBlocks   — SAME reference the orchestrator
 *   uses for personality calls. Pitfall 4: must be passed by identity.
 * @param {Object} opts.diary               — createDiary() instance
 * @param {Object} opts.config              — { anthropic: {timeout_ms}, ... }
 * @param {{info?:Function,warn?:Function,error?:Function}} [opts.logger]
 */
export function createCompactor({ anthropic, cachedSystemBlocks, diary, config, logger = console } = {}) {
  if (!anthropic) throw new Error('createCompactor: anthropic required')
  if (!cachedSystemBlocks) throw new Error('createCompactor: cachedSystemBlocks required')
  if (!diary) throw new Error('createCompactor: diary required')
  if (!config?.anthropic?.timeout_ms) throw new Error('createCompactor: config.anthropic.timeout_ms required')

  const TIMEOUT_MS = config.anthropic.timeout_ms

  async function summarizeLoopBatch({ loopMessagesBatch, when = new Date(), signal } = {}) {
    try {
      const serialized = serializeMessagesForPrompt(loopMessagesBatch)
      const promptBody = [
        SUMMARY_PROMPT_INTRO,
        SUMMARY_PROMPT_FORMAT,
        '',
        '--- Recent activity ---',
        serialized,
      ].join('\n')
      const resp = await anthropic.call({
        systemBlocks: cachedSystemBlocks,
        tools: [],
        messages: [{ role: 'user', content: promptBody }],
        signal,
        timeoutMs: TIMEOUT_MS,
      })
      const text = (resp?.content?.find?.(b => b && b.type === 'text')?.text
                  ?? resp?.text
                  ?? '').trim()
      if (!text) {
        logger.warn?.('[sei/compact] empty summary; skipping diary append')
        return null
      }
      const topic = deriveTopic(text)
      await diary.appendEntry({ topic, body: text, when })
      logger.info?.(`[sei/compact] diary entry written: ${topic}`)
      return { topic, body: text }
    } catch (err) {
      logger.warn?.(`[sei/compact] summarize failed: ${err.message}`)
      return null
    }
  }

  async function consolidateOlderHalf({ signal } = {}) {
    let entries
    try {
      entries = await diary.readAll()
    } catch (err) {
      logger.warn?.(`[sei/compact] consolidate readAll failed: ${err.message}`)
      return false
    }
    // Q5: split at max(ceil(N/2), 5) — min 5 entries always kept untouched at top
    const keep = Math.max(Math.ceil(entries.length / 2), 5)
    if (entries.length <= keep) {
      logger.info?.(`[sei/compact] consolidate skip: ${entries.length} entries ≤ keep threshold ${keep}`)
      return false
    }
    const older = entries.slice(keep)
    try {
      const olderSerialized = older
        .map(e => `${e.headingLine}\n${e.body}`)
        .join('\n\n')
      const promptBody = [
        CONSOLIDATE_PROMPT_INTRO,
        CONSOLIDATE_PROMPT_FORMAT,
        '',
        '--- Older entries ---',
        olderSerialized,
      ].join('\n')
      const resp = await anthropic.call({
        systemBlocks: cachedSystemBlocks,
        tools: [],
        messages: [{ role: 'user', content: promptBody }],
        signal,
        timeoutMs: TIMEOUT_MS,
      })
      const dense = (resp?.content?.find?.(b => b && b.type === 'text')?.text
                  ?? resp?.text
                  ?? '').trim()
      if (!dense) {
        logger.warn?.('[sei/compact] empty consolidation; skipping rewrite')
        return false
      }
      // "consolidated through" date: the boundary date — derived from the
      // last entry of `older` (the oldest in the older slice when the diary
      // is newest-first). Falls back to today if the heading lacks a date.
      const boundary = older[older.length - 1]
      const through = dateIsoFromHeading(boundary?.headingLine)
                   ?? new Date().toISOString().slice(0, 10)
      const replacement = `## Earlier (consolidated through ${through})\n${dense}\n`
      await diary.replaceOlderHalf(replacement)
      logger.info?.(`[sei/compact] consolidation written; older=${older.length} kept=${keep}`)
      return true
    } catch (err) {
      logger.warn?.(`[sei/compact] consolidation failed: ${err.message}`)
      return false
    }
  }

  return { summarizeLoopBatch, consolidateOlderHalf }
}
