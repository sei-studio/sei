// src/bot/brain/memory/memoryLog.dedupe.test.js
//
// Loose duplicate guard on appendMemory (260725). Live capture: voice turns
// wrote "ouen wants me to hang up when they say bye" twice 9 seconds apart,
// and three "marv goes by mars" variants landed within 42 seconds. The guard
// only skips EXACT matches after normalization (case, punctuation, spacing) —
// wording variants still append, and cleaning those up stays the compactor's
// job.
//
// 260725: the scan is BOUNDED, to recent entries in the current world segment.
// An unbounded scan meant a fact the player re-confirms weeks later could
// never be re-recorded and kept its weeks-old stamp, which the date-aware seed
// prompt then reads as old history ("a weeks-old note is an old thread").

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendMemory, noteWorld } from './memoryLog.js'

const HOUR_MS = 60 * 60 * 1000

describe('appendMemory duplicate guard', () => {
  let dir, file
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sei-mem-'))
    file = join(dir, 'MEMORY.md')
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('skips an exact repeat', async () => {
    expect(await appendMemory(file, 'ouen wants me to hang up when they say bye')).toBe(1)
    expect(await appendMemory(file, 'ouen wants me to hang up when they say bye')).toBe(0)
    const raw = await readFile(file, 'utf8')
    expect(raw.match(/hang up when they say bye/g)).toHaveLength(1)
  })

  it('skips a repeat that differs only in case/punctuation/spacing', async () => {
    await appendMemory(file, 'marv goes by mars now. same deadpan nihilist energy')
    expect(await appendMemory(file, 'Marv goes by Mars now — same  deadpan nihilist energy!')).toBe(0)
  })

  it('still appends genuinely different wording', async () => {
    await appendMemory(file, 'marv goes by mars now. same deadpan nihilist energy, different name')
    expect(await appendMemory(file, 'marv goes by mars now. same deadpan nihilist energy, different vibe')).toBe(1)
  })

  it('re-records a fact confirmed again much later, with the fresh stamp', async () => {
    const old = new Date(Date.now() - 14 * 24 * HOUR_MS)
    expect(await appendMemory(file, 'they are packing for LA', old)).toBe(1)
    expect(await appendMemory(file, 'they are packing for LA', new Date())).toBe(1)
    const raw = await readFile(file, 'utf8')
    expect(raw.match(/packing for LA/g)).toHaveLength(2)
    // The newest copy carries today's stamp, so the date-aware prompt reads it
    // as fresh rather than as a two-week-old thread.
    const stamps = [...raw.matchAll(/^- \[([^\]]+)\]/gm)].map((m) => m[1])
    expect(Date.now() - Date.parse(stamps[stamps.length - 1])).toBeLessThan(60_000)
  })

  it('does not dedupe across a world change', async () => {
    expect(await appendMemory(file, 'the base is on a hill by the river')).toBe(1)
    await noteWorld(file, 2, 'plains village')
    expect(await appendMemory(file, 'the base is on a hill by the river')).toBe(1)
  })

  it('an entry with an unparseable stamp is never treated as a duplicate', async () => {
    await appendMemory(file, 'a legit note')
    // Hand-edited / corrupted stamp: undatable, so it cannot prove recency.
    const raw = await readFile(file, 'utf8')
    await writeFile(file, raw.replace(/\[[^\]]*\]/, '[whenever]'))
    expect(await appendMemory(file, 'a legit note')).toBe(1)
  })
})
