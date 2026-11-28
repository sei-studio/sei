// 261128: quality pass 68. While shelter() ran, the in_flight line read
// "shelter() started=8.5s ago" and nothing else, and she told the player "im
// almost done with the walls" and "shelter's almost up, you're safe in here"
// while it was still digging dirt with no wall placed (11-28 scorecard
// night_social-02). The shelter now reports its stage (behaviors/shelter.js)
// and the line says where it is.

import { describe, it, expect } from 'vitest'
import { getInFlightLineForSnapshot } from './inflight.js'

const shelter = (progress) => ({ name: 'shelter', args: { size: 3 }, startedAt: 0, progress })

describe('shelter in_flight line', () => {
  it('says it is still digging blocks and nothing is built', () => {
    const l = getInFlightLineForSnapshot(shelter({ shelter: true, stage: 'supply', have: 8, need: 25 }), 8_500)
    expect(l).toBe('in_flight: shelter() started=8.5s ago, still digging up blocks to build it with (8 of the 25 it needs so far). Nothing is built yet: no wall or roof is placed')
  })

  it('gives the walls and roof counts', () => {
    expect(getInFlightLineForSnapshot(shelter({ shelter: true, stage: 'walls', filled: 3, cells: 16 }), 1_000))
      .toContain(', placing the walls (3 of the 16 wall blocks are in place, 13 still to go, and the roof goes on after them). It is not finished and keeps nothing out yet')
    expect(getInFlightLineForSnapshot(shelter({ shelter: true, stage: 'roof', filled: 2, cells: 9 }), 1_000))
      .toContain(', the walls are up and it is putting on the roof (2 of 9 roof blocks in place). It is not finished yet')
    expect(getInFlightLineForSnapshot(shelter({ shelter: true, stage: 'door' }), 1_000))
      .toContain(', the walls and roof are up and it is cutting the doorway')
  })

  it('keeps the bare line with no or unknown progress', () => {
    expect(getInFlightLineForSnapshot(shelter(null), 1_000)).toBe('in_flight: shelter() started=1.0s ago')
    expect(getInFlightLineForSnapshot(shelter({ shelter: true, stage: 'what' }), 1_000)).toBe('in_flight: shelter() started=1.0s ago')
    expect(getInFlightLineForSnapshot(shelter({ shelter: true, stage: 'walls' }), 1_000)).toBe('in_flight: shelter() started=1.0s ago')
  })

  it('a build keeps its own placed count', () => {
    const l = getInFlightLineForSnapshot({ name: 'build', args: {}, startedAt: 0, progress: { placed: 4, skipped: 0, total: 9 } }, 1_000)
    expect(l).toContain('placed 4 of 9 so far')
  })
})
