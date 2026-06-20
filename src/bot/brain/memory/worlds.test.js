// src/bot/brain/memory/worlds.test.js
//
// World-aware memory: a character accumulates memories across many LAN worlds,
// and must not conflate them. These tests pin the three subtle behaviors:
//   - memoryLog.noteWorld appends a `## World N` header, deduping a repeat of
//     the same trailing world, writing again when the world changes.
//   - readMemoryForSeed preserves world headers when it truncates by budget.
//   - the world registry assigns STABLE numbers per fingerprint and segments
//     MEMORY.md, and the compactor keeps headers + groups across compaction.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryLog, noteWorld, appendMemory, readMemoryForSeed } from './memoryLog.js'
import { createWorldRegistry } from './worlds.js'
import { createMemoryCompactor } from './compactor.js'

let dir
let file
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sei-worlds-'))
  file = join(dir, 'MEMORY.md')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('noteWorld section headers', () => {
  it('appends a header, dedupes the same trailing world, re-writes on change', async () => {
    await noteWorld(file, 1, 'Survival')
    await noteWorld(file, 1, 'Survival') // duplicate trailing world → no-op
    await appendMemory(file, 'built a house', '2026-06-17T00:00:00.000Z')
    await noteWorld(file, 2, 'Creative') // world changed → new header
    await noteWorld(file, 1, 'Survival') // back to world 1 → new header again

    const raw = await readFile(file, 'utf8')
    const headers = raw.match(/^## World \d+/gm) ?? []
    expect(headers).toEqual(['## World 1', '## World 2', '## World 1'])
    expect(raw).toContain('## World 1 — Survival')
    expect(raw).toContain('## World 2 — Creative')
  })
})

describe('readMemoryForSeed preserves world headers under truncation', () => {
  it('keeps every world marker plus the newest entries within budget', async () => {
    await noteWorld(file, 1, 'Alpha')
    for (let i = 0; i < 5; i++) {
      await appendMemory(file, `alpha memory number ${i} padding padding padding`, '2026-06-17T00:00:00.000Z')
    }
    await noteWorld(file, 2, 'Beta')
    await appendMemory(file, 'newest beta memory', '2026-06-17T01:00:00.000Z')

    // Tight budget forces truncation of the oldest entries.
    const seed = await readMemoryForSeed(file, 360)
    expect(Buffer.byteLength(seed, 'utf8')).toBeLessThanOrEqual(360 + 80) // marker slack
    // Both world headers survive even though older entries were dropped.
    expect(seed).toContain('## World 1 — Alpha')
    expect(seed).toContain('## World 2 — Beta')
    // The newest entry (beta) is kept; a truncation marker is present.
    expect(seed).toContain('newest beta memory')
    expect(seed).toContain('older memory truncated')
  })
})

describe('world registry', () => {
  it('assigns stable numbers per fingerprint and writes headers to MEMORY.md', async () => {
    const memoryLog = createMemoryLog({ path: file })
    const worldsPath = join(dir, 'worlds.json')
    const reg = createWorldRegistry({ worldsPath, memoryLog })

    const a = await reg.resolveOnSpawn({ fingerprint: 'overworld@10,64,-20', label: 'Home' })
    expect(a).toEqual({ num: 1, label: 'Home' })
    expect(reg.current()).toEqual({ num: 1, label: 'Home' })

    const b = await reg.resolveOnSpawn({ fingerprint: 'overworld@99,70,5', label: 'Far' })
    expect(b.num).toBe(2)

    // Re-resolving the FIRST world returns its original number (stable id).
    const a2 = await reg.resolveOnSpawn({ fingerprint: 'overworld@10,64,-20', label: 'Home' })
    expect(a2.num).toBe(1)

    const raw = await readFile(file, 'utf8')
    expect(raw).toContain('## World 1 — Home')
    expect(raw).toContain('## World 2 — Far')

    const registry = JSON.parse(await readFile(worldsPath, 'utf8'))
    expect(registry.worlds.map((w) => w.num)).toEqual([1, 2])
  })
})

describe('compactor preserves world segmentation', () => {
  it('keeps headers and compacts each world segment independently', async () => {
    // Two worlds, each with enough entries to trigger per-segment compaction.
    await noteWorld(file, 1, 'One')
    for (let i = 0; i < 5; i++) await appendMemory(file, `w1 entry ${i}`, '2026-06-17T00:00:00.000Z')
    await noteWorld(file, 2, 'Two')
    for (let i = 0; i < 5; i++) await appendMemory(file, `w2 entry ${i}`, '2026-06-17T01:00:00.000Z')

    // Fake Anthropic: returns a single compacted line per segment (shrinks 5→1).
    let calls = 0
    const anthropic = {
      call: async () => {
        calls += 1
        return { text: `- [2026-06-17] compacted segment ${calls}` }
      },
    }
    const memoryLog = createMemoryLog({ path: file })
    const compactor = createMemoryCompactor({
      anthropic,
      memoryLog,
      config: { anthropic: { timeout_ms: 1000 }, memory: { compaction_trigger_bytes: 1 } },
    })

    const ok = await compactor.compactNow()
    expect(ok).toBe(true)
    expect(calls).toBe(2) // one Haiku call per world-segment

    const raw = await readFile(file, 'utf8')
    // Both headers survive, in order, each followed by its compacted entry.
    expect(raw).toContain('## World 1 — One')
    expect(raw).toContain('## World 2 — Two')
    expect(raw.indexOf('## World 1')).toBeLessThan(raw.indexOf('## World 2'))
    expect(raw).toContain('compacted segment 1')
    expect(raw).toContain('compacted segment 2')
  })
})
