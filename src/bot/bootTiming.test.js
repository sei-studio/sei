import { describe, it, expect, beforeEach } from 'vitest'
import { markBoot, bootMarks, onBootMark, __resetBootMarks } from './bootTiming.js'

describe('bootTiming (260926)', () => {
  beforeEach(() => __resetBootMarks())

  it('stamps a phase once: the first stamp wins', () => {
    markBoot('booted', 100)
    markBoot('booted', 200)
    expect(bootMarks()).toEqual({ booted: 100 })
  })

  it('pushes a full snapshot to the listener on every new phase', () => {
    const seen = []
    markBoot('modules_loaded', 10) // before the port exists
    onBootMark((m) => seen.push(m))
    markBoot('init_received', 20)
    markBoot('init_received', 25) // duplicate: no push
    markBoot('booted', 30)
    expect(seen).toEqual([
      { modules_loaded: 10, init_received: 20 },
      { modules_loaded: 10, init_received: 20, booted: 30 },
    ])
  })

  it('hands out copies, and a throwing listener never breaks a stamp', () => {
    onBootMark(() => { throw new Error('port closed') })
    expect(() => markBoot('spawn', 5)).not.toThrow()
    const snap = bootMarks()
    snap.spawn = 999
    expect(bootMarks().spawn).toBe(5)
  })

  it('ignores empty or non-string names', () => {
    markBoot('', 1)
    markBoot(undefined, 1)
    expect(bootMarks()).toEqual({})
  })
})
