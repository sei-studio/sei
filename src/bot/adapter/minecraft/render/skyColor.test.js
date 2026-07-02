// 260611: time-of-day sky approximation — pure-function coverage.
// (povRenderer.js itself dlopens GL natives at import; the wiring there is
// covered by the electron-as-node smoke test, not vitest.)
import { describe, expect, it } from 'vitest'
import { skyColorForTime } from './skyColor.js'

describe('skyColorForTime', () => {
  it('returns the classic lightblue at noon', () => {
    expect(skyColorForTime(6000)).toEqual([173, 216, 230])
  })

  it('returns a dark sky in the middle of the night', () => {
    const [r, g, b] = skyColorForTime(18000)
    expect(r).toBeLessThan(40)
    expect(g).toBeLessThan(40)
    expect(b).toBeLessThan(70)
  })

  it('returns a warm tone during sunset', () => {
    const [r, , b] = skyColorForTime(12500)
    expect(r).toBeGreaterThan(b) // warmer than blue
    expect(r).toBeGreaterThan(180)
  })

  it('interpolates between keyframes (dusk is between sunset and night)', () => {
    const sunset = skyColorForTime(12500)
    const night = skyColorForTime(13800)
    const dusk = skyColorForTime(13150)
    expect(dusk[0]).toBeLessThan(sunset[0])
    expect(dusk[0]).toBeGreaterThan(night[0])
  })

  it('wraps out-of-range ticks and tolerates garbage', () => {
    expect(skyColorForTime(24000 + 6000)).toEqual(skyColorForTime(6000))
    expect(skyColorForTime(-6000)).toEqual(skyColorForTime(18000))
    expect(skyColorForTime(undefined)).toEqual([173, 216, 230])
    expect(skyColorForTime(NaN)).toEqual([173, 216, 230])
  })
})
