// 261008: the Haiku 5 request rules (anthropicModelDefaults.js). Haiku 5
// thinks unless told not to and rejects a fixed thinking budget, sampling
// params and assistant prefill with HTTP 400, so every request builder runs
// its body through applyAnthropicModelDefaults. Other models pass untouched.

import { describe, it, expect } from 'vitest'
import { applyAnthropicModelDefaults, isHaiku5Model } from './anthropicModelDefaults.js'

const user = (text) => ({ role: 'user', content: text })
const assistant = (text) => ({ role: 'assistant', content: text })

describe('isHaiku5Model', () => {
  it('matches Haiku 5 aliases and dated snapshots only', () => {
    for (const m of ['claude-haiku-5-5', 'claude-haiku-5', 'claude-haiku-5-5-20260930', 'claude-haiku-5-6']) {
      expect(isHaiku5Model(m), m).toBe(true)
    }
    for (const m of ['claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-5', 'gpt-5-mini', '', undefined, null, 'anthropic/claude-haiku-4.5', 'claude-haiku-50']) {
      expect(isHaiku5Model(m), String(m)).toBe(false)
    }
  })
})

describe('applyAnthropicModelDefaults', () => {
  it('disables thinking on Haiku 5 when the request has no thinking field', () => {
    const req = applyAnthropicModelDefaults({ model: 'claude-haiku-5-5', max_tokens: 160, messages: [user('hi')] })
    expect(req.thinking).toEqual({ type: 'disabled' })
  })

  it('turns a fixed thinking budget into thinking disabled on Haiku 5', () => {
    const req = applyAnthropicModelDefaults({
      model: 'claude-haiku-5-5', max_tokens: 2048, messages: [user('hi')],
      thinking: { type: 'enabled', budget_tokens: 1024 },
    })
    expect(req.thinking).toEqual({ type: 'disabled' })
  })

  it('keeps an explicit disabled or adaptive setting', () => {
    expect(applyAnthropicModelDefaults({ model: 'claude-haiku-5-5', messages: [user('x')], thinking: { type: 'adaptive' } }).thinking)
      .toEqual({ type: 'adaptive' })
    expect(applyAnthropicModelDefaults({ model: 'claude-haiku-5-5', messages: [user('x')], thinking: { type: 'disabled' } }).thinking)
      .toEqual({ type: 'disabled' })
  })

  it('removes temperature, top_p and top_k on Haiku 5', () => {
    const req = applyAnthropicModelDefaults({ model: 'claude-haiku-5-5', messages: [user('x')], temperature: 0, top_p: 0.9, top_k: 5 })
    expect(req).not.toHaveProperty('temperature')
    expect(req).not.toHaveProperty('top_p')
    expect(req).not.toHaveProperty('top_k')
  })

  it('removes a trailing assistant prefill on Haiku 5 without touching the caller array', () => {
    const messages = [user('hi'), assistant('sure'), user('go on'), assistant('{"')]
    const req = applyAnthropicModelDefaults({ model: 'claude-haiku-5-5', messages })
    expect(req.messages).toEqual([user('hi'), assistant('sure'), user('go on')])
    expect(messages).toHaveLength(4)
  })

  it('leaves a request that ends on a user turn (tool results included) alone', () => {
    const messages = [
      user('hi'),
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'say', input: { text: 'yo' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    ]
    const req = applyAnthropicModelDefaults({ model: 'claude-haiku-5-5', messages })
    expect(req.messages).toBe(messages)
  })

  it('returns Haiku 4.5, Sonnet and other-provider requests unchanged', () => {
    for (const model of ['claude-haiku-4-5', 'claude-sonnet-5', 'gpt-5-mini']) {
      const body = { model, max_tokens: 10, temperature: 0, messages: [user('a'), assistant('b')] }
      const copy = structuredClone(body)
      expect(applyAnthropicModelDefaults(body)).toEqual(copy)
    }
  })

  it('tolerates a missing body', () => {
    expect(applyAnthropicModelDefaults(undefined)).toBeUndefined()
  })
})
