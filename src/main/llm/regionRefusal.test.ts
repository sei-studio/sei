/**
 * 261103 (T303): main's half of the provider region refusal. A BYOK
 * provider's region answer is rethrown tagged (chat, voice, games all call
 * through buildLocalProviderFor), and the Settings / onboarding key test
 * reads it as its own token rather than "the provider rejected this key".
 */
import { describe, expect, it, vi } from 'vitest';
import type { LlmProvider } from './types';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp' },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' },
}));

const { withRegionRefusal } = await import('./index');
const { typedError } = await import('./listModels');

function failing(err: unknown): LlmProvider {
  return {
    backend: 'local',
    kind: 'openai',
    model: 'gpt-x',
    vision: 'unknown',
    call: async () => {
      throw err;
    },
  } as unknown as LlmProvider;
}

const OPENAI_REGION =
  'openai API 403: {"error":{"code":"unsupported_country_region_territory","message":"Country, region, or territory not supported"}}';

describe('withRegionRefusal', () => {
  it('rethrows a region refusal tagged with the provider name', async () => {
    const cause = new Error(OPENAI_REGION);
    const p = withRegionRefusal('openai', failing(cause));
    await expect(p.call({ messages: [], maxTokens: 1 } as never)).rejects.toMatchObject({
      message: 'PROVIDER_REGION_UNSUPPORTED[OpenAI]: OpenAI does not support your region.',
      code: 'PROVIDER_REGION_UNSUPPORTED',
      cause,
    });
  });

  it('passes every other error through untouched, and keeps the provider fields', async () => {
    const other = new Error('openai API 401: invalid_api_key');
    const p = withRegionRefusal('openai', failing(other));
    await expect(p.call({ messages: [], maxTokens: 1 } as never)).rejects.toBe(other);
    expect(p).toMatchObject({ kind: 'openai', model: 'gpt-x', backend: 'local' });
  });
});

describe('typedError (llm:test / llm:list-models token)', () => {
  it('a region refusal is its own token, ahead of the 403 = unauthorized rule', () => {
    expect(typedError(new Error(OPENAI_REGION))).toBe('region_unsupported');
    const anthropic = Object.assign(
      new Error('403 {"type":"error","error":{"type":"forbidden","message":"Request not allowed"}}'),
      { status: 403 },
    );
    expect(typedError(anthropic)).toBe('region_unsupported');
    expect(typedError(new Error('list 400: {"error":{"message":"User location is not supported for the API use."}}'))).toBe(
      'region_unsupported',
    );
  });

  it('an Anthropic model-list 403 "Request not allowed" is a region refusal, by message or by status', () => {
    const body = '{"type":"error","error":{"type":"forbidden","message":"Request not allowed"}}';
    expect(typedError(new Error(`list 403: ${body}`))).toBe('region_unsupported');
    expect(typedError(Object.assign(new Error(`list 403: ${body}`), { status: 403 }))).toBe('region_unsupported');
    expect(typedError(new Error('list 401: {"type":"error","error":{"type":"authentication_error"}}'))).toBe('unauthorized');
  });

  it('auth failures keep reading as unauthorized', () => {
    expect(typedError(new Error('openai API 401: invalid_api_key'))).toBe('unauthorized');
    expect(typedError(new Error('list 403: Forbidden'))).toBe('unauthorized');
  });
});
