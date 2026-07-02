// src/bot/brain/memory/heartbeat.test.js
//
// 260615: HEARTBEAT.md carries active goals/standing orders across loops so a
// multi-step goal survives a loop ending after one step. Mirrors MEMORY.md's
// append-only, file-locked, byte-budgeted shape. These tests pin append/remove
// and the seed-read (newest-first, budget-trimmed, '' when empty).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendGoal,
  removeGoal,
  readHeartbeatForSeed,
  readHeartbeatFull,
} from './heartbeat.js'

let dir
let file
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sei-heartbeat-'))
  file = join(dir, 'HEARTBEAT.md')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('heartbeat store', () => {
  it('reads empty before any write', async () => {
    expect(await readHeartbeatFull(file)).toBe('')
    expect(await readHeartbeatForSeed(file, 2048)).toBe('')
  })

  it('appends a goal with header + timestamped line', async () => {
    const n = await appendGoal(file, 'gather 10 wood then build a statue', new Date('2026-06-15T00:00:00.000Z'))
    expect(n).toBe(1)
    const raw = await readFile(file, 'utf8')
    expect(raw).toContain('# Heartbeat')
    expect(raw).toContain('- [2026-06-15T00:00:00.000Z] gather 10 wood then build a statue')
  })

  it('ignores empty/whitespace goals', async () => {
    expect(await appendGoal(file, '   ')).toBe(0)
    expect(await readHeartbeatFull(file)).toBe('')
  })

  it('seed-read returns only entry lines, newest last, no header', async () => {
    await appendGoal(file, 'goal one', new Date('2026-06-15T00:00:00.000Z'))
    await appendGoal(file, 'goal two', new Date('2026-06-15T00:01:00.000Z'))
    const seed = await readHeartbeatForSeed(file, 2048)
    expect(seed).not.toContain('# Heartbeat')
    expect(seed).toContain('goal one')
    expect(seed).toContain('goal two')
    expect(seed.indexOf('goal one')).toBeLessThan(seed.indexOf('goal two'))
  })

  it('removeGoal deletes matching lines case-insensitively', async () => {
    await appendGoal(file, 'gather wood standing order')
    await appendGoal(file, 'build a statue at ten logs')
    const removed = await removeGoal(file, 'STATUE')
    expect(removed).toBe(1)
    const raw = await readFile(file, 'utf8')
    expect(raw).toContain('gather wood standing order')
    expect(raw).not.toContain('statue')
  })

  it('removeGoal returns 0 on no match', async () => {
    await appendGoal(file, 'only goal')
    expect(await removeGoal(file, 'nonexistent')).toBe(0)
  })

  it('coexists multiple distinct goals', async () => {
    expect(await appendGoal(file, 'build a base by the river')).toBe(1)
    expect(await appendGoal(file, 'gather wood until ten logs')).toBe(1)
    const seed = await readHeartbeatForSeed(file, 2048)
    expect(seed).toContain('build a base by the river')
    expect(seed).toContain('gather wood until ten logs')
  })

  it('clearGoal by partial substring removes the right line, leaves others', async () => {
    await appendGoal(file, 'build a base by the river')
    await appendGoal(file, 'gather wood until ten logs')
    const removed = await removeGoal(file, 'ten logs')
    expect(removed).toBe(1)
    const raw = await readFile(file, 'utf8')
    expect(raw).toContain('build a base by the river')
    expect(raw).not.toContain('ten logs')
  })

  it('appendGoal dedups a near-duplicate goal (punctuation/case/whitespace)', async () => {
    expect(await appendGoal(file, 'Build a base by the river.')).toBe(1)
    // same goal restated next loop with different case/punctuation/spacing
    expect(await appendGoal(file, 'build a base   by the river')).toBe(0)
    const entries = (await readFile(file, 'utf8'))
      .split('\n')
      .filter(l => /^- \[/.test(l))
    expect(entries).toHaveLength(1)
  })

  it('appendGoal allows a genuinely different goal after a dedup', async () => {
    await appendGoal(file, 'build a base by the river')
    expect(await appendGoal(file, 'build a base by the river')).toBe(0) // dup
    expect(await appendGoal(file, 'mine cobblestone for stone tools')).toBe(1) // distinct
    const entries = (await readFile(file, 'utf8'))
      .split('\n')
      .filter(l => /^- \[/.test(l))
    expect(entries).toHaveLength(2)
  })

  it('appendGoal seeds the header on ENOENT and returns empty before any write', async () => {
    expect(await readHeartbeatFull(file)).toBe('')
    await appendGoal(file, 'first goal')
    const raw = await readFile(file, 'utf8')
    expect(raw.startsWith('# Heartbeat')).toBe(true)
    expect(raw).toContain('first goal')
  })

  it('seed-read drops oldest goals past the byte budget (keeps newest)', async () => {
    for (let i = 0; i < 40; i++) {
      await appendGoal(file, `goal number ${i} with some padding text`, new Date(2026, 5, 15, 0, i))
    }
    const seed = await readHeartbeatForSeed(file, 256)
    expect(Buffer.byteLength(seed, 'utf8')).toBeLessThanOrEqual(256 + 40) // marker slack
    expect(seed).toContain('goal number 39')
    expect(seed).not.toContain('goal number 0 ')
    expect(seed).toContain('older goals truncated')
  })
})
