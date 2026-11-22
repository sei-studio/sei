// src/bot/brain/memory/compactor.test.js
//
// 261024: compaction output-cap safety. A segment sent whole could need a
// reply longer than the output cap; the cut-off reply was accepted (it had
// fewer lines) and every entry after the cut was lost. Pins:
//   - chunkEntries splits a segment into ordered, byte-bounded, even chunks.
//   - a reply that stopped at max_tokens is never written; its chunk keeps
//     its originals while the other chunks still compact.
//   - the bot defaults: 4096-token cap, 10 KB chunks, a 60 s floor on the
//     compaction timeout.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryCompactor, chunkEntries } from './compactor.js'

const HEADER = '# Memory\n\nAppend-only record. One line per entry. Written via remember(); removed via forget().\n\n'

const entry = (i) => `- [2026-08-${String(1 + (i % 28)).padStart(2, '0')}] note ${String(i).padStart(3, '0')} ${'z'.repeat(90)}`

let dir
let file
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sei-compactor-'))
  file = join(dir, 'MEMORY.md')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const entryLines = (content) => content.split('\n').filter((l) => l.startsWith('- ['))

describe('chunkEntries (261024)', () => {
  it('keeps a small segment as one chunk', () => {
    const e = [entry(0), entry(1)]
    expect(chunkEntries(e, 10_000)).toEqual([e])
    expect(chunkEntries([], 10_000)).toEqual([])
  })

  it('splits into ordered chunks under the byte limit, evenly sized', () => {
    const e = Array.from({ length: 300 }, (_, i) => entry(i))
    const chunks = chunkEntries(e, 10_240)
    expect(chunks.flat()).toEqual(e)
    const sizes = chunks.map((c) => c.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0))
    for (const s of sizes) expect(s).toBeLessThanOrEqual(10_240)
    // Even split: no sliver at the end.
    expect(Math.min(...sizes)).toBeGreaterThan(Math.max(...sizes) / 2)
  })

  it('puts an entry longer than the limit in its own chunk', () => {
    const big = `- [2026-08-01] ${'q'.repeat(500)}`
    const chunks = chunkEntries([entry(0), big, entry(1)], 200)
    expect(chunks.flat()).toEqual([entry(0), big, entry(1)])
    expect(chunks.some((c) => c.length === 1 && c[0] === big)).toBe(true)
  })
})

describe('compactor output-cap safety (261024)', () => {
  it('keeps the originals of a chunk whose reply hit max_tokens, compacts the rest', async () => {
    const entries = Array.from({ length: 250 }, (_, i) => entry(i))
    await writeFile(file, HEADER + '## World 1 â€” One\n' + entries.join('\n') + '\n', 'utf8')
    const calls = []
    const anthropic = {
      async call(req) {
        calls.push(req)
        if (calls.length === 1) return { text: '- [2026-08-02] partial list', stopReason: 'max_tokens' }
        return { text: `- [2026-08-09] merged chunk ${calls.length}`, stopReason: 'end_turn' }
      },
    }
    const compactor = createMemoryCompactor({
      anthropic,
      memoryLog: { path: file },
      config: { anthropic: { timeout_ms: 1000 }, memory: { compaction_trigger_bytes: 1 } },
      logger: { info() {}, warn() {} },
    })
    expect(await compactor.compactNow()).toBe(true)

    // 250 entries (~27 KB) is more than one 10 KB chunk at the bot defaults.
    expect(calls.length).toBeGreaterThan(1)
    const sent = calls.flatMap((c) => entryLines(c.messages[0].content))
    expect(sent).toEqual(entries)
    for (const c of calls) {
      expect(c.maxTokens).toBe(4096)
      expect(c.timeoutMs).toBe(60_000)
      expect(Buffer.byteLength(entryLines(c.messages[0].content).join('\n'))).toBeLessThanOrEqual(10_240)
    }

    const raw = await readFile(file, 'utf8')
    for (const l of entryLines(calls[0].messages[0].content)) expect(raw).toContain(l)
    expect(raw).not.toContain('partial list')
    expect(raw).toContain('merged chunk 2')
    expect(raw).toContain('## World 1 â€” One')
  })

  it('writes nothing when every reply hit max_tokens, and also honours stop_reason', async () => {
    const body = HEADER + Array.from({ length: 30 }, (_, i) => entry(i)).join('\n') + '\n'
    await writeFile(file, body, 'utf8')
    const anthropic = { async call() { return { text: '- [2026-08-02] partial', stop_reason: 'max_tokens' } } }
    const compactor = createMemoryCompactor({
      anthropic,
      memoryLog: { path: file },
      config: { anthropic: { timeout_ms: 1000 }, memory: { compaction_trigger_bytes: 1, compaction_chunk_bytes: 100_000 } },
      logger: { info() {}, warn() {} },
    })
    expect(await compactor.compactNow()).toBe(false)
    expect(await readFile(file, 'utf8')).toBe(body)
  })
})




