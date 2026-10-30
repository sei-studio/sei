// 261028 facepack pilot: the expression vocabulary, tag reader and prompt.
import { describe, it, expect } from 'vitest'
import {
  FACE_EXPRESSIONS,
  FACE_EXPRESSION_NAMES,
  FACE_PROMPT,
  FACE_DECAY_MS,
  resolveExpression,
  readFaceTags,
  FACE_EXTRA_EXPRESSIONS,
  FACE_ALL_EXPRESSIONS,
  normalizePalette,
  FACE_OFFERED_NAMES,
  FACE_EXPRESSION_ENUM,
} from './faceExpressions.js'

describe('resolveExpression', () => {
  it('accepts every name', () => {
    for (const n of FACE_EXPRESSION_NAMES) expect(resolveExpression(n)).toBe(n)
    expect(FACE_EXPRESSION_NAMES).toHaveLength(12)
  })
  it('maps aliases, ignoring case and spacing', () => {
    expect(resolveExpression('smirk')).toBe('smug')
    expect(resolveExpression(' Blushing ')).toBe('embarrassed')
    expect(resolveExpression('LOL')).toBe('laugh')
    expect(resolveExpression('hmm')).toBe('thinking')
    expect(resolveExpression('ugh')).toBe('annoyed')
    expect(resolveExpression('gasps')).toBe('surprised')
  })
  it('maps the tags the probe saw invented (worried, relieved, nervous)', () => {
    expect(resolveExpression('worried')).toBe('sad')
    expect(resolveExpression('concerned')).toBe('sad')
    expect(resolveExpression('relieved')).toBe('happy')
    expect(resolveExpression('nervous')).toBe('embarrassed')
  })
  it('no alias collides with another expression name', () => {
    const names = new Set(FACE_EXPRESSION_NAMES)
    for (const e of FACE_EXPRESSIONS) for (const a of e.aliases) expect(names.has(a)).toBe(false)
  })
  it('returns null for unknown, empty and non-string input', () => {
    expect(resolveExpression('flibberflop')).toBeNull()
    expect(resolveExpression('leans in')).toBeNull()
    expect(resolveExpression('')).toBeNull()
    expect(resolveExpression('   ')).toBeNull()
    expect(resolveExpression(null)).toBeNull()
    expect(resolveExpression(3)).toBeNull()
  })
})

describe('readFaceTags', () => {
  it('reads a leading tag', () => {
    expect(readFaceTags('[happy] oh nice, you made it')).toEqual({ lead: 'happy', trail: null })
  })
  it('reads an alias tag', () => {
    expect(readFaceTags('[smirk] told you')).toEqual({ lead: 'smug', trail: null })
  })
  it('keeps the last valid leading tag', () => {
    expect(readFaceTags('[happy] [excited] wait what')).toEqual({ lead: 'excited', trail: null })
  })
  it('a tag after spoken words is the trail', () => {
    expect(readFaceTags('fine. [pout]')).toEqual({ lead: null, trail: 'pout' })
    expect(readFaceTags('[happy] ok sure [smug] whatever')).toEqual({ lead: 'happy', trail: 'smug' })
  })
  it('ignores unknown tags and keeps reading', () => {
    expect(readFaceTags('[leans in] [sad] oh no')).toEqual({ lead: 'sad', trail: null })
    expect(readFaceTags('[flibberflop] hi')).toEqual({ lead: null, trail: null })
  })
  it('no tag, empty and non-string input', () => {
    expect(readFaceTags('plain line')).toEqual({ lead: null, trail: null })
    expect(readFaceTags('')).toEqual({ lead: null, trail: null })
    expect(readFaceTags(undefined)).toEqual({ lead: null, trail: null })
  })
  it('is case-insensitive and tolerates inner spaces', () => {
    expect(readFaceTags('[ Surprised ] whoa')).toEqual({ lead: 'surprised', trail: null })
  })
  it('does not read markdown links or numbers as tags', () => {
    expect(readFaceTags('see [1] and [happy](x)')).toEqual({ lead: null, trail: 'happy' })
  })
})

describe('FACE_PROMPT', () => {
  it('lists every expression in brackets and says the tag is not spoken', () => {
    for (const n of FACE_EXPRESSION_NAMES) expect(FACE_PROMPT).toContain(`[${n}]`)
    expect(FACE_PROMPT).toMatch(/not spoken or shown/)
  })
  it('has no em dash (prompt-writing style)', () => {
    expect(FACE_PROMPT).not.toContain('—')
    expect(FACE_PROMPT).toMatch(/Begin each reply with a face tag/)
    // 261028: the line that keeps replies at their normal length.
    expect(FACE_PROMPT).toMatch(/then reply as you normally would/)
  })
  it('decay holds only on the four strong expressions', () => {
    expect(Object.keys(FACE_DECAY_MS).sort()).toEqual(['embarrassed', 'excited', 'laugh', 'surprised'])
  })
  it('laugh never blinks (eyes already squeezed shut)', () => {
    expect(FACE_EXPRESSIONS.find((e) => e.name === 'laugh').blink).toBe(false)
  })
})

