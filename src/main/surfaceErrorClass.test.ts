/**
 * 260926: local/Ollama/BYOK failures classified as unknown/turn_unknown (180
 * events from one Ollama user in 30 days). These tests drive the REAL
 * providers with fake HTTP responses (the bodies are the ones Ollama, OpenAI-
 * compatible servers and Gemini send), a real refused TCP connect, and real
 * Anthropic SDK error objects, so the classes track the shapes we throw.
 */
import { describe, it, expect } from 'vitest';
import net from 'node:net';
import Anthropic from '@anthropic-ai/sdk';
import { surfaceErrorClass } from './surfaceErrorClass';
import { createOllamaProvider } from './llm/ollama';
import { createOpenAICompatProvider } from './llm/openaiCompat';
import { createGeminiProvider } from './llm/gemini';

const params = { maxTokens: 50, system: 'sys', messages: [{ role: 'user' as const, content: 'hi' }] };

function httpFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

async function errorOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
}

const ollama = (status: number, body: unknown): Promise<unknown> =>
  errorOf(createOllamaProvider({ model: 'llama3', fetchImpl: httpFetch(status, body) }).call(params));
const openai = (status: number, body: unknown): Promise<unknown> =>
  errorOf(
    createOpenAICompatProvider({ kind: 'openai', apiKey: 'k', baseUrl: 'http://x/v1', model: 'm', fetchImpl: httpFetch(status, body) }).call(params),
  );
const gemini = (status: number, body: unknown): Promise<unknown> =>
  errorOf(createGeminiProvider({ apiKey: 'k', model: 'gemini-x', fetchImpl: httpFetch(status, body) }).call(params));

describe('surfaceErrorClass: Ollama', () => {
  it('model not pulled -> model_not_found', async () => {
    expect(surfaceErrorClass(await ollama(404, { error: 'model "llama3" not found, try pulling it first' }))).toBe(
      'model_not_found',
    );
  });
  it('model without tool support -> tools_unsupported', async () => {
    expect(
      surfaceErrorClass(await ollama(400, { error: 'registry.ollama.ai/library/gemma3:1b does not support tools' })),
    ).toBe('tools_unsupported');
  });
  it('not enough RAM for the model -> out_of_memory', async () => {
    expect(
      surfaceErrorClass(
        await ollama(500, { error: 'model requires more system memory (5.6 GiB) than is available (3.1 GiB)' }),
      ),
    ).toBe('out_of_memory');
  });
  it('any other 5xx -> server_error; any other 4xx -> bad_request', async () => {
    expect(surfaceErrorClass(await ollama(500, { error: 'llama runner process has terminated: exit status 2' }))).toBe(
      'server_error',
    );
    expect(surfaceErrorClass(await ollama(400, { error: 'invalid options: foo' }))).toBe('bad_request');
  });
  it('a 404 with no model in it (wrong base URL) -> not_found', async () => {
    expect(surfaceErrorClass(await ollama(404, '404 page not found'))).toBe('not_found');
  });
  it('a non-JSON 200 body -> bad_response', async () => {
    expect(surfaceErrorClass(await ollama(200, '<html>proxy login</html>'))).toBe('bad_response');
  });
  it('Ollama not running (real refused connect) -> connection_refused', async () => {
    // Grab a free port, close it, then connect: a real undici ECONNREFUSED.
    const port = await new Promise<number>((resolve) => {
      const srv = net.createServer();
      srv.listen(0, '127.0.0.1', () => {
        const p = (srv.address() as net.AddressInfo).port;
        srv.close(() => resolve(p));
      });
    });
    const err = await errorOf(createOllamaProvider({ model: 'm', baseUrl: `http://127.0.0.1:${port}` }).call(params));
    expect(String((err as Error).message)).toBe('fetch failed');
    expect(surfaceErrorClass(err)).toBe('connection_refused');
  });
});

describe('surfaceErrorClass: OpenAI-compatible and Gemini', () => {
  it('context_length_exceeded -> context_length', async () => {
    const body = {
      error: {
        message: "This model's maximum context length is 8192 tokens. However, you requested 9000 tokens.",
        type: 'invalid_request_error',
        code: 'context_length_exceeded',
      },
    };
    expect(surfaceErrorClass(await openai(400, body))).toBe('context_length');
  });
  it('unknown model -> model_not_found', async () => {
    const body = { error: { message: 'The model `gpt-9` does not exist or you do not have access to it.', code: 'model_not_found' } };
    expect(surfaceErrorClass(await openai(404, body))).toBe('model_not_found');
  });
  it('bad key -> auth', async () => {
    const body = { error: { message: 'Incorrect API key provided: sk-abc.', code: 'invalid_api_key' } };
    expect(surfaceErrorClass(await openai(401, body))).toBe('auth');
  });
  it('429 rate limit -> rate_limited, 429 insufficient_quota -> payment_required', async () => {
    expect(surfaceErrorClass(await openai(429, { error: { message: 'Rate limit reached for requests' } }))).toBe(
      'rate_limited',
    );
    expect(
      surfaceErrorClass(
        await openai(429, { error: { message: 'You exceeded your current quota.', code: 'insufficient_quota' } }),
      ),
    ).toBe('payment_required');
  });
  it('Gemini: bad key -> auth, unknown model -> model_not_found, quota -> rate_limited', async () => {
    expect(
      surfaceErrorClass(await gemini(400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } })),
    ).toBe('auth');
    expect(
      surfaceErrorClass(await gemini(404, { error: { code: 404, message: 'models/gemini-x is not found for API version v1beta', status: 'NOT_FOUND' } })),
    ).toBe('model_not_found');
    expect(surfaceErrorClass(await gemini(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED' } }))).toBe(
      'rate_limited',
    );
  });
});

