// src/bot/brain/anthropicClient.rescueRetry.test.js
//
// Rescue-retry policy (post-260610). Transient failures (5xx / 429 /
// connection blips) are origin-wide — vision and plain turns share the same
// proxy origin — so call() gives EVERY request up to MAX_RESCUE_RETRIES (2)
// retries, under the unchanged deadline controller (total wall-clock is still
// hard-capped by the call budget; sleeps stay short, capped, abortable —
// the 260609 frozen-bot constraints all hold). These tests assert:
//   1. Two transient failures, then success → response returned (3 requests).
//   2. Three transient failures → terminal (allowance exhausted, 3 requests).
//   3. Non-retryable 4xx → terminal immediately (1 request).

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

// retry-after: 0 pins the rescue sleep to its 100ms floor so tests stay fast.
function transient(status) {
  const err = new Error(`${status} transient`)
  err.status = status
  err.headers = { get: (k) => (k === 'retry-after' ? '0' : null) }
  return err
}

const OK_RESPONSE = {
  content: [{ type: 'text', text: 'fine. i answered.' }],
  usage: { input_tokens: 1, output_tokens: 1 },
  stop_reason: 'end_turn',
}

function makeConfig() {
  return {
    anthropic: {
      model: 'claude-haiku-4-5',
      timeout_ms: 10_000,
      cloudMode: { baseURL: 'https://api.sei.gg', authToken: 'jwt' },
    },
  }
}

const REQ = { systemBlocks: [{ type: 'text', text: 'sys' }], tools: [], messages: [{ role: 'user', content: 'hi' }] }

describe('rescue-retry policy', () => {
  beforeEach(() => {
    createMock.mockReset()
  })

  it('recovers from two consecutive transient failures (5xx then 429)', async () => {
    createMock
      .mockRejectedValueOnce(transient(502))
      .mockRejectedValueOnce(transient(429))
      .mockResolvedValueOnce(OK_RESPONSE)
    const client = createAnthropicClient(makeConfig())

    const result = await client.call({ ...REQ })

    expect(result.text).toBe('fine. i answered.')
    expect(createMock).toHaveBeenCalledTimes(3)
  })

  it('three transient failures exhaust the allowance and surface the last error', async () => {
    createMock.mockImplementation(() => Promise.reject(transient(502)))
    const client = createAnthropicClient(makeConfig())

    await expect(client.call({ ...REQ })).rejects.toMatchObject({ status: 502 })
    expect(createMock).toHaveBeenCalledTimes(3)
  })

  it('non-retryable 4xx is terminal on the first attempt', async () => {
    const err = new Error('400 bad request')
    err.status = 400
    createMock.mockRejectedValue(err)
    const client = createAnthropicClient(makeConfig())

    await expect(client.call({ ...REQ })).rejects.toMatchObject({ status: 400 })
    expect(createMock).toHaveBeenCalledTimes(1)
  })
})
