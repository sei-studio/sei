// src/bot/brain/postProcessSay.test.js
//
// 260616: all hardcoded content filters (telemetry/narration regex, fragment
// words) were removed — nothing is banned by phrase or keyword. postProcessSay
// now only NORMALIZES (whitespace collapse, lowercase, 256-char cap) and
// splitChatMessages only SPLITS a line into texting-style messages (count
// capped). These tests pin that normalize/split behavior and that no message is
// dropped for what it says.

import { describe, it, expect } from 'vitest'
import { postProcessSay, splitChatMessages } from './orchestrator.js'

describe('postProcessSay — normalize only (no content filter)', () => {
  it('collapses whitespace', () => {
    expect(postProcessSay('  hello   world ')).toBe('hello world')
  })

  it('keeps ALL-CAPS words as emphasis, lowercases everything else', () => {
    expect(postProcessSay('WATCH THIS')).toBe('WATCH THIS')
    expect(postProcessSay('Oh Good')).toBe('oh good')
    expect(postProcessSay("i'm an AI it's fine")).toBe("i'm an AI it's fine")
    expect(postProcessSay('diamonds. DIAMONDS.')).toBe('diamonds. DIAMONDS.')
    expect(postProcessSay('I')).toBe('i') // single letter is not emphasis
    expect(postProcessSay('ok we are building a BASE')).toBe('ok we are building a BASE')
  })

  it('returns empty for empty/whitespace/null input', () => {
    expect(postProcessSay('')).toBe('')
    expect(postProcessSay('   ')).toBe('')
    expect(postProcessSay(null)).toBe('')
  })

  it('caps at 256 chars', () => {
    expect(postProcessSay('x'.repeat(400)).length).toBe(256)
  })

  // 260707: the ONE exception to "no content filter" — a line that is nothing
  // but a bracketed/asterisked silence placeholder is the model acting out an
  // instruction ("silence is fine") instead of staying quiet, and it was being
  // spoken aloud on calls. Dropped entirely; real lines still pass.
  it('drops bracketed "(silence)"-style filler entirely', () => {
    expect(postProcessSay('(silence)')).toBe('')
    expect(postProcessSay('[silence]')).toBe('')
    expect(postProcessSay('*stays silent*')).toBe('')
    expect(postProcessSay('(staying silent)')).toBe('')
    expect(postProcessSay('(remains quiet)')).toBe('')
    expect(postProcessSay('(says nothing)')).toBe('')
    expect(postProcessSay('( no reply )')).toBe('')
  })

  // Real lines captured from a Sui/Marv game transcript (260707): the model
  // embellishes the marker with a trailing clause, or shortens it to
  // "(nothing)". These leaked past the first, stricter pattern.
  it('drops embellished silence markers from the real transcript', () => {
    expect(postProcessSay('(staying silent, letting it rest)')).toBe('')
    expect(postProcessSay('(saying nothing, the thread has landed)')).toBe('')
    expect(postProcessSay('(nothing)')).toBe('')
    expect(postProcessSay('(silence, just watching the furnace)')).toBe('')
  })

  it('keeps in-character lines that merely mention silence', () => {
    expect(postProcessSay('silence!')).toBe('silence!')
    expect(postProcessSay('the silence here is creepy')).toBe('the silence here is creepy')
    expect(postProcessSay('(sigh) fine, silence it is')).toBe('(sigh) fine, silence it is')
    // Content after the closing bracket = a real line, not a marker.
    expect(postProcessSay('(silence) okay fine, one more thing')).toBe(
      '(silence) okay fine, one more thing',
    )
    // "nothing" with a tail is a real aside, only the bare form is a marker.
    expect(postProcessSay('(nothing but bones down here)')).toBe('(nothing but bones down here)')
  })

  it('passes content through unchanged — nothing is banned', () => {
    // Lines the old filter used to drop now ship (lowercased).
    for (const line of [
      'gather still running, 8/10',
      'staying silent',
      'let me look around',
      "i've got 4 logs, need 10 total",
      'you',
    ]) {
      expect(postProcessSay(line)).toBe(line.toLowerCase())
    }
  })

  it('keeps a parenthetical aside (no longer dropped)', () => {
    expect(postProcessSay('(took forever.)')).toBe('(took forever.)')
  })
})

describe('splitChatMessages — texting-style split (no content filter)', () => {
  it('splits two sentences into two messages and drops trailing periods', () => {
    expect(splitChatMessages('i have ten logs. time to build your statue.'))
      .toEqual(['i have ten logs', 'time to build your statue'])
  })

  it('breaks on an em-dash / en-dash / spaceless em-dash', () => {
    expect(splitChatMessages('gonna build a base — walls, roof, the works'))
      .toEqual(['gonna build a base', 'walls, roof, the works'])
    expect(splitChatMessages('ok listen – you dig down')).toEqual(['ok listen', 'you dig down'])
    expect(splitChatMessages('base—walls')).toEqual(['base', 'walls'])
  })

  it('does NOT split list commas', () => {
    expect(splitChatMessages('build walls, roof, and a door')).toEqual(['build walls, roof, and a door'])
  })

  it('keeps ? and ! (they carry tone)', () => {
    expect(splitChatMessages('you nearby? i need wood')).toEqual(['you nearby?', 'i need wood'])
    expect(splitChatMessages('WATCH THIS! it works')).toEqual(['WATCH THIS!', 'it works'])
  })

  it('no message cap — every segment ships', () => {
    expect(splitChatMessages('one. two. three. four. five.'))
      .toEqual(['one', 'two', 'three', 'four', 'five'])
  })

  it('ships every segment by content — fragments and narration are NOT dropped', () => {
    // Old behavior dropped the lone "you" and narration shapes; now nothing is
    // banned, so they ship.
    expect(splitChatMessages("you. i've got 8 logs now")).toEqual(['you', "i've got 8 logs now"])
    expect(splitChatMessages('let me look around. ugh so many trees'))
      .toEqual(['let me look around', 'ugh so many trees'])
  })

  it('empty input yields no messages', () => {
    expect(splitChatMessages('')).toEqual([])
    expect(splitChatMessages(null)).toEqual([])
  })

  // 260705: per-character punctuation register (config.persona.punctuation).
  it('casual keeps a trailing ellipsis — only a LONE period is stripped', () => {
    expect(splitChatMessages('hm... fine')).toEqual(['hm...', 'fine'])
    expect(splitChatMessages('great...')).toEqual(['great...'])
    expect(splitChatMessages('done.')).toEqual(['done'])
  })

  it('deliberate keeps trailing periods but still splits into messages', () => {
    expect(splitChatMessages('done. as ordered. as always.', 'deliberate'))
      .toEqual(['done.', 'as ordered.', 'as always.'])
    expect(splitChatMessages('you nearby? i need wood.', 'deliberate'))
      .toEqual(['you nearby?', 'i need wood.'])
    expect(splitChatMessages('hm... fine.', 'deliberate')).toEqual(['hm...', 'fine.'])
  })
})
