/**
 * 261017 (issue #46, review round 2): the Settings Test for the ChatGPT plan
 * is a tiny, capped prompt (the route has no max_output_tokens).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp' },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' },
}));

const { testCallParams } = await import('./listModels');
const { charCapFor } = await import('./chatgptResponses');

describe('testCallParams', () => {
  it('asks the ChatGPT plan for one word with a tiny cap', () => {
    const p = testCallParams('chatgpt');
    expect(p.system).toMatch(/single word/);
    expect(p.messages).toEqual([{ role: 'user', content: 'ping' }]);
    expect(charCapFor(p.maxTokens)).toBeLessThanOrEqual(16);
  });

  it('other providers keep the 1-token probe', () => {
    expect(testCallParams('openai')).toMatchObject({ maxTokens: 1, messages: [{ role: 'user', content: 'hi' }] });
  });
});




