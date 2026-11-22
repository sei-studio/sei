import { describe, it, expect } from 'vitest'
import {
  LONG_PROMPT_TIER_TOKENS, TRIM_NOTE, IMAGE_STUB,
  longPromptTierFor, contextLimitFor,
  estimateTextTokens, estimateImageTokens, imageDimsFromBase64, estimateRequestTokens,
  fitPromptBudget, applyPromptBudget, describeBudgetReport,
} from './promptBudget.js'

// ~1 token per 4-letter word under the estimator: "abcd " = 2 tokens (ceil(4/3.5)).
const words = (n) => 'abcd '.repeat(n)
const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] })
const asst = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] })

function pngB64(w, h) {
  const b = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20)
  return b.toString('base64')
}
function jpegB64(w, h) {
  // SOI, APP0 (len 16), SOF0 with height/width.
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(14)])
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0])
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(16)]).toString('base64')
}
const img = (data, media = 'image/png') => ({ type: 'image', source: { type: 'base64', media_type: media, data } })

describe('model tables', () => {
  it('only Haiku 5.x has the long-prompt tier', () => {
    expect(longPromptTierFor('claude-haiku-5-5')).toBe(LONG_PROMPT_TIER_TOKENS)
    expect(longPromptTierFor('claude-haiku-5-5-20261001')).toBe(LONG_PROMPT_TIER_TOKENS)
    expect(longPromptTierFor('claude-haiku-4-5')).toBeNull()
    expect(longPromptTierFor('claude-sonnet-5')).toBeNull()
    expect(longPromptTierFor(undefined)).toBeNull()
  })
  it('hard input limits come from the Models API (261013)', () => {
    expect(contextLimitFor('claude-haiku-5-5')).toBe(1_000_000)
    expect(contextLimitFor('claude-sonnet-5')).toBe(1_000_000)
    expect(contextLimitFor('claude-opus-5')).toBe(1_000_000)
    expect(contextLimitFor('claude-haiku-4-5-20251001')).toBe(200_000)
    expect(contextLimitFor('gpt-5')).toBeNull()
    expect(contextLimitFor('qwen3:8b')).toBeNull()
  })
})

describe('estimator', () => {
  it('counts letters, digits, punctuation and CJK the calibrated way', () => {
    expect(estimateTextTokens('')).toBe(0)
    expect(estimateTextTokens('hello world')).toBe(4) // ceil(5/3.5) * 2
    expect(estimateTextTokens('12345')).toBe(2)
    expect(estimateTextTokens('a, b.')).toBe(4)
    expect(estimateTextTokens('ã“ã‚“ã«ã¡ã¯')).toBe(7) // 5 * 1.4
  })
  it('over-counts measured English prose (3.17 chars/token on haiku-5-5)', () => {
    const prose = 'The companion walks over to the crafting table and asks the player what they want to build next. '.repeat(50)
    expect(estimateTextTokens(prose)).toBeGreaterThan(prose.length / 3.17)
  })
  it('reads image sizes and applies the 5.5 resize rule', () => {
    expect(imageDimsFromBase64(pngB64(800, 600))).toEqual({ w: 800, h: 600 })
    expect(imageDimsFromBase64(jpegB64(1204, 1008))).toEqual({ w: 1204, h: 1008 })
    expect(estimateImageTokens(img(pngB64(256, 256)))).toBe(Math.ceil(256 * 256 / 750) + 20)
    // Huge images cap at the measured maximum; unknown size counts as the cap.
    expect(estimateImageTokens(img(pngB64(3840, 2160)))).toBeLessThanOrEqual(4_800)
    expect(estimateImageTokens(img('not-an-image'))).toBe(4_800)
  })
})

describe('applyPromptBudget: the price tier is logged, never trimmed', () => {
  it('returns null and leaves a normal request alone', () => {
    const req = { model: 'claude-haiku-5-5', system: 'sys', messages: [user('hi'), asst('hey'), user('sup')] }
    const before = req.messages
    expect(applyPromptBudget(req)).toBeNull()
    expect(req.messages).toBe(before)
  })
  it('reports a Haiku 5.5 request over 100k and sends it untouched', () => {
    const msgs = []
    for (let i = 0; i < 30; i++) msgs.push(user(words(2_500)), asst(words(2_500)))
    msgs.push(user('latest'))
    const req = { model: 'claude-haiku-5-5', messages: msgs }
    const before = req.messages
    const r = applyPromptBudget(req, { pinFirst: 1 })
    expect(r).not.toBeNull()
    expect(r.longTier).toBe(true)
    expect(r.trim).toBeNull()
    expect(r.estBefore).toBeGreaterThan(LONG_PROMPT_TIER_TOKENS)
    expect(req.messages).toBe(before)
    expect(describeBudgetReport(r, 'bot')).toMatch(/over the long-prompt tier, sent untouched/)
  })
  it('does not flag flat-priced models', () => {
    const msgs = [user(words(80_000))]
    expect(applyPromptBudget({ model: 'claude-sonnet-5', messages: msgs })).toBeNull()
    expect(applyPromptBudget({ model: 'gpt-5', messages: msgs })).toBeNull()
  })
})

