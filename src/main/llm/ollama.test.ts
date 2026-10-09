/**
 * Ollama adapter (260915): thinking is switched OFF on the wire. Ollama enables
 * it by default on qwen3/deepseek-r1/gemma4-class models and charges the
 * reasoning against num_predict, so a 200-token chat turn came back with an
 * empty content ("typing... then radio silence"). Also: the empty-with-
 * thinking diagnostic, stop-sequence mapping, and tool_calls normalization.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

// num_ctx sizing has its own tests (ollamaContext.test.ts); here it is pinned
// so the fetch mocks below only ever see /api/chat.
const { chooseNumCtx } = vi.hoisted(() => ({ chooseNumCtx: vi.fn(async () => 16384) }));
vi.mock('./ollamaContext', async (orig) => ({
  ...(await orig<typeof import('./ollamaContext')>()),
  chooseOllamaNumCtx: chooseNumCtx,
}));
import {
  createOllamaProvider,
  effectiveTimeoutMs,
  flattenToolTurns,
  LOCAL_TIMEOUT_FLOOR_MS,
  NO_TOOLS_MODELS,
} from './ollama';

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as unknown as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
  NO_TOOLS_MODELS.clear();
});

function errorResponse(status: number, payload: unknown): Response {
  return {
    ok: false,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as unknown as Response;
}

describe('effectiveTimeoutMs', () => {
  it('raises a cloud-sized caller timeout to the local floor', () => {
    expect(effectiveTimeoutMs(30_000)).toBe(LOCAL_TIMEOUT_FLOOR_MS);
    expect(effectiveTimeoutMs(undefined)).toBe(LOCAL_TIMEOUT_FLOOR_MS);
  });
  it('keeps a caller timeout above the floor', () => {
    expect(effectiveTimeoutMs(LOCAL_TIMEOUT_FLOOR_MS + 1)).toBe(LOCAL_TIMEOUT_FLOOR_MS + 1);
  });
});

describe('createOllamaProvider', () => {
  const params = {
    maxTokens: 200,
    system: 'sys',
    messages: [{ role: 'user' as const, content: 'hello' }],
    stopSequences: ['\nHuman:', '\nPlayer:'],
  };

  it('sends think:false, num_predict and stop on the native /api/chat route', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: { body: string }) => jsonResponse({ message: { role: 'assistant', content: 'hi there' }, done_reason: 'stop' }));
    const p = createOllamaProvider({ model: 'qwen3:1.7b', fetchImpl: fetchImpl as unknown as typeof fetch });
    const res = await p.call(params);
    expect(fetchImpl.mock.calls[0][0]).toBe('http://localhost:11434/api/chat');
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    // 261010: a context window sized to the prompt rides every request.
    expect(body.options.num_ctx).toBe(16384);
    expect(chooseNumCtx).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: 'http://localhost:11434', model: 'qwen3:1.7b', maxTokens: 200 }),
    );
    expect(body.model).toBe('qwen3:1.7b');
    expect(body.stream).toBe(false);
    expect(body.think).toBe(false);
    expect(body.options).toEqual({ num_ctx: 16384, num_predict: 200, stop: ['\nHuman:', '\nPlayer:'] });
    expect(res.text).toBe('hi there');
    expect(res.stopReason).toBe('end_turn');
  });

  it('maps done_reason length to max_tokens', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: { body: string }) => jsonResponse({ message: { role: 'assistant', content: "i'm just a" }, done_reason: 'length' }));
    const p = createOllamaProvider({ model: 'm', fetchImpl: fetchImpl as unknown as typeof fetch });
    const res = await p.call(params);
    expect(res.stopReason).toBe('max_tokens');
  });

  it('warns when the reply is empty but thinking was produced', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = vi.fn(async (_url: string, _init: { body: string }) =>
      jsonResponse({ message: { role: 'assistant', content: '', thinking: 'Okay, the player said hello...' }, done_reason: 'length' }),
    );
    const p = createOllamaProvider({ model: 'qwen3:1.7b', fetchImpl: fetchImpl as unknown as typeof fetch });
    const res = await p.call(params);
    expect(res.text).toBe('');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('empty reply');
  });

  it('does not warn on a normal reply', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = vi.fn(async (_url: string, _init: { body: string }) => jsonResponse({ message: { role: 'assistant', content: 'ok' }, done_reason: 'stop' }));
    const p = createOllamaProvider({ model: 'm', fetchImpl: fetchImpl as unknown as typeof fetch });
    await p.call(params);
    expect(warn).not.toHaveBeenCalled();
  });

  it('normalizes tool_calls whose arguments are already objects', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: { body: string }) =>
      jsonResponse({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'remember', arguments: { text: 'likes cats' } } }] }, done_reason: 'stop' }),
    );
    const p = createOllamaProvider({ model: 'm', fetchImpl: fetchImpl as unknown as typeof fetch });
    const res = await p.call(params);
    expect(res.toolUses).toEqual([{ id: expect.stringMatching(/^toolu_/), name: 'remember', input: { text: 'likes cats' } }]);
    expect(res.stopReason).toBe('tool_use');
  });
});

// 261010 ("Ollama vision models all not working").
describe('createOllamaProvider: images and tool-less vision models', () => {
  const IMG = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'data:image/png;base64,QUJD' } };
  const tools = [{ name: 'remember', description: 'save', input_schema: { type: 'object', properties: {} } }];

  it('sends an image as `images` on a string-content message (not OpenAI image_url parts)', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: { body: string }) => jsonResponse({ message: { role: 'assistant', content: 'a red circle' }, done_reason: 'stop' }));
    const p = createOllamaProvider({ model: 'qwen2.5vl:3b', fetchImpl: fetchImpl as unknown as typeof fetch });
    const res = await p.call({ maxTokens: 50, messages: [{ role: 'user', content: [IMG, { type: 'text', text: 'what is it?' }] }] as never });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.messages).toEqual([{ role: 'user', content: 'what is it?', images: ['QUJD'] }]);
    expect(JSON.stringify(body)).not.toContain('image_url');
    expect(res.text).toBe('a red circle');
  });

  it('retries once without tools when Ollama says the model does not support tools, and remembers it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = vi
      .fn(async (_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body);
        return body.tools
          ? errorResponse(400, { error: 'registry.ollama.ai/library/qwen2.5vl:3b does not support tools' })
          : jsonResponse({ message: { role: 'assistant', content: 'nice drawing' }, done_reason: 'stop' });
      });
    const p = createOllamaProvider({ model: 'qwen2.5vl:3b', fetchImpl: fetchImpl as unknown as typeof fetch });
    const call = { maxTokens: 50, tools, messages: [{ role: 'user', content: [IMG] }] } as never;
    const res = await p.call(call);
    expect(res.text).toBe('nice drawing');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body).tools).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    // A second provider instance (another surface) skips the doomed request.
    const p2 = createOllamaProvider({ model: 'qwen2.5vl:3b', fetchImpl: fetchImpl as unknown as typeof fetch });
    await p2.call(call);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(JSON.parse(fetchImpl.mock.calls[2][1].body).tools).toBeUndefined();
  });

  it('a forced tool on a tool-less model still lands through the JSON fallback', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: { body: string }) =>
      JSON.parse(init.body).tools
        ? errorResponse(400, { error: 'm does not support tools' })
        : jsonResponse({ message: { role: 'assistant', content: '{"guess": "cat"}' }, done_reason: 'stop' }),
    );
    const p = createOllamaProvider({ model: 'm', fetchImpl: fetchImpl as unknown as typeof fetch });
    const res = await p.call({ maxTokens: 50, tools, toolChoice: { type: 'tool', name: 'remember' }, messages: [{ role: 'user', content: 'go' }] } as never);
    expect(res.toolUses).toEqual([{ id: expect.any(String), name: 'remember', input: { guess: 'cat' } }]);
  });

  it('does not retry other 400s', async () => {
    const fetchImpl = vi.fn(async () => errorResponse(400, { error: 'Multimodal data provided, but model does not support multimodal requests.' }));
    const p = createOllamaProvider({ model: 'qwen2.5:0.5b', fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(p.call({ maxTokens: 50, tools, messages: [{ role: 'user', content: [IMG] }] } as never)).rejects.toThrow(
      /ollama API 400: .*does not support multimodal/,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('flattenToolTurns folds tool calls and results into text for a tool-less template', () => {
    expect(
      flattenToolTurns([
        { role: 'assistant', content: '', tool_calls: [{ function: { name: 'pen', arguments: { n: 1 } } }] },
        { role: 'tool', content: 'drawn', tool_name: 'pen' },
        { role: 'user', content: 'hi', images: ['A'] },
      ]),
    ).toEqual([
      { role: 'assistant', content: '(called pen {"n":1})' },
      { role: 'user', content: '(pen result) drawn' },
      { role: 'user', content: 'hi', images: ['A'] },
    ]);
  });
});

// 261010: setup failures used to reach the user as a generic "couldn't reply".
describe('createOllamaProvider: setup errors are tagged', () => {
  const params = { maxTokens: 50, system: 's', messages: [{ role: 'user' as const, content: 'hi' }] };

  it('a refused connection becomes OLLAMA_UNREACHABLE with the cause kept', async () => {
    const refused = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' }),
    });
    const p = createOllamaProvider({ model: 'qwen3:4b', fetchImpl: (async () => { throw refused; }) as unknown as typeof fetch });
    const err = (await p.call(params).catch((e) => e)) as Error;
    expect(err.message).toMatch(/^OLLAMA_UNREACHABLE: couldn't reach Ollama at http:\/\/localhost:11434 \(connect ECONNREFUSED/);
    expect(err.cause).toBe(refused);
  });

  it('a caller cancel stays an abort, not "unreachable"', async () => {
    const ctl = new AbortController();
    const fetchImpl = vi.fn(async (_u: string, init: { signal: AbortSignal }) => {
      ctl.abort();
      const e = new Error('This operation was aborted');
      e.name = 'AbortError';
      expect(init.signal.aborted).toBe(true);
      throw e;
    });
    const p = createOllamaProvider({ model: 'qwen3:4b', fetchImpl: fetchImpl as unknown as typeof fetch });
    const err = (await p.call({ ...params, signal: ctl.signal }).catch((e) => e)) as Error;
    expect(err.name).toBe('AbortError');
  });

  it('a 404 "model not found" becomes OLLAMA_MODEL_MISSING naming the model', async () => {
    const fetchImpl = vi.fn(async () => errorResponse(404, { error: 'model "qwen3:14b" not found, try pulling it first' }));
    const p = createOllamaProvider({ model: 'qwen3:14b', fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(p.call(params)).rejects.toThrow(/^OLLAMA_MODEL_MISSING: Ollama has no model named qwen3:14b/);
  });
});
