import { describe, it, expect } from 'vitest'
import { applyEdits, dollarQuote, updateSql } from './card-edits.mjs'

describe('applyEdits', () => {
  it('replaces each before string once, in order', () => {
    const out = applyEdits('a sun line. a sea line.', [['sun line', 'tide line'], ['a sea', 'one sea']])
    expect(out).toBe('a tide line. one sea line.')
  })
  it('refuses a missing or repeated before string', () => {
    expect(() => applyEdits('x', [['y', 'z']], 'red')).toThrow(/red: expected 1 match, found 0/)
    expect(() => applyEdits('sun sun', [['sun', 'moon']])).toThrow(/found 2/)
  })
  it('keeps $ patterns in the replacement literal', () => {
    expect(applyEdits('pay x', [['x', '$& and $1']])).toBe('pay $& and $1')
  })
})

describe('updateSql', () => {
  it('quotes the text with a tag it does not contain', () => {
    expect(dollarQuote('plain')).toBe('$card$plain$card$')
    expect(dollarQuote('has $card$ in it')).toBe('$cardx$has $card$ in it$cardx$')
  })
  it('guards on the md5 of the current text and bumps updated_at', () => {
    const sql = updateSql({ id: 'abc', name: 'Red', before: 'old', after: "it's new" })
    expect(sql).toContain("where id = 'abc' and md5(persona_expanded) = '149603e6c03516362a8da23f624db945'")
    expect(sql).toContain("set persona_expanded = $card$it's new$card$, updated_at = now()")
  })
})
