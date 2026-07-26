// src/bot/brain/memory/memoryLog.archive.test.js
//
// Raw memory archive (260725): MEMORY.archive.md is a write-only mirror of
// every entry line and world header, kept so future (better) compaction tech
// can recover the originals. Pins:
//   - appends and world headers are mirrored at write time
//   - forget() removes from MEMORY.md but never from the archive
//   - duplicate-guard skips are not archived (they never became a memory)
//   - the archive is plain UTC-ISO lines like the live file

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendMemory, forgetMemory, noteWorld } from './memoryLog.js'

describe('memory archive', () => {
  let dir, file, archive
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sei-mem-'))
    file = join(dir, 'MEMORY.md')
    archive = join(dir, 'MEMORY.archive.md')
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('mirrors entries and world headers', async () => {
    await noteWorld(file, 1, 'plains village')
    await appendMemory(file, 'ouen gave the dandelion back', '2026-07-08T04:00:35.040Z')
    const raw = await readFile(archive, 'utf8')
    expect(raw).toContain('# Memory archive')
    expect(raw).toContain('## World 1 — plains village')
    expect(raw).toContain('- [2026-07-08T04:00:35.040Z] ouen gave the dandelion back')
  })

  it('keeps forgotten lines and skips duplicate-guard rejects', async () => {
    await appendMemory(file, 'marv goes by mars now')
    await appendMemory(file, 'marv goes by mars now') // dup — not written anywhere
    await forgetMemory(file, 'mars')
    expect(await readFile(file, 'utf8')).not.toContain('mars')
    const raw = await readFile(archive, 'utf8')
    expect(raw.match(/marv goes by mars now/g)).toHaveLength(1)
  })
})
