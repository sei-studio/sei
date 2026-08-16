import { describe, it, expect, vi } from 'vitest'
import { createLlmProvider, SUPPORTED_PROVIDERS } from './index.js'

const baseConfig = {
  anthropic: { api_key: 'sk-fake', model: 'claude-haiku-4-5', timeout_ms: 20_000 },
  llm: { provider: 'anthropic', providers: {} },
}

describe('createLlmProvider', () => {
  it('lists all 14 supported providers (incl. qwen and the grandfathered set)', () => {
    // 260816: qwen added; mistral/together/groq/fireworks/cerebras/perplexity
    // are grandfathered (hidden from the picker, still run here).
    expect(SUPPORTED_PROVIDERS).toEqual([
      'anthropic', 'openai', 'grok', 'openrouter', 'deepseek', 'qwen',
      'mistral', 'together', 'groq', 'fireworks', 'cerebras', 'perplexity',
      'gemini', 'ollama',
    ])
  })

  it('defaults to anthropic when llm.provider missing', () => {
    const p = createLlmProvider({ anthropic: baseConfig.anthropic })
    expect(p.kind).toBe('anthropic')
    expect(p.capabilities).toEqual({ vision: true, cached: true, local: false })
    expect(typeof p.call).toBe('function')
    expect(typeof p.buildCachedSystem).toBe('function')
    expect(typeof p.setAuthToken).toBe('function')
  })

  for (const kind of ['openai', 'grok', 'openrouter', 'deepseek', 'qwen', 'mistral', 'together', 'groq', 'fireworks', 'cerebras', 'perplexity']) {
    it(`returns openai-compat provider for kind=${kind}`, () => {
      const p = createLlmProvider({
        anthropic: baseConfig.anthropic,
        llm: { provider: kind, providers: { [kind]: { api_key: 'k', model: 'm' } } },
      })
      expect(p.kind).toBe(kind)
      expect(typeof p.call).toBe('function')
      expect(p.model).toBe('m')
    })
  }

  it('returns gemini provider', () => {
    const p = createLlmProvider({
      anthropic: baseConfig.anthropic,
      llm: { provider: 'gemini', providers: { gemini: { api_key: 'k', model: 'gem-1' } } },
    })
    expect(p.kind).toBe('gemini')
    expect(p.model).toBe('gem-1')
    expect(p.capabilities).toEqual({ vision: true, cached: true, local: false })
  })

  it('returns ollama provider with local capability', () => {
    const p = createLlmProvider({
      anthropic: baseConfig.anthropic,
      llm: { provider: 'ollama', providers: { ollama: { base_url: 'http://localhost:11434', model: 'llama3.1' } } },
    })
    expect(p.kind).toBe('ollama')
    expect(p.capabilities.local).toBe(true)
  })

  it('throws on unknown provider', () => {
    expect(() => createLlmProvider({
      anthropic: baseConfig.anthropic,
      llm: { provider: 'palantir' },
    })).toThrow(/Unknown llm.provider/)
  })

  it('throws when openai-compat api_key missing', () => {
    expect(() => createLlmProvider({
      anthropic: baseConfig.anthropic,
      llm: { provider: 'openai', providers: { openai: {} } },
    })).toThrow(/api_key missing/)
  })

  it('throws when gemini api_key missing', () => {
    expect(() => createLlmProvider({
      anthropic: baseConfig.anthropic,
      llm: { provider: 'gemini', providers: { gemini: {} } },
    })).toThrow(/api_key missing/)
  })
})