// 261028: per-pack palettes. Fixtures are shaped like the baked packs but the
// code under test never sees a character name.
describe('pack palettes', () => {
  const LED = normalizePalette(
    ['neutral', 'deadpan', 'resigned', 'smirk', 'annoyed', 'sad', 'sleepy', 'thinking', 'surprised'],
    { happy: 'smirk', laugh: 'smirk', excited: 'smirk', smug: 'smirk', pout: 'annoyed', embarrassed: 'resigned' },
  )
  const THA3 = normalizePalette([...FACE_EXPRESSION_NAMES, 'worried'])

  it('normalizePalette cleans names and drops aliases that point nowhere', () => {
    expect(normalizePalette([' Happy ', 'happy', 'two words', 7, 'sad'], { glad: 'happy', x: 'nope', sad: 'happy' })).toEqual({
      expressions: ['happy', 'sad'],
      aliases: { glad: 'happy' },
    })
    expect(normalizePalette(['happy', 'laugh'], {}, ['happy'])).toEqual({ expressions: ['happy'], aliases: {} })
    expect(normalizePalette([])).toBeNull()
    expect(normalizePalette(undefined)).toBeNull()
  })

  it('without a palette every word still lands on the base 12 as before', () => {
    expect(resolveExpression('smirk')).toBe('smug')
    expect(resolveExpression('worried')).toBe('sad')
    expect(resolveExpression('sighs')).toBe('sad')
    expect(resolveExpression('deadpan')).toBe('neutral')
    expect(resolveExpression('resigned')).toBe('sad')
    for (const e of FACE_ALL_EXPRESSIONS) {
      for (const w of [e.name, ...e.aliases]) expect(FACE_EXPRESSION_NAMES).toContain(resolveExpression(w))
    }
  })

  it('maps through the pack aliases first', () => {
    expect(resolveExpression('laugh', LED)).toBe('smirk')
    expect(resolveExpression('laughs', LED)).toBe('smirk')
    expect(resolveExpression('excited', LED)).toBe('smirk')
    expect(resolveExpression('happy', LED)).toBe('smirk')
    expect(resolveExpression('pout', LED)).toBe('annoyed')
    expect(resolveExpression('deadpan', LED)).toBe('deadpan')
    expect(resolveExpression('sighs', LED)).toBe('resigned')
    expect(resolveExpression('worried', LED)).toBe('sad')
  })

  it('a pack with worried keeps it; one without falls back to sad', () => {
    expect(resolveExpression('worried', THA3)).toBe('worried')
    expect(resolveExpression('concerned', THA3)).toBe('worried')
    expect(resolveExpression('smirk', THA3)).toBe('smug')
    expect(resolveExpression('deadpan', THA3)).toBe('neutral')
  })

  it('a tag the pack cannot show is ignored (the current face stays)', () => {
    const tiny = normalizePalette(['neutral', 'happy'])
    expect(resolveExpression('annoyed', tiny)).toBeNull()
    expect(readFaceTags('[happy] ok [annoyed] fine', tiny)).toEqual({ lead: 'happy', trail: null })
    expect(readFaceTags('[happy] [annoyed] fine', tiny)).toEqual({ lead: 'happy', trail: null })
  })

  it('every palette result is one of its names', () => {
    for (const e of FACE_ALL_EXPRESSIONS) {
      for (const w of [e.name, ...e.aliases]) {
        const r = resolveExpression(w, LED)
        if (r !== null) expect(LED.expressions).toContain(r)
      }
    }
  })

  it('every character is offered the same full list (no per-pack filter)', () => {
    expect(FACE_OFFERED_NAMES).toEqual(FACE_ALL_EXPRESSIONS.map((e) => e.name))
    for (const n of FACE_OFFERED_NAMES) expect(FACE_PROMPT).toContain(`[${n}]`)
    expect(FACE_EXPRESSION_ENUM).toEqual(FACE_OFFERED_NAMES)
  })

  it('the prompt names no character', () => {
    expect(FACE_PROMPT).not.toMatch(/\b(sui|lyra|marv)\b/i)
  })

  it('every offered face lands on a face any pack can show', () => {
    for (const n of FACE_OFFERED_NAMES) {
      expect(resolveExpression(n)).not.toBeNull()
      expect(LED.expressions).toContain(resolveExpression(n, LED))
      expect(THA3.expressions).toContain(resolveExpression(n, THA3))
    }
  })

  it('extra names never collide with base names and each falls back to a base name', () => {
    const base = new Set(FACE_EXPRESSION_NAMES)
    for (const e of FACE_EXTRA_EXPRESSIONS) {
      expect(base.has(e.name)).toBe(false)
      expect(base.has(e.fallback)).toBe(true)
    }
    const all = new Set(FACE_ALL_EXPRESSIONS.map((e) => e.name))
    for (const e of FACE_ALL_EXPRESSIONS) for (const a of e.aliases) expect(all.has(a)).toBe(false)
  })
})
