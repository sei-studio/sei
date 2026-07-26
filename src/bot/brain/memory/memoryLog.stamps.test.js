// src/bot/brain/memory/memoryLog.stamps.test.js
//
// Model-facing stamp humanization (260725). MEMORY.md stores UTC ISO stamps;
// the model reads local-time stamps in the same format as the prompt clock so
// it can judge "how long ago" (live capture: a two-week-old note read as
// days-old) and so day boundaries match the player's timezone. These tests pin:
//   - ISO entry stamps render as local "D Mon YYYY, HH:MM" at read time
//   - non-entry bracket lines (truncation marker, world headers) pass through
//   - readMemoryForSeed output is humanized on both the under-budget and
//     truncated paths, while the file on disk keeps ISO.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendMemory, readMemoryForSeed, humanizeMemoryStamps, forgetMemory } from './memoryLog.js'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Expected local rendering of an ISO instant, computed with the same Date
// APIs so the test is timezone-independent.
function localStamp(iso) {
  const d = new Date(iso)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${hh}:${mm}`
}

describe('humanizeMemoryStamps', () => {
  it('renders ISO entry stamps as local date-time', () => {
    const iso = '2026-07-11T09:23:45.123Z'
    const out = humanizeMemoryStamps(`- [${iso}] they are packing for LA\n`)
    expect(out).toBe(`- [${localStamp(iso)}] they are packing for LA\n`)
  })

  it('leaves the truncation marker, world headers, and non-ISO brackets alone', () => {
    const doc =
      '# Memory\n' +
      '- [...older memory truncated]\n' +
      '## World 2 — plains village\n' +
      '- [not-a-date] odd line survives verbatim\n'
    expect(humanizeMemoryStamps(doc)).toBe(doc)
  })

  it('only rewrites stamps at the start of an entry line', () => {
    const iso = '2026-07-11T09:23:45.123Z'
    const inline = `- [${iso}] the player quoted "[${iso}]" back at me\n`
    const out = humanizeMemoryStamps(inline)
    expect(out.startsWith(`- [${localStamp(iso)}]`)).toBe(true)
    expect(out).toContain(`"[${iso}]"`) // quoted ISO in the body untouched
  })
})

describe('readMemoryForSeed humanization', () => {
  let dir, file
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sei-mem-'))
    file = join(dir, 'MEMORY.md')
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('humanizes the under-budget path and keeps ISO on disk', async () => {
    const iso = '2026-07-11T09:23:45.000Z'
    await appendMemory(file, 'they are packing for LA', iso)
    const seed = await readMemoryForSeed(file, 1024 * 1024)
    expect(seed).toContain(`- [${localStamp(iso)}] they are packing for LA`)
    expect(seed).not.toContain(iso)
    expect(await readFile(file, 'utf8')).toContain(`- [${iso}]`)
  })

  it('humanizes the truncated path too', async () => {
    for (let i = 0; i < 40; i++) {
      await appendMemory(file, `note number ${i} with some padding text`, '2026-07-11T09:23:45.000Z')
    }
    const seed = await readMemoryForSeed(file, 600)
    expect(seed).toContain('- [...older memory truncated]')
    expect(seed).toContain(`- [${localStamp('2026-07-11T09:23:45.000Z')}]`)
    expect(seed).not.toContain('2026-07-11T')
  })
})

// The model only ever sees the humanized rendering, so forget() has to match
// the entry AS SHOWN — quoting the line back, bracketed stamp and all, used to
// match nothing at all (the stamp on disk is UTC ISO).
describe('forgetMemory matches the shown (humanized) entry', () => {
  let dir, file
  const iso = '2026-07-11T09:23:45.000Z'
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sei-mem-'))
    file = join(dir, 'MEMORY.md')
    await appendMemory(file, 'they are packing for LA', iso)
    await appendMemory(file, 'they hate being called buddy', iso)
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('matches a quoted entry line including its rendered stamp', async () => {
    expect(await forgetMemory(file, `- [${localStamp(iso)}] they are packing for LA`)).toBe(1)
    const raw = await readFile(file, 'utf8')
    expect(raw).not.toContain('packing for LA')
    expect(raw).toContain('called buddy')
  })

  it('matches the bare rendered stamp with no dash prefix', async () => {
    expect(await forgetMemory(file, `[${localStamp(iso)}] they are packing for LA`)).toBe(1)
  })

  it('still matches a plain substring of the entry text', async () => {
    expect(await forgetMemory(file, 'packing for LA')).toBe(1)
  })

  it('does not match a quoted stamp that belongs to a different entry text', async () => {
    expect(await forgetMemory(file, `- [${localStamp(iso)}] they moved to berlin`)).toBe(0)
  })
})
