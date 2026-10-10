/**
 * 261010: Ollama vision is asked of Ollama (/api/show capabilities), with the
 * catalog's name heuristic only as the fallback. The heuristic alone used to
 * judge qwen2.5vl / gemma3 / llama4 blind and lock Draw! and backseat.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkOllamaForGame, clearOllamaVisionCache, ollamaModelVision, probeOllamaVision } from './ollamaCapabilities';

function showResponse(payload: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 404, json: async () => payload } as unknown as Response;
}

beforeEach(() => clearOllamaVisionCache());

describe('probeOllamaVision', () => {
  it('reads "vision" out of /api/show capabilities', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: { body: string }) => showResponse({ capabilities: ['completion', 'vision'] }));
    expect(await probeOllamaVision('http://h:1', 'qwen2.5vl:3b', fetchImpl as unknown as typeof fetch)).toBe('yes');
    expect(fetchImpl.mock.calls[0][0]).toBe('http://h:1/api/show');
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ model: 'qwen2.5vl:3b' });
  });

  it('a capability list without vision is a confident no', async () => {
    const fetchImpl = vi.fn(async () => showResponse({ capabilities: ['completion', 'tools'] }));
    expect(await probeOllamaVision('http://h:1', 'qwen2.5:0.5b', fetchImpl as unknown as typeof fetch)).toBe('no');
  });

  it('null when Ollama cannot say (old build, error, unreachable)', async () => {
    expect(await probeOllamaVision('http://h:1', 'a', (async () => showResponse({ details: {} })) as unknown as typeof fetch)).toBeNull();
    expect(await probeOllamaVision('http://h:1', 'b', (async () => showResponse({}, false)) as unknown as typeof fetch)).toBeNull();
    expect(
      await probeOllamaVision('http://h:1', 'c', (async () => {
        throw new Error('fetch failed');
      }) as unknown as typeof fetch),
    ).toBeNull();
  });

  it('caches a successful answer per base+model', async () => {
    const fetchImpl = vi.fn(async () => showResponse({ capabilities: ['vision'] }));
    await probeOllamaVision('http://h:1', 'm', fetchImpl as unknown as typeof fetch);
    await probeOllamaVision('http://h:1', 'm', fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await probeOllamaVision('http://h:2', 'm', fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('ollamaModelVision', () => {
  const down = (async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;

  it("prefers Ollama's answer over the name", async () => {
    // A name the heuristic does not know, but Ollama says it sees.
    expect(await ollamaModelVision('http://h:1', 'my-custom:latest', (async () => showResponse({ capabilities: ['vision'] })) as unknown as typeof fetch)).toBe('yes');
  });

  it('falls back to the name heuristic when Ollama is down', async () => {
    expect(await ollamaModelVision('http://h:1', 'qwen2.5vl:3b', down)).toBe('yes');
    expect(await ollamaModelVision('http://h:1', 'gemma3:4b', down)).toBe('yes');
    expect(await ollamaModelVision('http://h:1', 'llama3.1:8b', down)).toBe('unknown');
  });
});

// 261010: before a game companion joins, the Ollama model must be able to run
// the game brain (tools), exist, and Ollama must be up.
describe('checkOllamaForGame', () => {
  const ok = (payload: unknown, status = 200): Response =>
    ({ ok: status < 400, status, json: async () => payload, text: async () => JSON.stringify(payload) }) as unknown as Response;

  it('a model with tools passes', async () => {
    const f = (async () => ok({ capabilities: ['completion', 'tools', 'thinking'] })) as unknown as typeof fetch;
    expect(await checkOllamaForGame('http://h', 'qwen3:4b', f)).toBeNull();
  });

  it('a vision model without tools is refused with OLLAMA_MODEL_NO_TOOLS', async () => {
    const f = (async () => ok({ capabilities: ['completion', 'vision'] })) as unknown as typeof fetch;
    expect(await checkOllamaForGame('http://h', 'gemma3:12b', f)).toMatchObject({ error: 'OLLAMA_MODEL_NO_TOOLS' });
  });

  it('a model that was never pulled is OLLAMA_MODEL_MISSING', async () => {
    const f = (async () => ok({ error: "model 'qwen3:14b' not found" }, 404)) as unknown as typeof fetch;
    expect(await checkOllamaForGame('http://h', 'qwen3:14b', f)).toMatchObject({ error: 'OLLAMA_MODEL_MISSING' });
  });

  it('a bare "404 page not found" (wrong address, not a missing model) fails open', async () => {
    const f = (async () => ({ ok: false, status: 404, text: async () => '404 page not found' })) as unknown as typeof fetch;
    expect(await checkOllamaForGame('http://h', 'qwen3:4b', f)).toBeNull();
  });

  it('a refused connection is OLLAMA_NOT_RUNNING', async () => {
    const f = (async () => { throw Object.assign(new TypeError('fetch failed'), { cause: new Error('connect ECONNREFUSED') }); }) as unknown as typeof fetch;
    expect(await checkOllamaForGame('http://h', 'qwen3:4b', f)).toMatchObject({ error: 'OLLAMA_NOT_RUNNING', message: expect.stringContaining('ECONNREFUSED') });
  });

  it('fails open when the answer is unclear (old Ollama, server error)', async () => {
    expect(await checkOllamaForGame('http://h', 'm', (async () => ok({ details: {} })) as unknown as typeof fetch)).toBeNull();
    expect(await checkOllamaForGame('http://h', 'm', (async () => ok({}, 500)) as unknown as typeof fetch)).toBeNull();
  });
});
