import { describe, it, expect } from 'vitest'
import { createSessionDigest, DIGEST_MAX_LINES, DIGEST_LINE_CHARS } from './sessionDigest.js'
import { createConvoMemory } from './convoMemory.js'

describe('sessionDigest', () => {
  it('keeps the last lines, truncated, and counts each side over the session', () => {
    const d = createSessionDigest()
    for (let i = 0; i < DIGEST_MAX_LINES + 4; i++) d.record(i % 2 ? 'you' : 'player', `line ${i}`)
    d.record('other', 'x'.repeat(DIGEST_LINE_CHARS + 50))
    const snap = d.snapshot()
    expect(snap.lines).toHaveLength(DIGEST_MAX_LINES)
    expect(snap.lines.at(-1)).toEqual({ who: 'other', text: 'x'.repeat(DIGEST_LINE_CHARS) })
    expect(snap.lines[0].text).toBe('line 5')
    expect(snap.playerLines).toBe(10)
    expect(snap.selfLines).toBe(10)
  })

  it('tracks dirtiness so the bot only posts when something changed', () => {
    const d = createSessionDigest()
    expect(d.isDirty()).toBe(false)
    d.record('player', '   ')
    expect(d.isDirty()).toBe(false)
    d.record('player', 'hi\n  there')
    expect(d.isDirty()).toBe(true)
    expect(d.snapshot().lines).toEqual([{ who: 'player', text: 'hi there' }])
    expect(d.isDirty()).toBe(false)
  })
})

describe('convoMemory onLine tap', () => {
  it('hands every recorded line to onLine with who it came from', () => {
    const seen = []
    const { recentChat } = createConvoMemory({ onLine: (who, text) => seen.push([who, text]) })
    recentChat.pushPlayer('Alex', 'want to build a cabin?')
    recentChat.pushPlayer('Lyra', 'I can help', { companion: true })
    recentChat.pushSelf('Sui', 'yes, by the lake')
    recentChat.pushPlayer('Alex', '   ')
    expect(seen).toEqual([
      ['player', 'want to build a cabin?'],
      ['other', 'I can help'],
      ['you', 'yes, by the lake'],
    ])
  })

  it('a throwing tap never breaks the ring buffers', () => {
    const { recentChat } = createConvoMemory({ onLine: () => { throw new Error('boom') } })
    recentChat.pushPlayer('Alex', 'hello')
    recentChat.pushSelf('Sui', 'hi')
    expect(recentChat.playerSize).toBe(1)
    expect(recentChat.selfSize).toBe(1)
  })
})
