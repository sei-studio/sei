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
import { createMemoryLog, noteWorld, appendMemory, readMemoryForSeed, APP_SECTION_HEADER } from './memoryLog.js'
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
    await noteWorld(file, 1, 'Survival') // duplicate trailing world â†’ no-op
    await appendMemory(file, 'built a house', '2026-06-17T00:00:00.000Z')
    await noteWorld(file, 2, 'Creative') // world changed â†’ new header
    await noteWorld(file, 1, 'Survival') // back to world 1 â†’ new header again

    const raw = await readFile(file, 'utf8')
    const headers = raw.match(/^## World \d+/gm) ?? []
    expect(headers).toEqual(['## World 1', '## World 2', '## World 1'])
    expect(raw).toContain('## World 1 â€” Survival')
    expect(raw).toContain('## World 2 â€” Creative')
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
    expect(seed).toContain('## World 1 â€” Alpha')
    expect(seed).toContain('## World 2 â€” Beta')
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
    expect(raw).toContain('## World 1 â€” Home')
    expect(raw).toContain('## World 2 â€” Far')

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

    // Fake Anthropic: returns a single compacted line per segment (shrinks 5â†’1).
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
    expect(raw).toContain('## World 1 â€” One')
    expect(raw).toContain('## World 2 â€” Two')
    expect(raw.indexOf('## World 1')).toBeLessThan(raw.indexOf('## World 2'))
    expect(raw).toContain('compacted segment 1')
    expect(raw).toContain('compacted segment 2')
  })
})

