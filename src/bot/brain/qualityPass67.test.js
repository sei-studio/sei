// 261128 (quality pass 67): an action's own progress words on the in_flight
// line (shelter: digging for blocks, digging in, walls, roof).
import { describe, it, expect } from 'vitest'
import { getInFlightLineForSnapshot } from './inflight.js'

describe('in_flight progress text (pass 67)', () => {
  it('renders a text progress after the args', () => {
    const line = getInFlightLineForSnapshot({ name: 'shelter', args: { size: 3 }, startedAt: 1000, progress: { text: 'digging in: 1 of 3 blocks of the pit dug, no roof on it yet' } }, 3000)
    expect(line).toMatch(/^in_flight: shelter\(.*\) started=2\.0s ago — digging in: 1 of 3 blocks of the pit dug, no roof on it yet$/)
  })
  it('keeps the placed/total form for build', () => {
    const line = getInFlightLineForSnapshot({ name: 'build', args: {}, startedAt: 0, progress: { placed: 2, total: 9 } }, 0)
    expect(line).toContain('placed 2 of 9 so far')
  })
})
