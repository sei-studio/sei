// 261104: the DST respawn decision (cap, quick-death streak = bad spot).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRespawnPolicy, sanitizeDeathCause, describeDeathCause, MAX_RESPAWNS, QUICK_DEATH_MS } from './respawn.js'

function clock(start = 1_000_000) {
  let t = start
  return { now: () => t, tick: (ms) => { t += ms } }
}

describe('createRespawnPolicy', () => {
  it('respawns up to the cap (3), then ends with reason cap', () => {
    const c = clock()
    const p = createRespawnPolicy({ now: c.now })
    for (let i = 0; i < MAX_RESPAWNS; i++) {
      c.tick(60_000)
      expect(p.onDeath({ cause: 'spider' })).toEqual({ action: 'respawn' })
      p.onRespawned()
    }
    expect(p.respawns).toBe(3)
    expect(p.respawnsLeft).toBe(0)
    c.tick(60_000)
    expect(p.onDeath({ cause: 'hound' })).toEqual({ action: 'end', reason: 'cap' })
    expect(p.deaths).toBe(4)
    expect(p.lastCause).toBe('hound')
  })

  it('two deaths in a row within 20 s of a respawn is a bad spot', () => {
    const c = clock()
    const p = createRespawnPolicy({ now: c.now })
    c.tick(300_000)
    expect(p.onDeath({ cause: 'darkness' }).action).toBe('respawn')
    p.onRespawned()
    c.tick(QUICK_DEATH_MS - 5_000)
    expect(p.onDeath({ cause: 'darkness' }).action).toBe('respawn') // first quick death
    p.onRespawned()
    c.tick(8_000)
    expect(p.onDeath({ cause: 'darkness' })).toEqual({ action: 'end', reason: 'bad_spot' })
    expect(p.respawns).toBe(2)
  })

  it('a death after the respawn cooldown resets the quick-death streak', () => {
    const c = clock()
    const p = createRespawnPolicy({ now: c.now })
    p.onDeath({}); p.onRespawned()
    c.tick(5_000)
    expect(p.onDeath({}).action).toBe('respawn') // quick #1
    p.onRespawned()
    c.tick(QUICK_DEATH_MS + 1_000)
    expect(p.onDeath({}).action).toBe('respawn') // slow: streak back to 0
    p.onRespawned()
    c.tick(5_000)
    // quick again, but only the first in a row; the cap is what ends it here
    expect(p.onDeath({})).toEqual({ action: 'end', reason: 'cap' })
  })

  it('a quick death after the FIRST summon is not a bad spot (only respawns count)', () => {
    const c = clock()
    const p = createRespawnPolicy({ now: c.now })
    c.tick(2_000)
    expect(p.onDeath({ cause: 'darkness' }).action).toBe('respawn')
  })

  it('bad spot wins over the cap when both apply, and the knobs are configurable', () => {
    const c = clock()
    const p = createRespawnPolicy({ now: c.now, maxRespawns: 1, badSpotStreak: 1, quickDeathMs: 10_000 })
    expect(p.onDeath({}).action).toBe('respawn')
    p.onRespawned()
    c.tick(3_000)
    expect(p.onDeath({})).toEqual({ action: 'end', reason: 'bad_spot' })
    const none = createRespawnPolicy({ maxRespawns: 0 })
    expect(none.onDeath({})).toEqual({ action: 'end', reason: 'cap' })
  })
})

describe('death cause wording', () => {
  it('sanitizes the cause to a game id for analytics', () => {
    expect(sanitizeDeathCause('darkness')).toBe('darkness')
    expect(sanitizeDeathCause('Spider')).toBe('spider')
    expect(sanitizeDeathCause('NIL')).toBe('unknown')
    expect(sanitizeDeathCause('Steve the Player')).toBe('unknown')
    expect(sanitizeDeathCause(undefined)).toBe('unknown')
  })

  it('describes the cause in plain words', () => {
    expect(describeDeathCause({ cause: 'darkness' })).toBe('Charlie in the darkness')
    expect(describeDeathCause({ cause: 'hunger' })).toBe('starvation')
    expect(describeDeathCause({ cause: 'cold' })).toBe('freezing')
    expect(describeDeathCause({ cause: 'hot' })).toBe('overheating')
    expect(describeDeathCause({ cause: 'spider', afflicter: 'Spider' })).toBe('Spider')
    expect(describeDeathCause({ cause: 'tentacle' })).toBe('tentacle')
    expect(describeDeathCause({ cause: 'NIL' })).toBeNull()
  })

  it('the cap in the user copy matches MAX_RESPAWNS', () => {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const copy = readFileSync(path.join(here, '../../../renderer/src/lib/errors.ts'), 'utf8')
    expect(copy).toContain(`coming back ${MAX_RESPAWNS} times`)
  })
})
