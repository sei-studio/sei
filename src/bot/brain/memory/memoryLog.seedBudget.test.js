// readMemoryForSeed budget (261013): a MEMORY.md with no `- [` entry lines
// used to come back whole, the one path around seed_memory_budget_bytes.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendMemory, readMemoryForSeed } from './memoryLog.js'

let dir
let file
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sei-seedbudget-'))
  file = join(dir, 'MEMORY.md')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('readMemoryForSeed', () => {
  it('caps a hand-edited file with no entry lines, newest lines kept', async () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `note line ${i} about the player`)
    await writeFile(file, lines.join('\n'))
    const out = await readMemoryForSeed(file, 4096)
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(4096)
    expect(out).toContain('note line 1999 about the player')
    expect(out).not.toContain('note line 0 about the player')
    expect(out.startsWith('- [...older memory truncated]')).toBe(true)
  })

  it('returns a small no-entry file whole, as before', async () => {
    await writeFile(file, 'a short hand-written note\n')
    expect(await readMemoryForSeed(file, 4096)).toBe('a short hand-written note\n')
  })

  it('is unchanged for app-written entry files', async () => {
    for (let i = 0; i < 300; i++) await appendMemory(file, `fact number ${i}`, '2026-10-13T00:00:00.000Z')
    const out = await readMemoryForSeed(file, 4096)
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(4096 + 200)
    expect(out).toContain('fact number 299')
    expect(out).not.toContain('fact number 0\n')
  })
})




