// 260926: the post-spawn render-stack warm-up runs only when the model can see.
// A text-only model never gets look(), so loading the natives for it is pure
// cost (and on a slow Windows machine, a risk to the keep-alive).
import { describe, it, expect } from 'vitest'
import { visionWarmupWanted } from './runtime.js'

const brain = (canSee) => ({ visionCapable: () => canSee })

describe('visionWarmupWanted', () => {
  it('warms for a vision-capable model with vision on', () => {
    expect(visionWarmupWanted({ vision: { mode: 'on-demand' } }, brain(true))).toBe(true)
    expect(visionWarmupWanted({ vision: { mode: 'continuous' } }, brain(true))).toBe(true)
  })
  it('skips a text-only model', () => {
    expect(visionWarmupWanted({ vision: { mode: 'on-demand' } }, brain(false))).toBe(false)
  })
  it('skips when vision is off, missing, or the brain is not up', () => {
    expect(visionWarmupWanted({ vision: { mode: 'off' } }, brain(true))).toBe(false)
    expect(visionWarmupWanted({}, brain(true))).toBe(false)
    expect(visionWarmupWanted({ vision: { mode: 'on-demand' } }, null)).toBe(false)
    expect(visionWarmupWanted({ vision: { mode: 'on-demand' } }, { visionCapable: () => { throw new Error('x') } })).toBe(false)
  })
})
