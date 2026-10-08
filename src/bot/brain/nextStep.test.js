import { describe, it, expect } from 'vitest'
import { normalizeNextStep, nextStepMemoryLine, NEXT_STEP_MAX_CHARS } from './nextStep.js'
import { NEXT_TIME_GREETING } from './prompts.js'

describe('normalizeNextStep', () => {
  it('returns null when the model left the field out', () => {
    expect(normalizeNextStep(undefined)).toBeNull()
    expect(normalizeNextStep(null)).toBeNull()
    expect(normalizeNextStep(42)).toBeNull()
    expect(normalizeNextStep('')).toBeNull()
    expect(normalizeNextStep(' \n\t ')).toBeNull()
  })

  it('collapses whitespace into one line', () => {
    expect(normalizeNextStep('  finish the\n\n cabin   roof ')).toBe('finish the cabin roof')
  })

  it('caps a runaway field at a word boundary', () => {
    const long = 'build '.repeat(100)
    const out = normalizeNextStep(long)
    expect(out.length).toBeLessThanOrEqual(NEXT_STEP_MAX_CHARS)
    expect(out.endsWith('build')).toBe(true)
  })
})

describe('nextStepMemoryLine', () => {
  it('uses the prefix the greeting prompt points at', () => {
    const line = nextStepMemoryLine('finish the roof')
    expect(line).toBe('Plan for next time: finish the roof')
    expect(NEXT_TIME_GREETING).toContain('"Plan for next time"')
  })
})
