import { describe, it, expect } from 'vitest'
import { minecraftVocabulary } from './vocabulary.js'
import { repeatedOwnPhrases, repeatedOpener } from '../../brain/ownRepeats.js'

const session = (turns, start = 1_000_000) => turns.map((text, i) => ({ at: start + i * 5000, text }))
const now = (n) => 1_000_000 + n * 5000 + 1000

describe('minecraftVocabulary', () => {
  it('holds item, block and mob words, and is the same array each call', () => {
    const v = minecraftVocabulary('1.21.4')
    for (const w of ['oak', 'log', 'ingot', 'iron', 'table', 'zombie', 'cobblestone', 'tree']) expect(v).toContain(w)
    expect(minecraftVocabulary('1.21.4')).toBe(v)
  })

  it('leaves out describing words, disc titles and sherd motifs', () => {
    const v = minecraftVocabulary('1.21.4')
    for (const w of ['dead', 'small', 'happy', 'wait', 'friend', 'danger', 'player']) expect(v).not.toContain(w)
  })

  it('falls back to a known version when the bot has none yet', () => {
    expect(minecraftVocabulary(undefined)).toContain('pickaxe')
    expect(minecraftVocabulary('0.0.0-not-a-version')).toContain('pickaxe')
  })
})

// The review probes, through the real word list.
describe('the repeat note with the real vocabulary', () => {
  const vocab = minecraftVocabulary('1.21.4')

  it('never names the job', () => {
    expect(repeatedOwnPhrases(session(['heading to the oak trees', 'heading to the oak trees']), [], { now: now(2), vocab })).toEqual([])
    expect(repeatedOwnPhrases(session(['need a crafting table', 'need a crafting table']), [], { now: now(2), vocab })).toEqual([])
    expect(repeatedOwnPhrases(session(['need iron ingots', 'need iron ingots']), [], { now: now(2), vocab, context: ['raw_ironÃ—3'] })).toEqual([])
    expect(repeatedOpener(session(["table's down", "table's ready"]), { now: now(2), vocab })).toBeNull()
  })

  it('still names her own bits', () => {
    expect(repeatedOwnPhrases(session(["you're the boss of the wood pile", 'ok boss of the wood pile']), [], { now: now(2), vocab })
      .map((h) => h.phrase)).toEqual(['boss of the wood pile'])
    expect(repeatedOwnPhrases(session(['you owe me a snack', 'fine, you owe me a snack']), [], { now: now(2), vocab })
      .map((h) => h.phrase)).toEqual(['owe me a snack'])
  })
})




