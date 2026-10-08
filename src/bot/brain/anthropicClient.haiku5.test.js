// 261008: every bot-process Anthropic request (game brains, in-game voice,
// the compactor's Sonnet override) goes through anthropicClient.call, which
// applies the Haiku 5 rules: thinking disabled unless adaptive was asked for,
// and never a fixed budget. Covers the plain create and the voice streaming
// path, the configured model and a per-call override.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const createMock = vi.fn()

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    constructor() {
      this.messages = { create: (...args) => createMock(...args) }
    }
  },
}))

vi.mock('./log.js', () => ({
  logHaikuQuery: () => {},
  logHaikuResponse: () => {},
  logHaikuError: () => {},
}))

const { createAnthropicClient } = await import('./anthropicClient.js')

const OK = { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn' }
const config = (model) => ({ anthropic: { model, timeout_ms: 10_000, cloudMode: { baseURL: 'https://api.sei.gg', authToken: 'jwt' } } })
const base = { systemBlocks: [{ type: 'text', text: 'sys' }], tools: [], messages: [{ role: 'user', content: 'hi' }] }

async function* streamOf(events) { for (const e of events) yield e }

beforeEach(() => {
  createMock.mockReset()
  createMock.mockResolvedValue(OK)
})

describe('anthropicClient.call on Haiku 5', () => {
  it('sends thinking disabled for the configured Haiku 5 model', async () => {
    const c = createAnthropicClient(config('claude-haiku-5-5'))
    await c.call(base)
    expect(createMock.mock.calls[0][0]).toMatchObject({ model: 'claude-haiku-5-5', thinking: { type: 'disabled' } })
  })

  it('turns the thinking_budget_tokens dev knob into thinking disabled', async () => {
    const c = createAnthropicClient(config('claude-haiku-5-5'))
    await c.call({ ...base, maxTokens: 2048, thinking: { type: 'enabled', budget_tokens: 1024 } })
    expect(createMock.mock.calls[0][0].thinking).toEqual({ type: 'disabled' })
  })

  it('applies to the voice streaming path too', async () => {
    createMock.mockResolvedValue(streamOf([
      { type: 'message_start', message: { usage: { input_tokens: 1 } } },
      { type: 'content_block_start', content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hey' } },
      { type: 'content_block_stop' },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    ]))
    const c = createAnthropicClient(config('claude-haiku-5-5'))
    await c.call({ ...base, onSay: () => {} })
    expect(createMock.mock.calls[0][0]).toMatchObject({ stream: true, thinking: { type: 'disabled' } })
  })

  it('applies to a per-call Haiku 5 override and leaves Haiku 4.5 and Sonnet alone', async () => {
    const c = createAnthropicClient(config('claude-haiku-4-5'))
    await c.call(base)
    expect(createMock.mock.calls[0][0]).not.toHaveProperty('thinking')
    await c.call({ ...base, model: 'claude-sonnet-5' })
    expect(createMock.mock.calls[1][0]).not.toHaveProperty('thinking')
    await c.call({ ...base, model: 'claude-haiku-5-5' })
    expect(createMock.mock.calls[2][0].thinking).toEqual({ type: 'disabled' })
  })
})