describe('applyPromptBudget: context safety net near the hard limit', () => {
  it('drops the oldest turns only past 90% of 1M, keeping the seed and the latest turn', () => {
    const seed = user('SEED ' + words(1_000))
    const msgs = [seed]
    // 24 turns of ~40k tokens each = ~960k: over the 900k net.
    for (let i = 0; i < 12; i++) msgs.push(asst(`a${i} ` + words(20_000)), user(`u${i} ` + words(20_000)))
    const req = { model: 'claude-haiku-5-5', messages: msgs }
    const r = applyPromptBudget(req, { pinFirst: 1 })
    expect(r.trim).not.toBeNull()
    expect(r.trim.droppedMessages).toBeGreaterThan(0)
    expect(r.trim.estAfter).toBeLessThanOrEqual(900_000)
    expect(req.messages[0].content[0].text.startsWith('SEED')).toBe(true)
    expect(req.messages.at(-1)).toBe(msgs.at(-1))
    expect(describeBudgetReport(r)).toMatch(/context safety net/)
    // Roles still alternate: the note rides inside an existing user turn.
    for (let i = 1; i < req.messages.length; i++) expect(req.messages[i].role).not.toBe(req.messages[i - 1].role)
    expect(JSON.stringify(req.messages)).toContain(TRIM_NOTE)
  })
  it('a 400k Haiku 5.5 prompt is sent whole', () => {
    const msgs = []
    for (let i = 0; i < 10; i++) msgs.push(user(words(20_000)), asst(words(20_000)))
    msgs.push(user('latest'))
    const req = { model: 'claude-haiku-5-5', messages: msgs }
    const r = applyPromptBudget(req)
    expect(r.longTier).toBe(true)
    expect(r.trim).toBeNull()
    expect(req.messages).toBe(msgs)
  })
  it('uses the 200k limit for Haiku 4.5', () => {
    const msgs = []
    for (let i = 0; i < 6; i++) msgs.push(user(words(20_000)), asst(words(20_000)))
    msgs.push(user('latest'))
    const req = { model: 'claude-haiku-4-5', messages: msgs }
    const r = applyPromptBudget(req)
    expect(r.longTier).toBe(false)
    expect(r.trim.estAfter).toBeLessThanOrEqual(180_000)
  })
})

describe('fitPromptBudget mechanics', () => {
  const opts = { ceiling: 1_000, quantum: 400 }

  it('never orphans a tool_result and never drops the latest exchange', () => {
    const msgs = [
      user(words(200)),
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'dig', input: { x: 1 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: words(300) }] },
      asst(words(200)),
      user(words(200)),
      { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'dig', input: { x: 2 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }] },
    ]
    const r = fitPromptBudget({ messages: msgs }, opts)
    const out = r.messages
    expect(out[0].role).toBe('user')
    // The first kept user turn must not answer a dropped tool_use.
    expect(out[0].content.some(b => b.type === 'tool_result')).toBe(false)
    expect(out.at(-1)).toBe(msgs.at(-1))
    expect(out.at(-2)).toBe(msgs.at(-2))
    expect(out[0].content[0].text).toBe(TRIM_NOTE)
  })

  it('moves the cut once per quantum of growth, not once per turn', () => {
    const msgs = []
    for (let i = 0; i < 14; i++) msgs.push(user(`u${i} ` + words(50)), asst(`a${i} ` + words(50)))
    const dropped = []
    let thread = msgs.slice()
    for (let k = 0; k < 8; k++) {
      thread = [...thread, user(`n${k} ` + words(50)), asst(`m${k} ` + words(50))]
      const r = fitPromptBudget({ messages: [...thread, user('latest')] }, { ceiling: 2_000, quantum: 1_500 })
      expect(r.estAfter).toBeLessThanOrEqual(2_000)
      dropped.push(r.droppedMessages)
    }
    // Eight turns of growth (~1,700 tokens) cross one 1,500-token quantum:
    // the cut moves at most once (each move rewrites the cache once).
    const moves = dropped.filter((d, i) => i > 0 && d !== dropped[i - 1]).length
    expect(moves).toBeLessThanOrEqual(1)
  })

  it('stubs old images, then shortens old tool results, when dropping is not enough', () => {
    const big = pngB64(1600, 1600)
    const msgs = [
      user('seed'),
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'look', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [img(big), { type: 'text', text: words(4_000) }] }] },
    ]
    const r = fitPromptBudget({ messages: msgs }, { ceiling: 1_200, quantum: 100, pinFirst: 1 })
    expect(r.droppedMessages).toBe(0)
    // The latest message keeps its image; only its oversized text is cut.
    expect(r.strippedImages).toBe(0)
    expect(r.shortenedResults).toBeGreaterThan(0)
    expect(r.messages.at(-1).content[0].content[0].type).toBe('image')

    const withOld = [
      user('seed'),
      { role: 'user', content: [img(big)] },
      asst('ok'),
      user('latest'),
    ]
    const r2 = fitPromptBudget({ messages: withOld }, { ceiling: 300, quantum: 100, pinFirst: 3 })
    expect(r2.strippedImages).toBe(1)
    expect(r2.messages[1].content[0]).toEqual({ type: 'text', text: IMAGE_STUB })
    expect(withOld[1].content[0].type).toBe('image') // input untouched
  })

  it('estimates the whole request including tools and system', () => {
    const req = { system: [{ type: 'text', text: words(100) }], tools: [{ name: 'dig', description: 'dig a block', input_schema: { type: 'object' } }], messages: [user('hi')] }
    expect(estimateRequestTokens(req)).toBeGreaterThan(350 + 200)
    const ws = { ...req, tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }] }
    expect(estimateRequestTokens(ws)).toBeGreaterThan(3_000)
  })
})