describe('surfaceErrorClass: Anthropic SDK (BYOK and cloud)', () => {
  const headers = new Headers();
  const sdkErr = (status: number, type: string, message: string): unknown =>
    Anthropic.APIError.generate(status, { type: 'error', error: { type, message } }, undefined, headers);

  it('maps the SDK error classes', () => {
    expect(surfaceErrorClass(sdkErr(400, 'invalid_request_error', 'prompt is too long: 210000 tokens > 200000 maximum'))).toBe('context_length');
    expect(surfaceErrorClass(sdkErr(404, 'not_found_error', 'model: claude-nope'))).toBe('model_not_found');
    expect(surfaceErrorClass(sdkErr(401, 'authentication_error', 'invalid x-api-key'))).toBe('auth');
    expect(surfaceErrorClass(sdkErr(429, 'rate_limit_error', 'Number of request tokens has exceeded your per-minute rate limit'))).toBe('rate_limited');
    expect(surfaceErrorClass(sdkErr(529, 'overloaded_error', 'Overloaded'))).toBe('rate_limited');
    expect(surfaceErrorClass(sdkErr(500, 'api_error', 'Internal server error'))).toBe('server_error');
    expect(
      surfaceErrorClass(sdkErr(400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API.')),
    ).toBe('payment_required');
  });
  it('connection errors carry the fetch cause', () => {
    const cause = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' }),
    });
    expect(surfaceErrorClass(new Anthropic.APIConnectionError({ cause }))).toBe('connection_refused');
    expect(surfaceErrorClass(new Anthropic.APIConnectionTimeoutError())).toBe('timeout');
  });
});

describe('surfaceErrorClass: transport codes and our own sentinels', () => {
  const fetchFailed = (code: string): Error =>
    Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });

  it('reads undici cause codes', () => {
    expect(surfaceErrorClass(fetchFailed('ENOTFOUND'))).toBe('network');
    expect(surfaceErrorClass(fetchFailed('ECONNRESET'))).toBe('network');
    expect(surfaceErrorClass(fetchFailed('UND_ERR_CONNECT_TIMEOUT'))).toBe('timeout');
    expect(surfaceErrorClass(fetchFailed('UNABLE_TO_VERIFY_LEAF_SIGNATURE'))).toBe('tls');
  });
  it('reads an AggregateError of refused connects (localhost resolves to ::1 and 127.0.0.1)', () => {
    const agg = new AggregateError([
      Object.assign(new Error('connect ECONNREFUSED ::1:11434'), { code: 'ECONNREFUSED' }),
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' }),
    ]);
    expect(surfaceErrorClass(Object.assign(new TypeError('fetch failed'), { cause: agg }))).toBe('connection_refused');
  });
  it('maps the no-key and no-base-URL sentinels', () => {
    expect(surfaceErrorClass(new Error('LOCAL_NO_API_KEY: Local mode is on but no API key is saved.'))).toBe('no_api_key');
    expect(surfaceErrorClass(new Error("LLM provider 'openrouter' has no base URL configured."))).toBe('config');
  });
  it('a bug on our side is internal_error, not unknown', () => {
    expect(surfaceErrorClass(new TypeError("Cannot read properties of undefined (reading 'content')"))).toBe('internal_error');
  });
  it('keeps the pre-260926 tokens for the shapes they already covered', () => {
    expect(surfaceErrorClass(new Error('Request timed out'))).toBe('timeout');
    expect(surfaceErrorClass(new Error('429 rate_limit_error'))).toBe('rate_limited');
    expect(surfaceErrorClass(new Error('402 payment required'))).toBe('payment_required');
    expect(surfaceErrorClass(new Error('fetch failed'))).toBe('network');
    expect(surfaceErrorClass(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))).toBe('aborted');
    expect(surfaceErrorClass(new Error('something else entirely'))).toBe('unknown');
    expect(surfaceErrorClass('plain string weirdness')).toBe('unknown');
    expect(surfaceErrorClass(null)).toBe('unknown');
  });
  it('every class is a valid surface_error token', () => {
    const samples = [new Error('x'), fetchFailed('ECONNREFUSED'), new Error('ollama API 404: {"error":"model not found"}')];
    for (const s of samples) expect(surfaceErrorClass(s)).toMatch(/^[a-z0-9_]{1,64}$/);
  });
});
