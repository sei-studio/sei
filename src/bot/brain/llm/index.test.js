import { describe, it, expect, vi } from 'vitest'
import { createLlmProvider, SUPPORTED_PROVIDERS } from './index.js'
import { clearOllamaContextState, neededNumCtx } from './ollamaContext.js'
import { LOCAL_TIMEOUT_FLOOR_MS } from './ollamaProvider.js'

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
    expect(p.capabilities).toEqual({ vision: true, cached: true, local: false, serverWebSearch: true })
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
    // The provider's own /api/show capability probe (261010) also rides fetchImpl.
    const chatCall = fetchImpl.mock.calls.find(c => c[0].endsWith('/api/chat'))
    expect(chatCall[0]).toBe('http://localhost:11434/api/chat')
    const body = JSON.parse(chatCall[1].body)
    expect(body.stream).toBe(false)
    // 260915: thinking is switched off on the wire so qwen3/deepseek-r1-class
    // models cannot spend the whole num_predict budget in message.thinking.
    expect(body.think).toBe(false)
    expect(out.text).toBe('hi')
    expect(out.toolUses).toEqual([{ id: expect.stringMatching(/^toolu_/), name: 'go', input: { x: 1 } }])
    expect(out.usage).toEqual({ prompt_tokens: 5, completion_tokens: 7 })
  })
})

// 261010 ("Ollama vision models all not working"): vision used to be
// hard-coded false for every Ollama model, and images went out in the OpenAI
// array shape that /api/chat rejects.
describe('ollama provider vision', () => {
  const ollamaCfg = (model) => ({
    anthropic: baseConfig.anthropic,
    llm: { provider: 'ollama', providers: { ollama: { base_url: 'http://localhost:11434', model } } },
  })
  const routed = (show) => vi.fn(async (url, init) => {
    if (url.endsWith('/api/show')) {
      if (show instanceof Error) throw show
      return { ok: true, json: async () => show }
    }
    return { ok: true, json: async () => ({ message: { role: 'assistant', content: 'a red circle' }, done_reason: 'stop' }), _body: init?.body }
  })

  it('takes vision from /api/show capabilities', async () => {
    const fetchImpl = routed({ capabilities: ['completion', 'vision'] })
    const p = createLlmProvider(ollamaCfg('my-custom-model'), { fetchImpl })
    expect(p.capabilities.vision).toBe(false) // name unknown until Ollama answers
    expect(await p.visionReady).toBe(true)
    expect(p.capabilities.vision).toBe(true)
    const show = fetchImpl.mock.calls.find(c => c[0].endsWith('/api/show'))
    expect(JSON.parse(show[1].body)).toEqual({ model: 'my-custom-model' })
  })

  it('a model Ollama reports without vision stays blind even if the name looks like a VLM', async () => {
    const p = createLlmProvider(ollamaCfg('llava-but-not-really'), { fetchImpl: routed({ capabilities: ['completion'] }) })
    expect(p.capabilities.vision).toBe(true)
    expect(await p.visionReady).toBe(false)
  })

  it('falls back to the name when Ollama cannot answer', async () => {
    const down = new Error('ECONNREFUSED')
    const p1 = createLlmProvider(ollamaCfg('qwen2.5vl:3b'), { fetchImpl: routed(down) })
    expect(await p1.visionReady).toBe(true)
    const p2 = createLlmProvider(ollamaCfg('llama3.1'), { fetchImpl: routed(down) })
    expect(await p2.visionReady).toBe(false)
  })

  it('sends a frame as `images` on the native route', async () => {
    const fetchImpl = routed({ capabilities: ['vision'] })
    const p = createLlmProvider(ollamaCfg('qwen2.5vl:3b'), { fetchImpl })
    const out = await p.call({
      systemBlocks: [{ type: 'text', text: 's' }],
      tools: [],
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } }, { type: 'text', text: 'what do you see?' }] }],
    })
    const chatCall = fetchImpl.mock.calls.find(c => c[0].endsWith('/api/chat'))
    const body = JSON.parse(chatCall[1].body)
    expect(body.messages[1]).toEqual({ role: 'user', content: 'what do you see?', images: ['AAAA'] })
    expect(out.text).toBe('a red circle')
  })
})

