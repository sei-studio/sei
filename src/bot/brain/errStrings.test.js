// errLine (260709): ZodErrors from tool-arg validation used to reach the
// model as the raw multi-line JSON issue dump (craft count:92 produced a
// 12-line blob). Pins the one-line `field: message` rendering and the plain
// fallback for ordinary errors.

import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { errLine } from './errStrings.js'

describe('errLine', () => {
  it('flattens a ZodError to one `field: message` line', () => {
    const schema = z.object({ count: z.number().max(64) })
    let err
    try { schema.parse({ count: 92 }) } catch (e) { err = e }
    expect(errLine(err)).toBe('count: Number must be less than or equal to 64')
  })

  it('joins multiple issues with semicolons', () => {
    const schema = z.object({ count: z.number().max(64), item: z.string() })
    let err
    try { schema.parse({ count: 92, item: 5 }) } catch (e) { err = e }
    const line = errLine(err)
    expect(line).toContain('count: ')
    expect(line).toContain('; item: ')
    expect(line).not.toContain('\n')
  })

  it('renders a path-less custom refine issue as its bare message', () => {
    const schema = z.object({ n: z.number() }).refine(() => false, { message: 'cuboid too large' })
    let err
    try { schema.parse({ n: 1 }) } catch (e) { err = e }
    expect(errLine(err)).toBe('cuboid too large')
  })

  it('falls back to the first message line for ordinary errors', () => {
    expect(errLine(new Error('boom\nstack stack'))).toBe('boom')
    expect(errLine(undefined)).toBe('unknown')
  })
})