// 261020: memories written outside a game (texting, calls, minigames) used to
// land under whichever game world came last, so a Minecraft build told over
// text sat under a Stardew farm's header and the next Stardew session took it
// for a Stardew task. They now get their own section, and world headers name
// their game.
describe('261020: the app section and game-named world headers', () => {
  it('a world header names its game, unless the label already does', async () => {
    await noteWorld(file, 1, 'Sei Farm', 'Stardew Valley')
    await noteWorld(file, 2, 'Stardew Valley farm', 'Stardew Valley')
    await noteWorld(file, 3, '', 'Minecraft')
    const raw = await readFile(file, 'utf8')
    expect(raw).toContain('## World 1 â€” Sei Farm (Stardew Valley)\n')
    expect(raw).toContain('## World 2 â€” Stardew Valley farm\n')
    expect(raw).toContain('## World 3 (Minecraft)\n')
  })

  it('an app memory after a world opens the app section once; the world header comes back on the next join', async () => {
    await noteWorld(file, 1, 'Sei Farm', 'Stardew Valley')
    await appendMemory(file, 'ouen likes the river by the farm', '2026-10-19T20:00:00.000Z')
    await appendMemory(file, "ouen's favorite block is copper bulb", '2026-10-19T22:57:00.000Z', { section: 'app' })
    await appendMemory(file, 'ouen needs 40 more copper bulbs', '2026-10-19T22:59:00.000Z', { section: 'app' })
    await noteWorld(file, 1, 'Sei Farm', 'Stardew Valley') // same world, but the last section is the app's
    await appendMemory(file, 'ouen planted parsnips with me', '2026-10-20T06:20:00.000Z')
    const raw = await readFile(file, 'utf8')
    const sections = raw.match(/^## .*$/gm)
    expect(sections).toEqual([
      '## World 1 â€” Sei Farm (Stardew Valley)',
      APP_SECTION_HEADER,
      '## World 1 â€” Sei Farm (Stardew Valley)',
    ])
    const appPart = raw.slice(raw.indexOf(APP_SECTION_HEADER), raw.lastIndexOf('## World 1'))
    expect(appPart).toContain('copper bulb')
    expect(appPart).not.toContain('river')
    expect(raw.slice(raw.lastIndexOf('## World 1'))).toContain('parsnips')
  })

  it('an app memory with no world section yet adds no header', async () => {
    await appendMemory(file, 'ouen draws bananas kinda cursed', '2026-08-01T00:07:00.000Z', { section: 'app' })
    expect(await readFile(file, 'utf8')).not.toMatch(/^## /m)
  })

  it('the duplicate guard looks only at the current section', async () => {
    await noteWorld(file, 1, 'Sei Farm', 'Stardew Valley')
    await appendMemory(file, 'ouen likes copper', '2026-10-19T22:57:00.000Z', { section: 'app' })
    expect(await appendMemory(file, 'ouen likes copper', '2026-10-19T22:58:00.000Z', { section: 'app' })).toBe(0)
    // Back in the world (its header written again), the same line is new to that section.
    await noteWorld(file, 1, 'Sei Farm', 'Stardew Valley')
    expect(await appendMemory(file, 'ouen likes copper', '2026-10-19T22:59:00.000Z')).toBe(1)
  })

  it('readMemoryForSeed keeps the app section header when it truncates', async () => {
    await noteWorld(file, 1, 'Sei Farm', 'Stardew Valley')
    for (let i = 0; i < 40; i++) await appendMemory(file, `farm note ${i} ${'x'.repeat(60)}`, new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString())
    await appendMemory(file, 'copper bulb lighthouse', '2026-10-19T22:57:00.000Z', { section: 'app' })
    const seed = await readMemoryForSeed(file, 1200)
    expect(seed).toContain('[...older memory truncated]')
    expect(seed).toContain('## World 1 â€” Sei Farm (Stardew Valley)')
    expect(seed).toContain(APP_SECTION_HEADER)
    expect(seed.indexOf(APP_SECTION_HEADER)).toBeLessThan(seed.indexOf('copper bulb lighthouse'))
  })

  it('the compactor keeps the app section as its own segment', async () => {
    const { splitWorldSegments } = await import('./compactor.js')
    const segs = splitWorldSegments(`# Memory\n\n- [a] pre\n## World 1 â€” Farm (Stardew Valley)\n- [b] farm\n${APP_SECTION_HEADER}\n- [c] chat\n`)
    expect(segs.map((s) => [s.marker, s.entries.length])).toEqual([
      [null, 1],
      ['## World 1 â€” Farm (Stardew Valley)', 1],
      [APP_SECTION_HEADER, 1],
    ])
  })

  it('the registry passes the game name into the header', async () => {
    const memoryLog = createMemoryLog({ path: file })
    const reg = createWorldRegistry({ worldsPath: join(dir, 'worlds.json'), memoryLog })
    await reg.resolveOnSpawn({ fingerprint: 'stardew:1', label: 'Sei Farm', game: 'Stardew Valley' })
    expect(await readFile(file, 'utf8')).toContain('## World 1 â€” Sei Farm (Stardew Valley)')
  })
})

// 261020 review: alternating a game and the app writes a world header and an
// app header every session. The seed reader paid nothing for headers and the
// compactor never sent a 1-2 entry segment to the model, so headers piled up
// without bound: after 120 sessions a 4000-byte seed came back 12.7 KB of
// headers with no entries, and compaction could not shrink the file.
describe('261020: repeated section headers stay bounded', () => {
  async function alternate(sessions) {
    let t = Date.UTC(2026, 9, 1)
    for (let day = 0; day < sessions; day++) {
      await noteWorld(file, 1, 'Sky Base', 'Minecraft')
      t += 3_600_000
      await appendMemory(file, `played on day ${day}`, new Date(t).toISOString())
      t += 3_600_000
      await appendMemory(file, `texted about day ${day}`, new Date(t).toISOString(), { section: 'app' })
    }
  }

  it('readMemoryForSeed pays for headers and keeps only those of kept entries plus the last', async () => {
    await alternate(120)
    const seed = await readMemoryForSeed(file, 4000)
    expect(Buffer.byteLength(seed, 'utf8')).toBeLessThanOrEqual(4000)
    expect(seed).toContain('texted about day 119')
    expect(seed).toContain('played on day 119')
    expect(seed.trimEnd().split('\n').some((l) => l === APP_SECTION_HEADER)).toBe(true)
    // Every kept entry still sits under its own section's header.
    const lines = seed.split('\n')
    let section = null
    for (const l of lines) {
      if (l.startsWith('## ')) section = l
      else if (l.startsWith('- [') && l.includes('texted about')) expect(section).toBe(APP_SECTION_HEADER)
      else if (l.startsWith('- [') && l.includes('played on')) expect(section).toMatch(/^## World 1/)
    }
  })

  it('readMemoryForSeed keeps the last header even when its section has no entries yet', async () => {
    await noteWorld(file, 1, 'Sky Base', 'Minecraft')
    for (let i = 0; i < 40; i++) await appendMemory(file, `old note ${i} ${'x'.repeat(60)}`, new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString())
    await noteWorld(file, 2, 'Sei Farm', 'Stardew Valley')
    const seed = await readMemoryForSeed(file, 1200)
    expect(seed.trimEnd().endsWith('## World 2 â€” Sei Farm (Stardew Valley)')).toBe(true)
    expect(seed).toContain('## World 1 â€” Sky Base (Minecraft)')
  })

  it('the compactor merges each section into one segment at its last place, upgrading old world headers', async () => {
    await noteWorld(file, 1, 'Sky Base') // an old, unlabeled header
    await appendMemory(file, 'old world note', '2026-09-01T00:00:00.000Z')
    await alternate(30)
    const anthropic = { call: async () => null } // the model fails: only the merge applies
    const compactor = createMemoryCompactor({
      anthropic,
      memoryLog: createMemoryLog({ path: file }),
      config: { anthropic: { timeout_ms: 1000 }, memory: { compaction_trigger_bytes: 1 } },
    })
    const before = (await readFile(file, 'utf8')).match(/^- \[.*$/gm)
    expect(await compactor.compactNow()).toBe(true)
    const raw = await readFile(file, 'utf8')
    expect(raw.match(/^## .*$/gm)).toEqual(['## World 1 â€” Sky Base (Minecraft)', APP_SECTION_HEADER])
    // Nothing lost or duplicated, and each entry is in its own section.
    const after = raw.match(/^- \[.*$/gm)
    expect([...after].sort()).toEqual([...before].sort())
    const appPart = raw.slice(raw.indexOf(APP_SECTION_HEADER))
    expect(appPart).not.toContain('played on')
    expect(appPart).toContain('texted about day 29')
    expect(raw.slice(0, raw.indexOf(APP_SECTION_HEADER))).toContain('old world note')
    // Within a section the entries keep their file order.
    expect(raw.indexOf('played on day 3\n')).toBeLessThan(raw.indexOf('played on day 4\n'))
  })

  it('a merged section that is not last and has no entries is dropped; the last is kept', async () => {
    const { coalesceSegments } = await import('./compactor.js')
    const segs = coalesceSegments([
      { marker: null, entries: [] },
      { marker: '## World 1 â€” A (Minecraft)', entries: [] },
      { marker: APP_SECTION_HEADER, entries: ['- [a] chat'] },
      { marker: '## World 2 â€” B (Stardew Valley)', entries: [] },
    ])
    expect(segs.map((s) => s.marker)).toEqual([APP_SECTION_HEADER, '## World 2 â€” B (Stardew Valley)'])
  })
})

describe('261020: a game session keeps its entries under its own world', () => {
  it('a bot write after an app section opened mid-session re-opens the world header first', async () => {
    const world = { num: 1, label: 'Sky Base', game: 'Minecraft' }
    await noteWorld(file, 1, 'Sky Base', 'Minecraft')
    await appendMemory(file, 'mined iron with ouen', '2026-10-20T10:00:00.000Z', { world })
    await appendMemory(file, 'ouen joined the group call', '2026-10-20T10:01:00.000Z', { section: 'app' })
    await appendMemory(file, 'built the furnace room', '2026-10-20T10:02:00.000Z', { world })
    await appendMemory(file, 'lit the furnace room', '2026-10-20T10:03:00.000Z', { world }) // already under it
    const raw = await readFile(file, 'utf8')
    expect(raw.match(/^## .*$/gm)).toEqual(['## World 1 â€” Sky Base (Minecraft)', APP_SECTION_HEADER, '## World 1 â€” Sky Base (Minecraft)'])
    const tail = raw.slice(raw.lastIndexOf('## World 1'))
    expect(tail).toContain('built the furnace room')
    expect(tail).toContain('lit the furnace room')
  })
})




