/**
 * Ollama adapter (260915): thinking is switched OFF on the wire. Ollama enables
 * it by default on qwen3/deepseek-r1/gemma4-class models and charges the
 * reasoning against num_predict, so a 200-token chat turn came back with an
 * empty content ("typing... then radio silence"). Also: the empty-with-
 * thinking diagnostic, stop-sequence mapping, and tool_calls normalization.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createOllamaProvider, effectiveTimeoutMs, LOCAL_TIMEOUT_FLOOR_MS } from './ollama';

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as unknown as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
});

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
    expect(body.model).toBe('qwen3:1.7b');
    expect(body.stream).toBe(false);
    expect(body.think).toBe(false);
    expect(body.options).toEqual({ num_predict: 200, stop: ['\nHuman:', '\nPlayer:'] });
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
