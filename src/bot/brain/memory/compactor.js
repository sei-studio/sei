// MEMORY.md compactor.
//
// Triggered after a successful remember() when the on-disk file exceeds
// `compaction_trigger_bytes`. Reads the full file, asks the latest Sonnet
// (260703; per-call model override â€” the main loop stays on Haiku) to
// compress the entries in the being's own voice while preserving emotional
// and objective detail, and atomically replaces the file with the compacted
// body â€” unless the file changed while the LLM call was in flight, in which
// case the pass is discarded (lost-update guard).
//
// Single-flight: at most one compaction is in flight at a time. Failures
// are non-fatal â€” the file is left untouched and the next remember() will
// re-attempt the trigger check. A pass that could not shrink anything sets a
// plateau backoff so subsequent remember()s don't re-pay futile LLM calls
// until the file has actually grown.
//
// The compaction call does NOT share the personality cached system blocks;
// it uses a small bespoke system prompt so the prompt cache for the main
// loop is unaffected.

import { readFile } from 'node:fs/promises'
import { atomicWrite } from '../storage/atomicWrite.js'
import { withFileLock } from '../storage/fileLock.js'
// Compaction instruction lives in the single editable prompt document.
import { COMPACTION_SYSTEM } from '../promptLibrary.js'
import { fillPersonaPlaceholders } from '../personaPlaceholders.js'

const HEADER =
  '# Memory\n' +
  '\n' +
  'Append-only record. One line per entry. Written via remember(); removed via forget().\n' +
  '\n'

/**
 * Noise robustness (260810). remember() is offered on every surface, and the
 * screen-watching surface proved it can flood the file with the same
 * speculative screen reading re-filed dozens of times in minutes (the 260808
 * feedback-loop incident: ~30 near-identical guesses about what the player was
 * doing on a shared screen in 14 minutes, drowning the real person-facts).
 * This clause is appended to COMPACTION_SYSTEM on BOTH compaction surfaces
 * (the bot's and the chat-side compactor in src/main/chat/memoryCompaction.ts).
 * Deliberately prose that NAMES THE SHAPE and never quotes an example noise
 * line â€” quoting a phrase inside a ban has been measured (backseat 260807) to
 * FEED that phrase back into outputs.
 */
export const MEMORY_NOISE_GUARD = [
  'Noise guard â€” durable person-facts outrank screen observations:',
  '- Some entries are not memories of the player at all: guesses written while watching a screen the player was sharing, narration of background media, or the same speculative observation re-filed many times in a short span with slightly different wording.',
  '- Treat a long run of near-identical entries written minutes apart as ONE observation. Compress it to at most one short line framed as a guess about what was on screen, or drop it entirely when it says nothing about the player as a person.',
  '- Things the player actually said (their name and its spelling, corrections, stated preferences, standing requests, relationship beats) must survive intact. They are never displaced, reworded away, or contradicted by screen-derived guesses, no matter how many screen entries repeat the guess.',
  '- When a screen-derived entry conflicts with something the player said directly, keep what the player said. When in doubt between an older established entry and newer repetitive observations, keep the older entry.',
].join('\n')

/**
 * Split a raw MEMORY.md body into world segments: [{marker, entries}], where
 * segment 0 (marker null) holds any pre-header entries and each `## World N`
 * header opens a new segment. Pure; exported so the offline eval harness
 * (scripts/fold-noise-eval.ts) exercises the exact same segmentation the
 * compactor uses instead of a re-implementation.
 */