describe('openai-compat provider call', () => {
  it('issues a POST to baseURL/chat/completions with bearer auth and returns Anthropic-shape response', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{
          message: { content: 'hi', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'go', arguments: '{"x":1}' } }] },
          finish_reason: 'tool_calls',
        }],
        usage: { total_tokens: 42 },
      }),
    }))
    const p = createLlmProvider({
      anthropic: baseConfig.anthropic,
      llm: { provider: 'openai', providers: { openai: { api_key: 'sk-x', model: 'gpt-4o-mini' } } },
    }, { fetchImpl })
    const out = await p.call({
      systemBlocks: [{ type: 'text', text: 'sys' }],
      tools: [{ name: 'go', description: 'move', input_schema: { type: 'object', properties: {} } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://api.openai.com/v1/chat/completions')
    expect(opts.headers.authorization).toBe('Bearer sk-x')
    const body = JSON.parse(opts.body)
    expect(body.model).toBe('gpt-4o-mini')
    expect(body.messages[0]).toEqual({ role: 'system', content: 'sys' })
    expect(out.text).toBe('hi')
    expect(out.toolUses).toEqual([{ id: 'c1', name: 'go', input: { x: 1 } }])
  })

  it('qwen targets the DashScope compatible-mode base URL with default model qwen-plus', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
    }))
    const p = createLlmProvider({
      anthropic: baseConfig.anthropic,
      llm: { provider: 'qwen', providers: { qwen: { api_key: 'qk' } } },
    }, { fetchImpl })
    expect(p.model).toBe('qwen-plus')
    expect(p.capabilities).toEqual({ vision: false, cached: false, local: false })
    await p.call({ systemBlocks: [], tools: [], messages: [{ role: 'user', content: 'hi' }] })
    expect(fetchImpl.mock.calls[0][0]).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions')
  })

  it('deepseek defaults to deepseek-v4-flash, sends thinking:disabled, and never sends tool_choice', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
    }))
    const p = createLlmProvider({
      anthropic: baseConfig.anthropic,
      llm: { provider: 'deepseek', providers: { deepseek: { api_key: 'dk' } } },
    }, { fetchImpl })
    expect(p.model).toBe('deepseek-v4-flash')
    await p.call({
      systemBlocks: [{ type: 'text', text: 's' }],
      tools: [{ name: 'go', description: 'move', input_schema: { type: 'object', properties: {} } }],
      messages: [{ role: 'user', content: 'hi' }],
    })
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body)
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect('tool_choice' in body).toBe(false)
  })

  it('non-deepseek providers do not get the thinking extra', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
    }))
    const p = createLlmProvider({
      anthropic: baseConfig.anthropic,
      llm: { provider: 'openai', providers: { openai: { api_key: 'k', model: 'm' } } },
    }, { fetchImpl })
    await p.call({ systemBlocks: [], tools: [], messages: [] })
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body)
    expect('thinking' in body).toBe(false)
  })

  it('deepseek floors the request timeout at 60s (no fast abort at CN peak queueing)', async () => {
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    try {
      const fetchImpl = vi.fn(async () => ({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
      }))
      const ds = createLlmProvider({
        anthropic: baseConfig.anthropic,
        llm: { provider: 'deepseek', providers: { deepseek: { api_key: 'dk' } } },
      }, { fetchImpl })
      await ds.call({ systemBlocks: [], tools: [], messages: [], timeoutMs: 20_000 })
      const dsDelay = timeoutSpy.mock.calls.at(-1)[1]
      expect(dsDelay).toBe(60_000)

      const oa = createLlmProvider({
        anthropic: baseConfig.anthropic,
        llm: { provider: 'openai', providers: { openai: { api_key: 'k', model: 'm' } } },
      }, { fetchImpl })
      await oa.call({ systemBlocks: [], tools: [], messages: [], timeoutMs: 20_000 })
      const oaDelay = timeoutSpy.mock.calls.at(-1)[1]
      expect(oaDelay).toBe(20_000)
    } finally {
      timeoutSpy.mockRestore()
    }
  })

  it('throws with status code embedded on non-2xx', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false, status: 429, text: async () => 'rate limited',
    }))
    const p = createLlmProvider({
      anthropic: baseConfig.anthropic,
      llm: { provider: 'openai', providers: { openai: { api_key: 'k', model: 'm' } } },
    }, { fetchImpl })
    await expect(p.call({ systemBlocks: [], tools: [], messages: [] }))
      .rejects.toThrow(/openai API 429/)
  })
})

describe('ollama provider call', () => {
  it('targets /api/chat with stream:false and parses message.tool_calls', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        message: { role: 'assistant', content: 'hi', tool_calls: [{ function: { name: 'go', arguments: { x: 1 } } }] },
        done_reason: 'stop',
        prompt_eval_count: 5,
        eval_count: 7,
      }),
    }))
    const p = createLlmProvider({
      anthropic: baseConfig.anthropic,
      llm: { provider: 'ollama', providers: { ollama: { base_url: 'http://localhost:11434', model: 'llama3.1' } } },
    }, { fetchImpl })
    const out = await p.call({ systemBlocks: [{ type: 'text', text: 's' }], tools: [], messages: [{ role: 'user', content: 'hi' }] })
    expect(fetchImpl.mock.calls[0][0]).toBe('http://localhost:11434/api/chat')
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body)
    expect(body.stream).toBe(false)
    expect(out.text).toBe('hi')
    expect(out.toolUses).toEqual([{ id: expect.stringMatching(/^toolu_/), name: 'go', input: { x: 1 } }])
    expect(out.usage).toEqual({ prompt_tokens: 5, completion_tokens: 7 })
  })
})

describe('gemini provider call', () => {
  it('targets v1beta generateContent with API key in query and parses parts', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        candidates: [{
          content: { parts: [{ text: 'hello' }, { functionCall: { name: 'go', args: { x: 1 } } }] },
          finishReason: 'STOP',
        }],
        usageMetadata: { totalTokenCount: 10 },
      }),
    }))
    const p = createLlmProvider({
      anthropic: baseConfig.anthropic,
      llm: { provider: 'gemini', providers: { gemini: { api_key: 'gk', model: 'gemini-2.0-flash' } } },
    }, { fetchImpl })
    const out = await p.call({
      systemBlocks: [{ type: 'text', text: 'sys' }],
      tools: [{ name: 'go', description: 'move', input_schema: { type: 'object', properties: {} } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })
    const url = fetchImpl.mock.calls[0][0]
    expect(url).toContain('generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent')
    expect(url).toContain('key=gk')
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body)
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'sys' }] })
    expect(body.tools[0].functionDeclarations[0].name).toBe('go')
    expect(out.text).toBe('hello')
    expect(out.toolUses[0]).toEqual({ id: expect.stringMatching(/^toolu_/), name: 'go', input: { x: 1 } })
  })
})
