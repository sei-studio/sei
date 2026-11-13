import { describe, it, expect } from 'vitest'
import { classifyTerrariaResult, createTerrariaStats, reflexKindOf } from './stats.js'

describe('terraria stats', () => {
  it('classifies the mod result strings', () => {
    expect(classifyTerrariaResult('mined 4 blocks (got Dirt Block x4)')).toBeNull()
    expect(classifyTerrariaResult('aborted')).toBe('aborted')
    expect(classifyTerrariaResult('paused: the player paused the game')).toBe('aborted')
    expect(classifyTerrariaResult('failed: no way to get there from (1,2)')).toBe('no_path')
    expect(classifyTerrariaResult('failed: I have no pickaxe; give me one and I can mine')).toBe('no_tool')
    expect(classifyTerrariaResult('failed: cannot craft Torch: missing Gel x1')).toBe('missing_materials')
    expect(classifyTerrariaResult('failed: no tree within 30 tiles')).toBe('target_not_found')
    expect(classifyTerrariaResult('failed: still walking after 90s; stopped at (1,2)')).toBe('timeout')
    expect(classifyTerrariaResult('failed: I am already at full health (100/100)')).toBe('refused')
  })

  it('counts and snapshots, clearing the dirty flag', () => {
    const s = createTerrariaStats()
    expect(s.isDirty()).toBe(false)
    s.verb('mine', 'mined 2/2')
    s.verb('mine', 'failed: nothing mineable in that area')
    s.verb('bad name!', 'x')
    s.reflex('healed')
    s.reflex('nope')
    s.alert('boss_spawn')
    expect(s.isDirty()).toBe(true)
    const snap = s.snapshot()
    expect(snap.verbs).toEqual({ mine: { n: 2, ok: 1, fail: { target_not_found: 1 } } })
    expect(snap.reflex.healed).toBe(1)
    expect(snap.alerts.boss_spawn).toBe(1)
    expect(s.isDirty()).toBe(false)
    expect(reflexKindOf({ t: 'survival', kind: 'retreating' })).toBe('retreat')
    expect(reflexKindOf({ t: 'death' })).toBe('knocked_out')
  })
})