export function splitWorldSegments(raw) {
  const lines = String(raw ?? '').split('\n')
  const segments = []
  let cur = { marker: null, entries: [] }
  for (const l of lines) {
    // 261020: every `## ` section (worlds and the app section) opens one.
    if (/^## /.test(l)) {
      segments.push(cur)
      cur = { marker: l, entries: [] }
    } else if (/^- \[/.test(l)) {
      cur.entries.push(l)
    }
  }
  segments.push(cur)
  return segments
}

/** The identity of a section: `world:N` for a world header (its label may change), else the header line. */
function sectionKey(marker) {
  if (marker === null) return null
  const w = /^## World (\d+)\b/.exec(marker)
  return w ? `world:${w[1]}` : marker
}

/**
 * 261020: one segment per section. Since app-side writers open the app
 * section and a game session re-opens its world header after it, a player who
 * alternates a game and texting gets a new pair of headers every session, each
 * holding a line or two. Segments under COMPACT_SEGMENT_MIN entries are never
 * sent to the model, so without this the file could not shrink at all and the
 * headers piled up without bound. Every occurrence of a section is gathered at
 * its LAST position (so the file still ends in the section new entries are
 * filed under), in file order, under the newest header line (an old unlabeled
 * `## World 1 â€” Base` becomes `## World 1 â€” Base (Minecraft)`). A section left
 * with no entries is dropped, except the last one. Pure.
 */
export function coalesceSegments(segments) {
  const lastIdx = new Map()
  segments.forEach((s, i) => lastIdx.set(sectionKey(s.marker), i))
  const gathered = new Map()
  const out = []
  segments.forEach((s, i) => {
    const key = sectionKey(s.marker)
    const acc = gathered.get(key) ?? []
    acc.push(...s.entries)
    gathered.set(key, acc)
    if (lastIdx.get(key) === i) out.push({ marker: s.marker, entries: acc })
  })
  return out.filter((s, i) => s.entries.length > 0 || i === out.length - 1)
}

/**
 * 261024: split one segment's entries into chronological chunks of at most
 * `maxBytes` of entry text each, sized evenly so the last chunk is not a
 * sliver. Each chunk is one compaction call, so its reply (even a nearly
 * verbatim one, plus Sonnet's own thinking) must fit the output cap: before
 * this a large segment went out whole, the reply hit max_tokens, and the
 * entries after the cut were lost. A single entry longer than `maxBytes`
 * becomes its own chunk. Order is kept. Pure; exported for tests.
 *
 * @param {string[]} entries
 * @param {number} maxBytes
 * @returns {string[][]}
 */
export function chunkEntries(entries, maxBytes) {
  const size = (l) => Buffer.byteLength(l, 'utf8') + 1
  const total = entries.reduce((n, l) => n + size(l), 0)
  if (!(maxBytes > 0) || total <= maxBytes) return entries.length ? [entries] : []
  const target = total / Math.ceil(total / maxBytes)
  const chunks = []
  let cur = []
  let curBytes = 0
  for (const l of entries) {
    const b = size(l)
    if (cur.length && (curBytes + b > maxBytes || curBytes >= target)) {
      chunks.push(cur)
      cur = []
      curBytes = 0
    }
    cur.push(l)
    curBytes += b
  }
  if (cur.length) chunks.push(cur)
  return chunks
}

/**
 * @param {Object} opts
 * @param {{call: Function}} opts.anthropic     Anthropic client (createAnthropicClient instance).
 * @param {Object} opts.memoryLog               createMemoryLog() instance â€” used for .path only.
 * @param {Object} opts.config                  Validated config. Reads memory.compaction_trigger_bytes and anthropic.timeout_ms,
 *                                              plus the optional memory.compaction_max_tokens, compaction_chunk_bytes and
 *                                              compaction_timeout_ms knobs.
 * @param {{info?:Function,warn?:Function,error?:Function,debug?:Function}} [opts.logger]
 */
export function createMemoryCompactor({ anthropic, memoryLog, config, logger = console } = {}) {
  if (!anthropic) throw new Error('createMemoryCompactor: anthropic required')
  if (!memoryLog?.path) throw new Error('createMemoryCompactor: memoryLog with .path required')
  if (!config?.anthropic?.timeout_ms) throw new Error('createMemoryCompactor: config.anthropic.timeout_ms required')

  const filePath = memoryLog.path
  const triggerBytes = config?.memory?.compaction_trigger_bytes ?? 4096
  // 261024: compaction runs fire-and-forget after remember(), so it gets at
  // least a minute instead of the turn timeout (the bot's is 12 s, and a
  // Sonnet compaction of an 8 KB file took 5-11 s even in small chunks).
  const timeoutMs = config?.memory?.compaction_timeout_ms ?? Math.max(config.anthropic.timeout_ms, 60_000)
  // 260810: output budget; the chat-side compactor (memoryCompaction.ts)
  // passes its own. 261024: the bot default was 1024, but Sonnet 5 thinks by
  // default and the thinking counts against this cap: in a measured run on
  // 8.6 KB files, 3 of 12 calls stopped at 1024 (two spent all 1023 tokens
  // thinking). Such a cut-off reply used to be written as the whole chunk,
  // losing the entries after the cut. Unused headroom costs nothing.
  const maxTokens = config?.memory?.compaction_max_tokens ?? 4096
  // 261024: most entry text sent in one call (see chunkEntries). 10 KB keeps a
  // normal 8 KB bot file to one call and its reply, thinking included, well
  // inside the cap.
  const chunkBytes = config?.memory?.compaction_chunk_bytes ?? 10_240

  let inFlight = false

  // Plateau guard (260703): when a full pass could not shrink the file, the
  // size stays over triggerBytes and â€” without this â€” EVERY later remember()
  // would burn another round of futile compaction calls (the same per-message
  // thrash the chat-surface fold had). Remember the size the plateau happened
  // at and only retry once the file has grown meaningfully past it.
  let futileAtBytes = null
  const PLATEAU_REGROW_BYTES = 1024

  // Latest Sonnet for compaction (260703) â€” parity with the chat surface's
  // summary fold: it runs rarely and its output is re-read by every future
  // session, so quality compounds. Per-call override; the main loop stays on
  // the configured (Haiku) model. Cloud-proxy note: the proxy's PRICING table
  // must know this model id.
  const COMPACTION_MODEL = 'claude-sonnet-5'

  // The being's persona, appended to the compaction system prompt so the
  // compacted entries keep the character's own voice (they are read back as
  // "your own past notes" on both surfaces).
  // 261013: card {{user}}/{{char}} placeholders filled the same way as the
  // persona block, so compacted notes never copy the literal braces.
  const personaExpanded = (typeof config?.persona?.expanded === 'string' && config.persona.expanded.trim())
    ? fillPersonaPlaceholders(config.persona.expanded.trim(), {
        charName: config.persona.name,
        userName: config.player_display_name,
      })
    : null
  // 260810: the noise guard rides on both surfaces (see MEMORY_NOISE_GUARD).
  const baseSystem = `${COMPACTION_SYSTEM}\n\n${MEMORY_NOISE_GUARD}`
  const systemText = personaExpanded
    ? `${baseSystem}\n\nThe being's persona â€” write the compacted entries in this voice:\n${personaExpanded}`
    : baseSystem

  // Minimum entries in a single world-segment before we spend an LLM call on
  // it; smaller segments are kept verbatim (not worth a round-trip, and they
  // hold little redundancy to squeeze).
  const COMPACT_SEGMENT_MIN = 4

  // One LLM round-trip compacting a list of entry lines. Returns the compacted
  // entry lines, or null on any failure (caller keeps the originals).
  async function compactEntries(entries) {
    const prompt = [
      'Compact the following memory entries per the rules in the system message.',
      '',
      '--- Current MEMORY.md entries ---',
      entries.join('\n'),
    ].join('\n')

    let resp
    try {
      resp = await anthropic.call({
        systemBlocks: [{ type: 'text', text: systemText }],
        tools: [],
        messages: [{ role: 'user', content: prompt }],
        timeoutMs,
        maxTokens,
        model: COMPACTION_MODEL,
      })
    } catch (err) {
      logger.warn?.(`[sei/compact] anthropic call failed: ${err.message}`)
      return null
    }

    // 261024: a reply cut off at the output cap is a partial list. Taking it
    // would replace the whole chunk and drop every entry after the cut, so
    // the originals are kept instead.
    if ((resp?.stopReason ?? resp?.stop_reason) === 'max_tokens') {
      logger.warn?.(`[sei/compact] reply hit max_tokens (${maxTokens}) on ${entries.length} entries, keeping them as they are`)
      return null
    }
    const text = (resp?.text ?? '').trim()
    if (!text) return null
    const compacted = text
      .split('\n')
      .map(l => l.trim())
      .filter(l => /^- \[/.test(l))
    return compacted.length ? compacted : null
  }

  async function compactNow() {
    let raw
    try {
      raw = await readFile(filePath, 'utf8')
    } catch (err) {
      if (err && err.code === 'ENOENT') return false
      logger.warn?.(`[sei/compact] readFile failed: ${err.message}`)
      return false
    }

    // Split into world-segments so the `## World <n>` headers survive
    // compaction and each world's entries stay grouped. Segment 0 (marker null)
    // holds any pre-header entries. Each segment's entries are compacted
    // independently; the headers are re-emitted verbatim between them.
    const split = splitWorldSegments(raw)
    // 261020: repeated headers of one section are merged first (see
    // coalesceSegments); that alone is a change worth writing.
    const segments = coalesceSegments(split)
    const markerCount = (segs) => segs.filter((s) => s.marker !== null).length

    const totalEntries = segments.reduce((s, seg) => s + seg.entries.length, 0)
    if (totalEntries < 4) return false

    let changed = markerCount(segments) < markerCount(split)
    let totalAfter = 0
    const outParts = []
    for (const seg of segments) {
      const entries = []
      // 261024: a large segment goes out in chunks so every reply fits the
      // output cap; a chunk that fails or does not shrink keeps its originals.
      for (const chunk of chunkEntries(seg.entries, chunkBytes)) {
        if (chunk.length >= COMPACT_SEGMENT_MIN) {
          const compacted = await compactEntries(chunk)
          if (compacted && compacted.length < chunk.length) {
            entries.push(...compacted)
            changed = true
            continue
          }
        }
        entries.push(...chunk)
      }
      totalAfter += entries.length
      if (seg.marker) outParts.push(seg.marker)
      if (entries.length) outParts.push(entries.join('\n'))
    }

    const beforeBytes = Buffer.byteLength(raw, 'utf8')
    if (!changed) {
      // Plateau: this content cannot be squeezed further. Back off until the
      // file grows meaningfully, or every remember() re-pays these LLM calls.
      futileAtBytes = beforeBytes
      logger.warn?.('[sei/compact] nothing to compact (no segment shrank), leaving MEMORY.md untouched')
      return false
    }

    const newBody = HEADER + outParts.join('\n') + '\n'
    try {
      let drifted = false
      await withFileLock(filePath, async () => {
        // Lost-update guard (260703): remember()/forget()/noteWorld may have
        // written while the compaction LLM calls were in flight. newBody was
        // derived from the pre-call snapshot, so writing it blindly would
        // silently clobber those entries. Re-read under the lock and discard
        // this pass on any drift â€” the next remember() re-triggers against
        // the fresh content.
        const current = await readFile(filePath, 'utf8').catch(() => null)
        if (current !== raw) {
          drifted = true
          return
        }
        await atomicWrite(filePath, newBody)
      })
      if (drifted) {
        logger.warn?.('[sei/compact] MEMORY.md changed while compacting â€” discarding this pass')
        return false
      }
    } catch (err) {
      logger.warn?.(`[sei/compact] write failed: ${err.message}`)
      return false
    }

    futileAtBytes = null // shrank â€” clear any plateau backoff
    const afterBytes = Buffer.byteLength(newBody, 'utf8')
    logger.info?.(`[sei/compact] MEMORY.md compacted: ${totalEntries} â†’ ${totalAfter} entries across ${segments.length} world-segment(s), ${beforeBytes} â†’ ${afterBytes} bytes`)
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
    // Plateau backoff: a prior pass at this size couldn't shrink anything;
    // skip until the file has actually grown past it.
    if (futileAtBytes != null && size < futileAtBytes + PLATEAU_REGROW_BYTES) return false
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




