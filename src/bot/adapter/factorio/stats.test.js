import { describe, it, expect } from 'vitest'
import { classifyFactorioResult, createFactorioStats, reflexKindOf, FAIL_CLASSES } from './stats.js'

// The mod's own fixed result strings (scripts/verbs.lua, api.lua), as the registry returns them.
const CASES = [
  ['gathered 8 wood', null],
  ['crafted 3 iron-gear-wheel', null],
  ['failed: no uranium-ore to mine within 128 tiles', 'target_not_found'],
  ['failed: could not reach any iron-ore (no path)', 'no_path'],
  ['failed: could not walk to 10,4: stuck', 'no_path'],
  ['failed: my inventory is full after 40 stone', 'inventory_full'],
  ["failed: the player's inventory is full", 'inventory_full'],
  ['failed: no coal in the wooden-chest (or my inventory is full)', 'target_not_found'],
  ['failed: the wooden-chest is empty (or my inventory is full)', 'target_not_found'],
  ['failed: cannot craft lab: missing 10 electronic-circuit', 'missing_materials'],
  ['failed: I have no stone-furnace', 'missing_materials'],
  ['failed: electronic-circuit is not researched yet', 'not_researched'],
  ['failed: could not start automation: first needs automation-science-pack (unlocked by crafting lab)', 'not_researched'],
  ['failed: nothing with handle #48 here', 'target_not_found'],
  ['failed: I am dead, back in 9 s', 'dead'],
  ['failed: I am retreating with low health', 'dead'],
  ['failed: ran out of time', 'timeout'],
  ['failed: cmd gather got no answer from Factorio in 8s', 'timeout'],
  ['failed: the game is not answering right now (it may be paused, saving, or in a menu); try again in a moment', 'timeout'],
  ['failed: told to stop', 'aborted'],
  ['aborted', 'aborted'],
  ['paused: the player paused the game', 'aborted'],
  ['failed: error: attempt to index nil', 'error'],
  ['failed: cannot place stone-furnace at 3,4: something is in the way or the ground is wrong', 'refused'],
]

describe('classifyFactorioResult', () => {
  it.each(CASES)('%s -> %s', (text, cls) => {
    expect(classifyFactorioResult(text)).toBe(cls)
  })
  it('only ever returns a known class', () => {
    for (const [text] of CASES) {
      const c = classifyFactorioResult(text)
      if (c) expect(FAIL_CLASSES).toContain(c)
    }
  })
})

describe('createFactorioStats', () => {
  it('counts verbs by outcome and reflexes by kind, shape only', () => {
    const s = createFactorioStats()
    expect(s.isDirty()).toBe(false)
    s.verb('gather', 'gathered 8 wood')
    s.verb('gather', 'failed: no uranium-ore to mine within 128 tiles')
    s.verb('craft', 'crafted 1 lab')
    s.verb('bad name!', 'x')
    s.reflex('fight')
    s.reflex('nonsense')
    s.linkTimeout()
    s.respawnedByApp()
    expect(s.isDirty()).toBe(true)
    expect(s.snapshot()).toEqual({
      verbs: { gather: { n: 2, ok: 1, fail: { target_not_found: 1 } }, craft: { n: 1, ok: 1, fail: {} } },
      reflex: { fight: 1, hit: 0, retreat: 0, safe: 0, no_ammo: 0, death: 0, respawn: 0, rescue: 0, owner_away: 0 },
      link_timeouts: 1,
      app_respawns: 1,
    })
    expect(s.isDirty()).toBe(false)
  })

  it('maps feed events to reflex kinds', () => {
    expect(reflexKindOf({ t: 'survival', kind: 'retreat' })).toBe('retreat')
    expect(reflexKindOf({ t: 'survival', kind: 'weird' })).toBeNull()
    expect(reflexKindOf({ t: 'respawned' })).toBe('respawn')
    expect(reflexKindOf({ t: 'chat' })).toBeNull()
  })
})
