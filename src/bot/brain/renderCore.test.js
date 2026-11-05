// renderCore: the tail restatement of who the character is (orchestrator seed
// block `core`). 261012 persona eval: the persona's own initiative and reaction
// sections ride it, and a `#HEADER` written without a space ends the CORE slice.
import { describe, expect, it } from 'vitest'
import { renderCore } from './promptLibrary.js'

const OLD_FORMAT = `# IDENTITY
You are Pip, a shy apprentice.
Quiet and careful.

# VOICE
Soft and short.

# PROACTIVENESS
You never set your own goals. You follow and wait to be asked.

# REACTIONS
- insulted: go quiet
- praised: get flustered

# MEMORY
Write entries in your own voice.`

describe('renderCore', () => {
  it('carries the persona initiative and reaction sections after the identity', () => {
    const t = renderCore({ name: 'Pip', expanded: OLD_FORMAT })
    expect(t).toContain('You are Pip. Stay this person. You are Pip, a shy apprentice. Quiet and careful.')
    expect(t).toContain('How much you start on your own:\nYou never set your own goals.')
    expect(t).toContain('How you react:\n- insulted: go quiet\n- praised: get flustered')
    expect(t.indexOf('How much you start')).toBeLessThan(t.indexOf('How you react'))
    expect(t).not.toContain('Soft and short')
    expect(t).not.toContain('Write entries')
  })

  it('a persona with only CORE gets just its CORE section', () => {
    const t = renderCore({ name: 'Ada', expanded: '# CORE\nAda, 30, dry wit.\n\n# VOICE\nterse\n\n# EXTERNAL\ncalm' })
    expect(t.endsWith('Ada, 30, dry wit.')).toBe(true)
    expect(t).not.toContain('How you react')
  })

  it('a header without a space after # ends the CORE slice', () => {
    const t = renderCore({ name: 'Roger', expanded: '#CORE\nYou are Roger, a timid kid.\n\n#VOICE\nSpeak softly.\n\n#INTERNAL\nWants to belong.' })
    expect(t.endsWith('You are Roger, a timid kid.')).toBe(true)
    expect(t).not.toContain('Speak softly')
  })

  it('never throws on an empty persona', () => {
    expect(renderCore({})).toContain('You are this character. Stay this person.')
    expect(renderCore(null)).toContain('# CORE')
  })
})
