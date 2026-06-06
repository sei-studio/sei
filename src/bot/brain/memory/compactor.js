// MEMORY.md compactor.
//
// Triggered after a successful remember() when the on-disk file exceeds
// `compaction_trigger_bytes`. Reads the full file, asks Haiku to compress
// the entries while preserving emotional and objective detail, and
// atomically replaces the file with the compacted body.
//
// Single-flight: at most one compaction is in flight at a time. Failures
// are non-fatal — the file is left untouched and the next remember() will
// re-attempt the trigger check.
//
// The compaction call does NOT share the personality cached system blocks;
// it uses a small bespoke system prompt so the prompt cache for the main
// loop is unaffected.

import { readFile } from 'node:fs/promises'
import { atomicWrite } from '../storage/atomicWrite.js'
import { withFileLock } from '../storage/fileLock.js'

const HEADER =
  '# Memory\n' +
  '\n' +
  'Append-only record. One line per entry. Written via remember(); removed via forget().\n' +
  '\n'

const COMPACTION_SYSTEM = [
  'You are compacting a bot\'s long-term memory file (MEMORY.md). The bot will read this file cold at the start of future sessions and use it to understand its relationship with the player, how the player talks, and what to do next in the world.',
  '',
  'Keep:',
  '- Emotional arc across entries — if entries show a relationship shifting (e.g. hostile → warm, distant → close, formal → casual), the condensed version MUST still show that shift. Long-time relationship development depends on the emotional arc surviving compaction; flattening it into a single steady-state summary is forbidden. When in doubt, preserve the trajectory at the cost of literal detail.',
  '- Specific things the player said, quoted or near-quoted: praise, complaints, jokes, insults, stated preferences, names, "from now on" rules, requests.',
  '- Specific things the player did that the bot observed.',
  '- Objective world progress: builds completed, resources stockpiled, base location, milestones reached.',
  '- Recurring patterns: what the player tends to ask for, what frustrates them, how decisions usually go.',
  '',
  'Drop:',
  '- Generic Minecraft facts.',
  '- Routine state: inventory counts, coordinates, biome, time of day, whether the player was nearby.',
  '- The bot\'s own reasoning or inner thoughts.',
  '- Self-attributed preferences the player did not confirm.',
  '- Duplicates and near-duplicates of other entries.',
  '',
  'Output format: one entry per line. Each line is `- [YYYY-MM-DD] <text>`. Use the date from the original entry where present; if multiple entries collapse into one, use the most recent date among them. Keep entries terse and specific. Quote the player verbatim where the wording matters. Target roughly half the input size; fewer lines is better if many entries are noise. Output the lines only — no headers, no commentary, no markdown other than the list bullets.',
].join('\n')

/**
 * @param {Object} opts
 * @param {{call: Function}} opts.anthropic     Anthropic client (createAnthropicClient instance).
 * @param {Object} opts.memoryLog               createMemoryLog() instance — used for .path only.
 * @param {Object} opts.config                  Validated config. Reads memory.compaction_trigger_bytes and anthropic.timeout_ms.
 * @param {{info?:Function,warn?:Function,error?:Function,debug?:Function}} [opts.logger]
 */
export function createMemoryCompactor({ anthropic, memoryLog, config, logger = console } = {}) {
  if (!anthropic) throw new Error('createMemoryCompactor: anthropic required')
  if (!memoryLog?.path) throw new Error('createMemoryCompactor: memoryLog with .path required')
  if (!config?.anthropic?.timeout_ms) throw new Error('createMemoryCompactor: config.anthropic.timeout_ms required')

  const filePath = memoryLog.path
  const triggerBytes = config?.memory?.compaction_trigger_bytes ?? 4096
  const timeoutMs = config.anthropic.timeout_ms

  let inFlight = false

  async function compactNow() {
    let raw
    try {
      raw = await readFile(filePath, 'utf8')
    } catch (err) {
      if (err && err.code === 'ENOENT') return false
      logger.warn?.(`[sei/compact] readFile failed: ${err.message}`)
      return false
    }

    const lines = raw.split('\n')
    const entries = lines.filter(l => /^- \[/.test(l))
    if (entries.length < 4) return false

    const prompt = [
      'Compact the following memory entries per the rules in the system message.',
      '',
      '--- Current MEMORY.md entries ---',
      entries.join('\n'),
    ].join('\n')

    let resp
    try {
      resp = await anthropic.call({
        systemBlocks: [{ type: 'text', text: COMPACTION_SYSTEM }],
        tools: [],
        messages: [{ role: 'user', content: prompt }],
        timeoutMs,
        maxTokens: 1024,
      })
    } catch (err) {
      logger.warn?.(`[sei/compact] anthropic call failed: ${err.message}`)
      return false
    }

    const text = (resp?.text ?? '').trim()
    if (!text) {
      logger.warn?.('[sei/compact] empty response, leaving MEMORY.md untouched')
      return false
    }

    const compactedEntries = text
      .split('\n')
      .map(l => l.trim())
      .filter(l => /^- \[/.test(l))

    if (compactedEntries.length === 0) {
      logger.warn?.('[sei/compact] response had no valid entry lines, leaving MEMORY.md untouched')
      return false
    }

    const newBody = HEADER + compactedEntries.join('\n') + '\n'
    try {
      await withFileLock(filePath, async () => {
        await atomicWrite(filePath, newBody)
      })
    } catch (err) {
      logger.warn?.(`[sei/compact] write failed: ${err.message}`)
      return false
    }

    const beforeBytes = Buffer.byteLength(raw, 'utf8')
    const afterBytes = Buffer.byteLength(newBody, 'utf8')
    logger.info?.(`[sei/compact] MEMORY.md compacted: ${entries.length} → ${compactedEntries.length} entries, ${beforeBytes} → ${afterBytes} bytes`)
    return true
  }

  async function maybeCompact() {
    if (inFlight) return false
    let size = 0
    try {
      const raw = await readFile(filePath, 'utf8')
      size = Buffer.byteLength(raw, 'utf8')
    } catch (err) {
      if (err && err.code === 'ENOENT') return false
      logger.warn?.(`[sei/compact] size check failed: ${err.message}`)
      return false
    }
    if (size < triggerBytes) return false
    inFlight = true
    try {
      return await compactNow()
    } finally {
      inFlight = false
    }
  }

  return {
    maybeCompact,
    compactNow,
    get inFlight() { return inFlight },
    get triggerBytes() { return triggerBytes },
  }
}