// 261010: "works a short while then craps itself" / "anything bigger flat
// out does not work". Ollama ran the ~12k-token Minecraft prompt in its 4096
// default window (front silently dropped), turns were aborted at the 12s
// cloud budget and dropped without a retry, and a model with no tools or one
// never pulled left the companion mute.
describe('ollama provider robustness', () => {
  const cfg = (model = 'qwen3:4b') => ({
    anthropic: { ...baseConfig.anthropic, timeout_ms: 12_000 },
    llm: { provider: 'ollama', providers: { ollama: { base_url: 'http://localhost:11434', model } } },
  })
  const sys = [{ type: 'text', text: 'x'.repeat(42_000) }]
  const route = (chat) => vi.fn(async (url, init) => {
    if (url.endsWith('/api/show')) return { ok: true, json: async () => ({ capabilities: ['completion', 'tools'] }) }
    if (url.endsWith('/api/ps')) return { ok: true, json: async () => ({ models: [] }) }
    return chat(url, init)
  })
  const okChat = async () => ({ ok: true, json: async () => ({ message: { role: 'assistant', content: 'hi' }, done_reason: 'stop' }) })

  it('sends a num_ctx big enough for the whole prompt', async () => {
    clearOllamaContextState()
    const fetchImpl = route(okChat)
    const p = createLlmProvider(cfg(), { fetchImpl })
    await p.call({ systemBlocks: sys, tools: [], messages: [{ role: 'user', content: 'hi' }], maxTokens: 1024 })
    const body = JSON.parse(fetchImpl.mock.calls.find(c => c[0].endsWith('/api/chat'))[1].body)
    // 42k chars of system is about 9-12k tokens: far past Ollama's 4096 default.
    expect(body.options.num_ctx).toBeGreaterThanOrEqual(16_384)
    expect(body.options.num_ctx % 4096).toBe(0)
    expect(body.options.num_ctx).toBeLessThanOrEqual(neededNumCtx(1e9, 1024))
  })

  it('a slow local turn gets the local floor, not the 12s cloud budget, and times out as a retryable timeout', async () => {
    vi.useFakeTimers()
    try {
      const fetchImpl = route((_url, init) => new Promise((_res, rej) => {
        init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      }))
      const p = createLlmProvider(cfg(), { fetchImpl })
      const pending = p.call({ systemBlocks: [{ type: 'text', text: 's' }], tools: [], messages: [{ role: 'user', content: 'hi' }], timeoutMs: 12_000 }).catch(e => e)
      await vi.advanceTimersByTimeAsync(12_000)
      let settled = false
      pending.then(() => { settled = true })
      await vi.advanceTimersByTimeAsync(1)
      expect(settled).toBe(false) // still waiting at 12s
      await vi.advanceTimersByTimeAsync(LOCAL_TIMEOUT_FLOOR_MS)
      const err = await pending
      expect(err.name).toBe('AbortError')
      expect(err.isTimeout).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a caller abort is NOT tagged as a timeout', async () => {
    const ctl = new AbortController()
    const fetchImpl = route((_url, init) => new Promise((_res, rej) => {
      init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      setTimeout(() => ctl.abort(), 1)
    }))
    const p = createLlmProvider(cfg(), { fetchImpl })
    const err = await p.call({ systemBlocks: [], tools: [], messages: [{ role: 'user', content: 'hi' }], signal: ctl.signal }).catch(e => e)
    expect(err.name).toBe('AbortError')
    expect(err.isTimeout).toBeUndefined()
  })

  it('"does not support tools" becomes OLLAMA_MODEL_NO_TOOLS', async () => {
    const fetchImpl = route(async () => ({ ok: false, status: 400, text: async () => '{"error":"registry.ollama.ai/library/gemma3:12b does not support tools"}' }))
    const p = createLlmProvider(cfg('gemma3:12b'), { fetchImpl })
    const err = await p.call({ systemBlocks: [], tools: [{ name: 'say', description: 'd', input_schema: { type: 'object', properties: {} } }], messages: [{ role: 'user', content: 'hi' }] }).catch(e => e)
    expect(err.code).toBe('OLLAMA_MODEL_NO_TOOLS')
  })

  it('a 404 model-not-found becomes OLLAMA_MODEL_MISSING; a refused connection OLLAMA_UNREACHABLE', async () => {
    const missing = createLlmProvider(cfg('qwen3:14b'), { fetchImpl: route(async () => ({ ok: false, status: 404, text: async () => '{"error":"model \'qwen3:14b\' not found"}' })) })
    expect((await missing.call({ systemBlocks: [], tools: [], messages: [{ role: 'user', content: 'hi' }] }).catch(e => e)).code).toBe('OLLAMA_MODEL_MISSING')
    const down = createLlmProvider(cfg(), { fetchImpl: route(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: new Error('connect ECONNREFUSED') }) }) })
    const err = await down.call({ systemBlocks: [], tools: [], messages: [{ role: 'user', content: 'hi' }] }).catch(e => e)
    expect(err.code).toBe('OLLAMA_UNREACHABLE')
    expect(err.message).toContain('ECONNREFUSED')
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
